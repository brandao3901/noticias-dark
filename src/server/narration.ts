import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { normalizeTextForPtBrSpeech } from '../app/services/pt-br-speech';
import { activeTtsModel, synthesizeSpeechWithGemini } from './gemini';
import { kokoroModelsReady, readChannelVoiceSync, readKokoroConfig, synthesizeKokoroWav } from './kokoro';
import { projectsRoot } from './projects';
import { ffmpegBin, ffprobeBin } from './ffmpeg-bin';

const execFileAsync = promisify(execFile);

/** Taxa usada no PCM intermediario (o AAC final e reamostrado para 44.1 kHz). */
export const NARRATION_SAMPLE_RATE = 16_000;

export type TtsEngine = 'kokoro' | 'gemini' | 'edge';

export const DEFAULT_TTS_ENGINE: TtsEngine = 'gemini';

export interface TtsVoice {
  id: string;
  engine: TtsEngine;
  label: string;
  description: string;
}

/**
 * Vozes oferecidas na interface.
 *
 * Gemini TTS é o padrão (cota gratuita da mesma chave). As vozes do Edge ficam
 * como reserva: se o Gemini estourar cota ou cair, a síntese cai nelas em vez
 * de deixar o vídeo mudo.
 */
export const TTS_VOICES: TtsVoice[] = [
  { id: 'blend', engine: 'kokoro', label: 'Voz do canal', description: 'Kokoro · mistura 70/30' },
  { id: 'pm_alex', engine: 'kokoro', label: 'Alex', description: 'Kokoro · masculina' },
  { id: 'pf_dora', engine: 'kokoro', label: 'Dora', description: 'Kokoro · feminina' },
  { id: 'pm_santa', engine: 'kokoro', label: 'Santa', description: 'Kokoro · masculina' },
  { id: 'Kore', engine: 'gemini', label: 'Kore', description: 'firme, feminina' },
  { id: 'Charon', engine: 'gemini', label: 'Charon', description: 'grave, masculina' },
  { id: 'Puck', engine: 'gemini', label: 'Puck', description: 'jovem, masculina' },
  { id: 'Aoede', engine: 'gemini', label: 'Aoede', description: 'leve, feminina' },
  { id: 'Fenrir', engine: 'gemini', label: 'Fenrir', description: 'intensa, masculina' },
  { id: 'pt-BR-AntonioNeural', engine: 'edge', label: 'Antonio', description: 'Edge · reserva' },
  { id: 'pt-BR-FranciscaNeural', engine: 'edge', label: 'Francisca', description: 'Edge · reserva' },
];

/** Compatibilidade com o código/UI anterior. */
export const PT_BR_VOICES = TTS_VOICES.filter((voice) => voice.engine === 'edge').map((voice) => ({
  id: voice.id,
  label: `${voice.label} — ${voice.description}`,
}));

export type PtBrVoiceId = string;

export const DEFAULT_PT_BR_VOICE = 'pt-BR-AntonioNeural';

export const KOKORO_VOICES = TTS_VOICES.filter((voice) => voice.engine === 'kokoro');
export const GEMINI_VOICES = TTS_VOICES.filter((voice) => voice.engine === 'gemini');
export const EDGE_VOICES = TTS_VOICES.filter((voice) => voice.engine === 'edge');

export const NARRATION_STYLES = [
  { id: 'ancora', label: 'Âncora de telejornal' },
  { id: 'explicativo', label: 'Explicativo' },
  { id: 'urgente', label: 'Urgente' },
  { id: 'leve', label: 'Leve' },
  { id: 'neutro', label: 'Neutro' },
] as const;

export const DEFAULT_NARRATION_STYLE = 'ancora';

export function defaultTtsEngine(): TtsEngine {
  // A voz do canal (config.json) manda: é a escolha que vale para todas as pautas.
  const channel = readChannelVoiceSync();
  if (channel.engine === 'kokoro' && kokoroModelsReady()) return 'kokoro';
  if (channel.engine === 'gemini' && process.env['GEMINI_API_KEY']?.trim()) return 'gemini';
  if (channel.engine === 'edge') return 'edge';

  const configured = (process.env['TTS_ENGINE'] ?? '').trim().toLowerCase();
  if (configured === 'edge') return 'edge';
  if (configured === 'gemini') return 'gemini';
  // Só usa Kokoro se os modelos estiverem presentes (portátil pode não ter).
  if (configured === 'kokoro' && kokoroModelsReady()) return 'kokoro';
  // Sem escolha explícita: Kokoro se os modelos estiverem na raiz; senão o que
  // já existia (Gemini com chave ou Edge).
  if (kokoroModelsReady()) return 'kokoro';
  return process.env['GEMINI_API_KEY']?.trim() ? 'gemini' : 'edge';
}

export function isTtsEngine(value: unknown): value is TtsEngine {
  return value === 'kokoro' || value === 'gemini' || value === 'edge';
}

/**
 * Resolve o motor a partir do pedido, da voz e do ambiente. Uma voz com prefixo
 * `pt-BR-` (Edge) força o motor Edge — é o que mantém pautas antigas coerentes.
 */
export function resolveTtsEngine(requested?: unknown, voice?: string): TtsEngine {
  if (isTtsEngine(requested)) return requested;
  if (voice?.startsWith('pt-BR-')) return 'edge';
  return defaultTtsEngine();
}

export function resolveTtsVoice(engine: TtsEngine, requested?: string): TtsVoice {
  const pool =
    engine === 'kokoro' ? KOKORO_VOICES : engine === 'gemini' ? GEMINI_VOICES : EDGE_VOICES;
  const found = pool.find((voice) => voice.id === requested);
  if (found) return found;

  // Sem escolha explícita: a voz do canal (vale para todas as pautas).
  if (!requested) {
    const channel = readChannelVoiceSync();
    if (channel.engine === engine) {
      const channelVoice = pool.find((voice) => voice.id === channel.voice);
      if (channelVoice) return channelVoice;
    }
  }

  if (engine === 'kokoro') return KOKORO_VOICES[0];
  if (engine === 'gemini') {
    const fromEnv = GEMINI_VOICES.find((voice) => voice.id === process.env['GEMINI_TTS_VOICE']);
    return fromEnv ?? GEMINI_VOICES[0];
  }

  return EDGE_VOICES.find((voice) => voice.id === 'pt-BR-AntonioNeural') ?? EDGE_VOICES[0];
}

/** Converte a velocidade da interface (0.8–1.5) no formato aceito pelo Edge. */
export function toEdgeRate(rate: number | undefined): string {
  if (!rate || !Number.isFinite(rate)) return '+0%';
  const clamped = Math.max(0.6, Math.min(1.6, rate));
  const percent = Math.round((clamped - 1) * 100);
  return `${percent >= 0 ? '+' : ''}${percent}%`;
}

// ---------------------------------------------------------------------------
// Cache de áudio (evita gastar cota refazendo a mesma cena)
// ---------------------------------------------------------------------------

function ttsCacheDir(): string {
  return join(projectsRoot(), '.tts-cache');
}

function cacheKey(params: {
  engine: TtsEngine;
  voice: string;
  style: string;
  model: string;
  text: string;
}): string {
  return createHash('sha1')
    .update(`${params.engine}|${params.voice}|${params.style}|${params.model}|${params.text}`)
    .digest('hex');
}

async function readCachedPcm(key: string): Promise<Buffer | null> {
  const path = join(ttsCacheDir(), `${key}.pcm`);
  if (!existsSync(path)) return null;
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

async function writeCachedPcm(key: string, pcm: Buffer): Promise<void> {
  await mkdir(ttsCacheDir(), { recursive: true });
  await writeFile(join(ttsCacheDir(), `${key}.pcm`), pcm).catch(() => undefined);
}

/** Poda simples: mantém no máximo 200 áudios de 16 kHz. */
async function pruneCache(): Promise<void> {
  const dir = ttsCacheDir();
  if (!existsSync(dir)) return;
  try {
    const entries = await readdir(dir);
    if (entries.length <= 200) return;

    const withTime = await Promise.all(
      entries.map(async (name) => {
        const info = await stat(join(dir, name)).catch(() => null);
        return { name, time: info?.mtimeMs ?? 0 };
      }),
    );
    withTime.sort((a, b) => a.time - b.time);
    for (const entry of withTime.slice(0, withTime.length - 200)) {
      await rm(join(dir, entry.name), { force: true }).catch(() => undefined);
    }
  } catch {
    // Poda é best-effort.
  }
}

// ---------------------------------------------------------------------------
// Síntese por motor
// ---------------------------------------------------------------------------

/** Edge (reserva): MP3 24 kHz mono em disco. */
async function synthesizeEdgeMp3(params: {
  text: string;
  outDir: string;
  index: number;
  voice: string;
  rate?: number;
}): Promise<{ mp3Path: string } | null> {
  const clean = normalizeTextForPtBrSpeech(params.text ?? '');
  if (!clean || clean.replace(/[^\p{L}\p{N}]+/gu, '').length === 0) return null;

  await mkdir(params.outDir, { recursive: true });
  const baseName = `narracao_${String(params.index).padStart(2, '0')}`;
  const tts = new MsEdgeTTS();
  await tts.setMetadata(params.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

  const sceneDir = join(params.outDir, baseName);
  await mkdir(sceneDir, { recursive: true });
  await tts.toFile(sceneDir, clean);

  const buf = await readFile(join(sceneDir, 'audio.mp3'));
  if (!buf.length) return null;

  const mp3Path = join(params.outDir, `${baseName}.mp3`);
  await writeFile(mp3Path, buf);
  return { mp3Path };
}

/** Gemini TTS: PCM 24 kHz → WAV em disco (o decode para 16 kHz vem depois). */
async function synthesizeGeminiWav(params: {
  text: string;
  outDir: string;
  index: number;
  voice: string;
  style: string;
}): Promise<{ wavPath: string; model: string } | null> {
  const clean = normalizeTextForPtBrSpeech(params.text ?? '');
  if (!clean || clean.replace(/[^\p{L}\p{N}]+/gu, '').length === 0) return null;

  const speech = await synthesizeSpeechWithGemini({
    text: clean,
    voice: params.voice,
    style: params.style,
  });

  await mkdir(params.outDir, { recursive: true });
  const wavPath = join(params.outDir, `narracao_${String(params.index).padStart(2, '0')}.wav`);
  await writeWav(speech.pcm, wavPath, speech.sampleRate);

  return { wavPath, model: speech.model };
}

/**
 * Decodifica um arquivo de audio em PCM 16 bits mono. Grava em disco em vez de
 * capturar stdout: assim funciona igual no app e em execucao restrita.
 */
export async function decodeToPcm(
  audioPath: string,
  pcmPath: string,
  sampleRate = NARRATION_SAMPLE_RATE,
): Promise<Buffer> {
  await execFileAsync(
    ffmpegBin(),
    [
      '-y',
      '-v',
      'error',
      '-i',
      audioPath,
      '-f',
      's16le',
      '-acodec',
      'pcm_s16le',
      '-ac',
      '1',
      '-ar',
      String(sampleRate),
      pcmPath,
    ],
    { timeout: 60_000 },
  );
  return readFile(pcmPath);
}

/** Silencio em PCM 16 bits mono. */
export function silencePcm(seconds: number, sampleRate = NARRATION_SAMPLE_RATE): Buffer {
  const bytes = Math.max(0, Math.round(seconds * sampleRate)) * 2;
  return Buffer.alloc(bytes);
}

/** Respiro entre cenas: o suficiente para não colar a fala, sem dead air. */
export const NARRATION_BREATH_SEC = Math.max(
  0.05,
  Math.min(0.5, Number(process.env['NARRATION_BREATH_SEC']) || 0.15),
);

/** Nenhuma cena fica menor que isso, mesmo com fala de 2 palavras. */
const MIN_SCENE_SEC = 1.2;

/** Pausa máxima aceitável dentro de um clipe (ponto final do TTS). */
export const NARRATION_MAX_PAUSE_SEC = Math.max(
  0.15,
  Math.min(1, Number(process.env['NARRATION_MAX_PAUSE_SEC']) || 0.3),
);

/**
 * Comprime pausas internas longas (o TTS respira ~0,9 s no ponto final).
 *
 * Uma pausa de quase 1 s no meio da narração é o que faz o espectador rolar o
 * feed. Aqui qualquer silêncio interno maior que `maxPauseSec` é encurtado.
 */
export function compressInternalSilence(
  pcm: Buffer,
  sampleRate = NARRATION_SAMPLE_RATE,
  maxPauseSec = NARRATION_MAX_PAUSE_SEC,
): Buffer {
  if (process.env['NARRATION_COMPRESS_PAUSES'] === '0') return pcm;

  const threshold = 0.008;
  const windowSize = Math.max(1, Math.round(sampleRate * 0.01));
  const maxSilenceSamples = Math.round(maxPauseSec * sampleRate);
  const totalSamples = Math.floor(pcm.length / 2);
  if (totalSamples < windowSize * 8) return pcm;

  const rmsAt = (startSample: number): number => {
    const end = Math.min(totalSamples, startSample + windowSize);
    let sum = 0;
    for (let i = startSample; i < end; i += 1) {
      const value = pcm.readInt16LE(i * 2) / 32768;
      sum += value * value;
    }
    return Math.sqrt(sum / Math.max(1, end - startSample));
  };

  const chunks: Buffer[] = [];
  let cursor = 0;
  let silentStart = -1;

  for (let start = 0; start + windowSize <= totalSamples; start += windowSize) {
    const isSilent = rmsAt(start) < threshold;
    if (isSilent && silentStart < 0) {
      silentStart = start;
    } else if (!isSilent && silentStart >= 0) {
      const runSamples = start - silentStart;
      // Fala antes do silêncio.
      if (silentStart > cursor) {
        chunks.push(pcm.subarray(cursor * 2, silentStart * 2));
      }
      // Silêncio: encurta só o que passar do máximo.
      const keep = Math.min(runSamples, maxSilenceSamples);
      chunks.push(Buffer.alloc(keep * 2));
      cursor = start;
      silentStart = -1;
    }
  }

  if (cursor < totalSamples) chunks.push(pcm.subarray(cursor * 2));
  const result = Buffer.concat(chunks);
  // Compressão agressiva demais indica detecção errada: mantém o original.
  return result.length > pcm.length * 0.25 ? result : pcm;
}

/**
 * Apara silêncio no começo e no fim de um clipe de fala.
 *
 * O TTS devolve ~1 s de silêncio em cada ponta; sem aparar, essa sobra vira
 * pausa entre parágrafos — foi a maior causa do "pula vídeo".
 */
export function trimSilence(
  pcm: Buffer,
  sampleRate = NARRATION_SAMPLE_RATE,
  options: { threshold?: number; marginSec?: number } = {},
): Buffer {
  if (process.env['NARRATION_TRIM'] === '0') return pcm;

  const threshold = options.threshold ?? 0.008;
  const margin = Math.round(sampleRate * (options.marginSec ?? 0.06));
  const windowSize = Math.max(1, Math.round(sampleRate * 0.01));
  const totalSamples = Math.floor(pcm.length / 2);
  if (totalSamples < windowSize * 4) return pcm;

  const rmsAt = (startSample: number): number => {
    const end = Math.min(totalSamples, startSample + windowSize);
    let sum = 0;
    for (let i = startSample; i < end; i += 1) {
      const value = pcm.readInt16LE(i * 2) / 32768;
      sum += value * value;
    }
    return Math.sqrt(sum / Math.max(1, end - startSample));
  };

  let firstLoud = -1;
  for (let start = 0; start + windowSize <= totalSamples; start += windowSize) {
    if (rmsAt(start) >= threshold) {
      firstLoud = start;
      break;
    }
  }

  let lastLoud = -1;
  for (let start = totalSamples - windowSize; start >= 0; start -= windowSize) {
    if (rmsAt(start) >= threshold) {
      lastLoud = start + windowSize;
      break;
    }
  }

  // Clipe inteiro "silencioso" ou deteccao suspeita: nao mexe.
  if (firstLoud < 0 || lastLoud <= firstLoud) return pcm;

  const startSample = Math.max(0, firstLoud - margin);
  const endSample = Math.min(totalSamples, lastLoud + margin);
  if (endSample - startSample < windowSize * 4) return pcm;

  return pcm.subarray(startSample * 2, endSample * 2);
}

/** WAV PCM 16 bits mono a partir de PCM cru. */
export async function writeWav(pcm: Buffer, path: string, sampleRate = NARRATION_SAMPLE_RATE): Promise<void> {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // tamanho do bloco fmt
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits por amostra
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  await writeFile(path, Buffer.concat([header, pcm]));
}

/**
 * Nivel de abertura de boca por quadro de video, derivado do envelope de audio.
 * Mesma nocao da previa no navegador (RMS), quantizada para o avatar.
 */
export function buildJawEnvelope(params: {
  pcm: Buffer;
  fps: number;
  levels: number;
  totalFrames: number;
  sampleRate?: number;
}): number[] {
  const sampleRate = params.sampleRate ?? NARRATION_SAMPLE_RATE;
  const samplesPerFrame = Math.max(1, Math.round(sampleRate / params.fps));
  const totalSamples = Math.floor(params.pcm.length / 2);
  const levels = Math.max(2, params.levels);

  const raw: number[] = [];
  for (let frame = 0; frame < params.totalFrames; frame++) {
    const start = frame * samplesPerFrame;
    if (start >= totalSamples) {
      raw.push(0);
      continue;
    }
    const end = Math.min(totalSamples, start + samplesPerFrame);
    let sumSq = 0;
    for (let i = start; i < end; i++) {
      const sample = params.pcm.readInt16LE(i * 2) / 32768;
      sumSq += sample * sample;
    }
    raw.push(Math.sqrt(sumSq / Math.max(1, end - start)));
  }

  // Normaliza pelo percentil alto (nao pelo maximo) para nao achatar a fala
  // por causa de um unico pico.
  const sorted = [...raw].filter((v) => v > 0).sort((a, b) => a - b);
  const reference = sorted.length ? sorted[Math.floor(sorted.length * 0.92)] : 0.12;
  const scale = reference > 0.01 ? reference : 0.12;

  // Suavizacao curta: a boca nao deve tremer quadro a quadro.
  const smoothed = raw.map((value, idx) => {
    const prev = raw[Math.max(0, idx - 1)];
    const next = raw[Math.min(raw.length - 1, idx + 1)];
    return (prev + value * 2 + next) / 4;
  });

  return smoothed.map((value) => {
    const opening = Math.min(0.95, (value / scale) * 0.62);
    const quantized = Math.round(opening * (levels - 1));
    return Math.max(0, Math.min(levels - 1, quantized));
  });
}

export interface NarrationSceneInput {
  durationSec: number;
  narration?: string;
}

export interface NarrationTrack {
  /** WAV PCM 16 bits mono pronto para o render. */
  wavPath: string;
  pcm: Buffer;
  /** Duracoes efetivas: nunca menores que a fala, para nao cortar a voz. */
  sceneDurations: number[];
  totalDurationSec: number;
  speechSeconds: number;
  failedScenes: number;
  /** Velocidade usada na sintese (pode ter sido reduzida para atingir o piso). */
  effectiveRate: number;
  /** Motor realmente usado (pode ter caido para o Edge no meio do vídeo). */
  engineUsed: TtsEngine | 'mixed';
  voiceUsed: string;
  ttsModel?: string;
  /** Cenas que caíram na reserva (Edge) por falha do motor principal. */
  fallbackScenes: number[];
  /** Motivo do primeiro fallback (para a UI e o render.json). */
  fallbackReason?: string;
}

/** Ritmo medio da voz neural em pt-BR, em palavras por segundo. */
const WORDS_PER_SECOND = 2.5;

export interface BuildNarrationParams {
  workDir: string;
  scenes: NarrationSceneInput[];
  engine?: TtsEngine;
  voice?: string;
  style?: string;
  rate?: number;
  targetMinSec?: number;
  /** Em falha/cota do Gemini, cai para o Edge em vez de deixar a cena muda. */
  fallbackToEdge?: boolean;
  /** Progresso por cena (1-based no `done`), para a barra do render. */
  onScene?: (done: number, total: number, note?: string) => void;
}

/**
 * Sintetiza a narracao de cada cena, monta uma faixa unica em PCM e devolve as
 * duracoes efetivas (a cena cresce se a fala nao couber no tempo planejado).
 * Cenas mudas ou com falha viram silencio — o render nunca aborta por TTS.
 *
 * Piso de duracao: no Edge a velocidade e reduzida; no Gemini (sem controle de
 * rate) o que sobra vira respiro distribuido entre as cenas.
 */
export async function buildNarrationTrack(params: BuildNarrationParams): Promise<NarrationTrack | null> {
  const audioDir = join(params.workDir, 'narracao');
  await mkdir(audioDir, { recursive: true });

  const engine = resolveTtsEngine(params.engine, params.voice);
  const voice = resolveTtsVoice(engine, params.voice);
  const style = (params.style ?? process.env['TTS_STYLE'] ?? DEFAULT_NARRATION_STYLE).trim();
  const model = activeTtsModel();
  const fallbackToEdge = params.fallbackToEdge !== false && engine === 'gemini';

  void pruneCache();

  const totalWords = params.scenes.reduce(
    (acc, scene) =>
      acc + (scene.narration ?? '').split(/\s+/).filter((word) => word.length > 0).length,
    0,
  );
  const estimatedSec = totalWords / WORDS_PER_SECOND;

  let effectiveRate = Math.max(0.6, Math.min(1.6, params.rate ?? 1));
  const target = Number(params.targetMinSec) || 0;
  // Só o Edge aceita controle de velocidade; no Gemini o ritmo vem do modelo.
  if (engine === 'edge' && target > 0 && estimatedSec > 0 && estimatedSec / effectiveRate < target) {
    effectiveRate = Math.max(0.8, Math.min(effectiveRate, estimatedSec / target));
  }

  const fallbackScenes: number[] = [];
  let fallbackReason: string | undefined;
  const enginesUsed = new Set<TtsEngine>();
  let ttsModel: string | undefined;

  interface Pass {
    sceneChunks: Buffer[];
    sceneDurations: number[];
    speechSeconds: number;
    failedScenes: number;
    producedAny: boolean;
  }

  const synthesizeScenePcm = async (
    index: number,
    text: string,
    rateValue: number,
  ): Promise<Buffer | null> => {
    const clean = normalizeTextForPtBrSpeech(text ?? '');
    if (!clean || clean.replace(/[^\p{L}\p{N}]+/gu, '').length === 0) return null;

    const attempt = async (which: TtsEngine): Promise<Buffer> => {
      const kokoroVoice = which === 'kokoro' ? voice.id : 'blend';
      const key = cacheKey({
        engine: which,
        voice:
          which === 'kokoro'
            ? `kokoro:${kokoroVoice}`
            : which === 'gemini'
              ? voice.id
              : 'pt-BR-AntonioNeural',
        style: which === 'gemini' ? style : '',
        model: which === 'kokoro' ? 'kokoro-onnx' : which === 'gemini' ? model : 'edge',
        text: clean,
      });

      const cached = await readCachedPcm(key);
      if (cached) return cached;

      const pcmPath = join(audioDir, `narracao_${String(index).padStart(2, '0')}_${which}.pcm`);

      if (which === 'kokoro') {
        const synthesized = await synthesizeKokoroWav({
          text: clean,
          outDir: audioDir,
          index,
          voice: kokoroVoice,
          speed: rateValue,
        });
        ttsModel = 'kokoro-onnx';
        const pcm = await decodeToPcm(synthesized.wavPath, pcmPath);
        await writeCachedPcm(key, pcm);
        return pcm;
      }

      if (which === 'gemini') {
        const synthesized = await synthesizeGeminiWav({
          text: clean,
          outDir: audioDir,
          index,
          voice: voice.id,
          style,
        });
        if (!synthesized) throw new Error('Gemini TTS não gerou áudio para esta cena.');
        ttsModel = synthesized.model;
        const pcm = await decodeToPcm(synthesized.wavPath, pcmPath);
        await writeCachedPcm(key, pcm);
        return pcm;
      }

      const edgeVoice = EDGE_VOICES.find((item) => item.id === params.voice) ?? EDGE_VOICES[0];
      const synthesized = await synthesizeEdgeMp3({
        text: clean,
        outDir: audioDir,
        index,
        voice: edgeVoice.id,
        rate: rateValue,
      });
      if (!synthesized) throw new Error('Edge TTS não gerou áudio para esta cena.');
      const pcm = await decodeToPcm(synthesized.mp3Path, pcmPath);
      await writeCachedPcm(key, pcm);
      return pcm;
    };

    if (engine === 'edge') {
      const pcm = await attempt('edge');
      enginesUsed.add('edge');
      return pcm;
    }

    if (engine === 'kokoro') {
      try {
        const pcm = await attempt('kokoro');
        enginesUsed.add('kokoro');
        return pcm;
      } catch (err) {
        fallbackReason = fallbackReason ?? (err instanceof Error ? err.message : String(err));
        console.warn('[kokoro] falhou na cena', index + 1, ':', fallbackReason);
        if (!fallbackToEdge) throw err;
        // Kokoro fora do ar (Python/modelo): cai na reserva sem deixar cena muda.
        const pcm = await attempt('edge');
        enginesUsed.add('edge');
        fallbackScenes.push(index + 1);
        return pcm;
      }
    }

    try {
      const pcm = await attempt('gemini');
      enginesUsed.add('gemini');
      return pcm;
    } catch (err) {
      if (!fallbackToEdge) throw err;
      // Cota/instabilidade do Gemini não pode deixar a cena muda.
      const pcm = await attempt('edge');
      enginesUsed.add('edge');
      fallbackScenes.push(index + 1);
      return pcm;
    }
  };

  const runPass = async (rateValue: number): Promise<Pass> => {
    const sceneChunks: Buffer[] = [];
    const sceneDurations: number[] = [];
    let speechSeconds = 0;
    let failedScenes = 0;
    let producedAny = false;

    for (let index = 0; index < params.scenes.length; index++) {
      const scene = params.scenes[index];
      const planned = Math.max(1, Number(scene.durationSec) || 4);
      let speechPcm: Buffer | null = null;

      try {
        speechPcm = await synthesizeScenePcm(index, scene.narration ?? '', rateValue);
        if (speechPcm) {
          // Tira o silêncio que o TTS põe nas pontas: ele é o grosso da pausa.
          speechPcm = compressInternalSilence(trimSilence(speechPcm));
          producedAny = true;
        }
      } catch {
        failedScenes++;
        speechPcm = null;
      }

      const speechDuration = speechPcm ? speechPcm.length / 2 / NARRATION_SAMPLE_RATE : 0;
      speechSeconds += speechDuration;

      // A cena encolhe para a fala: `planned` é alvo editorial, não piso. Sem
      // isso, uma cena de 8 s de fala ficava com 10 s de vídeo (2 s de morto).
      const effective =
        speechDuration > 0
          ? Math.max(MIN_SCENE_SEC, speechDuration + NARRATION_BREATH_SEC)
          : planned;
      sceneDurations.push(Number(effective.toFixed(3)));

      const targetBytes = Math.round(effective * NARRATION_SAMPLE_RATE) * 2;
      if (speechPcm) {
        const padding = targetBytes - speechPcm.length;
        sceneChunks.push(
          padding > 0
            ? Buffer.concat([speechPcm, silencePcm(padding / 2 / NARRATION_SAMPLE_RATE)])
            : speechPcm,
        );
      } else {
        sceneChunks.push(silencePcm(targetBytes / 2 / NARRATION_SAMPLE_RATE));
      }

      const engineNote = engine === 'gemini' && fallbackScenes.includes(index + 1) ? 'Edge' : undefined;
      params.onScene?.(index + 1, params.scenes.length, engineNote);
    }

    return { sceneChunks, sceneDurations, speechSeconds, failedScenes, producedAny };
  };

  let pass = await runPass(effectiveRate);

  // A estimativa do Edge erra por poucos por cento: mede e refaz uma vez.
  if (
    engine === 'edge' &&
    target > 0 &&
    pass.producedAny &&
    pass.speechSeconds < target - 0.5 &&
    effectiveRate > 0.8
  ) {
    const adjusted = Math.max(
      0.8,
      Math.min(effectiveRate, (effectiveRate * pass.speechSeconds) / target),
    );
    if (adjusted < effectiveRate - 0.005) {
      const second = await runPass(adjusted);
      if (second.producedAny && second.speechSeconds > pass.speechSeconds) {
        pass = second;
        effectiveRate = adjusted;
      }
    }
  }

  if (!pass.producedAny) return null;

  // Ultimo recurso para garantir o piso: distribui a diferenca como respiro
  // entre as cenas. Passar um pouco do alvo e aceitavel; ficar abaixo do minimo
  // de monetizacao, nao. O Ken Burns e o avatar continuam animando esse tempo.
  let plannedTotal = pass.sceneDurations.reduce((acc, value) => acc + value, 0);
  if (target > 0 && plannedTotal < target) {
    const gap = target - plannedTotal;
    const sceneCount = Math.max(1, pass.sceneDurations.length);

    // 1) Micro-pausas: no máximo 0,35 s por cena — imperceptível, não "pula vídeo".
    const microTotal = Math.min(gap, 0.35 * sceneCount);
    const perScene = microTotal / sceneCount;
    if (perScene > 0.01) {
      const pad = silencePcm(perScene);
      pass.sceneChunks = pass.sceneChunks.map((chunk) => Buffer.concat([chunk, pad]));
      pass.sceneDurations = pass.sceneDurations.map((value) =>
        Number((value + perScene).toFixed(3)),
      );
    }

    // 2) O que sobra vai no FIM (o card de fechamento cobre na tela), nunca
    //    como silêncio no meio da narrativa.
    const tail = gap - microTotal;
    if (tail > 0.01) {
      const last = pass.sceneDurations.length - 1;
      pass.sceneChunks[last] = Buffer.concat([pass.sceneChunks[last], silencePcm(tail)]);
      pass.sceneDurations[last] = Number((pass.sceneDurations[last] + tail).toFixed(3));
    }

    plannedTotal += gap;
  }

  const pcm = Buffer.concat(pass.sceneChunks);
  const wavPath = join(params.workDir, 'narracao.wav');
  await writeWav(pcm, wavPath);

  const engineUsed: NarrationTrack['engineUsed'] =
    enginesUsed.size > 1
      ? 'mixed'
      : enginesUsed.has('kokoro')
        ? 'kokoro'
        : enginesUsed.has('gemini')
          ? 'gemini'
          : 'edge';

  return {
    wavPath,
    pcm,
    sceneDurations: pass.sceneDurations,
    totalDurationSec: pcm.length / 2 / NARRATION_SAMPLE_RATE,
    speechSeconds: pass.speechSeconds,
    failedScenes: pass.failedScenes,
    effectiveRate: Number(effectiveRate.toFixed(3)),
    engineUsed,
    voiceUsed: voice.id,
    ttsModel: ttsModel ?? (engine === 'gemini' ? model : undefined),
    fallbackScenes,
    fallbackReason,
  };
}

// ---------------------------------------------------------------------------
// Amostra de voz para a interface ("Ouvir amostra")
// ---------------------------------------------------------------------------

const PREVIEW_TEXT =
  'Esta é uma amostra da voz do Canal Dark. O comitê manteve a taxa básica de juros em quinze por cento ao ano, em decisão unânime.';

interface PreviewCacheEntry {
  at: number;
  wav: Buffer;
}
const previewCache = new Map<string, PreviewCacheEntry>();

/**
 * Amostra curta para o usuário escolher a voz antes de renderizar.
 * Devolve WAV 16 bits mono; o navegador toca direto.
 */
export async function synthesizeVoicePreview(params: {
  engine?: TtsEngine;
  voice?: string;
  style?: string;
}): Promise<{ wav: Buffer; engine: TtsEngine; voice: string; model?: string }> {
  const engine = resolveTtsEngine(params.engine, params.voice);
  const voice = resolveTtsVoice(engine, params.voice);
  const style = (params.style ?? DEFAULT_NARRATION_STYLE).trim();
  const cacheKeyValue = `${engine}|${voice.id}|${style}`;

  const cached = previewCache.get(cacheKeyValue);
  if (cached && Date.now() - cached.at < 10 * 60_000) {
    return { wav: cached.wav, engine, voice: voice.id };
  }

  let pcm: Buffer;
  let model: string | undefined;

  if (engine === 'kokoro') {
    // Amostra com a mesma voz do render (inclui a mistura salva em voz_canal.npy).
    const tmpDir = join(projectsRoot(), '.preview');
    const synthesized = await synthesizeKokoroWav({
      text: PREVIEW_TEXT,
      outDir: tmpDir,
      index: 99,
      voice: voice.id,
      speed: 1,
    });
    model = 'kokoro-onnx';
    pcm = await decodeToPcm(synthesized.wavPath, join(tmpDir, 'preview-kokoro.pcm'));

    const kokoroHeader = Buffer.alloc(44);
    kokoroHeader.write('RIFF', 0, 'ascii');
    kokoroHeader.writeUInt32LE(36 + pcm.length, 4);
    kokoroHeader.write('WAVE', 8, 'ascii');
    kokoroHeader.write('fmt ', 12, 'ascii');
    kokoroHeader.writeUInt32LE(16, 16);
    kokoroHeader.writeUInt16LE(1, 20);
    kokoroHeader.writeUInt16LE(1, 22);
    kokoroHeader.writeUInt32LE(NARRATION_SAMPLE_RATE, 24);
    kokoroHeader.writeUInt32LE(NARRATION_SAMPLE_RATE * 2, 28);
    kokoroHeader.writeUInt16LE(2, 32);
    kokoroHeader.writeUInt16LE(16, 34);
    kokoroHeader.write('data', 36, 'ascii');
    kokoroHeader.writeUInt32LE(pcm.length, 40);

    const wav = Buffer.concat([kokoroHeader, pcm]);
    previewCache.set(cacheKeyValue, { wav, at: Date.now() });
    return { wav, engine, voice: voice.id, model };
  }

  if (engine === 'gemini') {
    const speech = await synthesizeSpeechWithGemini({
      text: PREVIEW_TEXT,
      voice: voice.id,
      style,
      timeoutMs: 90_000,
    });
    model = speech.model;
    // WAV na taxa nativa do modelo (24 kHz) — menor e sem reamostragem extra.
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + speech.pcm.length, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(speech.sampleRate, 24);
    header.writeUInt32LE(speech.sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(speech.pcm.length, 40);
    const wav = Buffer.concat([header, speech.pcm]);
    previewCache.set(cacheKeyValue, { at: Date.now(), wav });
    return { wav, engine, voice: voice.id, model };
  }

  const tmpDir = join(projectsRoot(), '.tts-cache');
  await mkdir(tmpDir, { recursive: true });
  const synthesized = await synthesizeEdgeMp3({
    text: PREVIEW_TEXT,
    outDir: tmpDir,
    index: 99,
    voice: voice.id,
    rate: 1,
  });
  if (!synthesized) throw new Error('Não foi possível gerar a amostra de voz.');
  pcm = await decodeToPcm(synthesized.mp3Path, join(tmpDir, 'preview.pcm'));

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(NARRATION_SAMPLE_RATE, 24);
  header.writeUInt32LE(NARRATION_SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  const wav = Buffer.concat([header, pcm]);
  previewCache.set(cacheKeyValue, { at: Date.now(), wav });
  return { wav, engine, voice: voice.id };
}
