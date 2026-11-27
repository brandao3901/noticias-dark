import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Resvg } from '@resvg/resvg-js';
import type { AvatarExpression } from './avatar-svg';
import { buildAvatarSvg } from './avatar-svg';
import { ffmpegBin, ffprobeBin } from './ffmpeg-bin';

const execFileAsync = promisify(execFile);

/** Niveis de abertura de boca: 8 quadros bastam para uma leitura natural. */
export const JAW_LEVELS = 8;

/** Largura de rasterizacao do avatar (o overlay escala para o tamanho final). */
const RASTER_WIDTH = 600;

export interface AvatarFrameState {
  expression: AvatarExpression;
  level: number;
  /** PiP usa cartao arredondado; full usa a figura solta; desk é a bancada. */
  mode?: 'full' | 'pip' | 'desk';
}

export interface AvatarOverlayResult {
  videoPath: string;
  frames: number;
}

function frameKey(state: AvatarFrameState): string {
  const mode = state.mode === 'pip' ? 'pip' : state.mode === 'desk' ? 'desk' : 'full';
  return `${mode}_${state.expression}_${String(state.level).padStart(2, '0')}`;
}

/**
 * Gera um video com canal alfa (PNG em MOV) em que cada quadro mostra o avatar
 * com a boca na altura calculada a partir do envelope de audio. Esse video e
 * sobreposto ao material no passe final, respeitando o modo de cada cena.
 */
export async function buildAvatarOverlay(params: {
  workDir: string;
  fps: number;
  frames: AvatarFrameState[];
}): Promise<AvatarOverlayResult | null> {
  const totalFrames = params.frames.length;
  if (!totalFrames) return null;

  const pngDir = join(params.workDir, 'avatar');
  await mkdir(pngDir, { recursive: true });

  const unique = new Map<string, AvatarFrameState>();
  for (const frame of params.frames) unique.set(frameKey(frame), frame);

  for (const [key, state] of unique) {
    const svg = buildAvatarSvg({
      jawOpen: state.level / (JAW_LEVELS - 1),
      expression: state.expression,
      framed: state.mode === 'pip',
      // Bancada: base esmaecida para o busto entrar atrás da mesa.
      fadeBottom: state.mode === 'desk',
    });
    const png = new Resvg(svg, {
      fitTo: { mode: 'width', value: RASTER_WIDTH },
      background: 'rgba(0,0,0,0)',
    })
      .render()
      .asPng();
    await writeFile(join(pngDir, `${key}.png`), png);
  }

  const frameDuration = 1 / params.fps;
  const concatLines: string[] = [];
  for (const frame of params.frames) {
    concatLines.push(`file '${frameKey(frame)}.png'`);
    concatLines.push(`duration ${frameDuration.toFixed(6)}`);
  }
  // O demuxer ignora a duracao do ultimo item; repetir estabiliza o total.
  concatLines.push(`file '${frameKey(params.frames[totalFrames - 1])}.png'`);
  await writeFile(join(pngDir, 'frames.txt'), `${concatLines.join('\n')}\n`, 'utf8');

  const videoPath = join(params.workDir, 'avatar_overlay.mov');
  await execFileAsync(
    ffmpegBin(),
    [
      '-y',
      '-v',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      join(pngDir, 'frames.txt'),
      '-frames:v',
      String(totalFrames),
      '-vf',
      `fps=${params.fps},format=rgba`,
      '-c:v',
      'png',
      '-pix_fmt',
      'rgba',
      videoPath,
    ],
    { timeout: 120_000 },
  );

  return { videoPath, frames: totalFrames };
}
