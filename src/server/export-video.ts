import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AvatarExpression } from './avatar-svg';
import { buildAvatarOverlay, JAW_LEVELS } from './avatar-overlay';
import { buildJawEnvelope, buildNarrationTrack } from './narration';
import { WEB_USER_AGENT } from './http';
import { validateSafePublicUrl } from './ssrf-guard';
import { retimeSubtitles, buildKaraokeAss } from './subtitles';
import { renderDocumentPage } from './document-page';
import { renderNewsCard, buildSceneBeats } from './news-card';

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
  engine?: 'kokoro' | 'gemini' | 'edge';
  voice?: string;
  /** Preset de estilo do Gemini TTS (ancora, explicativo, urgente, leve, neutro). */
  style?: string;
  rate?: number;
  /** Em falha/cota do Gemini, cai para o Edge em vez de deixar a cena muda. */
  fallbackToEdge?: boolean;
  /** false = a pauta usa a própria voz em vez da voz do canal. */
  useChannelVoice?: boolean;
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
  /** Motivo do fallback de voz, quando houve. */
  ttsFallback?: string;
  /** Auditoria de ritmo visual (vai para o render.json). */
  dynamics?: string;
  videoMode?: 'fotos' | 'documento' | 'cards';
  cuts?: number;
  avgShotSec?: number;
  firstCutSec?: number;
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
 * Zoom lento (Ken Burns) sobre imagens paradas, com variantes de câmera.
 *
 * Sobre o tremor: `zoompan` arredonda x/y em pixels da imagem de entrada. Se o
 * movimento acontece em 1080 px, o passo de 1 px por quadro aparece como
 * "tremida". A solução é ampliar a entrada (2×) antes do zoompan: o mesmo
 * deslocamento vira meio pixel e o olho lê como movimento contínuo. As
 * transições de troca de imagem (flash/punch) continuam iguais.
 */
function buildKenBurnsFilter(
  segmentIndex: number,
  durationSec: number,
  options: { punch?: boolean } = {},
): string {
  const fps = 30;
  const frames = Math.max(2, Math.round(durationSec * fps));
  const variant = segmentIndex % 6;
  const dz = 0.10 / frames; // 10% de zoom ao longo do shot

  // `punch`: 4 quadros (≈0,13 s) começando em 1,08 e caindo para o zoom normal.
  const punch = options.punch ? 'if(lt(on,4),1.08-0.02*on,1.0)' : null;

  const zoomIn = punch ? `${punch}+${dz.toFixed(6)}*(on-4)` : `1+${dz.toFixed(6)}*on`;
  const zoomOut = punch ? `${punch}+${(1.10 + dz * frames).toFixed(6)}-${dz.toFixed(6)}*on` : `1.10-${dz.toFixed(6)}*on`;

  // Posição em fração da área disponível (0 = borda, 0.5 = centro). Sem
  // `if(eq(zoom,1))`: o salto no primeiro quadro era parte do tremor.
  const frac = (from: number, to: number): string =>
    `(${from.toFixed(3)}+(${(to - from).toFixed(3)})*on/${frames})`;
  const xAt = (from: number, to: number): string => `(iw-iw/zoom)*${frac(from, to)}`;
  const yAt = (from: number, to: number): string => `(ih-ih/zoom)*${frac(from, to)}`;
  const centered = '(iw-iw/zoom)*0.5';

  // Entrada ampliada 2×: é o que elimina o passo de 1 px (tremor).
  const upscale = ',scale=3240:5760:flags=lanczos';
  const zoompan = (z: string, x: string, y: string): string =>
    `,zoompan=z='${z}':x='${x}':y='${y}':d=1:s=1080x1920:fps=${fps}`;

  switch (variant) {
    case 1:
      // afastamento
      return `${upscale}${zoompan(zoomOut, centered, '(ih-ih/zoom)*0.5')}`;
    case 2:
      // pan esquerda -> direita
      return `${upscale}${zoompan('1.12', xAt(0.32, 0.68), '(ih-ih/zoom)*0.5')}`;
    case 3:
      // pan direita -> esquerda
      return `${upscale}${zoompan('1.12', xAt(0.68, 0.32), '(ih-ih/zoom)*0.5')}`;
    case 4:
      // diagonal (baixo-direita -> cima-esquerda)
      return `${upscale}${zoompan(zoomIn, xAt(0.38, 0.56), yAt(0.38, 0.56))}`;
    case 5:
      // diagonal oposta
      return `${upscale}${zoompan(zoomIn, xAt(0.56, 0.38), yAt(0.56, 0.38))}`;
    default:
      // aproximação central
      return `${upscale}${zoompan(zoomIn, centered, '(ih-ih/zoom)*0.5')}`;
  }
}

/** Transição de entrada do shot (assada no segmento, sem grafo extra). */
function buildTransitionFilter(type: 'cut' | 'punch' | 'flash'): string {
  if (type === 'flash') return 'fade=t=in:st=0:d=0.07:color=white,';
  return '';
}

/** Recorte "virtual" quando falta mídia: wide, médio ou detalhe. */
function cropZoomForVariant(variant: number): number {
  return variant % 3 === 0 ? 1 : variant % 3 === 1 ? 1.28 : 1.6;
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
 *
 * `cropZoom` > 1 aproxima a imagem da frente — é o que cria um "segundo shot"
 * a partir da mesma foto, sem baixar mídia nova.
 */
function buildStillFilterComplex(
  motionFilter: string,
  transition: 'cut' | 'punch' | 'flash',
  cropZoom = 1,
): string {
  const flash = transition === 'flash' ? ',fade=t=in:st=0:d=0.07:color=white' : '';
  return [
    '[0:v]split=2[bgs][fgs]',
    '[bgs]scale=1620:2880:force_original_aspect_ratio=increase,crop=1620:2880,gblur=sigma=42,eq=brightness=-0.06[bgb]',
    cropZoom > 1.01
      ? `[fgs]scale=${Math.round(1620 * cropZoom)}:-1,crop=1620:2880:(iw-1620)/2:(ih-2880)/2[fgn]`
      : '[fgs]scale=1620:-1[fgn]',
    `[bgb][fgn]overlay=(W-w)/2:(H-h)/2:shortest=1${motionFilter},fps=30,format=yuv420p${flash}[vout]`,
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

/** Quebra o texto em linhas curtas para o drawtext (que não faz wrap). */
function wrapForCard(text: string, maxChars = 24): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (`${current} ${word}`.length <= maxChars) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.join('\n');
}

/**
 * A fonte entra por caminho relativo a pasta de trabalho (workDir): o "C:" de um
 * caminho absoluto e interpretado como separador de opcoes pelo parser de filtros.
 */
function buildVideoFilter(params: {
  includeLabel: boolean;
  subtitleFile: string;
  totalDuration: number;
  captionVariant?: 'default' | 'compact' | 'cards';
}): string {
  const filters: string[] = [];

  if (params.includeLabel) {
    filters.push(
      `drawtext=fontfile=${LABEL_FONT_FILE}:text='${escapeDrawText(channelLabel())}':x=36:y=48:fontsize=22:fontcolor=white@0.85:box=1:boxcolor=black@0.5:boxborderw=6`,
    );
  }

  // Vinheta leve dá profundidade à imagem sem custo perceptível.
  filters.push('vignette=angle=PI/6');

  // Barra de progresso: o drawbox não aceita `t` na largura, então a barra é
  // desenhada em passos com `enable` (1 s cada, no máximo 60).
  const steps = Math.min(60, Math.max(10, Math.round(params.totalDuration)));
  const stepSec = Math.max(0.2, params.totalDuration / steps);
  for (let index = 0; index < steps; index += 1) {
    const width = Math.max(4, Math.round((1080 * (index + 1)) / steps));
    const from = (index * stepSec).toFixed(3);
    const to = ((index + 1) * stepSec).toFixed(3);
    filters.push(
      `drawbox=x=0:y=ih-12:w=${width}:h=12:color=0xe59a38@0.95:t=fill:enable='between(t,${from},${to})'`,
    );
  }

  if (params.subtitleFile.endsWith('.ass')) {
    filters.push('subtitles=legendas.ass');
  } else {
    // libass dimensiona o SRT sobre PlayResY=288 (1 unidade = 6,67 px em 1920).
    // - default: legenda grande de rodapé;
    // - compact: papel branco na tela, legenda menor e colada embaixo;
    // - cards:  precisa limpar a faixa inferior (180 px), então sobe.
    const styles: Record<string, string> = {
      default: 'Alignment=2,MarginV=48,FontSize=12',
      compact: 'Alignment=2,MarginV=6,FontSize=7',
      cards: 'Alignment=2,MarginV=80,FontSize=7',
    };
    const base = styles[params.captionVariant ?? 'default'] ?? styles['default'];
    filters.push(
      `subtitles=legendas.srt:force_style='${base},BorderStyle=4,Outline=1,Shadow=0,BackColour=&H99000000'`,
    );
  }

  return filters.join(',');
}

/**
 * Cards de gancho (primeiros 2 s) e de fechamento (pergunta ao público).
 * Usam `textfile` para aceitar acentos e quebras de linha sem escapar nada.
 */
function buildCardFilters(params: {
  labelFontPresent: boolean;
  headline?: string;
  closingText?: string;
  totalDuration: number;
}): string {
  if (!params.labelFontPresent) return '';
  const filters: string[] = [];

  if (params.headline?.trim()) {
    filters.push(
      `drawtext=fontfile=${LABEL_FONT_FILE}:textfile=card-titulo.txt:x=(w-text_w)/2:y=h*0.14:fontsize=54:line_spacing=14:fontcolor=white:box=1:boxcolor=black@0.68:boxborderw=26:enable='between(t,0.12,2.0)'`,
    );
  }

  if (params.closingText?.trim()) {
    const end = Math.max(3, params.totalDuration - 0.1);
    const start = Math.max(0.5, end - 2.8);
    // O CTA já entra como última linha do mesmo arquivo: um único drawtext,
    // sem risco de sobrepor a legenda ou a si mesmo.
    filters.push(
      `drawtext=fontfile=${LABEL_FONT_FILE}:textfile=card-fechamento.txt:x=(w-text_w)/2:y=h*0.10:fontsize=48:line_spacing=12:fontcolor=white:box=1:boxcolor=black@0.72:boxborderw=24:enable='between(t,${start.toFixed(2)},${end.toFixed(2)})'`,
    );
  }

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

export interface RenderSourceInput {
  id?: string;
  title: string;
  domain: string;
  url: string;
  excerpt: string;
  publishedAt?: string;
}

/**
 * Cria a pasta de trabalho do render.
 *
 * O TEMP do Windows pode estar bloqueado (política corporativa, antivírus ou
 * sandbox) e derrubar o render com EPERM. Ordem: CANAL_DARK_WORK_DIR, TEMP do
 * sistema e, por último, build/render-tmp dentro do projeto.
 */
async function createWorkDir(): Promise<string> {
  const candidates = [
    process.env['CANAL_DARK_WORK_DIR']?.trim(),
    tmpdir(),
    resolve(process.cwd(), 'build', 'render-tmp'),
  ].filter((value): value is string => Boolean(value));

  let lastError: unknown = null;
  for (const base of candidates) {
    try {
      await mkdir(base, { recursive: true });
      return await mkdtemp(join(base, 'canal-dark-mp4-'));
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `não foi possível criar a pasta de trabalho do render (TEMP bloqueado?): ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

export async function renderVerticalShortMp4(params: {
  scenes: RenderSceneInput[];
  srtContent: string;
  audioBase64?: string;
  narration?: RenderNarrationOptions;
  /** 'fotos' (padrao): Ken Burns sobre midia. 'documento': pagina da fonte com rolagem. */
  videoMode?: 'fotos' | 'documento' | 'cards';
  /** Fontes do dossie; alimentam as paginas do modo documento. */
  sources?: RenderSourceInput[];
  /** 'alta' (padrao): cortes curtos, camera variada e transicoes. */
  dynamics?: 'alta' | 'normal';
  /** Legenda queimada: karaoke (palavra a palavra) ou classica. */
  captions?: 'karaoke' | 'classica';
  /** Manchete grande nos primeiros 2 s (gancho). */
  headline?: string;
  /** Movimento da cena: 'none' (padrão) = imagem parada; 'kenburns' = zoom/pan. */
  motion?: 'none' | 'kenburns';
  /** Editoria da pauta; vira a linha fina dos cartoes. */
  editorial?: string;
  /** Pergunta de engajamento no card final. */
  closingText?: string;
  /** Progresso do render: etapa, percentual (0–99) e mensagem curta. */
  onProgress?: (stage: string, pct: number, message?: string) => void;
}): Promise<RenderResult> {
  if (!params.scenes.length) {
    throw new Error('Nenhuma cena disponível para renderização.');
  }

  const workDir = await createWorkDir();
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

    const dynamicsHigh = params.dynamics !== 'normal';
    const documentMode = params.videoMode === 'documento' && (params.sources?.length ?? 0) > 0;
    const cardsMode = params.videoMode === 'cards';
    // Cena parada (padrão): sem Ken Burns, sem flash/punch e sem rolagem.
    const motionEnabled = params.motion === 'kenburns';
    // Personagem em PiP reserva o canto direito desde o primeiro cartão.
    const avatarInVideo = params.scenes.some((scene) => (scene.avatarMode ?? 'full') !== 'hidden');
    // Em cartões/documento o topo é da manchete: o personagem vai para a área livre.
    const pipY = cardsMode || documentMode ? '980' : '96';
    const segmentFiles: string[] = [];
    let segIdx = 0;
    let totalDuration = 0;
    /** Cena conseguiu exibir alguma mídia? Decide se o avatar entra nela. */
    const sceneVisuals: boolean[] = new Array(plannedDurations.length).fill(false);
    /** Segundo em que o primeiro corte acontece (gancho precisa ser ≤ 1,5 s). */
    let firstCutSec = 0;

    // Páginas do modo documento: geradas uma vez e reaproveitadas.
    const pageCache = new Map<number, { path: string; height: number }>();
    const ensurePage = async (index: number): Promise<{ path: string; height: number } | null> => {
      const cached = pageCache.get(index);
      if (cached) return cached;

      const source = params.sources?.[index % (params.sources?.length ?? 1)];
      if (!source) return null;

      try {
        const page = renderDocumentPage({
          domain: source.domain,
          title: source.title,
          excerpt: source.excerpt,
          url: source.url,
          publishedAt: source.publishedAt,
        });
        const path = join(workDir, `pagina_${index}.png`);
        await writeFile(path, page.png);
        const entry = { path, height: page.height };
        pageCache.set(index, entry);
        return entry;
      } catch {
        return null;
      }
    };

    for (let sceneIndex = 0; sceneIndex < plannedDurations.length; sceneIndex++) {
      const scene = params.scenes[sceneIndex];
      const sceneDur = sceneDurations[sceneIndex];
      totalDuration += sceneDur;

      // Modo cartões: tipografia de impacto + cartão da matéria (sem avatar).
      if (cardsMode) {
        const source = params.sources?.length
          ? params.sources[sceneIndex % params.sources.length]
          : undefined;
        const beats = buildSceneBeats({
          narration: scene.narration ?? '',
          editorial: params.editorial ?? 'Notícia',
          domain: source?.domain,
          entity: (scene as { detectedEntities?: string[] }).detectedEntities?.[0],
        });
        // Cena parada: um cartão por cena. Com movimento, um cartão a cada ~3 s
        // (até 3), alternando tipografia e cartão.
        const maxPerScene = params.scenes.length > 10 ? 1 : 3;
        const targetBeats = motionEnabled
          ? Math.max(1, Math.min(maxPerScene, Math.round(sceneDur / 3)))
          : 1;
        const useBeats = Array.from({ length: targetBeats }, (_, index) => beats[index % beats.length] ?? beats[0] ?? {});
        const beatDur = Math.max(1.2, sceneDur / Math.max(1, useBeats.length));
        const domains = Array.from(
          new Set((params.sources ?? []).map((item) => item.domain).filter(Boolean)),
        ).slice(0, 2);
        const sourcesLine = `FONTE · ${domains.join(' · ') || 'APURAÇÃO'}`;
        const headline = (
          params.headline ??
          source?.title ??
          params.scenes[0]?.narration ??
          'NOTÍCIA'
        )
          .replace(/\s+/g, ' ')
          .slice(0, 90);

        for (let beatIndex = 0; beatIndex < useBeats.length; beatIndex++) {
          const segName = `seg_${String(segIdx++).padStart(3, '0')}.mp4`;
          const segPath = join(workDir, segName);

          try {
            const png = renderNewsCard({
              channelLabel: channelLabel(),
              beat: useBeats[beatIndex],
              source,
              headline,
              sourcesLine,
              focus: beatIndex % 2 === 0 ? 'type' : 'card',
              // Canto direito reservado ao personagem: o texto não passa por baixo.
              reserveRight: avatarInVideo ? 340 : 0,
            });
            const pngPath = join(workDir, `card_${segIdx}.png`);
            await writeFile(pngPath, png);
            await execFileAsync(
              'ffmpeg',
              [
                '-y',
                '-loop',
                '1',
                '-framerate',
                '30',
                '-t',
                String(beatDur.toFixed(3)),
                '-i',
                pngPath,
                '-an',
                '-c:v',
                'libx264',
                '-preset',
                'ultrafast',
                '-crf',
                '21',
                '-pix_fmt',
                'yuv420p',
                segPath,
              ],
              { timeout: 60_000 },
            );
            sceneVisuals[sceneIndex] = true;
          } catch {
            await execFileAsync(
              'ffmpeg',
              [
                '-y',
                '-f',
                'lavfi',
                '-t',
                String(beatDur.toFixed(3)),
                '-i',
                'color=c=#0a0d12:s=1080x1920:r=30',
                '-an',
                '-c:v',
                'libx264',
                '-preset',
                'ultrafast',
                '-crf',
                '21',
                segPath,
              ],
              { timeout: 30_000 },
            );
          }

          if (segmentFiles.length === 0) firstCutSec = beatDur;
          segmentFiles.push(segName);
          params.onProgress?.(
            'montagem',
            44 + (segmentFiles.length / Math.max(1, totalSegments)) * 26,
            `Cartão ${beatIndex + 1}/${useBeats.length} da cena ${sceneIndex + 1}…`,
          );
        }
        continue;
      }

      // Modo documento: a cena é a página da fonte com rolagem lenta.
      if (documentMode) {
        const page = await ensurePage(sceneIndex);
        const segName = `seg_${String(segIdx++).padStart(3, '0')}.mp4`;
        const segPath = join(workDir, segName);

        if (page) {
          const scrolls = page.height > 1920;
          // Cena parada: mostra a página no topo, sem rolar.
          const base = scrolls && motionEnabled
            ? `scale=1080:-1,crop=1080:1920:0:'(ih-1920)*min(t/${sceneDur.toFixed(3)},1)'`
            : scrolls
              ? 'scale=1080:-1,crop=1080:1920:0:0'
              : 'scale=1080:-1,pad=1080:1920:0:0:color=0x0a0d12';

          // Estilo documentário: respiração lenta na imagem (zoom sutil) e
          // transição de entrada/saída em preto entre uma cena e outra.
          const frames = Math.max(2, Math.round(sceneDur * 30));
          const zoom = motionEnabled
            ? `,zoompan=z='1+0.035*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30`
            : '';
          const fadeOutStart = Math.max(0, sceneDur - 0.16).toFixed(3);
          const transition = `,fade=t=in:st=0:d=0.22:color=black,fade=t=out:st=${fadeOutStart}:d=0.16:color=black`;
          const filter = `${base}${zoom},fps=30${transition}`;
          await execFileAsync(
            'ffmpeg',
            [
              '-y',
              '-loop',
              '1',
              '-framerate',
              '30',
              '-t',
              String(sceneDur),
              '-i',
              page.path,
              '-vf',
              filter,
              '-an',
              '-c:v',
              'libx264',
              '-preset',
              'ultrafast',
              '-crf',
              '21',
              '-pix_fmt',
              'yuv420p',
              segPath,
            ],
            { timeout: 60_000 },
          );
          sceneVisuals[sceneIndex] = true;
        } else {
          await execFileAsync(
            'ffmpeg',
            [
              '-y',
              '-f',
              'lavfi',
              '-t',
              String(sceneDur),
              '-i',
              'color=c=#0a0d12:s=1080x1920:r=30',
              '-an',
              '-c:v',
              'libx264',
              '-preset',
              'ultrafast',
              '-crf',
              '21',
              segPath,
            ],
            { timeout: 30_000 },
          );
        }

        if (segmentFiles.length === 0) firstCutSec = sceneDur;
        segmentFiles.push(segName);
        params.onProgress?.(
          'montagem',
          44 + (segmentFiles.length / Math.max(1, plannedDurations.length)) * 26,
          `Página ${sceneIndex + 1} de ${plannedDurations.length}…`,
        );
        continue;
      }

      const items = scene.mediaItems.slice(0, 4);
      // Shots de ~2,8 s mesmo com uma única foto: quando falta mídia, o mesmo
      // arquivo entra com recorte diferente (wide / médio / detalhe).
      const maxShotSec = dynamicsHigh ? 2.8 : 10;
      const shotCount = Math.max(1, Math.min(4, Math.ceil(sceneDur / maxShotSec)));

      const shotDurations: number[] =
        shotCount === 1
          ? [sceneDur]
          : (() => {
              // Primeiro shot curto: o primeiro corte precisa acontecer cedo.
              const first = Math.min(1.5, Math.max(1.0, sceneDur * 0.18));
              const rest = (sceneDur - first) / (shotCount - 1);
              const values = [first, ...Array.from({ length: shotCount - 1 }, () => rest)];
              const sum = values.reduce((acc, value) => acc + value, 0);
              values[values.length - 1] += sceneDur - sum;
              return values;
            })();

      for (let shotIndex = 0; shotIndex < shotDurations.length; shotIndex++) {
        const shotDur = Math.max(1.0, Number(shotDurations[shotIndex].toFixed(2)));
        const item = items.length ? items[shotIndex % items.length] : null;
        const cropVariant = items.length > 1 ? 0 : shotIndex % 3;
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

        // Com a cena parada não há flash nem punch: só corte seco entre cenas.
        const transition: 'cut' | 'punch' | 'flash' = !motionEnabled
          ? 'cut'
          : segIdx <= 1
            ? 'cut'
            : segIdx % 5 === 0
              ? 'flash'
              : segIdx % 3 === 0
                ? 'punch'
                : 'cut';

        const motionFilter =
          isStill && motionEnabled
            ? buildKenBurnsFilter(segIdx, shotDur, { punch: transition === 'punch' })
            : '';
        const segmentFilter = `${buildTransitionFilter(transition)}${buildSegmentFilter('')}`;

        const ffmpegArgs: string[] = ['-y'];
        if (localMedia) {
          if (localMedia.kind === 'video') {
            ffmpegArgs.push('-stream_loop', '-1', '-t', String(shotDur), '-i', localMedia.path);
          } else {
            ffmpegArgs.push('-loop', '1', '-framerate', '30', '-t', String(shotDur), '-i', localMedia.path);
          }
        } else if (fallbackImg) {
          ffmpegArgs.push('-loop', '1', '-framerate', '30', '-t', String(shotDur), '-i', fallbackImg);
        } else {
          ffmpegArgs.push('-f', 'lavfi', '-t', String(shotDur), '-i', 'color=c=#0a0f18:s=1080x1920:r=30');
        }

        if (isStill) {
          ffmpegArgs.push(
            '-filter_complex',
            buildStillFilterComplex(motionFilter, transition, cropZoomForVariant(cropVariant)),
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
              ? ['-loop', '1', '-framerate', '30', '-t', String(shotDur), '-i', fallbackImg]
              : ['-f', 'lavfi', '-t', String(shotDur), '-i', 'color=c=#0a0f18:s=1080x1920:r=30']),
            '-an',
            ...(fallbackImg
              ? [
                  '-filter_complex',
                  buildStillFilterComplex(
                    buildKenBurnsFilter(segIdx, shotDur, { punch: transition === 'punch' }),
                    transition,
                    1,
                  ),
                  '-map',
                  '[vout]',
                ]
              : ['-vf', segmentFilter]),
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

        if (segmentFiles.length === 0) firstCutSec = shotDur;
        segmentFiles.push(segName);

        const buildPct = 44 + (segmentFiles.length / Math.max(1, totalSegments)) * 26;
        params.onProgress?.(
          'montagem',
          buildPct,
          `Montando cena ${sceneIndex + 1} de ${plannedDurations.length} (shot ${shotIndex + 1}/${shotDurations.length})…`,
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

    // Legenda karaokê (palavra a palavra). O SRT/VTT continua no pacote e no
    // YouTube; o ASS é só o que aparece queimado no vídeo.
    const captionMode = params.captions ?? (documentMode || cardsMode ? 'classica' : 'karaoke');
    let subtitleFile = 'legendas.srt';
    if (captionMode === 'karaoke') {
      const retimedForAss = retimeSubtitles(params.srtContent, plannedDurations, sceneDurations);
      const ass = buildKaraokeAss(retimedForAss, { fontSize: 58, marginV: 250, maxWordsPerChunk: 3 });
      if (ass.includes('Dialogue:')) {
        await writeFile(join(workDir, 'legendas.ass'), ass.normalize('NFC'), 'utf8');
        subtitleFile = 'legendas.ass';
      }
    }

    // Cards: `textfile` evita escapar acento e quebra de linha no drawtext.
    if (params.headline?.trim()) {
      await writeFile(join(workDir, 'card-titulo.txt'), wrapForCard(params.headline, 22), 'utf8');
    }
    if (params.closingText?.trim()) {
      await writeFile(
        join(workDir, 'card-fechamento.txt'),
        `${wrapForCard(params.closingText, 20)}\n\nCOMENTE AQUI EMBAIXO`,
        'utf8',
      );
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
          // Sem imagem de apoio: o apresentador ocupa a tela.
          mode = 'full';
        } else {
          // Com imagem: personagem fixo no canto durante o vídeo inteiro.
          mode = 'pip';
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
      const parts: string[] = [
        `[0:v]${buildVideoFilter({ includeLabel, subtitleFile, totalDuration, captionVariant: cardsMode ? 'cards' : documentMode ? 'compact' : 'default' })}[vb0]`,
      ];
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
        addWindows(pipWindows, needsSplit ? 'avsrcP' : '2:v', 'scale=340:-1', 'W-w-36', pipY);
      }

      // Cards por cima de tudo: gancho (0–2 s) e pergunta de fechamento.
      const cards = buildCardFilters({
        labelFontPresent,
        headline: params.headline,
        closingText: params.closingText,
        totalDuration,
      });
      if (cards) {
        parts.push(`[${last}]${cards}[vcard]`);
        last = 'vcard';
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
      // Padrão de Shorts: -14 LUFS e teto de -1,5 dB. Sem isso o vídeo fica
      // 7-12 dB abaixo do que o feed entrega e parece "baixo".
      '-af',
      'loudnorm=I=-14:TP=-1.5:LRA=11',
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
      await execFileAsync('ffmpeg', buildFinalArgs(labelFontPresent && !cardsMode, true), {
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
      ttsFallback: narrationTrack?.fallbackReason,
      dynamics: dynamicsHigh ? 'alta' : 'normal',
      videoMode: cardsMode ? 'cards' : documentMode ? 'documento' : 'fotos',
      cuts: segmentFiles.length,
      avgShotSec: segmentFiles.length
        ? Number((totalDuration / segmentFiles.length).toFixed(2))
        : undefined,
      firstCutSec: Number(firstCutSec.toFixed(2)),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
