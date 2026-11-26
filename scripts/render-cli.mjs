#!/usr/bin/env node
/**
 * CLI do Canal Dark — renderiza sem abrir navegador.
 *
 * Uso:
 *   node scripts/render-cli.mjs list
 *   node scripts/render-cli.mjs render <pautaId> [--formato fotos|documento|cartoes]
 *                                     [--voz blend|pm_alex|pf_dora|pm_santa|Kore|...]
 *                                     [--motor kokoro|gemini|edge] [--abrir]
 *
 * O servidor de produção é iniciado sozinho quando a porta está livre.
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env['PORT'] || 3000);
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_ENTRY = join(ROOT, 'dist', 'canal-dark', 'server', 'server.mjs');

const COLORS = {
  dim: '\u001b[2m',
  amber: '\u001b[38;5;214m',
  green: '\u001b[32m',
  red: '\u001b[31m',
  reset: '\u001b[0m',
};

function paint(color, text) {
  return process.stdout.isTTY ? `${COLORS[color]}${text}${COLORS.reset}` : text;
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function parseArgs(argv) {
  const args = { _: [], formato: undefined, voz: undefined, motor: undefined, abrir: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    if (key === 'abrir') {
      args.abrir = true;
      continue;
    }
    const value = argv[index + 1];
    if (value && !value.startsWith('--')) {
      args[key] = value;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

async function serverOnline() {
  try {
    await api('/api/config/status');
    return true;
  } catch {
    return false;
  }
}

function buildIfNeeded() {
  if (!existsSync(SERVER_ENTRY)) {
    console.log(paint('amber', '› build ausente; compilando (uma vez)…'));
    const result = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    return new Promise((done, fail) => {
      result.on('exit', (code) => (code === 0 ? done() : fail(new Error('falha no build'))));
    });
  }
  return Promise.resolve();
}

async function ensureServer() {
  if (await serverOnline()) {
    console.log(paint('dim', '› usando o servidor que já está em ' + BASE));
    return { started: false };
  }

  await buildIfNeeded();
  console.log(paint('dim', `› subindo o servidor em ${BASE}…`));

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
    detached: false,
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(500);
    if (await serverOnline()) {
      console.log(paint('dim', '› servidor temporário no ar (encerra ao terminar o render)'));
      return { started: true, child };
    }
  }
  throw new Error('o servidor não respondeu em 30 s (rode "npm start" manualmente).');
}

function formatSeconds(value) {
  const total = Math.round(Number(value) || 0);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

async function listar() {
  await ensureServer();
  const data = await api('/api/projects');
  const projects = data.projects ?? [];
  if (!projects.length) {
    console.log('Nenhuma pauta salva.');
    return;
  }

  console.log('');
  console.log(paint('dim', 'ID'.padEnd(30) + 'ESTÁGIO'.padEnd(12) + 'VÍDEO'.padEnd(7) + 'TÍTULO'));
  for (const project of projects) {
    const id = String(project.id).padEnd(30);
    const stage = String(project.stage ?? '?').padEnd(12);
    const video = (project.hasVideo ? 'sim' : '—').padEnd(7);
    const title = String(project.title ?? '').slice(0, 56);
    console.log(`${id}${stage}${video}${title}`);
  }
  console.log('');
  console.log(paint('dim', `render: npm run render -- <id> --formato cartoes`));
}

async function renderizar(args) {
  const pautaId = args._[1];
  if (!pautaId) {
    throw new Error('informe o id da pauta: npm run render -- <id>');
  }

  // Aceita o nome em português e o identificador interno.
  const FORMATOS = {
    fotos: 'fotos',
    foto: 'fotos',
    documento: 'documento',
    doc: 'documento',
    cartoes: 'cards',
    cartões: 'cards',
    cards: 'cards',
  };
  const formatoBruto = String(args.formato ?? '').toLowerCase();
  const formato = formatoBruto ? FORMATOS[formatoBruto] : undefined;
  if (formatoBruto && !formato) {
    throw new Error(`formato inválido: "${formatoBruto}" (use fotos, documento ou cartoes).`);
  }
  const voz = args.voz ?? 'blend';
  const motor = args.motor ?? (voz && voz !== 'Kore' && !/^pt-BR-/.test(voz) ? 'kokoro' : undefined);

  if (!(await serverOnline())) {
    temporaryServer = (await ensureServer()).child ?? null;
  }
  console.log(paint('dim', '› servidor pronto'));

  const project = await api(`/api/projects/${pautaId}`);
  console.log('');
  console.log(paint('amber', `▸ ${project.title ?? pautaId}`));
  console.log(paint('dim', `  estágio: ${project.stage} · cenas: ${project.script?.scenes?.length ?? 0} · voz: ${motor ?? 'padrão'} / ${voz}`));

  const started = await api(`/api/studio/render/${pautaId}`, {
    method: 'POST',
    body: JSON.stringify({ videoMode: formato, engine: motor, voice: voz }),
  });

  const jobId = started.job.id;
  const began = Date.now();
  let lastLine = '';

  for (;;) {
    await sleep(600);
    const job = await api(`/api/jobs/${jobId}`);
    const pct = Math.max(0, Math.min(100, Number(job.pct) || 0));
    const bar = '█'.repeat(Math.round(pct / 4)).padEnd(25, '·');
    const line = `  ${bar} ${String(pct).padStart(3)}%  ${job.stage}: ${String(job.message ?? '').slice(0, 58)}`;

    if (process.stdout.isTTY) {
      process.stdout.write(`\r\u001b[2K${line}`);
    } else if (line !== lastLine) {
      console.log(line);
    }
    lastLine = line;

    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
      if (process.stdout.isTTY) process.stdout.write('\n');
      if (job.status !== 'done') {
        throw new Error(job.error || `render ${job.status}`);
      }

      const result = job.result ?? {};
      const videoPath = join(
        process.env['CANAL_DARK_PROJECTS_DIR'] ?? join(ROOT, 'projects'),
        pautaId,
        'video.mp4',
      );
      const size = existsSync(videoPath) ? statSync(videoPath).size / (1024 * 1024) : 0;

      console.log('');
      console.log(paint('green', `✔ pronto em ${formatSeconds((Date.now() - began) / 1000)}`));
      console.log(`  vídeo:  ${videoPath} ${paint('dim', `(${size.toFixed(1)} MB)`)}`);
      console.log(`  duração: ${formatSeconds(result.seconds)} · formato: ${result.videoMode ?? formato ?? 'pauta'}`);
      console.log(`  voz: ${result.ttsEngine ?? '?'} / ${result.ttsVoice ?? '?'}`);
      if (result.cuts) console.log(`  cortes: ${result.cuts} · plano médio: ${result.avgShotSec ?? '?'}s`);

      if (args.abrir) {
        const opener =
          process.platform === 'win32' ? ['cmd', ['/c', 'start', '', videoPath]] : ['open', [videoPath]];
        spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).unref();
      }
      return;
    }
  }
}

function help() {
  console.log(`
${paint('amber', 'Canal Dark — CLI')}

  npm run cli -- list
  npm run render -- <pautaId> [opções]

Opções:
  --formato  fotos | documento | cartoes   ${paint('dim', '(padrão: o da pauta)')}
  --voz      blend | pm_alex | pf_dora | pm_santa | Kore | pt-BR-AntonioNeural
  --motor    kokoro | gemini | edge        ${paint('dim', '(padrão: deduzido da voz)')}
  --abrir    abre o MP4 no player ao terminar

Exemplo:
  npm run render -- pauta-1795724291238-w3yx --formato cartoes --voz blend --abrir
`);
}

let temporaryServer = null;

function stopTemporaryServer() {
  if (!temporaryServer) return;
  try {
    temporaryServer.kill();
  } catch {
    // já encerrado
  }
  temporaryServer = null;
}

/** Encerra o processo que estiver escutando na porta (uso: npm run cli -- stop). */
function stopServerOnPort() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(false);
      return;
    }
    const netstat = spawn('cmd', ['/c', 'netstat -ano | findstr ":' + PORT + '" | findstr LISTENING']);
    let out = '';
    netstat.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    netstat.on('exit', () => {
      const match = out.match(/\s(\d+)\s*$/m);
      if (!match) {
        resolve(false);
        return;
      }
      spawn('taskkill', ['/PID', match[1], '/F'], { stdio: 'ignore' }).on('exit', () => resolve(true));
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  try {
    if (!command || command === 'help' || command === '--help') {
      help();
      return;
    }
    if (command === 'list' || command === 'lista') {
      await listar();
      return;
    }
    if (command === 'render' || command === 'gerar') {
      await renderizar(args);
      return;
    }
    if (command === 'stop' || command === 'parar') {
      const stopped = await stopServerOnPort();
      console.log(stopped ? paint('green', '✔ servidor encerrado') : 'nenhum servidor rodando na porta ' + PORT);
      return;
    }
    help();
    process.exitCode = 1;
  } catch (error) {
    console.error('');
    console.error(paint('red', `✖ ${error instanceof Error ? error.message : String(error)}`));
    process.exitCode = 1;
  } finally {
    stopTemporaryServer();
  }
}

void main();
