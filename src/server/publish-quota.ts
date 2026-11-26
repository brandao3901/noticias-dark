import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PublishPlatform } from '../app/models/studio.models';
import { projectsRoot } from './projects';

/**
 * Controle local de cota/limite de publicação.
 *
 * O YouTube não expõe quanto sobrou da cota diária (10.000 unidades) e o dia
 * vira à meia-noite do Pacífico. Para não descobrir isso com um 403 no meio do
 * upload, o app mantém a contabilidade em disco e bloqueia antes de estourar.
 */

export const YOUTUBE_DAILY_UNITS = 10_000;
/** Margem de segurança: bloqueia em 90% para não arriscar 403 no meio do envio. */
export const YOUTUBE_SAFE_UNITS = 9_000;

/** Custos conhecidos (ver Quota Calculator do YouTube Data API). */
export const QUOTA_COST = {
  youtubeUpload: 1_600,
  youtubeThumbnail: 50,
  youtubeCaptions: 400,
  youtubeCommentInsert: 50,
  youtubeList: 1,
  youtubeAnalytics: 1,
} as const;

export const POST_DAILY_LIMIT: Record<'tiktok' | 'instagram', number> = {
  // TikTok: 5 usuários/24h em app não auditado; depois do audit usamos margem própria.
  tiktok: 20,
  // Instagram Content Publishing: 50 posts por 24h (limite da própria API).
  instagram: 50,
};

interface QuotaFile {
  day: string;
  youtubeUnits: number;
  posts: Record<'tiktok' | 'instagram', number>;
}

function quotaPath(): string {
  return join(projectsRoot(), '.publish-quota.json');
}

/** Dia corrente no fuso do YouTube (meia-noite do Pacífico). */
export function pacificDay(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function emptyQuota(day = pacificDay()): QuotaFile {
  return { day, youtubeUnits: 0, posts: { tiktok: 0, instagram: 0 } };
}

async function readQuotaFile(): Promise<QuotaFile> {
  const path = quotaPath();
  if (!existsSync(path)) return emptyQuota();
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<QuotaFile>;
    const today = pacificDay();
    // Vira o dia: zera tudo.
    if (parsed.day !== today) return emptyQuota(today);
    return {
      day: today,
      youtubeUnits: Number(parsed.youtubeUnits) || 0,
      posts: {
        tiktok: Number(parsed.posts?.tiktok) || 0,
        instagram: Number(parsed.posts?.instagram) || 0,
      },
    };
  } catch {
    return emptyQuota();
  }
}

async function writeQuotaFile(file: QuotaFile): Promise<void> {
  await writeFile(quotaPath(), JSON.stringify(file, null, 2), 'utf8');
}

export interface YoutubeQuotaCheck {
  ok: boolean;
  used: number;
  limit: number;
  safeLimit: number;
  remainingForUploads: number;
  day: string;
}

/** Quantas publicações completas (upload + thumbnail + legenda) ainda cabem hoje. */
export function fullPublishCost(): number {
  return QUOTA_COST.youtubeUpload + QUOTA_COST.youtubeThumbnail + QUOTA_COST.youtubeCaptions;
}

export async function checkYoutubeQuota(units: number): Promise<YoutubeQuotaCheck> {
  const file = await readQuotaFile();
  const used = file.youtubeUnits;
  return {
    ok: used + units <= YOUTUBE_SAFE_UNITS,
    used,
    limit: YOUTUBE_DAILY_UNITS,
    safeLimit: YOUTUBE_SAFE_UNITS,
    remainingForUploads: Math.max(0, Math.floor((YOUTUBE_SAFE_UNITS - used) / fullPublishCost())),
    day: file.day,
  };
}

export async function consumeYoutubeUnits(units: number): Promise<void> {
  const file = await readQuotaFile();
  file.youtubeUnits += Math.max(0, Math.round(units));
  await writeQuotaFile(file);
}

export async function checkPostQuota(
  platform: 'tiktok' | 'instagram',
): Promise<{ ok: boolean; used: number; limit: number; day: string }> {
  const file = await readQuotaFile();
  const limit = POST_DAILY_LIMIT[platform];
  const used = file.posts[platform] ?? 0;
  return { ok: used < limit, used, limit, day: file.day };
}

export async function consumePost(platform: 'tiktok' | 'instagram'): Promise<void> {
  const file = await readQuotaFile();
  file.posts[platform] = (file.posts[platform] ?? 0) + 1;
  await writeQuotaFile(file);
}

export function quotaForPlatform(platform: PublishPlatform): string {
  return platform === 'youtube' ? 'unidades do YouTube' : 'posts';
}
