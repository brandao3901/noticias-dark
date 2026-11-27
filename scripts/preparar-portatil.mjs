import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Prepara os binários do FFmpeg para o executável portátil.
 *
 * O app precisa de ffmpeg + ffprobe em runtime. Em vez de exigir instalação no
 * PC de destino, copiamos os binários (e as DLLs do build compartilhado) para
 * `build/portable/ffmpeg`, que o electron-builder coloca em `resources/ffmpeg`.
 *
 * Uso: node scripts/preparar-portatil.mjs [caminho-do-ffmpeg.exe]
 */

const DEST = resolve('build', 'portable', 'ffmpeg');

function acharFfmpeg() {
  const arg = process.argv[2];
  if (arg && existsSync(arg)) return resolve(arg);

  if (process.env.FFMPEG_DIR && existsSync(process.env.FFMPEG_DIR)) {
    return resolve(process.env.FFMPEG_DIR, 'ffmpeg.exe');
  }

  try {
    const saida = execFileSync('where', ['ffmpeg'], { encoding: 'utf8' });
    const primeira = saida.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    if (primeira && existsSync(primeira)) return primeira;
  } catch {
    // sem ffmpeg no PATH
  }
  return null;
}

const origem = acharFfmpeg();
if (!origem) {
  console.error(
    'FFmpeg não encontrado. Instale (winget install Gyan.FFmpeg) ou passe o caminho:\n' +
      '  node scripts/preparar-portatil.mjs "C:\\caminho\\ffmpeg.exe"',
  );
  process.exit(1);
}

const pasta = dirname(origem);
mkdirSync(DEST, { recursive: true });

// ffplay não é usado pelo app; todo o resto (DLLs do build compartilhado) vai junto.
const arquivos = readdirSync(pasta).filter(
  (nome) =>
    /^ffmpeg\.exe$/i.test(nome) ||
    /^ffprobe\.exe$/i.test(nome) ||
    /\.dll$/i.test(nome),
);

let total = 0;
for (const nome of arquivos) {
  const de = join(pasta, nome);
  const para = join(DEST, nome);
  copyFileSync(de, para);
  total += statSync(para).size;
}

console.log(`FFmpeg de: ${origem}`);
console.log(`${arquivos.length} arquivo(s) copiados para ${DEST}`);
console.log(`total: ${(total / 1024 / 1024).toFixed(1)} MB`);
