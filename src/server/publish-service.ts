import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  InstagramPublishState,
  PautaRecord,
  PublishMetadata,
  PublishPlatform,
  PublishRecord,
  TiktokPublishState,
  YoutubePublishState,
} from '../app/models/studio.models';
import { instagramStatus, publishToInstagram } from './instagram';
import { projectDir, readProject, writeProject } from './projects';
import { buildDeterministicMetadata, validateMetadata } from './publish-metadata';
import {
  checkPostQuota,
  checkYoutubeQuota,
  consumePost,
  consumeYoutubeUnits,
  fullPublishCost,
  QUOTA_COST,
} from './publish-quota';
import { publishToTiktok, tiktokStatus } from './tiktok';
import { getAccessToken, getChannelInfo, expectedChannelId, youtubeConfig } from './youtube-auth';
import { publishToYoutube } from './youtube-upload';
import { readFile, writeFile } from 'node:fs/promises';

/** Erro com status HTTP: a rota usa para responder 409/422 em vez de 500. */
export class PublishError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = 'PublishError';
  }
}

export interface PublishRequest {
  pautaId: string;
  platforms?: PublishPlatform[];
  metadata?: PublishMetadata;
  privacyStatus?: 'public' | 'unlisted' | 'private';
  publishAt?: string;
  confirmRights?: boolean;
  force?: boolean;
}

export interface PublishResult {
  pautaId: string;
  youtube?: YoutubePublishState;
  tiktok?: TiktokPublishState;
  instagram?: InstagramPublishState;
  skipped: Array<{ platform: PublishPlatform; reason: string }>;
  warnings: string[];
  quotaUsed: number;
}

export function publishRecordPath(pautaId: string): string {
  return join(projectDir(pautaId), 'publish.json');
}

export async function readPublishRecord(pautaId: string): Promise<PublishRecord | null> {
  const path = publishRecordPath(pautaId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8')) as PublishRecord;
  } catch {
    return null;
  }
}

async function writePublishRecord(pautaId: string, record: PublishRecord): Promise<void> {
  await writeFile(publishRecordPath(pautaId), JSON.stringify(record, null, 2), 'utf8');
}

/** A pauta usa foto publicada pelo veículo? Isso muda o gate de direitos. */
export function hasThirdPartyMedia(pauta: PautaRecord): boolean {
  if ((pauta.dossier?.articleMedia ?? []).length > 0) return true;
  return (pauta.script?.scenes ?? []).some((scene) => {
    const list = scene.mediaAssets ?? (scene.mediaAsset ? [scene.mediaAsset] : []);
    return list.some((asset) => asset.provider === 'article');
  });
}

/** Checagens antes de enfileirar: o usuário recebe o motivo na hora. */
export async function assertPublishable(
  request: PublishRequest,
): Promise<{ project: PautaRecord; metadata: PublishMetadata }> {
  const project = await readProject(request.pautaId);
  if (!project) {
    throw new PublishError('Pauta não encontrada no disco.', 404);
  }
  if (project.stage !== 'APPROVED' && project.stage !== 'PUBLISHED' && !request.force) {
    throw new PublishError(
      `Aprovação humana obrigatória antes de publicar (estágio atual: ${project.stage}).`,
    );
  }
  if (project.qc?.hasBlockingErrors) {
    throw new PublishError('O QC tem itens bloqueantes. Resolva antes de publicar.');
  }

  const videoPath = join(projectDir(request.pautaId), 'video.mp4');
  if (!existsSync(videoPath)) {
    throw new PublishError('Renderize o pacote final antes de publicar (video.mp4 não existe).');
  }

  const metadata = request.metadata ?? buildDeterministicMetadata(project);
  const problems = validateMetadata(metadata);
  if (problems.length > 0) {
    throw new PublishError(`Metadados inválidos: ${problems.join(' ')}`, 422);
  }

  const platforms = request.platforms?.length ? request.platforms : (['youtube'] as PublishPlatform[]);

  // Idempotência: já publicado não vira job novo (e não duplica no canal).
  const existingRecord = await readPublishRecord(request.pautaId);
  if (
    platforms.includes('youtube') &&
    existingRecord?.youtube?.videoId &&
    !request.force
  ) {
    throw new PublishError(
      `Esta pauta já foi publicada no YouTube: ${existingRecord.youtube.url} — apague no Studio ou reenvie com force.`,
    );
  }

  // Direitos vêm antes de conexão: é uma decisão editorial, não técnica.
  const privacy = request.privacyStatus ?? youtubeConfig()?.privacyDefault ?? 'unlisted';
  if (privacy === 'public' && hasThirdPartyMedia(project) && !request.confirmRights) {
    throw new PublishError(
      'A pauta usa foto publicada pelo veículo. Para publicar como público, confirme que você tem o direito de uso.',
    );
  }

  if (platforms.includes('youtube') && !youtubeConfig()) {
    throw new PublishError(
      'YouTube não configurado: defina YOUTUBE_CLIENT_ID e YOUTUBE_CLIENT_SECRET no .env e conecte a conta.',
    );
  }
  if (platforms.includes('youtube') && !(await getAccessToken())) {
    throw new PublishError('YouTube não conectado. Use "Conectar YouTube" para autorizar a conta.');
  }

  // Trava de canal: o token é da conta Google, não do canal. Sem isso é fácil
  // publicar no canal pessoal por engano.
  if (platforms.includes('youtube')) {
    const expected = expectedChannelId();
    if (expected) {
      const channel = await getChannelInfo();
      if (!channel || channel.id !== expected) {
        throw new PublishError(
          `A conta conectada está no canal "${channel?.title ?? 'desconhecido'}" (${channel?.id ?? '—'}), ` +
            `mas o canal fixado é ${expected}. Reconecte com a conta dona do canal certo.`,
        );
      }
    }
  }

  if (platforms.includes('youtube')) {
    const quota = await checkYoutubeQuota(fullPublishCost());
    if (!quota.ok) {
      throw new PublishError(
        `Cota do YouTube insuficiente hoje (${quota.used}/${quota.limit} unidades usadas). ` +
          'A cota reinicia à meia-noite do Pacífico.',
      );
    }
  }

  return { project, metadata };
}

/**
 * Publica o pacote nas plataformas pedidas.
 *
 * YouTube é o caminho completo. TikTok/Instagram entram como "skip" com motivo
 * quando faltam as aprovações das plataformas — nunca falham silenciosamente.
 */
export async function publishPauta(
  request: PublishRequest,
  onProgress: (stage: string, pct: number, message?: string) => void = () => undefined,
): Promise<PublishResult> {
  const { project, metadata } = await assertPublishable(request);
  const platforms: PublishPlatform[] = request.platforms?.length
    ? request.platforms
    : ['youtube'];
  const privacyStatus =
    request.privacyStatus ?? youtubeConfig()?.privacyDefault ?? 'unlisted';

  const existing = await readPublishRecord(request.pautaId);
  if (existing?.youtube?.videoId && platforms.includes('youtube') && !request.force) {
    throw new PublishError(
      `Esta pauta já foi publicada no YouTube: ${existing.youtube.url}`,
    );
  }

  const dir = projectDir(request.pautaId);
  const result: PublishResult = { pautaId: request.pautaId, skipped: [], warnings: [], quotaUsed: 0 };
  const at = new Date().toISOString();

  const record: PublishRecord = existing ?? {
    schemaVersion: 'canal-dark-publish/0.1',
    updatedAt: at,
    metadata,
    requests: [],
  };
  record.metadata = metadata;
  record.updatedAt = at;
  record.requests = [...(record.requests ?? []), { platform: 'youtube', at, detail: 'início' }];

  if (platforms.includes('youtube')) {
    onProgress('youtube', 12, 'Enviando para o YouTube…');
    const youtube = await publishToYoutube({
      videoPath: join(dir, 'video.mp4'),
      thumbnailPath: existsSync(join(dir, 'thumbnail.jpg')) ? join(dir, 'thumbnail.jpg') : null,
      srtPath: existsSync(join(dir, 'legendas.srt')) ? join(dir, 'legendas.srt') : null,
      metadata,
      privacyStatus,
      publishAt: request.publishAt,
      onProgress,
    });

    result.youtube = {
      videoId: youtube.videoId,
      url: youtube.url,
      privacyStatus: youtube.privacyStatus as 'public' | 'unlisted' | 'private',
      publishedAt: youtube.publishedAt,
      scheduledFor: youtube.scheduledFor,
      thumbnailSet: youtube.thumbnailSet,
      captionsSet: youtube.captionsSet,
    };
    record.youtube = result.youtube;
    result.quotaUsed += youtube.quotaUnits;
    await consumeYoutubeUnits(youtube.quotaUnits);

    // Prova de destino: o próprio YouTube informa o canal do vídeo.
    const expected = expectedChannelId();
    if (expected && youtube.channelId && youtube.channelId !== expected) {
      result.warnings.push(
        `ATENÇÃO: o vídeo caiu no canal ${youtube.channelTitle ?? youtube.channelId}, ` +
          `não no canal fixado (${expected}). Apague em https://studio.youtube.com e reconecte a conta certa.`,
      );
    }

    if (!youtube.thumbnailSet) {
      result.warnings.push(
        'Capa não aplicada (canal pode não estar verificado para thumbnails personalizadas).',
      );
    }
    if (!youtube.captionsSet) {
      result.warnings.push('Legenda não enviada ao YouTube; o .SRT continua no pacote.');
    }
  }

  if (platforms.includes('tiktok')) {
    const status = tiktokStatus();
    if (!status.ready) {
      result.skipped.push({ platform: 'tiktok', reason: status.reason ?? 'TikTok indisponível.' });
    } else {
      const quota = await checkPostQuota('tiktok');
      if (!quota.ok) {
        result.skipped.push({
          platform: 'tiktok',
          reason: `Limite diário do TikTok atingido (${quota.used}/${quota.limit}).`,
        });
      } else {
        onProgress('tiktok', 60, 'Enviando para o TikTok…');
        const tiktok = await publishToTiktok({
          videoPath: join(dir, 'video.mp4'),
          metadata,
          privacyLevel: 'PUBLIC_TO_EVERYONE',
        });
        result.tiktok = {
          publishId: tiktok.publishId,
          publishedAt: at,
          privacy: tiktok.privacyLevel,
        };
        record.tiktok = result.tiktok;
        await consumePost('tiktok');
      }
    }
  }

  if (platforms.includes('instagram')) {
    const status = instagramStatus();
    if (!status.ready) {
      result.skipped.push({ platform: 'instagram', reason: status.reason ?? 'Instagram indisponível.' });
    } else {
      const quota = await checkPostQuota('instagram');
      if (!quota.ok) {
        result.skipped.push({
          platform: 'instagram',
          reason: `Limite de 50 posts/24h do Instagram atingido.`,
        });
      } else {
        onProgress('instagram', 75, 'Enviando para o Instagram…');
        const instagram = await publishToInstagram({
          metadata,
          publicVideoUrl: `${status.publicBaseUrl}/api/projects/${request.pautaId}/video`,
        });
        result.instagram = { mediaId: instagram.mediaId, publishedAt: at, permalink: instagram.permalink };
        record.instagram = result.instagram;
        await consumePost('instagram');
      }
    }
  }

  record.updatedAt = new Date().toISOString();
  record.requests = [
    ...(record.requests ?? []),
    {
      platform: platforms[0] ?? 'youtube',
      at: record.updatedAt,
      detail: result.youtube ? `videoId ${result.youtube.videoId}` : 'sem publicação',
    },
  ].slice(-20);
  await writePublishRecord(request.pautaId, record);

  if (result.youtube) {
    // Atualiza a pauta: estágio PUBLISHED + link do vídeo.
    const updated: PautaRecord = {
      ...project,
      stage: 'PUBLISHED',
      updatedAt: record.updatedAt,
      youtube: result.youtube,
    };
    await writeProject(request.pautaId, updated);
  }

  if (!result.youtube && result.skipped.length === platforms.length) {
    throw new PublishError(
      `Nenhuma plataforma publicou: ${result.skipped.map((s) => `${s.platform}: ${s.reason}`).join(' | ')}`,
    );
  }

  return result;
}
