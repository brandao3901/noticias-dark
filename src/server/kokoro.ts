import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * Ponte Node → Kokoro (Python/ONNX, CPU).
 *
 * O modelo roda em processo separado (`python/tts.py`) para não prender o
 * servidor: carregar 310 MB de ONNX na mesma thread do Express travaria o app.
 * A síntese devolve WAV 24 kHz e o pipeline reamostra para 16 kHz como nos
 * outros motores.
 */

const execFileAsync = promisify(execFile);

/**
 * Raiz do projeto. O servidor SSR pode rodar com cwd diferente (dist/…), então
 * procuramos para cima a partir do cwd e do próprio módulo.
 */
function findProjectRoot(): string {
  const override = process.env['CANAL_DARK_ROOT']?.trim();
  if (override && existsSync(join(override, 'python', 'tts.py'))) return override;

  const candidates: string[] = [];
  let dir = process.cwd();
  for (let level = 0; level < 6; level += 1) {
    candidates.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try {
    let moduleDir = dirname(fileURLToPath(import.meta.url));
    for (let level = 0; level < 6; level += 1) {
      candidates.push(moduleDir);
      const parent = dirname(moduleDir);
      if (parent === moduleDir) break;
      moduleDir = parent;
    }
  } catch {
    // import.meta.url indisponível: segue só com o cwd.
  }

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'python', 'tts.py'))) return candidate;
  }
  return process.cwd();
}

const ROOT = findProjectRoot();
const PYTHON_BIN = process.env['PYTHON_BIN']?.trim() || 'python';
const TTS_SCRIPT = join(ROOT, 'python', 'tts.py');
const CONFIG_PATH = join(ROOT, 'config.json');
const MODEL_PATH = join(ROOT, 'kokoro-v1.0.onnx');
const VOICES_PATH = join(ROOT, 'voices-v1.0.bin');

export interface KokoroVoiceConfig {
  engine?: string;
  a: string;
  b: string;
  mix: number;
  speed: number;
  lang: string;
  file: string;
}

/** Voz do canal: vale para TODAS as pautas (o render segue isto). */
export interface ChannelVoice {
  engine: 'kokoro' | 'gemini' | 'edge';
  voice: string;
}

function readConfigRaw(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Leitura síncrona: `defaultTtsEngine()` roda em contexto sem await. */
export function readChannelVoiceSync(): ChannelVoice {
  const raw = readConfigRaw()['default'] as Partial<ChannelVoice> | undefined;
  const engine = raw?.engine;
  return {
    engine: engine === 'gemini' || engine === 'edge' || engine === 'kokoro' ? engine : 'kokoro',
    voice: typeof raw?.voice === 'string' && raw.voice.trim() ? raw.voice.trim() : 'blend',
  };
}

export async function writeChannelVoice(
  engine: ChannelVoice['engine'],
  voice: string,
): Promise<ChannelVoice> {
  const raw = readConfigRaw();
  const next = { ...raw, default: { engine, voice } };
  await writeFile(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return { engine, voice };
}

/** Grava a mistura em `voz_canal.npy` + `config.json` (via Python). */
export async function saveChannelBlend(params: {
  a: string;
  b: string;
  mix: number;
  speed: number;
  lang?: string;
}): Promise<{ config: KokoroVoiceConfig; stdout: string }> {
  const script = join(ROOT, 'python', 'voice_studio.py');
  if (!existsSync(script)) throw new Error(`Script não encontrado: ${script}`);

  const { stdout } = await execFileAsync(
    PYTHON_BIN,
    [
      script,
      '--save',
      '--a',
      params.a,
      '--b',
      params.b,
      '--mix',
      String(params.mix),
      '--speed',
      String(params.speed),
      '--lang',
      params.lang ?? 'pt-br',
    ],
    { cwd: ROOT, timeout: 120_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
  );

  const line = stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value.startsWith('{'))
    .pop();
  if (!line) throw new Error('O estúdio de voz não devolveu resultado.');
  const parsed = JSON.parse(line) as { ok?: boolean; config?: KokoroVoiceConfig; message?: string };
  if (!parsed.ok || !parsed.config) throw new Error(parsed.message ?? 'Falha ao salvar a voz.');
  return { config: parsed.config, stdout };
}

/** Prévia de uma mistura qualquer, sem gravar nada. */
export async function previewChannelBlend(params: {
  a: string;
  b: string;
  mix: number;
  speed: number;
  text?: string;
  lang?: string;
}): Promise<Buffer> {
  const script = join(ROOT, 'python', 'voice_studio.py');
  if (!existsSync(script)) throw new Error(`Script não encontrado: ${script}`);
  if (!kokoroModelsReady()) {
    throw new Error('Kokoro indisponível: rode python python/download_models.py.');
  }

  const outPath = join(ROOT, 'build', `preview-${Date.now()}.wav`);
  await mkdir(join(ROOT, 'build'), { recursive: true });

  const args = [
    script,
    '--preview',
    '--a',
    params.a,
    '--b',
    params.b,
    '--mix',
    String(params.mix),
    '--speed',
    String(params.speed),
    '--out',
    outPath,
  ];
  if (params.text?.trim()) args.push('--text', params.text.trim().slice(0, 400));
  if (params.lang) args.push('--lang', params.lang);

  await execFileAsync(PYTHON_BIN, args, {
    cwd: ROOT,
    timeout: 180_000,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });

  const wav = await readFile(outPath);
  await rm(outPath, { force: true }).catch(() => undefined);
  return wav;
}

/** Os dois arquivos somam ~354 MB; tamanho mínimo pega download truncado. */
export function kokoroModelsReady(): boolean {
  try {
    return (
      existsSync(MODEL_PATH) &&
      statSync(MODEL_PATH).size > 300 * 1024 * 1024 &&
      existsSync(VOICES_PATH) &&
      statSync(VOICES_PATH).size > 20 * 1024 * 1024
    );
  } catch {
    return false;
  }
}

export async function readKokoroConfig(): Promise<KokoroVoiceConfig | null> {
  try {
    const raw = JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as {
      voice?: Partial<KokoroVoiceConfig>;
    };
    const voice = raw.voice;
    if (!voice?.a || !voice?.b) return null;
    return {
      engine: voice.engine ?? 'kokoro',
      a: voice.a,
      b: voice.b,
      mix: Number(voice.mix ?? 0.7),
      speed: Number(voice.speed ?? 1),
      lang: voice.lang ?? 'pt-br',
      file: voice.file ?? 'voz_canal.npy',
    };
  } catch {
    return null;
  }
}

export interface KokoroSynthesis {
  wavPath: string;
  seconds: number;
  voiceLabel: string;
  elapsedSec: number;
}

/**
 * Sintetiza um trecho em pt-BR e grava um WAV.
 * `voice` aceita nome de voz do Kokoro ou 'blend' (voz do canal).
 */
export async function synthesizeKokoroWav(params: {
  text: string;
  outDir: string;
  index: number;
  voice?: string;
  speed?: number;
  /** Mistura avulsa (prévia): sobrepõe a voz salva. */
  voiceA?: string;
  voiceB?: string;
  mix?: number;
  timeoutMs?: number;
}): Promise<KokoroSynthesis> {
  if (!kokoroModelsReady()) {
    throw new Error(
      'Kokoro indisponível: faltam kokoro-v1.0.onnx / voices-v1.0.bin (rode python python/download_models.py).',
    );
  }
  if (!existsSync(TTS_SCRIPT)) {
    throw new Error(`Script do Kokoro não encontrado em ${TTS_SCRIPT} (cwd=${process.cwd()}, raiz=${ROOT})`);
  }

  await mkdir(params.outDir, { recursive: true });
  const stamp = `${String(params.index).padStart(2, '0')}-${Date.now()}`;
  const textPath = join(params.outDir, `kokoro_${stamp}.txt`);
  const wavPath = join(params.outDir, `kokoro_${stamp}.wav`);
  await writeFile(textPath, params.text, 'utf8');

  const config = await readKokoroConfig();
  const args = [
    TTS_SCRIPT,
    '--text-file',
    textPath,
    '--out',
    wavPath,
    '--voice',
    params.voice?.trim() || 'blend',
    '--speed',
    String(params.speed ?? config?.speed ?? 1),
    '--lang',
    config?.lang ?? 'pt-br',
  ];
  if (params.voiceA && params.voiceB) {
    args.push('--voice-a', params.voiceA, '--voice-b', params.voiceB);
    if (params.mix !== undefined) args.push('--mix', String(params.mix));
  }

  try {
    const { stdout } = await execFileAsync(PYTHON_BIN, args, {
      cwd: ROOT,
      timeout: params.timeoutMs ?? 180_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });

    const line = stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter((value) => value.startsWith('{'))
      .pop();

    if (!line) throw new Error('O Kokoro não devolveu resultado (stdout vazio).');
    const parsed = JSON.parse(line) as {
      ok?: boolean;
      seconds?: number;
      voice?: string;
      elapsedSec?: number;
      message?: string;
    };
    if (!parsed.ok) {
      throw new Error(parsed.message ?? 'Falha ao sintetizar com Kokoro.');
    }

    return {
      wavPath,
      seconds: Number(parsed.seconds ?? 0),
      voiceLabel: parsed.voice ?? 'blend',
      elapsedSec: Number(parsed.elapsedSec ?? 0),
    };
  } finally {
    // O texto não precisa ficar no disco.
    await import('node:fs/promises')
      .then((fs) => fs.rm(textPath, { force: true }))
      .catch(() => undefined);
  }
}
