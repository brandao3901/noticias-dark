import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MediaAsset, RadarPersonality } from '../app/models/studio.models';
import { projectsRoot } from './projects';

/**
 * Imagens ilustrativas geradas por IA — de graça.
 *
 * Dois modos, escolhidos por `IMAGE_AI`:
 *  - `cloud`  (padrão): API pública sem chave (Pollinations), ~5–8 s por imagem.
 *  - `native`: modelo de difusão local (CPU), ~30–60 s por imagem, sem internet.
 *  - `off`:     não gera nada.
 *
 * Regra editorial: é **ilustração**, nunca "a foto do fato". Por isso o asset sai
 * com `isIllustrative: true`, crédito explícito e nunca usa nome de pessoa real no
 * prompt (para não inventar rosto de alguém).
 */

export type ImageAiMode = 'off' | 'cloud' | 'native';

export function imageAiMode(): ImageAiMode {
  const raw = (process.env['IMAGE_AI'] ?? 'native').trim().toLowerCase();
  return raw === 'off' || raw === 'native' ? raw : 'cloud';
}

const STYLE_BY_PERSONALITY: Record<RadarPersonality, string> = {
  documentario: 'cinematic documentary photograph, natural light, shallow depth of field, realistic',
  misterioso: 'moody low-key cinematic still, dramatic shadows, realistic',
  impactante: 'bold editorial photograph, high contrast, dramatic light, realistic',
  explicativo: 'clean editorial illustration, soft light, simple composition',
  jornalistico: 'photojournalistic scene, natural daylight, realistic',
};

const DEFAULT_STYLE = 'cinematic editorial photograph, natural light, realistic';

const STOPWORDS = new Set([
  'a', 'o', 'as', 'os', 'um', 'uma', 'de', 'da', 'do', 'das', 'dos', 'em', 'no', 'na', 'nos', 'nas',
  'para', 'por', 'com', 'que', 'e', 'é', 'sobre', 'como', 'mais', 'menos', 'já', 'não', 'se', 'ao',
  'aos', 'à', 'às', 'pelo', 'pela', 'the', 'of', 'and', 'to', 'in', 'on', 'for', 'with', 'this',
]);

/**
 * Monta o prompt em inglês a partir da cena.
 *
 * Nomes próprios (palavras capitalizadas fora do início da frase) são removidos:
 * gerar o rosto de uma pessoa real seria inventar prova, não ilustrar.
 */
export function buildIllustrationPrompt(params: {
  narration: string;
  title?: string;
  editorial?: string;
  personality?: RadarPersonality;
}): string {
  // A imagem nasce da FALA da cena: é o que o espectador está ouvindo naquele
  // momento. O título da matéria só entra quando a cena ainda não tem narração.
  const fala = (params.narration ?? '').trim();
  const base = fala.length >= 8 ? fala : (params.title ?? '').trim();

  // Duas primeiras frases: o resto da cena costuma repetir ou concluir.
  const source = base
    .split(/(?<=[.!?])\s+/)
    .slice(0, 2)
    .join(' ')
    .slice(0, 400);

  const semNomes = source
    .replace(/[^\p{L}\p{N}\s,]/gu, ' ')
    .split(/\s+/)
    .filter((word, index) => {
      if (!word) return false;
      const capitalized = /^[A-ZÁÉÍÓÚÂÊÔÃÕÇ]/.test(word) && index > 0;
      return !capitalized;
    })
    .filter((word) => !STOPWORDS.has(word.toLowerCase()))
    .slice(0, 20)
    .join(' ');

  const style = params.personality ? STYLE_BY_PERSONALITY[params.personality] : DEFAULT_STYLE;
  const editorial = params.editorial ? `${params.editorial.toLowerCase()} context, ` : '';

  return `${style}, ${editorial}${semNomes}, no text, no watermark, no logos, no recognizable faces`.slice(
    0,
    380,
  );
}

/**
 * Onde está o sidecar Python.
 *
 * Em desenvolvimento fica em `python/` na raiz; no pacote portátil o
 * electron-builder coloca em `resources/python` (uma pasta acima de `resources/app`).
 */
export function resolverScriptPython(nome: string): string | null {
  const candidatos = [
    process.env['CANAL_DARK_PYTHON_DIR']?.trim()
      ? join(process.env['CANAL_DARK_PYTHON_DIR'].trim(), nome)
      : null,
    join(process.cwd(), 'python', nome),
    join(process.cwd(), '..', 'python', nome),
  ].filter((item): item is string => Boolean(item));
  for (const candidato of candidatos) {
    if (existsSync(candidato)) return candidato;
  }
  return null;
}

export function aiImagesDir(): string {
  return join(projectsRoot(), '.ai-images');
}

function cachePathFor(prompt: string, seed: number, width: number, height: number): string {
  const hash = createHash('sha1').update(`${prompt}|${seed}|${width}x${height}`).digest('hex').slice(0, 16);
  return join(aiImagesDir(), `${hash}.png`);
}

async function fetchCloudImage(prompt: string, seed: number, width: number, height: number): Promise<Buffer> {
  const base = (process.env['IMAGE_AI_CLOUD'] ?? 'https://image.pollinations.ai/prompt').replace(/\/$/, '');
  const url = `${base}/${encodeURIComponent(prompt)}?width=${width}&height=${height}&nologo=true&seed=${seed}`;

  const started = Date.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!res.ok) {
    throw new Error(
      `gerador na nuvem respondeu HTTP ${res.status}. ` +
        'A API pública gratuita passou a exigir token: use IMAGE_AI=native (modelo local) ou aponte IMAGE_AI_CLOUD para um endpoint seu.'
    );
  }
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.startsWith('image/')) {
    throw new Error(`resposta inesperada do gerador (${contentType || 'sem tipo'})`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length || buffer.byteLength > 12 * 1024 * 1024) {
    throw new Error('imagem gerada vazia ou grande demais');
  }
  console.log(`[imagegen] nuvem: ${(buffer.byteLength / 1024).toFixed(0)} KB em ${Date.now() - started} ms`);
  return buffer;
}

/** Modo nativo: chama o sidecar Python (mesmo padrão do Kokoro). */
async function runNativeGenerator(
  prompt: string,
  seed: number,
  width: number,
  height: number,
  outPath: string,
): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const script = resolverScriptPython('imagegen.py');

  if (!script) {
    throw new Error('gerador nativo ausente: python/imagegen.py (instale com requirements-image.txt)');
  }

  const python = process.env['PYTHON_BIN']?.trim() || 'python';
  await execFileAsync(
    python,
    [
      script,
      '--prompt',
      prompt.slice(0, 380),
      '--out',
      outPath,
      '--seed',
      String(seed),
      '--steps',
      process.env['IMAGE_STEPS']?.trim() || '2',
      '--width',
      String(width),
      '--height',
      String(height),
    ],
    { cwd: process.cwd(), timeout: 600_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  );

  if (!existsSync(outPath)) {
    throw new Error('o gerador nativo não produziu a imagem');
  }
}

export interface GeneratedIllustration {
  buffer: Buffer;
  filePath: string;
  publicUrl: string;
  prompt: string;
  seed: number;
  provider: 'ai_cloud' | 'ai_local';
  cached: boolean;
}

/**
 * Gera (ou reaproveita do cache) uma ilustração 9:16.
 *
 * O cache é por hash de prompt+seed+tamanho: repetir a mesma cena é instantâneo.
 */
export async function generateIllustration(params: {
  prompt: string;
  seed?: number;
  width?: number;
  height?: number;
  mode?: ImageAiMode;
}): Promise<GeneratedIllustration> {
  const mode = params.mode ?? imageAiMode();
  if (mode === 'off') {
    throw new Error('Geração de imagens desligada (IMAGE_AI=off).');
  }

  const width = Math.max(512, Math.min(1080, params.width ?? 1080));
  const height = Math.max(512, Math.min(1920, params.height ?? 1920));
  const seed = params.seed ?? Math.floor(Math.random() * 1_000_000);
  const prompt = params.prompt.trim().slice(0, 380);
  if (prompt.length < 8) {
    throw new Error('Prompt curto demais para gerar imagem.');
  }

  const filePath = cachePathFor(prompt, seed, width, height);
  const publicUrl = `/api/ai-images/${filePath.split(/[\\/]/).pop()}`;

  if (existsSync(filePath)) {
    const { readFile } = await import('node:fs/promises');
    return {
      buffer: await readFile(filePath),
      filePath,
      publicUrl,
      prompt,
      seed,
      provider: mode === 'native' ? 'ai_local' : 'ai_cloud',
      cached: true,
    };
  }

  await mkdir(aiImagesDir(), { recursive: true });

  if (mode === 'native') {
    await runNativeGenerator(prompt, seed, width, height, filePath);
    const { readFile } = await import('node:fs/promises');
    return { buffer: await readFile(filePath), filePath, publicUrl, prompt, seed, provider: 'ai_local', cached: false };
  }

  const buffer = await fetchCloudImage(prompt, seed, width, height);
  await writeFile(filePath, buffer);
  return { buffer, filePath, publicUrl, prompt, seed, provider: 'ai_cloud', cached: false };
}

/** Converte a ilustração em `MediaAsset` (com crédito e marca de ilustrativa). */
export function illustrationToAsset(
  generated: GeneratedIllustration,
  title: string,
): MediaAsset {
  const localName = generated.filePath.split(/[\\/]/).pop() ?? 'ilustracao.png';
  return {
    id: `ai-${localName.replace(/\.[a-z]+$/i, '')}`,
    provider: generated.provider,
    kind: 'image',
    title: title.slice(0, 80) || 'Imagem ilustrativa',
    pageUrl: '',
    mediaUrl: generated.publicUrl,
    thumbUrl: generated.publicUrl,
    description: generated.prompt,
    author: 'Gerada por IA',
    licenseName: 'Ilustração gerada por IA (uso livre)',
    licenseUrl: '',
    attributionText: 'Imagem ilustrativa gerada por IA',
    capturedAt: new Date().toISOString(),
    isIllustrative: true,
    width: 1080,
    height: 1920,
    orientation: 'vertical',
    localPath: generated.filePath,
  };
}
