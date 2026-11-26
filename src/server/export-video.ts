import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AvatarExpression } from './avatar-svg';
import { buildAvatarOverlay, JAW_LEVELS } from './avatar-overlay';
import { buildJawEnvelope, buildNarrationTrack } from './narration';
import { WEB_USER_AGENT } from './http';
import { validateSafePublicUrl } from './ssrf-guard';
import { retimeSubtitles } from './subtitles';

const execFileAsync = promisify(execFile);

/** O video final e sempre 30 fps; o envelope da boca usa essa taxa. */
const FPS = 30;

export interface RenderSceneInput {
  durationSec: number;
  mediaItems: Array<{
    kind: 'image' | 'video';
    mediaUrl: string;
    thumbUrl: string;
  }>;
  narration?: string;
  avatarMode?: 'full' | 'pip' | 'hidden';
  avatarExpression?: AvatarExpression;
}

export interface RenderNarrationOptions {
  /** Quando true e nao ha audio importado, a fala e sintetizada no servidor. */
  enabled: boolean;
  /** Motor de voz: Gemini TTS (padrao) ou Edge neural (reserva). */
  engine?: 'gemini' | 'edge';
  voice?: string;
  /** Preset de estilo do Gemini TTS (ancora, explicativo, urgente, leve, neutro). */
  style?: string;
  rate?: number;
  /** Em falha/cota do Gemini, cai para o Edge em vez de deixar a cena muda. */
  fallbackToEdge?: boolean;
  /**
   * Piso de duracao em segundos (ex.: 60 para monetizar). Se a fala ficaria
   * mais curta, a velocidade e reduzida (Edge) ou o tempo e distribuido (Gemini).
   */
  minSeconds?: number;
}

export interface RenderResult {
  buffer: Buffer;
  durationSec: number;
  narrationRate?: number;
  narrationSeconds?: number;
  ttsEngine?: string;
  ttsVoice?: string;
  ttsModel?: string;
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

const LABEL_FONT_FILE = 'label-font.ttf';

/**
 * O filtro drawtext exige uma fonte explicita: o build do FFmpeg para Windows
 * nao traz fontconfig configurado, e sem `fontfile` o processo morre com
 * "Fontconfig error: Cannot load default config file" + 0xC0000005.
 * Ordem: variavel de ambiente, fonte empacotada no app, fontes do sistema.
 */
function resolveLabelFontPath(): string | null {
  const candidates = [
    process.env['CANAL_DARK_FONT'],
    resolve(process.cwd(), 'public/assets/fonts/canal-dark-bold.ttf'),
    resolve(process.cwd(), 'dist/canal-dark/browser/assets/fonts/canal-dark-bold.ttf'),
    'C:/Windows/Fonts/arialbd.ttf',
    'C:/Windows/Fonts/segoeuib.ttf',
    'C:/Windows/Fonts/arial.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Zoom lento (Ken Burns) sobre imagens paradas.
 *
 * Sem isso uma foto fica congelada por vários segundos e o Short parece
 * travado — o que pesa ainda mais nas cenas sem mídia, que usam o cenário do
 * estúdio. Alterna aproximação e afastamento para duas cenas seguidas não
 * repetirem o mesmo movimento.
 */
function buildKenBurnsFilter(segmentIndex: number, durationSec: number): string {
  const fps = 30;
  const frames = Math.max(2, Math.round(durationSec * fps));
  // 10% de variação de zoom ao longo da cena.
  const step = (0.1 / frames).toFixed(6);
  const zoom = segmentIndex % 2 === 0 ? `min(1+${step}*on,1.10)` : `max(1.10-${step}*on,1.0)`;

  return `,zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=${fps}`;
}

function buildSegmentFilter(motionFilter: string): string {
  return `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920${motionFilter},fps=30,format=yuv420p`;
}

/**
 * Imagem parada entra inteira sobre um fundo desfocado dela mesma.
 *
 * Recortar 9:16 direto em foto vertical/4:3 corta rosto e contexto (a foto da
 * matéria costuma ser retrato). O fundo desfocado preserva a imagem completa,
 * que é o padrão de telejornal.
 */
function buildStillFilterComplex(motionFilter: string, fadeIn: boolean): string {
  const fade = fadeIn ? ',fade=t=in:st=0:d=0.18' : '';
  return [
    '[0:v]split=2[bgs][fgs]',
    '[bgs]scale=1620:2880:force_original_aspect_ratio=increase,crop=1620:2880,gblur=sigma=42,eq=brightness=-0.06[bgb]',
    '[fgs]scale=1620:-1[fgn]',
    `[bgb][fgn]overlay=(W-w)/2:(H-h)/2:shortest=1${fade}${motionFilter},fps=30,format=yuv420p[vout]`,
  ].join(';');
}

/**
 * Texto da tarja fixa no topo do vídeo (identidade do canal).
 * Configurável por `CHANNEL_LABEL`; o padrão já é o nome do canal.
 */
export const DEFAULT_CHANNEL_LABEL = 'NOTÍCIAS NA BRASA · APRESENTADOR VIRTUAL';

export function channelLabel(): string {
  return (process.env['CHANNEL_LABEL'] ?? '').trim() || DEFAULT_CHANNEL_LABEL;
}

/** Escapa o texto para o parser de filtros do ffmpeg (drawtext). */
function escapeDrawText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\\\'")
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%')
    .replace(/,/g, '\\,');
}

/**
 * A fonte entra por caminho relativo a pasta de trabalho (workDir): o "C:" de um
 * caminho absoluto e interpretado como separador de opcoes pelo parser de filtros.
 */
function buildVideoFilter(includeLabel: boolean): string {
  const filters: string[] = [];

  if (includeLabel) {
    filters.push(
      `drawtext=fontfile=${LABEL_FONT_FILE}:text='${escapeDrawText(channelLabel())}':x=36:y=48:fontsize=22:fontcolor=white@0.85:box=1:boxcolor=black@0.5:boxborderw=6`,
    );
  }

  filters.push(
    // libass dimensiona o SRT sobre PlayResY=288: FontSize 12 e MarginV 48
    // resultam em ~80px e ~320px de margem no video 1080x1920, acima da barra
    // de interface do YouTube Shorts.
    "subtitles=legendas.srt:force_style='Alignment=2,MarginV=48,FontSize=12,BorderStyle=4,Outline=1,Shadow=0,BackColour=&H99000000'",
  );

  return filters.join(',');
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
          'User-Agent': WEB_USER_AGENT,
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
  narration?: RenderNarrationOptions;
  /** Progresso do render: etapa, percentual (0–99) e mensagem curta. */
  onProgress?: (stage: string, pct: number, message?: string) => void;
}): Promise<RenderResult> {
  if (!params.scenes.length) {
    throw new Error('Nenhuma cena disponível para renderização.');
  }

  const workDir = await mkdtemp(join(tmpdir(), 'canal-dark-mp4-'));
  const fallbackImg = resolveFallbackStudioPath();
  const downloadedCache = new Map<string, { path: string; kind: 'image' | 'video' } | null>();
  let assetCounter = 0;

  try {
    const plannedDurations = params.scenes
      .slice(0, 20)
      .map((scene) => Math.max(2, Math.min(30, Number(scene.durationSec) || 6)));

    const renderScenes = params.scenes.slice(0, 20);
    const totalSegments = renderScenes.reduce(
      (acc, scene) => acc + Math.max(1, Math.min(4, scene.mediaItems.length)),
      0,
    );

    // Narracao gerada aqui: a cena cresce para a fala caber, e a legenda e
    // retemporalizada depois para nao atrasar.
    params.onProgress?.('narracao', 3, 'Gerando a narração em pt-BR…');
    const narrationTrack =
      params.narration?.enabled && !params.audioBase64
        ? await buildNarrationTrack({
            workDir,
            scenes: renderScenes.map((scene) => ({
              durationSec: scene.durationSec,
              narration: scene.narration,
            })),
            engine: params.narration.engine,
            voice: params.narration.voice,
            style: params.narration.style,
            rate: params.narration.rate,
            targetMinSec: params.narration.minSeconds,
            fallbackToEdge: params.narration.fallbackToEdge,
            onScene: (done, total, note) => {
              params.onProgress?.(
                'narracao',
                4 + (done / Math.max(1, total)) * 24,
                `Narrando cena ${done} de ${total}${note ? ` (${note})` : ''}…`,
              );
            },
          })
        : null;

    const sceneDurations = narrationTrack ? narrationTrack.sceneDurations : plannedDurations;

    const requestedNarration = Boolean(params.narration?.enabled) && !params.audioBase64;
    const hasNarrationText = params.scenes.some((scene) => (scene.narration ?? '').trim().length > 0);
    if (requestedNarration && hasNarrationText && !narrationTrack) {
      throw new Error(
        'Não foi possível gerar a narração em pt-BR: o serviço de voz neural não respondeu. Verifique a conexão, tente de novo ou desative a narração automática.',
      );
    }

    const segmentFiles: string[] = [];
    let segIdx = 0;
    let totalDuration = 0;
    /** Cena conseguiu exibir alguma mídia? Decide se o avatar entra nela. */
    const sceneVisuals: boolean[] = new Array(plannedDurations.length).fill(false);

    for (let sceneIndex = 0; sceneIndex < plannedDurations.length; sceneIndex++) {
      const scene = params.scenes[sceneIndex];
      const sceneDur = sceneDurations[sceneIndex];
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
        if (localMedia) sceneVisuals[sceneIndex] = true;

        // Imagem parada (do acervo, da matéria ou o cenário do estúdio) recebe
        // Ken Burns e moldura desfocada; vídeo de verdade já preenche a tela.
        const isStill = localMedia ? localMedia.kind === 'image' : Boolean(fallbackImg);
        const motionFilter = isStill ? buildKenBurnsFilter(segIdx, slotDur) : '';
        // Transição curta a cada troca de imagem (o primeiro quadro do vídeo não
        // precisa: viria de preto sem motivo).
        const fadeIn = segIdx > 1;
        const segmentFilter = `${fadeIn ? 'fade=t=in:st=0:d=0.18,' : ''}${buildSegmentFilter('')}`;

        const ffmpegArgs: string[] = ['-y'];
        if (localMedia) {
          if (localMedia.kind === 'video') {
            ffmpegArgs.push('-stream_loop', '-1', '-t', String(slotDur), '-i', localMedia.path);
          } else {
            ffmpegArgs.push('-loop', '1', '-framerate', '30', '-t', String(slotDur), '-i', localMedia.path);
          }
        } else if (fallbackImg) {
          ffmpegArgs.push('-loop', '1', '-framerate', '30', '-t', String(slotDur), '-i', fallbackImg);
        } else {
          ffmpegArgs.push('-f', 'lavfi', '-t', String(slotDur), '-i', 'color=c=#0a0f18:s=1080x1920:r=30');
        }

        if (isStill) {
          ffmpegArgs.push(
            '-filter_complex',
            buildStillFilterComplex(motionFilter, fadeIn),
            '-map',
            '[vout]',
          );
        } else {
          ffmpegArgs.push('-vf', segmentFilter);
        }

        ffmpegArgs.push(
          '-an',
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
          const fallbackArgs = [
            '-y',
            ...(fallbackImg
              ? ['-loop', '1', '-framerate', '30', '-t', String(slotDur), '-i', fallbackImg]
              : ['-f', 'lavfi', '-t', String(slotDur), '-i', 'color=c=#0a0f18:s=1080x1920:r=30']),
            '-an',
            ...(fallbackImg
              ? [
                  '-filter_complex',
                  buildStillFilterComplex(buildKenBurnsFilter(segIdx, slotDur), fadeIn),
                  '-map',
                  '[vout]',
                ]
              : ['-vf', `${fadeIn ? 'fade=t=in:st=0:d=0.18,' : ''}${buildSegmentFilter('')}`]),
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

        const buildPct = 44 + (segmentFiles.length / Math.max(1, totalSegments)) * 26;
        params.onProgress?.(
          'montagem',
          buildPct,
          `Montando cena ${sceneIndex + 1} de ${plannedDurations.length}…`,
        );
      }
    }

    const concatList = segmentFiles.map((f) => `file '${f}'`).join('\n');
    await writeFile(join(workDir, 'concat.txt'), concatList, 'utf8');
    await writeFile(
      join(workDir, 'legendas.srt'),
      retimeSubtitles(params.srtContent, plannedDurations, sceneDurations).normalize('NFC'),
      'utf8',
    );

    let hasCustomAudio = false;
    if (params.audioBase64) {
      const cleanB64 = params.audioBase64.replace(/^data:[^;]+;base64,/, '').trim();
      const audioBuf = Buffer.from(cleanB64, 'base64');
      if (audioBuf.length > 0 && audioBuf.length <= MAX_AUDIO_BYTES) {
        await writeFile(join(workDir, 'narracao.audio'), audioBuf);
        hasCustomAudio = true;
      }
    }

    // O drawtext do build gyan no Windows nao tem config padrao de fontconfig e
    // derruba o processo (0xC0000005). Copiamos uma fonte para a pasta de
    // trabalho e referenciamos por caminho relativo, sem o "C:" que quebra o
    // parser de filtros.
    const labelFontSource = resolveLabelFontPath();
    let labelFontPresent = false;
    if (labelFontSource) {
      try {
        await copyFile(labelFontSource, join(workDir, LABEL_FONT_FILE));
        labelFontPresent = true;
      } catch {
        labelFontPresent = false;
      }
    }

    // Avatar: o apresentador não disputa espaço com a foto do fato.
    // Regra: cena COM imagem esconde o avatar; cena SEM imagem usa tela cheia;
    // a última cena (fechamento) mostra o apresentador em PiP quando há foto.
    type AvatarWindow = { start: number; end: number; mode: 'full' | 'pip'; expression: AvatarExpression };
    const avatarWindows: AvatarWindow[] = [];
    {
      let cursor = 0;
      const lastIndex = sceneDurations.length - 1;
      for (let i = 0; i < sceneDurations.length; i++) {
        const scene = params.scenes[i];
        const requested = scene.avatarMode ?? 'full';
        const hasVisual = sceneVisuals[i] === true;

        let mode: 'full' | 'pip' | 'hidden';
        if (requested === 'hidden') {
          mode = 'hidden';
        } else if (!hasVisual) {
          mode = 'full';
        } else if (i === lastIndex) {
          mode = 'pip';
        } else {
          mode = 'hidden';
        }

        if (mode !== 'hidden') {
          avatarWindows.push({
            start: cursor,
            end: cursor + sceneDurations[i],
            mode,
            expression: scene.avatarExpression ?? 'neutral',
          });
        }
        cursor += sceneDurations[i];
      }
    }

    let hasAvatar = false;
    if (avatarWindows.length > 0) {
      const totalFrames = Math.max(1, Math.round(totalDuration * FPS));
      const expressionAt = (t: number): AvatarExpression => {
        const win = avatarWindows.find((w) => t >= w.start && t < w.end);
        return win?.expression ?? avatarWindows[0].expression;
      };
      const modeAt = (t: number): 'full' | 'pip' => {
        const win = avatarWindows.find((w) => t >= w.start && t < w.end);
        return win?.mode ?? avatarWindows[0].mode;
      };

      let levels: number[];
      if (narrationTrack) {
        levels = buildJawEnvelope({
          pcm: narrationTrack.pcm,
          fps: FPS,
          levels: JAW_LEVELS,
          totalFrames,
        });
      } else {
        // Sem narracao: respiracao suave para o avatar nao parecer congelado.
        levels = Array.from({ length: totalFrames }, (_, frameIndex) => {
          const t = frameIndex / FPS;
          const opening = 0.12 + 0.1 * Math.sin(t * 2.2);
          return Math.max(0, Math.min(JAW_LEVELS - 1, Math.round(opening * (JAW_LEVELS - 1))));
        });
      }

      params.onProgress?.('avatar', 76, 'Montando o avatar sincronizado à fala…');
      const overlay = await buildAvatarOverlay({
        workDir,
        fps: FPS,
        frames: levels.map((level, frameIndex) => ({
          expression: expressionAt(frameIndex / FPS),
          mode: modeAt(frameIndex / FPS),
          level,
        })),
      });
      hasAvatar = Boolean(overlay);
    }

    const audioInput = narrationTrack
      ? ['-i', 'narracao.wav']
      : hasCustomAudio
        ? ['-i', 'narracao.audio']
        : [
            '-f',
            'lavfi',
            '-t',
            String(Math.max(2, totalDuration)),
            '-i',
            'anullsrc=channel_layout=stereo:sample_rate=44100',
          ];

    const buildFilterGraph = (includeLabel: boolean, includeAvatar: boolean): string => {
      const parts: string[] = [`[0:v]${buildVideoFilter(includeLabel)}[vb0]`];
      let last = 'vb0';

      if (includeAvatar && hasAvatar) {
        const fullWindows = avatarWindows.filter((w) => w.mode === 'full');
        const pipWindows = avatarWindows.filter((w) => w.mode === 'pip');
        const needsSplit = fullWindows.length > 0 && pipWindows.length > 0;

        // O FFmpeg recusa um `split` com saída não conectada: só divide o vídeo
        // do avatar quando os dois enquadramentos aparecem no mesmo vídeo.
        if (needsSplit) parts.push(`[2:v]split=2[avsrcF][avsrcP]`);

        let overlayIndex = 0;

        const addWindows = (
          windows: AvatarWindow[],
          source: string,
          scale: string,
          xExpr: string,
          yExpr: string,
        ) => {
          if (!windows.length) return;

          // Cada janela entra e sai com fade de 0,25 s: o apresentador não
          // "aparece de estalo" nem some seco quando a foto volta.
          const fadeFor = (win: AvatarWindow): string => {
            const outStart = Math.max(win.start, win.end - 0.25);
            return (
              `format=rgba,fade=t=in:st=${win.start.toFixed(3)}:d=0.25:alpha=1,` +
              `fade=t=out:st=${outStart.toFixed(3)}:d=0.25:alpha=1`
            );
          };

          const ids = windows.map((_, k) => overlayIndex + k);

          if (windows.length === 1) {
            parts.push(`[${source}]${scale},setsar=1,${fadeFor(windows[0])}[avo${ids[0]}]`);
          } else {
            parts.push(
              `[${source}]${scale},setsar=1,split=${windows.length}${ids
                .map((id) => `[avs${id}]`)
                .join('')}`,
            );
            windows.forEach((win, k) => {
              parts.push(`[avs${ids[k]}]${fadeFor(win)}[avo${ids[k]}]`);
            });
          }

          windows.forEach((win, k) => {
            const next = `vb${overlayIndex + 1}`;
            parts.push(
              `[${last}][avo${ids[k]}]overlay=x=${xExpr}:y=${yExpr}:enable='between(t,${win.start.toFixed(3)},${win.end.toFixed(3)})'[${next}]`,
            );
            last = next;
            overlayIndex++;
          });
        };

        addWindows(
          fullWindows,
          needsSplit ? 'avsrcF' : '2:v',
          // 600px de largura e base 520px acima do rodape: fica acima da legenda.
          'scale=600:-1',
          '(W-w)/2',
          'H-h-520',
        );
        addWindows(pipWindows, needsSplit ? 'avsrcP' : '2:v', 'scale=430:-1', 'W-w-52', '110');
      }

      parts.push(`[${last}]format=yuv420p[vout]`);
      return parts.join(';');
    };

    const buildFinalArgs = (includeLabel: boolean, includeAvatar: boolean): string[] => [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      'concat.txt',
      ...audioInput,
      ...(includeAvatar && hasAvatar ? ['-i', 'avatar_overlay.mov'] : []),
      '-filter_complex',
      buildFilterGraph(includeLabel, includeAvatar),
      '-map',
      '[vout]',
      '-map',
      '1:a',
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
      '-ar',
      '44100',
      '-shortest',
      '-movflags',
      '+faststart',
      'short_final_9x16.mp4',
    ];

    params.onProgress?.('render', 88, 'Renderizando o vídeo final…');
    try {
      await execFileAsync('ffmpeg', buildFinalArgs(labelFontPresent, true), {
        cwd: workDir,
        timeout: 180_000,
      });
    } catch (err) {
      // Faixa e avatar sao cosmeticos: se falharem, ainda entregamos o video
      // com narracao e legenda em vez de abortar a exportacao.
      const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
      console.warn(`[export-video] passe final falhou (${detail.slice(0, 200)}); tentando sem faixa e avatar.`);
      await execFileAsync('ffmpeg', buildFinalArgs(false, false), {
        cwd: workDir,
        timeout: 180_000,
      });
    }
    return {
      buffer: await readFile(join(workDir, 'short_final_9x16.mp4')),
      durationSec: Number(totalDuration.toFixed(2)),
      narrationRate: narrationTrack?.effectiveRate,
      narrationSeconds: narrationTrack
        ? Number(narrationTrack.totalDurationSec.toFixed(2))
        : undefined,
      ttsEngine: narrationTrack?.engineUsed,
      ttsVoice: narrationTrack?.voiceUsed,
      ttsModel: narrationTrack?.ttsModel,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
