import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { validateSafePublicUrl } from './ssrf-guard';

const execFileAsync = promisify(execFile);

export interface RenderSceneInput {
  durationSec: number;
  mediaItems: Array<{
    kind: 'image' | 'video';
    mediaUrl: string;
    thumbUrl: string;
  }>;
}

const MAX_REMOTE_MEDIA_BYTES = 25 * 1024 * 1024;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

function resolveFallbackStudioPath(): string | null {
  const candidates = [
    resolve(process.cwd(), 'public/assets/studio-fallback-bg.jpg'),
    resolve(process.cwd(), 'dist/canal-dark/browser/assets/studio-fallback-bg.jpg'),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

async function downloadSafeMediaToFile(
  rawUrl: string,
  preferredKind: 'image' | 'video',
  targetDir: string,
  index: number,
): Promise<{ path: string; kind: 'image' | 'video' } | null> {
  if (!rawUrl || !rawUrl.startsWith('http')) return null;

  let currentUrl = rawUrl;
  for (let hop = 0; hop <= 2; hop++) {
    const check = await validateSafePublicUrl(currentUrl);
    if (!check.allowed || !check.parsed) return null;

    let res: Response;
    try {
      res = await fetch(check.parsed.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(12_000),
        headers: {
          'User-Agent': 'CanalDarkEditorial/0.1 (+https://canaldark.local)',
        },
      });
    } catch {
      return null;
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return null;
      currentUrl = new URL(loc, check.parsed).toString();
      continue;
    }

    if (!res.ok) return null;

    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    const lenHeader = Number(res.headers.get('content-length') ?? 0);
    if (lenHeader > MAX_REMOTE_MEDIA_BYTES) return null;

    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.byteLength > MAX_REMOTE_MEDIA_BYTES) return null;

    let ext = 'jpg';
    let actualKind: 'image' | 'video' = preferredKind;
    if (ct.includes('video/mp4') || currentUrl.toLowerCase().endsWith('.mp4')) {
      ext = 'mp4';
      actualKind = 'video';
    } else if (ct.includes('video/webm') || currentUrl.toLowerCase().endsWith('.webm')) {
      ext = 'webm';
      actualKind = 'video';
    } else if (ct.includes('image/png')) {
      ext = 'png';
      actualKind = 'image';
    } else if (ct.includes('image/webp')) {
      ext = 'webp';
      actualKind = 'image';
    } else if (ct.includes('image/jpeg') || ct.includes('image/jpg')) {
      ext = 'jpg';
      actualKind = 'image';
    } else if (!ct.startsWith('image/') && !ct.startsWith('video/')) {
      return null;
    }

    const outPath = join(targetDir, `asset_${index}.${ext}`);
    await writeFile(outPath, buf);
    return { path: outPath, kind: actualKind };
  }

  return null;
}

export async function renderVerticalShortMp4(params: {
  scenes: RenderSceneInput[];
  srtContent: string;
  audioBase64?: string;
}): Promise<Buffer> {
  if (!params.scenes.length) {
    throw new Error('Nenhuma cena disponível para renderização.');
  }

  const workDir = await mkdtemp(join(tmpdir(), 'canal-dark-mp4-'));
  const fallbackImg = resolveFallbackStudioPath();
  const downloadedCache = new Map<string, { path: string; kind: 'image' | 'video' } | null>();
  let assetCounter = 0;

  try {
    const segmentFiles: string[] = [];
    let segIdx = 0;
    let totalDuration = 0;

    for (const scene of params.scenes.slice(0, 20)) {
      const sceneDur = Math.max(2, Math.min(30, Number(scene.durationSec) || 6));
      totalDuration += sceneDur;
      const items = scene.mediaItems.slice(0, 4);
      const slots = items.length ? items : [null];
      const slotDur = Math.max(1.5, Number((sceneDur / slots.length).toFixed(2)));

      for (const item of slots) {
        let localMedia: { path: string; kind: 'image' | 'video' } | null = null;

        if (item) {
          const candidates =
            item.kind === 'video' && (item.mediaUrl.endsWith('.mp4') || item.mediaUrl.endsWith('.webm'))
              ? [
                  { url: item.mediaUrl, kind: 'video' as const },
                  { url: item.thumbUrl, kind: 'image' as const },
                ]
              : [{ url: item.thumbUrl || item.mediaUrl, kind: 'image' as const }];

          for (const c of candidates) {
            if (!c.url) continue;
            if (downloadedCache.has(c.url)) {
              localMedia = downloadedCache.get(c.url) ?? null;
            } else {
              localMedia = await downloadSafeMediaToFile(c.url, c.kind, workDir, assetCounter++);
              downloadedCache.set(c.url, localMedia);
            }
            if (localMedia) break;
          }
        }

        const segName = `seg_${String(segIdx++).padStart(3, '0')}.mp4`;
        const segPath = join(workDir, segName);

        const ffmpegArgs: string[] = ['-y'];
        if (localMedia) {
          if (localMedia.kind === 'video') {
            ffmpegArgs.push('-stream_loop', '-1', '-t', String(slotDur), '-i', localMedia.path);
          } else {
            ffmpegArgs.push('-loop', '1', '-t', String(slotDur), '-i', localMedia.path);
          }
        } else if (fallbackImg) {
          ffmpegArgs.push('-loop', '1', '-t', String(slotDur), '-i', fallbackImg);
        } else {
          ffmpegArgs.push('-f', 'lavfi', '-t', String(slotDur), '-i', 'color=c=#0a0f18:s=1080x1920:r=30');
        }

        ffmpegArgs.push(
          '-an',
          '-vf',
          'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-crf',
          '21',
          segPath,
        );

        try {
          await execFileAsync('ffmpeg', ffmpegArgs, { timeout: 30_000 });
        } catch {
          // Fallback para cenário padrão se uma imagem/vídeo remoto vier corrompido
          const fallbackArgs = [
            '-y',
            ...(fallbackImg
              ? ['-loop', '1', '-t', String(slotDur), '-i', fallbackImg]
              : ['-f', 'lavfi', '-t', String(slotDur), '-i', 'color=c=#0a0f18:s=1080x1920:r=30']),
            '-an',
            '-vf',
            'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p',
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            '-crf',
            '21',
            segPath,
          ];
          await execFileAsync('ffmpeg', fallbackArgs, { timeout: 25_000 });
        }

        segmentFiles.push(segName);
      }
    }

    const concatList = segmentFiles.map((f) => `file '${f}'`).join('\n');
    await writeFile(join(workDir, 'concat.txt'), concatList, 'utf8');
    await writeFile(join(workDir, 'legendas.srt'), params.srtContent.normalize('NFC'), 'utf8');

    let hasCustomAudio = false;
    if (params.audioBase64) {
      const cleanB64 = params.audioBase64.replace(/^data:[^;]+;base64,/, '').trim();
      const audioBuf = Buffer.from(cleanB64, 'base64');
      if (audioBuf.length > 0 && audioBuf.length <= MAX_AUDIO_BYTES) {
        await writeFile(join(workDir, 'narracao.audio'), audioBuf);
        hasCustomAudio = true;
      }
    }

    const finalArgs = [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      'concat.txt',
      ...(hasCustomAudio
        ? ['-i', 'narracao.audio']
        : ['-f', 'lavfi', '-t', String(Math.max(2, totalDuration)), '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100']),
      '-vf',
      "subtitles=legendas.srt:force_style='Alignment=2,MarginV=75,FontSize=13,BorderStyle=4,Outline=1,Shadow=0,BackColour=&H99000000'",
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-shortest',
      '-movflags',
      '+faststart',
      'short_final_9x16.mp4',
    ];

    await execFileAsync('ffmpeg', finalArgs, { cwd: workDir, timeout: 90_000 });
    return await readFile(join(workDir, 'short_final_9x16.mp4'));
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
