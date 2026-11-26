import { open, stat } from 'node:fs/promises';
import type { PublishMetadata } from '../app/models/studio.models';
import { platformCaption } from './publish-metadata';

/**
 * TikTok Content Posting API (Direct Post).
 *
 * Trava importante: app **não auditado** pela TikTok só publica em modo privado
 * (SELF_ONLY) e para no máximo 5 usuários/24h. Publicar assim não serve para um
 * canal de notícias, então o adaptador se recusa a rodar sem `TIKTOK_AUDITED=1`.
 */

const API = 'https://open.tiktokapis.com/v2';
const CHUNK = 10 * 1024 * 1024;

export interface TiktokStatus {
  configured: boolean;
  audited: boolean;
  ready: boolean;
  reason?: string;
}

export function tiktokStatus(): TiktokStatus {
  const token = process.env['TIKTOK_ACCESS_TOKEN']?.trim();
  const audited = process.env['TIKTOK_AUDITED'] === '1';

  if (!token) {
    return {
      configured: false,
      audited,
      ready: false,
      reason: 'Defina TIKTOK_ACCESS_TOKEN no .env (Login Kit da TikTok).',
    };
  }
  if (!audited) {
    return {
      configured: true,
      audited: false,
      ready: false,
      reason:
        'App ainda não auditado pela TikTok: todo post sairia privado (SELF_ONLY). Peça o audit e depois defina TIKTOK_AUDITED=1.',
    };
  }
  return { configured: true, audited: true, ready: true };
}

export interface TiktokPublishResult {
  publishId: string;
  privacyLevel: string;
  url?: string;
}

async function tiktokFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = process.env['TIKTOK_ACCESS_TOKEN']?.trim();
  if (!token) throw new Error('TikTok não configurado: falta TIKTOK_ACCESS_TOKEN.');

  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('Content-Type', 'application/json; charset=UTF-8');
  return fetch(`${API}${path}`, { ...init, headers });
}

/** Publica o MP4 no TikTok em chunks. Só roda com app auditado. */
export async function publishToTiktok(params: {
  videoPath: string;
  metadata: PublishMetadata;
  privacyLevel?: 'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'SELF_ONLY';
}): Promise<TiktokPublishResult> {
  const status = tiktokStatus();
  if (!status.ready) throw new Error(status.reason ?? 'TikTok não está pronto para publicar.');

  const fileInfo = await stat(params.videoPath);
  const size = fileInfo.size;
  const chunkSize = Math.min(CHUNK, size);
  const totalChunks = Math.max(1, Math.ceil(size / chunkSize));

  const initRes = await tiktokFetch('/post/publish/video/init/', {
    method: 'POST',
    body: JSON.stringify({
      post_info: {
        title: platformCaption(params.metadata).slice(0, 2200),
        privacy_level: params.privacyLevel ?? 'PUBLIC_TO_EVERYONE',
        disable_comment: false,
        video_cover_timestamp_ms: 1000,
      },
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: size,
        chunk_size: chunkSize,
        total_chunk_count: totalChunks,
      },
    }),
  });

  const initData = (await initRes.json().catch(() => ({}))) as {
    data?: { publish_id?: string; upload_url?: string };
    error?: { code?: string; message?: string };
  };

  if (!initRes.ok || !initData.data?.upload_url || !initData.data.publish_id) {
    throw new Error(
      `TikTok recusou o início do post (${initData.error?.code ?? initRes.status}): ${
        initData.error?.message ?? 'sem detalhe'
      }`,
    );
  }

  const { publish_id: publishId, upload_url: uploadUrl } = initData.data;

  const handle = await open(params.videoPath, 'r');
  try {
    for (let index = 0; index < totalChunks; index++) {
      const offset = index * chunkSize;
      const length = Math.min(chunkSize, size - offset);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);

      const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(length),
          'Content-Range': `bytes ${offset}-${offset + length - 1}/${size}`,
        },
        body: buffer,
      });

      if (!res.ok && res.status !== 206) {
        throw new Error(`Falha ao enviar o chunk ${index + 1}/${totalChunks} para o TikTok.`);
      }
    }
  } finally {
    await handle.close().catch(() => undefined);
  }

  // Confirma o processamento (até ~1 min).
  for (let attempt = 0; attempt < 12; attempt++) {
    const res = await tiktokFetch('/post/publish/status/fetch/', {
      method: 'POST',
      body: JSON.stringify({ publish_id: publishId }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      data?: { status?: string };
    };
    const state = data.data?.status;
    if (state === 'PUBLISH_COMPLETE' || state === 'FAILED') break;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }

  return { publishId, privacyLevel: params.privacyLevel ?? 'PUBLIC_TO_EVERYONE' };
}
