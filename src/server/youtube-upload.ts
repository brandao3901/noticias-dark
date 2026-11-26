import { open, readFile, stat } from 'node:fs/promises';
import type { PublishMetadata } from '../app/models/studio.models';
import { QUOTA_COST } from './publish-quota';
import { youtubeFetch, youtubeUploadFetch } from './youtube-auth';

/** 8 MB por requisição: bom equilíbrio entre retomada e overhead. */
const CHUNK_SIZE = 8 * 1024 * 1024;

export interface YoutubePublishInput {
  videoPath: string;
  thumbnailPath?: string | null;
  srtPath?: string | null;
  metadata: PublishMetadata;
  privacyStatus: 'public' | 'unlisted' | 'private';
  publishAt?: string;
  onProgress?: (stage: string, pct: number, message?: string) => void;
}

export interface YoutubePublishResult {
  videoId: string;
  url: string;
  privacyStatus: string;
  publishedAt: string;
  scheduledFor?: string;
  thumbnailSet: boolean;
  captionsSet: boolean;
  quotaUnits: number;
  /** Canal onde o vídeo realmente nasceu (vem no snippet da resposta). */
  channelId?: string;
  channelTitle?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Extrai a mensagem útil do erro do Google (quota, permissão, limite). */
async function describeHttpError(res: Response, step: string): Promise<string> {
  const text = await res.text().catch(() => '');
  let detail = text.slice(0, 300);
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string; errors?: Array<{ reason?: string }> };
    };
    const reason = parsed.error?.errors?.[0]?.reason;
    const message = parsed.error?.message;
    if (reason === 'quotaExceeded') {
      return `Cota diária do YouTube esgotada ao ${step}. Tente de novo depois da meia-noite (Pacífico) ou peça aumento de cota no Google Cloud.`;
    }
    if (reason === 'uploadLimitExceeded') {
      return 'A conta atingiu o limite de uploads do YouTube para hoje.';
    }
    if (reason === 'forbidden' || reason === 'youtubeSignupRequired') {
      return 'A conta Google conectada não tem canal do YouTube habilitado.';
    }
    detail = [message, reason].filter(Boolean).join(' — ') || detail;
  } catch {
    // Corpo não era JSON: fica o texto cru.
  }
  return `Falha ao ${step} (HTTP ${res.status}): ${detail}`;
}

/**
 * Publica o MP4 no YouTube: upload resumable, espera o processamento, aplica
 * thumbnail e legenda. Cada etapa reporta progresso para a fila.
 */
export async function publishToYoutube(input: YoutubePublishInput): Promise<YoutubePublishResult> {
  const report = input.onProgress ?? (() => undefined);
  const fileStat = await stat(input.videoPath);
  const size = fileStat.size;
  if (size <= 0) throw new Error('Vídeo vazio — renderize o pacote antes de publicar.');

  const status: Record<string, unknown> = {
    privacyStatus: input.publishAt ? 'private' : input.privacyStatus,
    selfDeclaredMadeForKids: false,
    // O apresentador é um avatar procedural: declara conteúdo sintético.
    containsSyntheticMedia: true,
  };
  if (input.publishAt) status['publishAt'] = input.publishAt;

  report('metadados', 4, 'Validando metadados do post…');
  const body = {
    snippet: {
      title: input.metadata.title,
      description: input.metadata.description,
      tags: input.metadata.tags,
      categoryId: input.metadata.categoryId,
      defaultLanguage: 'pt-BR',
    },
    status,
  };

  report('autorizando', 8, 'Iniciando sessão de upload…');
  const initRes = await youtubeUploadFetch('/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(size),
      'X-Upload-Content-Type': 'video/mp4',
    },
    body: JSON.stringify(body),
  });

  if (!initRes.ok) throw new Error(await describeHttpError(initRes, 'iniciar o upload'));

  const location = initRes.headers.get('location');
  if (!location) throw new Error('O YouTube não devolveu a URL de upload resumable.');

  let videoId = '';
  let uploadedChannelId = '';
  let uploadedChannelTitle = '';
  let handle: Awaited<ReturnType<typeof open>> | null = null;

  try {
    handle = await open(input.videoPath, 'r');
    let offset = 0;

    while (offset < size) {
      const length = Math.min(CHUNK_SIZE, size - offset);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);

      const end = offset + length - 1;
      const chunkRes = await fetch(location, {
        method: 'PUT',
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(length),
          'Content-Range': `bytes ${offset}-${end}/${size}`,
        },
        body: buffer,
      });

      offset += length;
      const pct = 15 + (offset / size) * 65;
      report('enviando', pct, `Enviando ${Math.round((offset / size) * 100)}% (${Math.round(offset / 1024 / 1024)} MB)`);

      if (chunkRes.status === 200 || chunkRes.status === 201) {
        const payload = (await chunkRes.json().catch(() => ({}))) as {
          id?: string;
          snippet?: { channelId?: string; channelTitle?: string };
        };
        videoId = payload.id ?? '';
        uploadedChannelId = payload.snippet?.channelId ?? '';
        uploadedChannelTitle = payload.snippet?.channelTitle ?? '';
        break;
      }

      // 308 = sessão incompleta, continue de onde parou.
      if (chunkRes.status === 308) continue;

      throw new Error(await describeHttpError(chunkRes, 'enviar o vídeo'));
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }

  if (!videoId) throw new Error('O upload terminou sem devolver o identificador do vídeo.');

  // Thumbnail personalizada exige vídeo processado.
  report('processando', 84, 'Aguardando o YouTube processar o vídeo…');
  let processed = false;
  for (let attempt = 0; attempt < 24; attempt++) {
    const res = await youtubeFetch(`/videos?part=processingDetails&id=${videoId}`);
    if (res.ok) {
      const data = (await res.json()) as {
        items?: Array<{ processingDetails?: { processingStatus?: string } }>;
      };
      const state = data.items?.[0]?.processingDetails?.processingStatus;
      if (state === 'succeeded' || state === 'failed') {
        processed = state === 'succeeded';
        break;
      }
    }
    await sleep(5_000);
  }

  let thumbnailSet = false;
  let captionsSet = false;
  let quotaUnits = QUOTA_COST.youtubeUpload;

  if (input.thumbnailPath) {
    report('thumbnail', 90, processed ? 'Aplicando capa…' : 'Aplicando capa (vídeo ainda processando)…');
    try {
      const image = await readFile(input.thumbnailPath);
      const res = await youtubeUploadFetch(`/thumbnails/set?videoId=${videoId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg' },
        body: image,
      });
      thumbnailSet = res.ok;
      quotaUnits += QUOTA_COST.youtubeThumbnail;
    } catch {
      thumbnailSet = false;
    }
  }

  if (input.srtPath) {
    report('legenda', 95, 'Enviando legendas em pt-BR…');
    try {
      const srt = await readFile(input.srtPath, 'utf8');
      const boundary = `canal-dark-${Date.now()}`;
      const metadataPart = JSON.stringify({
        snippet: {
          videoId,
          language: 'pt-BR',
          name: 'Português (Brasil)',
          isDraft: false,
        },
      });

      const multipart = [
        `--${boundary}`,
        'Content-Type: application/json; charset=UTF-8',
        '',
        metadataPart,
        `--${boundary}`,
        'Content-Type: text/plain; charset=UTF-8',
        '',
        srt,
        `--${boundary}--`,
        '',
      ].join('\r\n');

      const res = await youtubeUploadFetch('/captions?part=snippet&uploadType=multipart', {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: multipart,
      });
      captionsSet = res.ok;
      quotaUnits += QUOTA_COST.youtubeCaptions;
    } catch {
      captionsSet = false;
    }
  }

  report('concluído', 99, 'Publicado.');
  return {
    videoId,
    url: `https://youtube.com/shorts/${videoId}`,
    privacyStatus: String(status['privacyStatus']),
    publishedAt: new Date().toISOString(),
    scheduledFor: input.publishAt,
    thumbnailSet,
    captionsSet,
    quotaUnits,
    channelId: uploadedChannelId,
    channelTitle: uploadedChannelTitle,
  };
}

/** Troca a capa de um vídeo já publicado (auxílio manual de teste de thumbnail). */
export async function setYoutubeThumbnail(videoId: string, thumbnailPath: string): Promise<boolean> {
  const image = await readFile(thumbnailPath);
  const res = await youtubeUploadFetch(`/thumbnails/set?videoId=${videoId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' },
    body: image,
  });
  if (!res.ok) throw new Error(await describeHttpError(res, 'trocar a capa'));
  return true;
}
