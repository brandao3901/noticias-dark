import { app, BrowserWindow, Menu, dialog, shell } from 'electron';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shell desktop do Canal Dark.
 *
 * O app continua sendo o mesmo servidor SSR da pasta `dist/`: o Electron sobe
 * esse servidor como processo filho, espera a API responder e abre a janela.
 * Nada de navegador: fechar a janela encerra o servidor e os netos (FFmpeg/Python).
 */

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ENTRY = join(APP_ROOT, 'dist', 'canal-dark', 'server', 'server.mjs');
const ICON = join(APP_ROOT, 'public', 'icons', 'icon-512.png');
const LOG_DIR = join(APP_ROOT, 'logs');
const LOG_FILE = join(LOG_DIR, 'electron-server.log');

/** `--smoke`: carrega a página, imprime o título e sai (teste automático). */
const SMOKE = process.argv.includes('--smoke');

// Perfil/dados do Chromium ao lado do projeto: evita depender do AppData
// (que em ambiente corporativo/sandbox pode negar escrita) e deixa o app portátil.
const DATA_DIR = join(APP_ROOT, '.electron-data');
try {
  mkdirSync(DATA_DIR, { recursive: true });
  app.setPath('userData', join(DATA_DIR, 'profile'));
  app.setPath('sessionData', join(DATA_DIR, 'session'));
  app.setPath('crashDumps', join(DATA_DIR, 'crash'));
} catch {
  // sem perfil customizado: segue o padrão do sistema
}
/** `CANAL_DARK_DEV_URL`: usa um servidor já em execução (npm run app:dev). */
const DEV_URL = process.env['CANAL_DARK_DEV_URL']?.trim();

let mainWindow = null;
let serverProcess = null;
let serverPort = null;
let quitting = false;

function log(message) {
  const stamp = new Date().toISOString();
  process.stdout.write(`[electron] ${message}\n`);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    logStream?.write(`${stamp} ${message}\n`);
  } catch {
    // log é conveniência, não pode derrubar o app
  }
}

const logStream = (() => {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    return createWriteStream(LOG_FILE, { flags: 'a' });
  } catch {
    return null;
  }
})();

function portIsFree(port) {
  return new Promise((done) => {
    const tester = createServer();
    tester.once('error', () => done(false));
    tester.once('listening', () => tester.close(() => done(true)));
    tester.listen(port, '127.0.0.1');
  });
}

async function findFreePort(start = 3000) {
  for (let port = start; port < start + 20; port += 1) {
    if (await portIsFree(port)) return port;
  }
  throw new Error('nenhuma porta livre entre 3000 e 3020');
}

async function waitForServer(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/config/status`);
      if (response.ok) return true;
    } catch {
      // servidor ainda subindo
    }
    await new Promise((done) => setTimeout(done, 400));
  }
  return false;
}

function stopServer() {
  if (!serverProcess || serverProcess.killed) return;

  const pid = serverProcess.pid;
  serverProcess = null;
  if (!pid) return;

  try {
    if (process.platform === 'win32') {
      // /T mata FFmpeg e o Python do Kokoro que o servidor tiver aberto.
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGTERM');
    }
  } catch (error) {
    log(`falha ao encerrar o servidor: ${error.message}`);
  }
}

function startServer(port) {
  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(
      `build ausente: ${SERVER_ENTRY}. Rode "npm run build" (ou use "npm run app", que compila sozinho).`,
    );
  }

  const nodeBin = process.env['CANAL_DARK_NODE']?.trim() || 'node';
  log(`subindo servidor em 127.0.0.1:${port}`);

  const child = spawn(nodeBin, [SERVER_ENTRY], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout.on('data', (chunk) => log(`servidor: ${String(chunk).trimEnd()}`));
  child.stderr.on('data', (chunk) => log(`servidor(erro): ${String(chunk).trimEnd()}`));
  child.on('exit', (code) => {
    log(`servidor saiu (código ${code})`);
    if (!quitting && mainWindow) showStartupError(`O servidor parou (código ${code}).`);
  });

  serverProcess = child;
  return child;
}

function writeSmoke(text) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(join(LOG_DIR, 'smoke.txt'), `${new Date().toISOString()} ${text}\n`, 'utf8');
  } catch {
    // sem arquivo de smoke: o código de saída ainda indica o resultado
  }
}

function errorPage(title, detail) {
  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Canal Dark</title>
<style>
  body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0a0d12;color:#e6eaf0;font-family:Segoe UI,Arial,sans-serif}
  .box{max-width:640px;padding:32px;border:1px solid rgba(255,255,255,.12);border-radius:14px;background:#111620}
  h1{font-size:18px;margin:0 0 8px;color:#f0aa4b}
  p{font-size:13px;line-height:1.6;color:#9fb0c7;white-space:pre-wrap}
  button{margin-top:16px;padding:8px 14px;border-radius:8px;border:0;background:#e59a38;
    color:#0a0d12;font-weight:700;cursor:pointer}
</style></head>
<body><div class="box"><h1>${title}</h1><p>${detail}</p>
<button onclick="location.reload()">Tentar de novo</button></div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function showStartupError(detail) {
  const message = `${detail}\n\nLog do servidor: ${LOG_FILE}`;
  if (mainWindow && !mainWindow.isDestroyed()) {
    void mainWindow.loadURL(errorPage('Não foi possível abrir o Canal Dark', message));
  } else {
    dialog.showErrorBox('Canal Dark', message);
  }
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#0a0d12',
    title: 'Canal Dark — Estúdio Editorial',
    icon: existsSync(ICON) ? ICON : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!SMOKE) mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Links externos abrem no navegador do sistema, não dentro do app.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target) && !target.startsWith(url.replace(/\/$/, ''))) {
      void shell.openExternal(target);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.webContents.on('did-finish-load', async () => {
    if (!SMOKE) return;
    try {
      const title = await mainWindow.webContents.executeJavaScript('document.title');
      writeSmoke(`OK ${title}`);
      stopServer();
      setTimeout(() => process.exit(0), 200);
    } catch (error) {
      writeSmoke(`FAIL ${error.message}`);
      stopServer();
      setTimeout(() => process.exit(1), 200);
    }
  });

  mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
    log(`falha ao carregar (${code}): ${description}`);
    if (!SMOKE) showStartupError(`Falha ao carregar a interface (${description}).`);
  });

  void mainWindow.loadURL(url);
}

function buildMenu() {
  const template = [
    {
      label: 'Arquivo',
      submenu: [{ role: 'quit', label: 'Sair' }],
    },
    {
      label: 'Editar',
      submenu: [
        { role: 'undo', label: 'Desfazer' },
        { role: 'redo', label: 'Refazer' },
        { type: 'separator' },
        { role: 'cut', label: 'Recortar' },
        { role: 'copy', label: 'Copiar' },
        { role: 'paste', label: 'Colar' },
        { role: 'selectAll', label: 'Selecionar tudo' },
      ],
    },
    {
      label: 'Exibir',
      submenu: [
        { role: 'reload', label: 'Recarregar' },
        { role: 'forceReload', label: 'Recarregar ignorando cache' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Zoom normal' },
        { role: 'zoomIn', label: 'Aumentar zoom' },
        { role: 'zoomOut', label: 'Diminuir zoom' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Tela cheia' },
        { role: 'toggleDevTools', label: 'Ferramentas do desenvolvedor' },
      ],
    },
    {
      label: 'Ajuda',
      submenu: [
        {
          label: 'Abrir pasta de projetos',
          click: () => void shell.openPath(join(APP_ROOT, 'projects')),
        },
        {
          label: 'Abrir log do servidor',
          click: () => void shell.openPath(LOG_FILE),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function boot() {
  if (!SMOKE) buildMenu();

  try {
    if (DEV_URL) {
      log(`modo desenvolvimento: ${DEV_URL}`);
      createWindow(DEV_URL);
      return;
    }

    serverPort = await findFreePort();
    startServer(serverPort);

    const ready = await waitForServer(serverPort);
    if (!ready) {
      showStartupError('O servidor não respondeu em 60 segundos.');
      return;
    }

    log(`servidor pronto em http://127.0.0.1:${serverPort}`);
    createWindow(`http://127.0.0.1:${serverPort}`);
  } catch (error) {
    log(`erro na inicialização: ${error.message}`);
    showStartupError(error.message);
  }
}

// Uma instância só: segundo clique foca a janela que já está aberta.
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  // Sem lock (arquivo preso/permissão): não bloqueia o uso, só avisa no log.
  log('aviso: outra instância parece ativa; seguindo mesmo assim');
}
{

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    void boot();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void boot();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    stopServer();
  });
}
