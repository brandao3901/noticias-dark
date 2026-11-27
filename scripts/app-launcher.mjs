#!/usr/bin/env node
/**
 * Launcher do app desktop (`npm run app`).
 *
 * 1. confere se o binário do Electron existe (senão explica como baixar);
 * 2. compila o app quando `dist/` está ausente ou mais velho que `src/`;
 * 3. abre o Electron (ou repassa os argumentos, ex.: `--smoke`).
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ENTRY = join(ROOT, 'dist', 'canal-dark', 'server', 'server.mjs');
const ELECTRON_BIN = join(
  ROOT,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);

function newestMtime(dir) {
  let newest = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(current, entry.name);
      const stats = statSync(full);
      if (stats.isDirectory()) walk(full);
      else newest = Math.max(newest, stats.mtimeMs);
    }
  };
  if (existsSync(dir)) walk(dir);
  return newest;
}

function run(command, args, options = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
    child.on('exit', (code) => (code === 0 ? done() : fail(new Error(`${command} saiu com código ${code}`))));
  });
}

async function main() {
  if (!existsSync(ELECTRON_BIN)) {
    console.error('\n[ERRO] O binário do Electron não está instalado.\n');
    console.error('Rode uma vez (baixa ~120 MB):');
    console.error('  node node_modules/electron/install.js\n');
    process.exitCode = 1;
    return;
  }

  const needsBuild =
    !existsSync(SERVER_ENTRY) ||
    newestMtime(join(ROOT, 'src')) > statSync(SERVER_ENTRY).mtimeMs;

  if (needsBuild) {
    console.log('[app] código mais novo que o build — compilando…');
    await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
      shell: process.platform === 'win32',
    });
  }

  const extraArgs = process.argv.slice(2);

  // Alguns Windows (política corporativa, conta de administrador, sessão sem
  // desktop) derrubam o Chromium com STATUS_BREAKPOINT. Nesse caso, tenta uma
  // vez com --no-sandbox em vez de deixar o usuário sem app.
  const SANDBOX_CRASH = 2147483651; // 0x80000003
  try {
    await run(ELECTRON_BIN, ['.', ...extraArgs]);
  } catch (error) {
    const crashed = /código\s+(2147483651|-1073740796)/.test(error.message);
    if (!crashed || extraArgs.includes('--no-sandbox')) throw error;
    console.warn('[app] o Electron não conseguiu iniciar com sandbox; tentando sem sandbox…');
    await run(ELECTRON_BIN, ['.', ...extraArgs, '--no-sandbox']);
  }
}

main().catch((error) => {
  console.error(`[app] ${error.message}`);
  process.exitCode = 1;
});
