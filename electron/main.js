import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Dev: load the Vite dev server. Prod: load the built files in dist/.
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
const isDev = !app.isPackaged;

// --- Vision streaming config ---
// We capture the FULL composited window (3D avatar + room + the live floating
// browser content) as a single image and stream it to the AI. This lets Gemini
// literally "see" everything on screen, including whatever page the in-scene
// browser is showing - no URL fetching or DOM scraping involved.
const HUB_WS_URL = 'ws://localhost:3000';
const VISION_FPS = 1; // Gemini Live API caps video input at ~1 frame/sec.
const VISION_FRAME_INTERVAL_MS = Math.round(1000 / VISION_FPS);
// Slightly above the classic 768 recommendation so browser text/UI stays
// readable. Paired with MEDIA_RESOLUTION_HIGH on the AI server.
const VISION_MAX_DIM = 1024;
const VISION_JPEG_QUALITY = 88; // 0-100; higher = clearer browser content

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

  // Start streaming what's on screen to the AI once the page is ready.
  win.webContents.once('did-finish-load', () => {
    console.log('[Vision] Main window finished loading, starting vision stream.');
    startVisionStream(win);
  });

  return win;
}

// ---------------------------------------------------------------------------
// Vision streaming: capture the composited window and push frames to the AI.
// ---------------------------------------------------------------------------

let visionWs = null;
let visionWsReady = false;
let visionTimer = null;
let visionReconnectTimer = null;
let capturing = false; // guards against overlapping async captures

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
    // 'close' will typically follow and trigger the reconnect.
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
  if (capturing) return; // skip if the previous capture hasn't finished
  if (!win || win.isDestroyed()) return;
  if (!visionWsReady || !visionWs || visionWs.readyState !== WebSocket.OPEN) return;
  // Don't waste captures while the window is minimized/hidden.
  if (win.isMinimized() || !win.isVisible()) return;

  capturing = true;
  try {
    // capturePage() grabs the fully composited window: the WebGL 3D scene AND
    // the <webview> browser content layered on top, exactly as the user sees it.
    let image = await win.webContents.capturePage();

    // Downscale to <=VISION_MAX_DIM on the longest side for Live API video.
    const size = image.getSize();
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
    if (!jpeg || jpeg.length === 0) {
      console.warn('[Vision] capturePage produced an empty frame, skipping.');
      return;
    }

    const finalSize = image.getSize();
    visionWs.send(JSON.stringify({
      type: 'visionFrame',
      mimeType: 'image/jpeg',
      data: jpeg.toString('base64'),
      width: finalSize.width,
      height: finalSize.height,
      ts: Date.now(),
    }));
    console.log(`[Vision] Sent frame ${finalSize.width}x${finalSize.height} (${(jpeg.length / 1024).toFixed(1)} KB).`);
  } catch (err) {
    console.error('[Vision] Capture/send failed:', err.message);
  } finally {
    capturing = false;
  }
}

function stopVisionStream() {
  if (visionTimer) { clearInterval(visionTimer); visionTimer = null; }
  if (visionReconnectTimer) { clearTimeout(visionReconnectTimer); visionReconnectTimer = null; }
  if (visionWs) {
    try { visionWs.close(); } catch { /* ignore */ }
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
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopVisionStream();
});
