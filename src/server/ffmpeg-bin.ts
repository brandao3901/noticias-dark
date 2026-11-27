import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Caminho do FFmpeg/FFprobe.
 *
 * No app instalado/portátil os binários viajam junto (`resources/ffmpeg`), e o
 * Electron exporta `FFMPEG_BIN`/`FFPROBE_BIN`. Sem isso, cai no PATH do sistema
 * — que é o caso de quem usa `npm run app` ou o modo desenvolvimento.
 */

function fromEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value && existsSync(value) ? value : null;
}

function besideApp(name: string): string | null {
  const candidates = [
    join(process.cwd(), 'build', 'portable', 'ffmpeg', name),
    join(process.cwd(), 'resources', 'ffmpeg', name),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function ffmpegBin(): string {
  return fromEnv('FFMPEG_BIN') ?? besideApp('ffmpeg.exe') ?? 'ffmpeg';
}

export function ffprobeBin(): string {
  return fromEnv('FFPROBE_BIN') ?? besideApp('ffprobe.exe') ?? 'ffprobe';
}

/** true quando o FFmpeg empacotado foi encontrado (usado nos avisos de diagnóstico). */
export function ffmpegBundled(): boolean {
  return Boolean(fromEnv('FFMPEG_BIN') ?? besideApp('ffmpeg.exe'));
}
