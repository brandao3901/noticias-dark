import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { PautaRecord } from '../app/models/studio.models';

const execFileAsync = promisify(execFile);

/**
 * Cada pauta vira um diretório com o pacote completo de entrega (spec §4.12):
 * vídeo, thumbnail, roteiro, legendas, manifesto de direitos e relatório de QC.
 *
 * Fica fora do banco de propósito: o pacote precisa sobreviver ao app, ser
 * copiável para o YouTube e auditável sem ferramenta nenhuma.
 */
export function projectsRoot(): string {
  return process.env['CANAL_DARK_PROJECTS_DIR']?.trim() || resolve(process.cwd(), 'projects');
}

/** Ids vêm do cliente: só aceitamos o formato gerado pelo app (sem path traversal). */
export function sanitizeProjectId(raw: string): string | null {
  const value = (raw ?? '').trim();
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(value)) return null;
  return value;
}

export function projectDir(id: string): string {
  return join(projectsRoot(), id);
}

export interface ProjectSummary {
  id: string;
  title: string;
  stage: string;
  editorial: string;
  updatedAt: string;
  hasVideo: boolean;
  hasThumbnail: boolean;
  videoSeconds?: number;
}

export interface RenderArtifactsInput {
  video: Buffer;
  srtContent: string;
  vttContent: string;
  scriptText: string;
  manifestJson: string;
  qcReport?: unknown;
  durationSec: number;
  narrationRate?: number;
  /** Motor e voz usados na narração (Gemini TTS / Edge). */
  tts?: { engine?: string; voice?: string; model?: string };
}

export interface RenderArtifactsResult {
  dir: string;
  videoPath: string;
  thumbnailPath: string | null;
  files: string[];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function readProject(id: string): Promise<PautaRecord | null> {
  try {
    const raw = await readFile(join(projectDir(id), 'project.json'), 'utf8');
    return JSON.parse(raw) as PautaRecord;
  } catch {
    return null;
  }
}

export async function writeProject(id: string, project: PautaRecord): Promise<void> {
  const dir = projectDir(id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'project.json'), JSON.stringify(project, null, 2), 'utf8');
}

export async function deleteProject(id: string): Promise<boolean> {
  const dir = projectDir(id);
  if (!existsSync(dir)) return false;
  await rm(dir, { recursive: true, force: true });
  return true;
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const root = projectsRoot();
  if (!existsSync(root)) return [];

  const entries = await readdir(root, { withFileTypes: true });
  const summaries: ProjectSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = sanitizeProjectId(entry.name);
    if (!id) continue;

    const project = await readProject(id);
    if (!project) continue;

    const dir = projectDir(id);
    const hasVideo = await pathExists(join(dir, 'video.mp4'));
    const hasThumbnail = await pathExists(join(dir, 'thumbnail.jpg'));
    let videoSeconds: number | undefined;

    if (hasVideo) {
      try {
        const meta = JSON.parse(await readFile(join(dir, 'render.json'), 'utf8')) as {
          durationSec?: number;
        };
        videoSeconds = meta.durationSec;
      } catch {
        videoSeconds = undefined;
      }
    }

    summaries.push({
      id,
      title: project.title,
      stage: project.stage,
      editorial: project.editorial,
      updatedAt: project.updatedAt,
      hasVideo,
      hasThumbnail,
      videoSeconds,
    });
  }

  summaries.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return summaries;
}

/** Gera a capa a partir do próprio vídeo (frame em ~1 s). */
async function extractThumbnail(videoPath: string, thumbnailPath: string): Promise<boolean> {
  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-v',
        'error',
        '-ss',
        '1',
        '-i',
        videoPath,
        '-frames:v',
        '1',
        '-vf',
        'scale=540:960',
        '-q:v',
        '3',
        thumbnailPath,
      ],
      { timeout: 30_000 },
    );
    return existsSync(thumbnailPath);
  } catch {
    return false;
  }
}

/**
 * Grava o pacote completo da pauta. O vídeo entra por último (arquivo grande):
 * se algo falhar antes, não fica um MP4 sem legendas nem manifesto.
 */
export async function saveRenderArtifacts(
  id: string,
  input: RenderArtifactsInput,
): Promise<RenderArtifactsResult> {
  const dir = projectDir(id);
  await mkdir(dir, { recursive: true });

  await writeFile(join(dir, 'legendas.srt'), input.srtContent.normalize('NFC'), 'utf8');
  await writeFile(join(dir, 'legendas.vtt'), input.vttContent.normalize('NFC'), 'utf8');
  await writeFile(join(dir, 'roteiro.txt'), input.scriptText.normalize('NFC'), 'utf8');
  await writeFile(join(dir, 'manifesto-direitos.json'), input.manifestJson, 'utf8');
  await writeFile(
    join(dir, 'render.json'),
    JSON.stringify(
      {
        durationSec: input.durationSec,
        narrationRate: input.narrationRate ?? null,
        tts: input.tts ?? null,
        renderedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );
  if (input.qcReport) {
    await writeFile(
      join(dir, 'qc-report.json'),
      JSON.stringify(input.qcReport, null, 2),
      'utf8',
    );
  }

  const videoPath = join(dir, 'video.mp4');
  await writeFile(videoPath, input.video);

  const thumbnailPath = join(dir, 'thumbnail.jpg');
  const thumbnailOk = await extractThumbnail(videoPath, thumbnailPath);

  return {
    dir,
    videoPath,
    thumbnailPath: thumbnailOk ? thumbnailPath : null,
    files: [
      'video.mp4',
      ...(thumbnailOk ? ['thumbnail.jpg'] : []),
      'legendas.srt',
      'legendas.vtt',
      'roteiro.txt',
      'manifesto-direitos.json',
      'render.json',
      ...(input.qcReport ? ['qc-report.json'] : []),
    ],
  };
}

/** Arquivos que podem ser servidos (evita expor o diretório inteiro). */
export const SERVABLE_FILES = new Set([
  'video.mp4',
  'thumbnail.jpg',
  'legendas.srt',
  'legendas.vtt',
  'roteiro.txt',
  'manifesto-direitos.json',
  'render.json',
  'qc-report.json',
  'publish.json',
  'project.json',
]);

export function filePath(id: string, name: string): string | null {
  if (!SERVABLE_FILES.has(name)) return null;
  return join(projectDir(id), name);
}
