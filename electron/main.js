import { app, BrowserWindow, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { initBrowserService, disposeBrowserService } from './browserService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
const isDev = !app.isPackaged;

// Vision: by default the *renderer* streams avatar first-person frames (src/main.js).
// Set TRUMPCHAN_VISION_MODE=window to fall back to full-window capturePage (third-person).
// The live website is Playwright Chromium; screenshots stream onto the plane (browserService).
const HUB_WS_URL = 'ws://localhost:3000';
const VISION_MODE = (process.env.TRUMPCHAN_VISION_MODE || 'avatar').toLowerCase(); // 'avatar' | 'window'
const VISION_FPS = 1;
const VISION_FRAME_INTERVAL_MS = Math.round(1000 / VISION_FPS);
const VISION_MAX_DIM = 1024;
const VISION_JPEG_QUALITY = 88;
let visionSeq = 0;

function createWindow() {
  console.log('[Electron] Creating main window, isDev:', isDev);

  const preloadPath = path.join(__dirname, 'preload.cjs');
  console.log('[Electron] Preload path:', preloadPath);

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#d8e6ec',
    webPreferences: {
      webviewTag: false,
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
    },
  });

  // Always load the 3D UI first — browser service must never block the shell.
  if (isDev) {
    console.log('[Electron] Loading dev server:', DEV_SERVER_URL);
    win.loadURL(DEV_SERVER_URL).catch((e) => console.error('[Electron] loadURL failed:', e));
  } else {
    // Set CSP for production builds to suppress security warnings
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://localhost:* http://localhost:*; media-src 'self' blob:; worker-src 'self' blob:;",
          ],
        },
      });
    });
    const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
    console.log('[Electron] Loading built file:', indexPath);
    win.loadFile(indexPath).catch((e) => console.error('[Electron] loadFile failed:', e));
  }

  // Offscreen browser after shell starts loading.
  try {
    initBrowserService(win);
  } catch (e) {
    console.error('[Electron] Browser service init error:', e);
  }

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[Electron] Failed to load:', code, desc, url);
  });

  win.webContents.on('console-message', (event) => {
    const tag = ['log', 'warn', 'error'][event.level] || 'log';
    const loc =
      event.sourceId && event.line
        ? ` (${event.sourceId}:${event.line})`
        : '';
    console.log(`[Renderer:${tag}] ${event.message}${loc}`);
  });

  win.webContents.once('did-finish-load', () => {
    if (VISION_MODE === 'window') {
      console.log('[Vision] Mode=window — starting main-window capturePage stream.');
      startVisionStream(win);
    } else {
      console.log(
        '[Vision] Mode=avatar — first-person frames come from the renderer (head camera). Window capture OFF.',
      );
    }
  });

  if (isDev) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  return win;
}

// ---------------------------------------------------------------------------
// Vision streaming
// ---------------------------------------------------------------------------

let visionWs = null;
let visionWsReady = false;
let visionTimer = null;
let visionReconnectTimer = null;
let capturing = false;

function connectVisionHub() {
  console.log('[Vision] Connecting to hub at', HUB_WS_URL);
  visionWs = new WebSocket(HUB_WS_URL);

  visionWs.on('open', () => {
    visionWsReady = true;
    console.log('[Vision] Connected to hub WebSocket.');
  });

  visionWs.on('close', () => {
    visionWsReady = false;
    console.warn('[Vision] Hub WebSocket closed. Reconnecting in 2s...');
    scheduleVisionReconnect();
  });

  visionWs.on('error', (err) => {
    visionWsReady = false;
    console.error('[Vision] Hub WebSocket error:', err.message);
  });
}

function scheduleVisionReconnect() {
  if (visionReconnectTimer) return;
  visionReconnectTimer = setTimeout(() => {
    visionReconnectTimer = null;
    connectVisionHub();
  }, 2000);
}

function startVisionStream(win) {
  connectVisionHub();
  if (visionTimer) clearInterval(visionTimer);
  visionTimer = setInterval(() => captureAndSend(win), VISION_FRAME_INTERVAL_MS);
  console.log(`[Vision] Streaming at ${VISION_FPS} FPS (every ${VISION_FRAME_INTERVAL_MS}ms).`);
}

async function captureAndSend(win) {
  if (capturing) return;
  if (!win || win.isDestroyed()) return;
  if (!visionWsReady || !visionWs || visionWs.readyState !== WebSocket.OPEN) return;
  if (win.isMinimized() || !win.isVisible()) return;

  capturing = true;
  try {
    let image = await Promise.race([
      win.webContents.capturePage(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('capture_timeout')), 3000)),
    ]);

    if (!image || (typeof image.isEmpty === 'function' && image.isEmpty())) {
      return;
    }

    const size = image.getSize();
    if (!size.width || !size.height) return;

    const longest = Math.max(size.width, size.height);
    if (longest > VISION_MAX_DIM) {
      const scale = VISION_MAX_DIM / longest;
      image = image.resize({
        width: Math.round(size.width * scale),
        height: Math.round(size.height * scale),
        quality: 'better',
      });
    }

    const jpeg = image.toJPEG(VISION_JPEG_QUALITY);
    if (!jpeg || jpeg.length === 0) return;

    const finalSize = image.getSize();
    if (visionWs && visionWs.readyState === WebSocket.OPEN) {
      visionSeq += 1;
      const ts = Date.now();
      visionWs.send(
        JSON.stringify({
          type: 'visionFrame',
          mimeType: 'image/jpeg',
          data: jpeg.toString('base64'),
          width: finalSize.width,
          height: finalSize.height,
          ts,
          seq: visionSeq,
          source: 'window-capture',
        }),
      );
      console.log(
        `[Vision] Sent frame #${visionSeq} ${finalSize.width}x${finalSize.height} ` +
          `(${(jpeg.length / 1024).toFixed(1)} KB) ts=${ts}`,
      );
    }
  } catch (err) {
    console.warn('[Vision] Capture/send skipped:', err.message);
  } finally {
    capturing = false;
  }
}

function stopVisionStream() {
  if (visionTimer) {
    clearInterval(visionTimer);
    visionTimer = null;
  }
  if (visionReconnectTimer) {
    clearTimeout(visionReconnectTimer);
    visionReconnectTimer = null;
  }
  if (visionWs) {
    try {
      visionWs.close();
    } catch {
      /* ignore */
    }
    visionWs = null;
  }
  visionWsReady = false;
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopVisionStream();
  disposeBrowserService();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopVisionStream();
  disposeBrowserService();
});
