import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mainWindow = null;
let serverProcess = null;

async function startServerAndWindow() {
  // Start Express SSR server locally inside Electron
  process.env['PORT'] = '3000';
  process.env['NODE_ENV'] = 'production';
  try {
    await import(join(__dirname, '../dist/canal-dark/server/server.mjs'));
  } catch (err) {
    console.error('Failed to start embedded SSR server:', err);
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    title: 'Canal Dark - Estúdio Editorial',
  });

  // Wait a moment for server to bind port 3000
  setTimeout(() => {
    void mainWindow?.loadURL('http://localhost:3000');
  }, 1200);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  void startServerAndWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void startServerAndWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
