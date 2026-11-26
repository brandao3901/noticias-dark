import type { PublishMetadata } from '../app/models/studio.models';
import { platformCaption } from './publish-metadata';

/**
 * Instagram Reels via Content Publishing API (Meta Graph).
 *
 * A API do Instagram **baixa o vídeo de uma URL pública** — ela não aceita o
 * arquivo do nosso disco. Como o Canal Dark roda em 127.0.0.1, publicar exige
 * um endereço público do pacote (`CANAL_DARK_PUBLIC_BASE_URL`, por exemplo um
 * túnel ou o servidor exposto). Sem isso, o adaptador recusa com explicação.
 */

const GRAPH_VERSION = process.env['IG_GRAPH_VERSION']?.trim() || 'v21.0';

export interface InstagramStatus {
  configured: boolean;
  ready: boolean;
  reason?: string;
  publicBaseUrl: string | null;
}

export function instagramStatus(): InstagramStatus {
  const token = process.env['FB_ACCESS_TOKEN']?.trim();
  const igUserId = process.env['IG_USER_ID']?.trim();
  const publicBaseUrl = process.env['CANAL_DARK_PUBLIC_BASE_URL']?.trim() || null;

  if (!token || !igUserId) {
    return {
      configured: false,
      ready: false,
      reason: 'Defina IG_USER_ID e FB_ACCESS_TOKEN no .env (app Meta com instagram_content_publish aprovado).',
      publicBaseUrl,
    };
  }
  if (!publicBaseUrl) {
    return {
      configured: true,
      ready: false,
      reason:
        'O Instagram baixa o vídeo de uma URL pública. Defina CANAL_DARK_PUBLIC_BASE_URL apontando para este servidor (ou exponha o pacote por um túnel).',
      publicBaseUrl,
    };
  }
  return { configured: true, ready: true, publicBaseUrl };
}

function graph(path: string, init: RequestInit = {}): Promise<Response> {
  const token = process.env['FB_ACCESS_TOKEN']?.trim();
  if (!token) throw new Error('Instagram não configurado: falta FB_ACCESS_TOKEN.');

  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}${path}`);
  url.searchParams.set('access_token', token);
  return fetch(url.toString(), init);
}

export interface InstagramPublishResult {
  mediaId: string;
  permalink?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Cria o container do Reel, espera o processamento e publica.
 * `publicVideoUrl` precisa ser acessível pela Meta (https, sem login).
 */
export async function publishToInstagram(params: {
  metadata: PublishMetadata;
  publicVideoUrl: string;
  shareToFeed?: boolean;
}): Promise<InstagramPublishResult> {
  const status = instagramStatus();
  if (!status.ready) throw new Error(status.reason ?? 'Instagram não está pronto para publicar.');

  const igUserId = process.env['IG_USER_ID']?.trim();
  if (!igUserId) throw new Error('Instagram não configurado: falta IG_USER_ID.');

  const containerRes = await graph(`/${igUserId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      media_type: 'REELS',
      video_url: params.publicVideoUrl,
      caption: platformCaption(params.metadata),
      share_to_feed: params.shareToFeed === false ? 'false' : 'true',
    }),
  });

  const container = (await containerRes.json().catch(() => ({}))) as {
    id?: string;
    error?: { message?: string; code?: number };
  };

  if (!containerRes.ok || !container.id) {
    throw new Error(
      `Instagram recusou o container (HTTP ${containerRes.status}): ${
        container.error?.message ?? 'sem detalhe'
      }`,
    );
  }

  // Espera o processamento do vídeo no lado da Meta.
  let finished = false;
  for (let attempt = 0; attempt < 24; attempt++) {
    const check = await graph(`/${container.id}?fields=status_code`);
    const data = (await check.json().catch(() => ({}))) as {
      status_code?: string;
      error?: { message?: string };
    };
    if (data.status_code === 'FINISHED') {
      finished = true;
      break;
    }
    if (data.status_code === 'ERROR') {
      throw new Error(`O Instagram não conseguiu processar o vídeo: ${data.error?.message ?? 'erro desconhecido'}`);
    }
    await sleep(5_000);
  }

  if (!finished) {
    throw new Error('O Instagram não terminou de processar o vídeo em 2 minutos. Tente de novo.');
  }

  const publishRes = await graph(`/${igUserId}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ creation_id: container.id }),
  });

  const published = (await publishRes.json().catch(() => ({}))) as {
    id?: string;
    error?: { message?: string };
  };

  if (!publishRes.ok || !published.id) {
    throw new Error(
      `Falha ao publicar no Instagram (HTTP ${publishRes.status}): ${
        published.error?.message ?? 'sem detalhe'
      }`,
    );
  }

  let permalink: string | undefined;
  try {
    const info = await graph(`/${published.id}?fields=permalink`);
    const data = (await info.json()) as { permalink?: string };
    permalink = data.permalink;
  } catch {
    permalink = undefined;
  }

  return { mediaId: published.id, permalink };
}
