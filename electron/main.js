import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Dev: load the Vite dev server. Prod: load the built files in dist/.
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
const isDev = !app.isPackaged;

function createWindow() {
  console.log('[Electron] Creating main window, isDev:', isDev);

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#d8e6ec',
    webPreferences: {
      // Required so the app can use the <webview> tag for the in-scene browser.
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    console.log('[Electron] Loading dev server:', DEV_SERVER_URL);
    win.loadURL(DEV_SERVER_URL);
  } else {
    const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
    console.log('[Electron] Loading built file:', indexPath);
    win.loadFile(indexPath);
  }

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[Electron] Failed to load:', code, desc, url);
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
