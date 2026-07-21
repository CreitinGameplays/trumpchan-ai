/**
 * Playwright + Chromium browser for the 3D scene.
 *
 * - Real Chromium via Playwright (auto-wait, locators, force click, aria refs)
 * - JPEG screenshots stream to the renderer as browser:paint (WebGL texture)
 * - Persistent user profile: cookies / localStorage / logins survive restarts
 * - Same IPC surface as the old Electron offscreen path
 */
import { app, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { BUILD_AX_SNAPSHOT_JS } from './axSnapshot.js';

const BROWSER_W = 1024;
const BROWSER_H = 720;
const PAINT_JPEG_QUALITY = 72;
const CAPTURE_INTERVAL_MS = 150;
/** Playwright default screenshot timeout is 30s; Discord heavy pages hang at ~12s. */
const SCREENSHOT_TIMEOUT_MS = 6000;
const DEFAULT_URL = 'https://example.com';
/** Profile subdir under Electron userData — cookies live here permanently */
const PROFILE_DIR_NAME = 'playwright-browser-profile';

let mainWin = null;
/** @type {import('playwright').Browser | null} */
let browser = null;
/** @type {import('playwright').BrowserContext | null} */
let context = null;
/** @type {import('playwright').Page | null} */
let page = null;
let guestReady = false;
let lastUrl = DEFAULT_URL;
let lastTitle = '';
let lastAxTree = '';
/** @type {Map<string, import('playwright').Locator>} */
let refMap = new Map();
let captureTimer = null;
let lastPaintAt = 0;
let paintEventCount = 0;
/** Serialize screenshots — concurrent page.screenshot on Discord hangs/timeouts. */
let captureInFlight = null;
let lastCaptureFailLogAt = 0;
let ipcRegistered = false;
let launching = null;
let profileDir = '';
/** Last pointer position in CSS pixels (viewport). Used for 3D cursor + hover continuity. */
let lastMouseX = Math.round(BROWSER_W / 2);
let lastMouseY = Math.round(BROWSER_H / 2);
let lastCursorEmitAt = 0;

export function getBrowserContentSize() {
  return { width: BROWSER_W, height: BROWSER_H, toolbarHeight: 0 };
}

function getProfileDir() {
  if (profileDir) return profileDir;
  try {
    // Electron userData: ~/Library/Application Support/<app>/playwright-browser-profile
    profileDir = path.join(app.getPath('userData'), PROFILE_DIR_NAME);
  } catch {
    profileDir = path.join(process.cwd(), '.playwright-browser-profile');
  }
  try {
    fs.mkdirSync(profileDir, { recursive: true });
  } catch (e) {
    console.warn('[BrowserService] mkdir profile:', e?.message ?? e);
  }
  return profileDir;
}

export function initBrowserService(ownerWindow) {
  mainWin = ownerWindow;
  registerIpcOnce();
  launching = launchPlaywright().catch((e) => {
    console.error('[BrowserService] Playwright launch failed (3D UI still works):', e);
  });
  console.log(
    '[BrowserService] Playwright Chromium init scheduled',
    BROWSER_W,
    'x',
    BROWSER_H,
    'profile=',
    getProfileDir(),
  );
}

async function ensureReady() {
  if (page && !page.isClosed()) return true;
  if (launching) await launching;
  if (page && !page.isClosed()) return true;
  launching = launchPlaywright();
  await launching;
  return Boolean(page && !page.isClosed());
}

/**
 * Persistent Chromium profile so cookies, localStorage, and logins are kept.
 * Uses launchPersistentContext — never wipe storage on close/restart.
 */
async function launchPlaywright() {
  // Close previous session cleanly but DO NOT delete the profile directory.
  await disposeBrowserInternals({ keepProfile: true });

  const userDataDir = getProfileDir();
  console.log('[BrowserService] Launching Playwright Chromium (persistent profile):', userDataDir);

  // launchPersistentContext returns a BrowserContext bound to userDataDir.
  // Cookies / localStorage / IndexedDB persist across app restarts.
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    viewport: { width: BROWSER_W, height: BROWSER_H },
    deviceScaleFactor: 1,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    javaScriptEnabled: true,
    ignoreHTTPSErrors: true,
    acceptDownloads: true,
    // Keep all site data; never clear on close
    bypassCSP: false,
    args: [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  browser = context.browser();

  // Reuse first page if profile restored one; otherwise open a blank page
  const pages = context.pages();
  page = pages.length > 0 ? pages[0] : await context.newPage();
  // Close extra leftover tabs so we only paint one page into the 3D plane
  for (let i = 1; i < pages.length; i++) {
    try {
      await pages[i].close();
    } catch {
      /* ignore */
    }
  }

  page.setDefaultTimeout(12000);
  page.setDefaultNavigationTimeout(20000);

  // Guard: never clear storage from our side
  context.on('close', () => {
    console.log('[BrowserService] context closed (profile retained on disk)');
  });

  page.on('load', () => {
    guestReady = true;
    lastUrl = page?.url() || lastUrl;
    page
      ?.title()
      .then((t) => {
        lastTitle = t || '';
        emitNav();
      })
      .catch(() => emitNav());
    console.log('[BrowserService] load', lastUrl);
    captureOnce('after-load').catch(() => {});
  });

  page.on('framenavigated', (frame) => {
    if (frame === page?.mainFrame()) {
      lastUrl = frame.url();
      emitNav();
    }
  });

  page.on('close', () => {
    console.warn('[BrowserService] page closed');
    guestReady = false;
  });

  try {
    // Restore last URL if page is blank/new; otherwise keep restored session page
    const cur = page.url();
    const needNav =
      !cur ||
      cur === 'about:blank' ||
      cur === 'chrome://newtab/' ||
      cur.startsWith('chrome://');
    if (needNav) {
      await page.goto(lastUrl || DEFAULT_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    }
    guestReady = true;
    lastUrl = page.url();
    lastTitle = await page.title().catch(() => '');
    emitNav();
    logCookieSummary().catch(() => {});
  } catch (e) {
    console.warn('[BrowserService] initial goto:', e?.message ?? e);
    guestReady = true;
  }

  startCaptureLoop();
  console.log('[BrowserService] Playwright Chromium ready (cookies persistent)', lastUrl);
}

/** Debug: how many cookies are currently in the profile (does not log values). */
async function logCookieSummary() {
  if (!context) return;
  try {
    const cookies = await context.cookies();
    const hosts = new Set(
      cookies.map((c) => c.domain || '').filter(Boolean),
    );
    console.log(
      `[BrowserService] cookies in profile: count=${cookies.length} domains=${hosts.size}`,
    );
  } catch (e) {
    console.warn('[BrowserService] cookie summary failed:', e?.message ?? e);
  }
}

/**
 * Close browser process/pages. Profile dir on disk is NEVER deleted.
 * @param {{ keepProfile?: boolean }} _opts
 */
async function disposeBrowserInternals(_opts = {}) {
  if (captureTimer) {
    clearInterval(captureTimer);
    captureTimer = null;
  }
  refMap.clear();

  // Flush cookies to disk by closing context gracefully (profile retained).
  // Do NOT call context.clearCookies() / clearPermissions() / storageState wipe.
  page = null;

  try {
    if (context) {
      // Closing persistent context writes cookies to userDataDir and exits Chromium.
      await context.close();
      console.log('[BrowserService] persistent context closed; profile kept at', getProfileDir());
    }
  } catch (e) {
    console.warn('[BrowserService] context.close:', e?.message ?? e);
  }
  context = null;
  browser = null;
  guestReady = false;
}

function startCaptureLoop() {
  if (captureTimer) clearInterval(captureTimer);
  captureTimer = setInterval(() => {
    if (!page || page.isClosed()) return;
    captureOnce('interval').catch(() => {});
  }, CAPTURE_INTERVAL_MS);
}

async function captureOnce(reason) {
  if (!page || page.isClosed()) return;
  const now = Date.now();
  if (reason === 'interval' && now - lastPaintAt < CAPTURE_INTERVAL_MS - 20) return;
  if (!mainWin || mainWin.isDestroyed()) return;

  // Drop interval captures while another screenshot is running (avoids pile-up).
  if (captureInFlight) {
    if (reason === 'interval') return;
    try {
      await captureInFlight;
    } catch {
      /* ignore prior failure */
    }
  }

  let releaseCapture = null;
  captureInFlight = new Promise((resolve) => {
    releaseCapture = resolve;
  });

  try {
    // Discord/heavy SPAs hang on default screenshot (fonts + animations).
    // Disable animations + short timeout; interval failures stay quiet.
    const timeout =
      reason === 'after-nav' || reason === 'after-load'
        ? Math.max(SCREENSHOT_TIMEOUT_MS, 10000)
        : SCREENSHOT_TIMEOUT_MS;
    const buf = await page.screenshot({
      type: 'jpeg',
      quality: PAINT_JPEG_QUALITY,
      timeout,
      animations: 'disabled',
      caret: 'hide',
      // viewport only — matches BROWSER_W x BROWSER_H
    });
    if (!buf?.length) return;
    lastPaintAt = Date.now();
    paintEventCount++;
    if (!mainWin || mainWin.isDestroyed()) return;
    mainWin.webContents.send('browser:paint', {
      data: Buffer.from(buf).toString('base64'),
      width: BROWSER_W,
      height: BROWSER_H,
      mimeType: 'image/jpeg',
      ts: lastPaintAt,
      source: reason || 'capture',
    });
  } catch (e) {
    const msg = String(e?.message ?? e);
    // Closed page during shutdown — ignore
    if (/has been closed|Target closed|browser has been closed/i.test(msg)) return;
    const important =
      reason === 'after-load' ||
      reason === 'after-click' ||
      reason === 'after-nav' ||
      reason === 'after-type';
    const t = Date.now();
    if (important || t - lastCaptureFailLogAt > 15000) {
      lastCaptureFailLogAt = t;
      console.warn(`[BrowserService] captureOnce(${reason}):`, msg.slice(0, 120));
    }
  } finally {
    const done = releaseCapture;
    captureInFlight = null;
    if (done) done();
  }
}

function emitNav() {
  if (!mainWin || mainWin.isDestroyed()) return;
  try {
    mainWin.webContents.send('browser:nav', {
      url: lastUrl,
      title: lastTitle,
      canGoBack: true,
      canGoForward: true,
      guestReady,
      engine: 'playwright-chromium',
      cursor: {
        x: lastMouseX / Math.max(BROWSER_W - 1, 1),
        y: lastMouseY / Math.max(BROWSER_H - 1, 1),
        px: { x: lastMouseX, y: lastMouseY },
      },
    });
  } catch {
    /* ignore */
  }
}

function clampMousePx(x, y) {
  const px = Math.round(Number(x));
  const py = Math.round(Number(y));
  return {
    x: Math.max(0, Math.min(BROWSER_W - 1, Number.isFinite(px) ? px : lastMouseX)),
    y: Math.max(0, Math.min(BROWSER_H - 1, Number.isFinite(py) ? py : lastMouseY)),
  };
}

/**
 * Record pointer and notify renderer so the 3D cursor can follow.
 * @param {number} x CSS px
 * @param {number} y CSS px
 * @param {{ force?: boolean, phase?: string }} [opts]
 */
function setCursorPosition(x, y, opts = {}) {
  const p = clampMousePx(x, y);
  lastMouseX = p.x;
  lastMouseY = p.y;
  const now = Date.now();
  if (!opts.force && now - lastCursorEmitAt < 16) return p;
  lastCursorEmitAt = now;
  if (!mainWin || mainWin.isDestroyed()) return p;
  try {
    mainWin.webContents.send('browser:cursor', {
      x: lastMouseX / Math.max(BROWSER_W - 1, 1),
      y: lastMouseY / Math.max(BROWSER_H - 1, 1),
      px: { x: lastMouseX, y: lastMouseY },
      phase: opts.phase || 'move',
      ts: now,
    });
  } catch {
    /* ignore */
  }
  return p;
}

/**
 * Smooth Playwright mouse move + 3D cursor update.
 * Accepts normalized 0–1 or CSS px (when >1).
 */
async function smartMove(opts = {}) {
  if (!(await ensureReady()) || !page) return { ok: false, error: 'no_browser' };

  let tx = lastMouseX;
  let ty = lastMouseY;
  const hasNx = opts.x != null && Number.isFinite(Number(opts.x));
  const hasNy = opts.y != null && Number.isFinite(Number(opts.y));
  if (hasNx || hasNy) {
    const nx = hasNx ? Number(opts.x) : lastMouseX / Math.max(BROWSER_W - 1, 1);
    const ny = hasNy ? Number(opts.y) : lastMouseY / Math.max(BROWSER_H - 1, 1);
    // Values in (0,1] treated as normalized; >1 as CSS pixels
    if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1) {
      tx = Math.round(nx * Math.max(BROWSER_W - 1, 1));
      ty = Math.round(ny * Math.max(BROWSER_H - 1, 1));
    } else {
      tx = Math.round(nx);
      ty = Math.round(ny);
    }
  }

  // Resolve target element center when ref/text/role given
  const candidates = buildLocatorCandidates(opts);
  for (const c of candidates) {
    if (c.method === 'coords' && c.x != null) {
      tx = c.x;
      ty = c.y;
      break;
    }
    if (!c.locator) continue;
    try {
      const vis = await c.locator.isVisible({ timeout: 600 }).catch(() => false);
      if (!vis && opts.force !== true) continue;
      await c.locator.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
      const box = await c.locator.boundingBox().catch(() => null);
      if (box) {
        tx = box.x + box.width / 2;
        ty = box.y + box.height / 2;
        break;
      }
    } catch {
      /* next */
    }
  }

  const steps = Math.max(1, Math.min(40, Number(opts.steps) || 12));
  const p = clampMousePx(tx, ty);
  console.log(`[BrowserService] smartMove → ${p.x},${p.y} steps=${steps}`);
  try {
    await page.mouse.move(p.x, p.y, { steps });
  } catch (e) {
    console.warn('[BrowserService] mouse.move failed:', e?.message ?? e);
  }
  setCursorPosition(p.x, p.y, { force: true, phase: 'move' });
  if (opts.capture !== false) {
    await captureOnce('after-move').catch(() => {});
  }
  return {
    ok: true,
    action: 'move',
    method: 'playwright-mouse-move',
    x: p.x / Math.max(BROWSER_W - 1, 1),
    y: p.y / Math.max(BROWSER_H - 1, 1),
    px: p,
  };
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeUrl(value) {
  if (!value) return 'about:blank';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  if (/^[^\s]+\.[^\s]+$/.test(value) && !value.includes(' ')) return `https://${value}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(value)}`;
}

/** Build locator from ref / role+name / text / selector / coords */
function resolveLocator(opts = {}) {
  const candidates = buildLocatorCandidates(opts);
  return candidates[0] || null;
}

/**
 * Multiple locator strategies tried in order with short timeouts.
 * Avoids one giant .or() chain that waits 8s and never matches menu items.
 */
function buildLocatorCandidates(opts = {}) {
  if (!page) return [];
  /** @type {Array<{ locator: import('playwright').Locator | null, method: string, ref?: string, x?: number, y?: number }>} */
  const out = [];

  const ref = opts.ref != null ? String(opts.ref).trim().replace(/^@/, '') : '';
  if (ref && refMap.has(ref)) {
    out.push({ locator: refMap.get(ref), method: 'ref', ref });
  }
  if (ref && /^e\d+$/i.test(ref)) {
    try {
      out.push({ locator: page.locator(`aria-ref=${ref}`), method: 'aria-ref', ref });
    } catch {
      /* ignore */
    }
  }

  const role = opts.role != null ? String(opts.role).trim().toLowerCase() : '';
  const name =
    opts.name != null
      ? String(opts.name).trim()
      : opts.text != null
        ? String(opts.text).trim()
        : opts.label != null
          ? String(opts.label).trim()
          : '';
  const text = opts.text != null ? String(opts.text).trim() : '';
  const selector = opts.selector != null ? String(opts.selector).trim() : '';
  const elementId = opts.elementId != null ? Number(opts.elementId) : null;
  const q = name || text;

  if (Number.isFinite(elementId) && refMap.has(`e${elementId + 1}`)) {
    out.push({
      locator: refMap.get(`e${elementId + 1}`),
      method: 'elementId',
      ref: `e${elementId + 1}`,
    });
  }

  if (selector) {
    out.push({ locator: page.locator(selector).first(), method: 'selector' });
  }

  if (role && q) {
    try {
      out.push({
        locator: page.getByRole(/** @type {any} */ (role), { name: q, exact: false }).first(),
        method: 'role+name',
      });
    } catch {
      /* invalid role */
    }
  }

  if (q) {
    // Menu items first (hover menus / context menus / Discord-style)
    for (const r of ['menuitem', 'option', 'button', 'link', 'tab', 'checkbox']) {
      try {
        out.push({
          locator: page.getByRole(/** @type {any} */ (r), { name: q, exact: false }).first(),
          method: `role:${r}`,
        });
      } catch {
        /* ignore */
      }
    }
    // Exact text, then substring — both visible only
    out.push({
      locator: page.getByText(q, { exact: true }).first(),
      method: 'text-exact',
    });
    out.push({
      locator: page.getByText(q, { exact: false }).first(),
      method: 'text-partial',
    });
    // Case-insensitive regex as last text strategy
    try {
      out.push({
        locator: page.getByText(new RegExp(escapeRe(q), 'i')).first(),
        method: 'text-re',
      });
    } catch {
      /* ignore */
    }
    out.push({
      locator: page.getByLabel(q, { exact: false }).first(),
      method: 'label',
    });
    // CSS attribute / data-testid contains
    const safe = q.replace(/"/g, '\\"');
    out.push({
      locator: page
        .locator(
          `[aria-label*="${safe}" i], [title*="${safe}" i], [data-testid*="${safe}" i], [data-label*="${safe}" i]`,
        )
        .first(),
      method: 'attr-contains',
    });
  }

  if (role && !q) {
    try {
      out.push({
        locator: page.getByRole(/** @type {any} */ (role)).first(),
        method: 'role',
      });
    } catch {
      /* ignore */
    }
  }

  if (opts.x != null && opts.y != null) {
    const x = Math.round(clamp01(opts.x) * (BROWSER_W - 1));
    const y = Math.round(clamp01(opts.y) * (BROWSER_H - 1));
    out.push({ locator: null, method: 'coords', x, y });
  }

  return out;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Labels that usually live inside hover/context menus */
const MENU_ITEM_HINT =
  /delete|remove|edit|rename|copy|paste|share|report|block|mute|hide|archive|pin|unpin|reply|forward|more|options|settings|leave|kick|ban|invite|mark as|open link|save|download|spam|report/i;

/**
 * Try to open a likely parent menu before clicking a menu item.
 * E.g. "Delete Message" often needs hover/click on ⋯ first.
 */
async function tryRevealMenuForLabel(label) {
  if (!page || !label || !MENU_ITEM_HINT.test(label)) return false;
  console.log('[BrowserService] menu-item label detected; trying to reveal overflow menus…', label);

  const openers = [
    page.getByRole('button', { name: /more|options|actions|menu/i }).first(),
    page.locator('[aria-label*="More" i], [aria-label*="more" i], [aria-label*="Options" i]').first(),
    page.locator('[data-testid*="more" i], [data-testid*="overflow" i], [data-testid*="context" i]').first(),
    page.getByText('⋯').first(),
    page.getByText('…').first(),
    page.getByText('⋮').first(),
    page.locator('button:has(svg)').filter({ hasNot: page.locator('[disabled]') }).last(),
  ];

  for (const loc of openers) {
    try {
      const n = await loc.count().catch(() => 0);
      if (!n) continue;
      const vis = await loc.isVisible({ timeout: 400 }).catch(() => false);
      if (!vis) continue;
      await loc.hover({ force: true, timeout: 1500 }).catch(() => {});
      await sleep(200);
      // Many UIs need click on ⋯ not just hover
      await loc.click({ force: true, timeout: 2000 }).catch(() => {});
      await sleep(350);
      console.log('[BrowserService] opened likely overflow/menu control');
      return true;
    } catch {
      /* try next opener */
    }
  }

  // Right-click near center as context-menu fallback
  try {
    await page.mouse.click(BROWSER_W / 2, BROWSER_H / 2, { button: 'right' });
    await sleep(300);
    console.log('[BrowserService] context-menu via right-click center');
    return true;
  } catch {
    return false;
  }
}

/**
 * DOM click by visible text — finds elements that Playwright role queries miss
 * (portals, custom menu items, spans acting as buttons).
 */
async function domClickByText(label, { clickCount = 1 } = {}) {
  if (!page || !label) return { ok: false, error: 'no_label' };
  const q = String(label).trim();
  try {
    const r = await page.evaluate(
      ({ q, clickCount }) => {
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const want = norm(q);
        if (!want) return { ok: false, error: 'empty' };

        function visible(el) {
          if (!el || !el.getBoundingClientRect) return false;
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return false;
          const st = window.getComputedStyle(el);
          if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
          // Allow slightly offscreen menus (portals)
          const vw = window.innerWidth || 1;
          const vh = window.innerHeight || 1;
          if (r.bottom < -20 || r.right < -20 || r.top > vh + 20 || r.left > vw + 20) return false;
          return true;
        }

        function deepAll(root, out, depth) {
          if (!root || depth > 8) return;
          try {
            const nodes = root.querySelectorAll
              ? root.querySelectorAll('button,a,[role],[tabindex],div,span,li,td,th,label')
              : [];
            for (const n of nodes) out.push(n);
            const hosts = root.querySelectorAll ? root.querySelectorAll('*') : [];
            for (const h of hosts) {
              if (h.shadowRoot) deepAll(h.shadowRoot, out, depth + 1);
            }
          } catch (e) {}
        }

        const candidates = [];
        deepAll(document, candidates, 0);

        let best = null;
        let bestScore = -1;
        for (const el of candidates) {
          if (!visible(el)) continue;
          const lab = norm(
            el.getAttribute('aria-label') ||
              el.getAttribute('title') ||
              el.getAttribute('data-label') ||
              el.innerText ||
              el.textContent ||
              '',
          );
          if (!lab || lab.length > 120) continue;
          let score = -1;
          if (lab === want) score = 100;
          else if (lab.startsWith(want)) score = 80;
          else if (lab.includes(want)) score = 50 - Math.min(20, lab.length / 20);
          else continue;
          // Prefer interactive roles
          const role = (el.getAttribute('role') || '').toLowerCase();
          const tag = el.tagName;
          if (role === 'menuitem' || role === 'option') score += 25;
          if (tag === 'BUTTON' || tag === 'A' || role === 'button') score += 10;
          if (score > bestScore) {
            bestScore = score;
            best = el;
          }
        }

        if (!best) return { ok: false, error: 'text_not_found', want };

        // Climb to clickable parent if we hit a span inside menuitem
        let target = best;
        let d = 0;
        while (target && d < 5) {
          const role = (target.getAttribute('role') || '').toLowerCase();
          if (
            target.tagName === 'BUTTON' ||
            target.tagName === 'A' ||
            role === 'menuitem' ||
            role === 'button' ||
            role === 'option' ||
            target.onclick
          ) {
            break;
          }
          if (target.parentElement) target = target.parentElement;
          else break;
          d++;
        }

        try {
          target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        } catch (e) {}

        const r = target.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        for (let i = 0; i < clickCount; i++) {
          try {
            target.focus({ preventScroll: true });
          } catch (e) {}
          target.dispatchEvent(
            new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }),
          );
          target.dispatchEvent(
            new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }),
          );
          if (typeof target.click === 'function') target.click();
          else
            target.dispatchEvent(
              new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }),
            );
        }

        return {
          ok: true,
          method: 'dom-text-click',
          tag: target.tagName.toLowerCase(),
          role: target.getAttribute('role'),
          name: (target.getAttribute('aria-label') || target.innerText || '').slice(0, 80),
          score: bestScore,
          x,
          y,
        };
      },
      { q, clickCount },
    );
    console.log('[BrowserService] domClickByText', r);
    return r;
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

async function captureAxSnapshot() {
  if (!page || page.isClosed()) {
    return { ok: false, error: 'no_page', elements: [], axTree: '' };
  }

  refMap.clear();
  let ariaText = '';
  let usedAria = false;

  // Prefer Playwright AI snapshot (refs e1, e2, …)
  try {
    if (typeof page._snapshotForAI === 'function') {
      const snap = await page._snapshotForAI({ track: 'response', timeout: 5000 });
      ariaText = typeof snap === 'string' ? snap : snap?.full || snap?.incremental || '';
      if (ariaText) usedAria = true;
    }
  } catch (e) {
    console.warn('[BrowserService] _snapshotForAI failed:', e?.message ?? e);
  }

  // Always also run DOM interactive list for geometry + modal flags
  let domSnap = null;
  try {
    domSnap = await page.evaluate(BUILD_AX_SNAPSHOT_JS);
  } catch (e) {
    console.warn('[BrowserService] DOM ax snapshot failed:', e?.message ?? e);
  }

  const elements = Array.isArray(domSnap?.elements) ? domSnap.elements : [];

  // Map refs to Playwright locators (prefer cssPath, then role+name, then text)
  for (const el of elements) {
    const ref = el.ref || `e${el.id + 1}`;
    let loc = null;
    if (el.cssPath) {
      try {
        loc = page.locator(el.cssPath).first();
      } catch {
        /* ignore */
      }
    }
    if (!loc && el.role && el.name) {
      try {
        loc = page.getByRole(/** @type {any} */ (el.role), { name: String(el.name), exact: false }).first();
      } catch {
        /* ignore */
      }
    }
    if (!loc && el.name) {
      try {
        loc = page.getByText(String(el.name), { exact: false }).first();
      } catch {
        /* ignore */
      }
    }
    // aria-ref from _snapshotForAI when available
    if (!loc && usedAria) {
      try {
        loc = page.locator(`aria-ref=${ref}`);
      } catch {
        /* ignore */
      }
    }
    if (loc) refMap.set(ref, loc);
  }

  const axTree =
    (usedAria && ariaText
      ? `Playwright aria snapshot:\n${String(ariaText).slice(0, 12000)}\n\n`
      : '') +
    (domSnap?.axTree || 'Page interactive elements:\n(none)') +
    `\nengine=playwright-chromium refs=${refMap.size}`;

  lastAxTree = axTree;
  console.log(
    `[BrowserService] AX snapshot elements=${elements.length} refs=${refMap.size} aria=${usedAria} modal=${!!domSnap?.modalBlocking}`,
  );

  return {
    ok: true,
    elements,
    axTree,
    textSample: domSnap?.textSample,
    scroll: domSnap?.scroll,
    count: elements.length,
    viewport: { w: BROWSER_W, h: BROWSER_H },
    modalBlocking: !!domSnap?.modalBlocking,
    modalCount: domSnap?.modalCount ?? 0,
    closeRefs: domSnap?.closeRefs || [],
    modals: domSnap?.modals,
    engine: 'playwright-chromium',
  };
}

/**
 * Click with short-timeout multi-strategy resolution.
 * Does NOT wait 8s on a single giant locator — tries candidates quickly,
 * opens overflow menus for "Delete Message"-style items, DOM text fallback.
 */
async function smartClick(opts = {}) {
  if (!(await ensureReady()) || !page) return { ok: false, error: 'no_browser' };

  const force = opts.force !== false;
  const clickCount = Math.max(1, Math.min(3, Number(opts.clickCount) || 1));
  const button = String(opts.button || 'left');
  const hoverFirst = opts.hover === true || opts.hoverFirst === true || opts.hoverBefore === true;
  const label =
    (opts.text != null ? String(opts.text) : '') ||
    (opts.name != null ? String(opts.name) : '') ||
    (opts.label != null ? String(opts.label) : '');

  let candidates = buildLocatorCandidates(opts);
  console.log(
    `[BrowserService] PW click candidates=${candidates.length} ref=${opts.ref || '-'} label=${(label || '-').slice(0, 40)} force=${force} hover=${hoverFirst}`,
  );

  if (candidates.length === 0) {
    const snap = await captureAxSnapshot().catch(() => null);
    return {
      ok: false,
      error: 'no_target',
      candidates: snap?.elements?.slice?.(0, 12),
      axTree: snap?.axTree || lastAxTree,
    };
  }

  // Pure coordinate path
  const coord = candidates.find((c) => c.method === 'coords' && c.x != null);
  if (coord && candidates.every((c) => c.method === 'coords' || !c.locator)) {
    try {
      setCursorPosition(coord.x, coord.y, { force: true, phase: 'click' });
      await page.mouse.move(coord.x, coord.y, { steps: 8 }).catch(() => {});
      await page.mouse.click(coord.x, coord.y, {
        button: /** @type {any} */ (button),
        clickCount,
      });
      setCursorPosition(coord.x, coord.y, { force: true, phase: 'click' });
      await sleep(150);
      await captureOnce('after-click');
      const ax = await captureAxSnapshot().catch(() => null);
      return {
        ok: true,
        method: 'playwright-mouse-coords',
        x: coord.x / BROWSER_W,
        y: coord.y / BROWSER_H,
        px: { x: coord.x, y: coord.y },
        axTree: ax?.axTree,
        elements: ax?.elements?.slice?.(0, 40),
        url: page.url(),
        title: await page.title().catch(() => ''),
      };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }

  async function tryClickLocator(loc, method) {
    if (!loc) return false;
    // Quick visibility check with short timeout — skip dead candidates fast
    const visible = await loc.isVisible({ timeout: 600 }).catch(() => false);
    if (!visible) {
      // Still try force click once with short timeout (hidden menu items)
      try {
        const hb = await loc.boundingBox().catch(() => null);
        if (hb) setCursorPosition(hb.x + hb.width / 2, hb.y + hb.height / 2, { force: true, phase: 'click' });
        await loc.click({
          force: true,
          timeout: 1200,
          clickCount,
          button: /** @type {any} */ (button),
        });
        console.log(`[BrowserService] click ok (hidden/force) method=${method}`);
        return true;
      } catch {
        return false;
      }
    }

    if (hoverFirst) {
      await loc.hover({ force: true, timeout: 1500 }).catch(() => {});
      const hb = await loc.boundingBox().catch(() => null);
      if (hb) setCursorPosition(hb.x + hb.width / 2, hb.y + hb.height / 2, { force: true, phase: 'hover' });
      await sleep(Number(opts.hoverMs) > 0 ? Math.min(2000, Number(opts.hoverMs)) : 280);
    }

    await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    const box = await loc.boundingBox().catch(() => null);
    if (box) {
      setCursorPosition(box.x + box.width / 2, box.y + box.height / 2, { force: true, phase: 'click' });
    }

    try {
      await loc.click({
        force,
        timeout: 2500,
        clickCount,
        button: /** @type {any} */ (button),
      });
      console.log(`[BrowserService] click ok method=${method}`);
      return true;
    } catch {
      try {
        await loc.click({
          force: true,
          timeout: 2000,
          clickCount,
          button: /** @type {any} */ (button),
        });
        console.log(`[BrowserService] click ok (force) method=${method}`);
        return true;
      } catch {
        try {
          await loc.evaluate((el, n) => {
            el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            for (let i = 0; i < n; i++) {
              if (typeof el.click === 'function') el.click();
              else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            }
          }, clickCount);
          console.log(`[BrowserService] click ok (evaluate) method=${method}`);
          return true;
        } catch {
          return false;
        }
      }
    }
  }

  // Pass 1: try each locator candidate quickly
  let usedMethod = null;
  for (const c of candidates) {
    if (c.method === 'coords') continue;
    if (!c.locator) continue;
    const ok = await tryClickLocator(c.locator, c.method);
    if (ok) {
      usedMethod = c.method;
      break;
    }
  }

  // Pass 2: menu-item labels → open ⋯ / context menu, rebuild candidates, retry
  if (!usedMethod && label && MENU_ITEM_HINT.test(label)) {
    const opened = await tryRevealMenuForLabel(label);
    if (opened) {
      // Refresh refs after menu opens
      await captureAxSnapshot().catch(() => {});
      candidates = buildLocatorCandidates(opts);
      for (const c of candidates) {
        if (c.method === 'coords' || !c.locator) continue;
        const ok = await tryClickLocator(c.locator, c.method + '+after-menu');
        if (ok) {
          usedMethod = c.method + '+after-menu';
          break;
        }
      }
    }
  }

  // Pass 3: DOM deep text search (portals, custom menus)
  let domResult = null;
  if (!usedMethod && label) {
    domResult = await domClickByText(label, { clickCount });
    if (domResult?.ok) usedMethod = 'dom-text';
  }

  // Pass 4: if still failing and we have coords, click there
  if (!usedMethod && coord) {
    try {
      await page.mouse.click(coord.x, coord.y, {
        button: /** @type {any} */ (button),
        clickCount,
      });
      usedMethod = 'coords-fallback';
    } catch {
      /* ignore */
    }
  }

  await sleep(180);
  await captureOnce('after-click');
  const ax = await captureAxSnapshot().catch(() => null);
  lastUrl = page.url();
  lastTitle = await page.title().catch(() => lastTitle);

  if (!usedMethod) {
    console.warn('[BrowserService] smartClick all strategies failed for', label || opts.ref);
    return {
      ok: false,
      error: 'click_timeout_all_strategies',
      message:
        'Could not find/click target. If it only appears on hover: browser_hover the parent (⋯/More), then browser_click the item. Or pass hover=true on the parent first.',
      label,
      tried: candidates.map((c) => c.method),
      axTree: ax?.axTree || lastAxTree,
      elements: ax?.elements?.slice?.(0, 40),
      candidates: ax?.elements?.slice?.(0, 15),
    };
  }

  return {
    ok: true,
    method: `playwright-${usedMethod}${force ? '+force' : ''}`,
    resolveMethod: usedMethod,
    ref: opts.ref,
    label,
    dom: domResult,
    axTree: ax?.axTree,
    elements: ax?.elements?.slice?.(0, 40),
    modalBlocking: ax?.modalBlocking,
    url: lastUrl,
    title: lastTitle,
  };
}

/**
 * Smart checkbox / radio / switch control (incl. captcha / "I'm not a robot").
 * Prefer Playwright setChecked; fall back to real mouse click + DOM force.
 * @param {object} opts
 * @param {boolean} [opts.checked] - desired state (true=on, false=off). Omit to toggle.
 * @param {boolean} [opts.check] - alias for checked:true
 * @param {boolean} [opts.uncheck] - alias for checked:false
 * @param {boolean} [opts.toggle] - force toggle regardless of current state
 */
async function smartCheck(opts = {}) {
  if (!(await ensureReady()) || !page) return { ok: false, error: 'no_browser' };

  let desired = null; // null = toggle
  if (opts.toggle === true) desired = null;
  else if (opts.uncheck === true || opts.checked === false || opts.check === false) desired = false;
  else if (opts.check === true || opts.checked === true) desired = true;
  else if (typeof opts.checked === 'boolean') desired = opts.checked;
  else if (typeof opts.value === 'boolean') desired = opts.value;
  else if (opts.state != null) {
    const s = String(opts.state).toLowerCase();
    if (s === 'on' || s === 'checked' || s === 'true' || s === 'yes' || s === '1') desired = true;
    else if (s === 'off' || s === 'unchecked' || s === 'false' || s === 'no' || s === '0') desired = false;
  }

  const label =
    (opts.text != null ? String(opts.text) : '') ||
    (opts.name != null ? String(opts.name) : '') ||
    (opts.label != null ? String(opts.label) : '') ||
    (opts.field != null ? String(opts.field) : '');

  const captchaHint =
    opts.captcha === true ||
    opts.recaptcha === true ||
    /captcha|recaptcha|hcaptcha|i.?m not a robot|not a robot|verify you.?re human/i.test(label);

  console.log(
    `[BrowserService] smartCheck desired=${desired === null ? 'toggle' : desired} captcha=${captchaHint} label=${(label || '-').slice(0, 40)} ref=${opts.ref || '-'}`,
  );

  // Build checkbox-oriented locator candidates first
  /** @type {import('playwright').Locator[]} */
  const locs = [];
  const push = (loc) => {
    if (loc) locs.push(loc);
  };

  if (opts.ref && refMap.has(String(opts.ref).replace(/^@/, ''))) {
    push(refMap.get(String(opts.ref).replace(/^@/, '')));
  }
  if (opts.selector) {
    push(page.locator(String(opts.selector)).first());
  }

  // Captcha / "I'm not a robot" frames + anchors (reCAPTCHA, hCaptcha, Turnstile-ish)
  if (captchaHint) {
    const captchaSelectors = [
      'iframe[src*="recaptcha"]',
      'iframe[title*="reCAPTCHA" i]',
      'iframe[src*="hcaptcha"]',
      'iframe[title*="hCaptcha" i]',
      'iframe[src*="challenges.cloudflare"]',
      '.g-recaptcha',
      '#rc-anchor-container',
      '.recaptcha-checkbox',
      '#recaptcha-anchor',
      '.rc-anchor-checkbox',
      '[data-sitekey]',
      'div[role="presentation"] .recaptcha-checkbox-border',
    ];
    for (const sel of captchaSelectors) {
      push(page.locator(sel).first());
    }
    // reCAPTCHA often lives in a child frame
    try {
      const frames = page.frames();
      for (const fr of frames) {
        const u = fr.url() || '';
        if (!/recaptcha|hcaptcha|challenges\.cloudflare/i.test(u)) continue;
        try {
          push(fr.locator('#recaptcha-anchor, .recaptcha-checkbox, .rc-anchor-checkbox, #checkbox, div[role="checkbox"]').first());
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (label) {
    try {
      push(page.getByRole('checkbox', { name: label, exact: false }).first());
    } catch {
      /* ignore */
    }
    try {
      push(page.getByRole('switch', { name: label, exact: false }).first());
    } catch {
      /* ignore */
    }
    try {
      push(page.getByRole('radio', { name: label, exact: false }).first());
    } catch {
      /* ignore */
    }
    try {
      push(page.getByLabel(label, { exact: false }).first());
    } catch {
      /* ignore */
    }
    // Label text near checkbox
    push(page.locator(`label:has-text("${label.replace(/"/g, '\\"')}")`).first());
    push(page.getByText(label, { exact: false }).first());
    // Common captcha label variants
    if (/robot|human|captcha/i.test(label)) {
      try {
        push(page.getByText(/i.?m not a robot|not a robot|verify you.?re human/i).first());
      } catch {
        /* ignore */
      }
    }
  }
  // Generic candidates from resolveLocator
  for (const c of buildLocatorCandidates({
    ...opts,
    role: opts.role || 'checkbox',
    text: label || opts.text,
    name: label || opts.name,
  })) {
    if (c.locator) push(c.locator);
  }
  // Also try switch/radio roles without label
  try {
    push(page.getByRole('checkbox').first());
  } catch {
    /* ignore */
  }

  let used = null;
  let before = null;
  let after = null;
  let method = null;

  async function readState(loc) {
    try {
      return await loc.evaluate((el) => {
        function findControl(n) {
          if (!n) return null;
          if (n.tagName === 'INPUT') {
            const t = (n.type || '').toLowerCase();
            if (t === 'checkbox' || t === 'radio') return n;
          }
          if (n.getAttribute?.('role') === 'checkbox' || n.getAttribute?.('role') === 'switch' || n.getAttribute?.('role') === 'radio') {
            return n;
          }
          const inner = n.querySelector?.('input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="switch"], [role="radio"]');
          if (inner) return inner;
          // label[for]
          if (n.tagName === 'LABEL' && n.htmlFor) {
            const t = document.getElementById(n.htmlFor);
            if (t) return t;
          }
          if (n.tagName === 'LABEL' && n.control) return n.control;
          return n;
        }
        const c = findControl(el) || el;
        if (c.tagName === 'INPUT' && (c.type === 'checkbox' || c.type === 'radio')) {
          return {
            kind: c.type,
            checked: !!c.checked,
            disabled: !!c.disabled,
            name: c.getAttribute('name') || c.getAttribute('aria-label') || '',
            id: c.id || '',
          };
        }
        const role = (c.getAttribute('role') || '').toLowerCase();
        if (role === 'checkbox' || role === 'switch' || role === 'radio') {
          const ac = c.getAttribute('aria-checked');
          return {
            kind: role,
            checked: ac === 'true' || ac === 'mixed',
            disabled: c.getAttribute('aria-disabled') === 'true',
            name: c.getAttribute('aria-label') || (c.innerText || '').slice(0, 80),
            id: c.id || '',
          };
        }
        // Custom toggle classes
        const cls = typeof c.className === 'string' ? c.className : '';
        const pressed = c.getAttribute('aria-pressed') === 'true';
        const on = /is-checked|is-on|checked|active|selected|on\b/i.test(cls) || pressed;
        return {
          kind: 'custom',
          checked: on,
          disabled: false,
          name: (c.getAttribute('aria-label') || c.innerText || '').slice(0, 80),
          id: c.id || '',
        };
      });
    } catch {
      return null;
    }
  }

  for (const loc of locs) {
    try {
      const vis = await loc.isVisible({ timeout: 800 }).catch(() => false);
      // Hidden native checkboxes are common (custom styled) — still try setChecked
      before = await readState(loc);

      if (desired === null) {
        // toggle
        if (before && typeof before.checked === 'boolean') {
          desired = !before.checked;
        } else {
          desired = true; // default check if unknown
        }
      }

      // Move 3D cursor onto control when we have a box
      const box = await loc.boundingBox().catch(() => null);
      if (box) {
        setCursorPosition(box.x + box.width / 2, box.y + box.height / 2, {
          force: true,
          phase: 'check',
        });
      }

      // Captcha anchors: prefer real mouse click (setChecked often fails / is blocked)
      if (captchaHint || (before && before.kind === 'custom')) {
        try {
          if (box) {
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          } else {
            await loc.click({ force: true, timeout: 2500 });
          }
          await sleep(180);
          after = await readState(loc);
          used = loc;
          method = box ? 'mouse-click-captcha' : 'click-captcha';
          // Captcha often has no reliable checked state until solved
          if (!after || after.checked === desired || captchaHint) break;
        } catch (e) {
          console.warn('[BrowserService] captcha click failed:', e?.message ?? e);
        }
      }

      // Playwright setChecked (best for real inputs) — skip pure captcha frames when already clicked
      if (!used) {
        try {
          await loc.setChecked(desired, { force: true, timeout: 3500 });
          after = await readState(loc);
          if (after && after.checked === desired) {
            used = loc;
            method = 'playwright-setChecked';
            break;
          }
        } catch (e) {
          console.warn('[BrowserService] setChecked failed:', e?.message ?? e);
        }
      }

      // Click label / control with real mouse first (better for custom + captcha UI)
      try {
        if (box) {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          setCursorPosition(box.x + box.width / 2, box.y + box.height / 2, {
            force: true,
            phase: 'check',
          });
        } else {
          await loc.click({ force: true, timeout: 2500 });
        }
        await sleep(100);
        after = await readState(loc);
        if (after && typeof after.checked === 'boolean') {
          if (after.checked === desired) {
            used = loc;
            method = box ? 'mouse-click' : 'click';
            break;
          }
          // Wrong state after click — click again once (toggle UIs)
          if (box) {
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          } else {
            await loc.click({ force: true, timeout: 2000 });
          }
          await sleep(100);
          after = await readState(loc);
          if (after && after.checked === desired) {
            used = loc;
            method = 'click-x2';
            break;
          }
        } else {
          // No readable state — assume click worked (common for captcha)
          used = loc;
          method = 'click-unverified';
          break;
        }
      } catch {
        /* try next loc */
      }
    } catch {
      /* next */
    }
  }

  // Coords path last (or early for captcha-only aims) — AI vision often provides x,y
  if (!used && opts.x != null && opts.y != null) {
    const nx = Number(opts.x);
    const ny = Number(opts.y);
    const cx = nx >= 0 && nx <= 1 ? Math.round(nx * (BROWSER_W - 1)) : Math.round(nx);
    const cy = ny >= 0 && ny <= 1 ? Math.round(ny * (BROWSER_H - 1)) : Math.round(ny);
    console.log(`[BrowserService] smartCheck coords fallback ${cx},${cy}`);
    try {
      setCursorPosition(cx, cy, { force: true, phase: 'check' });
      await page.mouse.move(cx, cy, { steps: 10 });
      await page.mouse.click(cx, cy);
      await sleep(200);
      used = true;
      method = 'playwright-mouse-coords-check';
      after = { checked: undefined, kind: captchaHint ? 'captcha' : 'coords' };
    } catch (e) {
      console.warn('[BrowserService] coord check failed:', e?.message ?? e);
    }
  }

  // DOM fallback by label text
  if (!used && label) {
    try {
      const r = await page.evaluate(
        ({ q, want }) => {
          const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
          const wantL = norm(q);

          function visible(el) {
            if (!el?.getBoundingClientRect) return false;
            const r = el.getBoundingClientRect();
            if (r.width < 1 || r.height < 1) return false;
            const st = window.getComputedStyle(el);
            if (st.display === 'none' || st.visibility === 'hidden') return false;
            return true;
          }

          function isCheckable(el) {
            if (!el) return false;
            if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) return true;
            const role = (el.getAttribute('role') || '').toLowerCase();
            return role === 'checkbox' || role === 'switch' || role === 'radio';
          }

          function readChecked(el) {
            if (el.tagName === 'INPUT') return !!el.checked;
            const ac = el.getAttribute('aria-checked');
            if (ac === 'true') return true;
            if (ac === 'false') return false;
            return /is-checked|checked|active|on\b/i.test(el.className || '');
          }

          function setNative(el, on) {
            if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
              if (el.checked === on) return true;
              // React-friendly
              const proto = window.HTMLInputElement.prototype;
              const desc = Object.getOwnPropertyDescriptor(proto, 'checked');
              if (desc?.set) desc.set.call(el, on);
              else el.checked = on;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
              return el.checked === on;
            }
            return false;
          }

          let control = null;
          // 1) label text match
          for (const lab of document.querySelectorAll('label')) {
            if (!visible(lab) && !lab.htmlFor) continue;
            const t = norm(lab.innerText || lab.textContent);
            if (!t.includes(wantL)) continue;
            if (lab.control && isCheckable(lab.control)) {
              control = lab.control;
              break;
            }
            if (lab.htmlFor) {
              const el = document.getElementById(lab.htmlFor);
              if (el && isCheckable(el)) {
                control = el;
                break;
              }
            }
            const inner = lab.querySelector('input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="switch"]');
            if (inner) {
              control = inner;
              break;
            }
          }
          // 2) aria-label / name on inputs
          if (!control) {
            for (const el of document.querySelectorAll(
              'input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="switch"], [role="radio"]',
            )) {
              const nm = norm(
                el.getAttribute('aria-label') ||
                  el.getAttribute('name') ||
                  el.getAttribute('title') ||
                  el.id ||
                  '',
              );
              if (nm.includes(wantL) || wantL.includes(nm)) {
                control = el;
                break;
              }
            }
          }
          // 3) text node near checkbox
          if (!control) {
            const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
            let n;
            while ((n = walk.nextNode())) {
              if (!visible(n)) continue;
              const t = norm(n.innerText || '');
              if (t.length > 80 || !t.includes(wantL)) continue;
              const near = n.querySelector?.('input[type="checkbox"], input[type="radio"], [role="checkbox"]');
              if (near) {
                control = near;
                break;
              }
              // previous sibling input
              let p = n.previousElementSibling;
              if (p && isCheckable(p)) {
                control = p;
                break;
              }
            }
          }

          if (!control) return { ok: false, error: 'checkbox_not_found' };

          const before = readChecked(control);
          let target = want;
          if (target === null || target === undefined) target = !before;

          if (isCheckable(control) && control.tagName === 'INPUT') {
            setNative(control, !!target);
          } else {
            // ARIA / custom: click until matches
            control.click();
            if (readChecked(control) !== !!target) control.click();
          }

          return {
            ok: true,
            method: 'dom-check',
            before,
            after: readChecked(control),
            desired: !!target,
            tag: control.tagName.toLowerCase(),
            type: control.type || control.getAttribute('role') || '',
            name: (control.getAttribute('aria-label') || control.name || control.id || '').slice(0, 80),
          };
        },
        { q: label, want: desired },
      );
      if (r?.ok) {
        method = r.method;
        before = { checked: r.before };
        after = { checked: r.after, name: r.name, kind: r.type };
        used = true;
      }
    } catch (e) {
      console.warn('[BrowserService] dom check failed:', e?.message ?? e);
    }
  }

  await sleep(100);
  await captureOnce('after-check');
  const ax = await captureAxSnapshot().catch(() => null);

  if (!used) {
    return {
      ok: false,
      error: 'checkbox_not_found',
      message:
        'Could not find checkbox/switch/radio. Call browser_snapshot and use ref of a checkbox, or pass label text (e.g. "I agree").',
      desired,
      label,
      axTree: ax?.axTree || lastAxTree,
      elements: ax?.elements?.slice?.(0, 40),
    };
  }

  const finalChecked = after?.checked;
  const ok =
    desired === null ||
    finalChecked === undefined ||
    finalChecked === desired ||
    method === 'click-unverified' ||
    method === 'mouse-click-captcha' ||
    method === 'click-captcha' ||
    method === 'playwright-mouse-coords-check' ||
    captchaHint;

  console.log(
    `[BrowserService] smartCheck done method=${method} before=${before?.checked} after=${finalChecked} desired=${desired} captcha=${captchaHint}`,
  );

  return {
    ok,
    action: 'check',
    method,
    desired: desired === null ? 'toggle' : desired,
    checked: finalChecked,
    before: before?.checked,
    after: finalChecked,
    kind: after?.kind || before?.kind,
    name: after?.name || before?.name || label,
    captcha: captchaHint,
    x: lastMouseX / Math.max(BROWSER_W - 1, 1),
    y: lastMouseY / Math.max(BROWSER_H - 1, 1),
    px: { x: lastMouseX, y: lastMouseY },
    axTree: ax?.axTree,
    elements: ax?.elements?.slice?.(0, 40),
    url: page.url(),
    title: await page.title().catch(() => lastTitle),
    instruction: ok
      ? captchaHint
        ? `Captcha/checkbox interaction done (method=${method}). If a challenge grid appeared, use vision + browser_click on tiles, then re-check.`
        : `Checkbox is now ${finalChecked ? 'checked' : 'unchecked'}.`
      : 'State may not have changed — try browser_snapshot and click the control ref, pass x,y for captcha boxes, or checked=true/false explicitly.',
  };
}

/**
 * Find best editable locator for chat/search/forms.
 * Tries explicit target, then role textbox/searchbox, then contenteditable, then focused.
 */
function resolveEditableLocator(opts = {}) {
  if (!page) return null;

  const hasTarget =
    opts.ref != null ||
    opts.elementId != null ||
    opts.selector ||
    opts.label ||
    opts.field ||
    opts.placeholder ||
    opts.role ||
    opts.name ||
    opts.x != null;

  if (hasTarget) {
    const r = resolveLocator({
      ref: opts.ref,
      elementId: opts.elementId,
      selector: opts.selector,
      role: opts.role || 'textbox',
      name: opts.name || opts.label || opts.field || opts.placeholder,
      text: opts.label || opts.field || opts.placeholder || opts.name,
      x: opts.x,
      y: opts.y,
    });
    if (r?.locator) return r;
    // Retry without forcing textbox role
    const r2 = resolveLocator({
      ref: opts.ref,
      elementId: opts.elementId,
      selector: opts.selector,
      name: opts.name || opts.label || opts.field || opts.placeholder,
      text: opts.label || opts.field || opts.placeholder,
      x: opts.x,
      y: opts.y,
    });
    if (r2?.locator) return r2;
  }

  // Heuristic: visible chat/search composers
  try {
    const chat = page
      .locator(
        [
          '[contenteditable="true"]',
          '[role="textbox"]',
          'textarea',
          'input[type="text"]',
          'input[type="search"]',
          'input:not([type])',
          'input[type="email"]',
          'div[role="textbox"]',
          '[data-testid*="message" i]',
          '[data-testid*="composer" i]',
          '[data-testid*="chat" i]',
          '[aria-label*="message" i]',
          '[aria-label*="Message" i]',
          '[placeholder*="message" i]',
          '[placeholder*="Message" i]',
          '[placeholder*="Search" i]',
          '[placeholder*="Type" i]',
        ].join(', '),
      )
      .filter({ hasNot: page.locator('[disabled], [aria-disabled="true"]') })
      .last();
    return { locator: chat, method: 'editable-heuristic' };
  } catch {
    return null;
  }
}

async function readActiveValue() {
  if (!page) return null;
  try {
    return await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return String(el.value || '').slice(0, 500);
      if (el.isContentEditable) return String(el.innerText || el.textContent || '').slice(0, 500);
      // Walk up to contenteditable parent (chat apps nest spans)
      let n = el.parentElement;
      let d = 0;
      while (n && d < 6) {
        if (n.isContentEditable) return String(n.innerText || n.textContent || '').slice(0, 500);
        n = n.parentElement;
        d++;
      }
      return null;
    });
  } catch {
    return null;
  }
}

/**
 * Insert text into chat/search/forms with multiple strategies.
 * Order optimized for React/DraftJS/contenteditable chat composers.
 */
async function insertTextIntoFocused(text, { locator = null, append = false } = {}) {
  const methods = [];
  const t = String(text);

  // 1) Playwright fill (best for input/textarea; often fails on contenteditable)
  if (locator && !append) {
    try {
      await locator.fill(t, { timeout: 4000, force: true });
      methods.push('fill');
      const after = await readActiveValue();
      if (after != null && (after.includes(t.slice(0, Math.min(12, t.length))) || after.length >= t.length * 0.5)) {
        return { ok: true, method: methods.join('+'), valueAfter: after };
      }
    } catch (e) {
      methods.push('fill-fail');
      console.warn('[BrowserService] fill failed:', e?.message ?? e);
    }
  }

  // 2) pressSequentially — fires real key events (chat apps love this)
  try {
    if (locator) {
      await locator.click({ force: true, timeout: 3000 }).catch(() => {});
    }
    if (!append) {
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await sleep(20);
      await page.keyboard.press('Backspace');
      await sleep(20);
    }
    await page.keyboard.insertText(t);
    methods.push('keyboard.insertText');
    let after = await readActiveValue();
    if (after != null && (after.includes(t.slice(0, Math.min(12, t.length))) || t.length === 0)) {
      return { ok: true, method: methods.join('+'), valueAfter: after };
    }
    // Some apps ignore insertText — fall through to type
    await page.keyboard.type(t, { delay: 8 });
    methods.push('keyboard.type');
    after = await readActiveValue();
    if (after != null && after.includes(t.slice(0, Math.min(8, t.length)))) {
      return { ok: true, method: methods.join('+'), valueAfter: after };
    }
  } catch (e) {
    methods.push('keyboard-fail');
    console.warn('[BrowserService] keyboard insert failed:', e?.message ?? e);
  }

  // 3) pressSequentially on locator
  if (locator) {
    try {
      if (!append) await locator.fill('').catch(() => {});
      await locator.pressSequentially(t, { delay: 10, timeout: 15000 });
      methods.push('pressSequentially');
      const after = await readActiveValue();
      if (after != null && after.includes(t.slice(0, Math.min(8, t.length)))) {
        return { ok: true, method: methods.join('+'), valueAfter: after };
      }
    } catch (e) {
      methods.push('pressSequentially-fail');
      console.warn('[BrowserService] pressSequentially failed:', e?.message ?? e);
    }
  }

  // 4) DOM + React native value setter + contenteditable execCommand / beforeinput
  try {
    const r = await page.evaluate(
      ({ text, append }) => {
        function findEditable() {
          let el = document.activeElement;
          const isEd = (n) => {
            if (!n || n.nodeType !== 1) return false;
            if (n.tagName === 'TEXTAREA') return true;
            if (n.tagName === 'INPUT') {
              const t = (n.type || 'text').toLowerCase();
              return !['button', 'submit', 'checkbox', 'radio', 'file', 'image', 'reset', 'hidden', 'range', 'color'].includes(t);
            }
            if (n.isContentEditable) return true;
            return false;
          };
          if (!isEd(el)) {
            let n = el;
            let d = 0;
            while (n && d < 8) {
              if (isEd(n)) {
                el = n;
                break;
              }
              n = n.parentElement;
              d++;
            }
          }
          if (!isEd(el)) {
            const nodes = document.querySelectorAll(
              'textarea, input:not([type]), input[type="text"], input[type="search"], [contenteditable="true"], [role="textbox"]',
            );
            for (const n of nodes) {
              const r = n.getBoundingClientRect();
              if (r.width > 20 && r.height > 10) {
                el = n;
                break;
              }
            }
          }
          return isEd(el) ? el : null;
        }

        const el = findEditable();
        if (!el) return { ok: false, error: 'no_editable' };

        try {
          el.focus({ preventScroll: true });
        } catch (e) {
          try {
            el.focus();
          } catch (e2) {}
        }

        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          const proto = el.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          const prev = append ? String(el.value || '') : '';
          const next = prev + text;
          if (desc && desc.set) desc.set.call(el, next);
          else el.value = next;
          try {
            el.setSelectionRange(next.length, next.length);
          } catch (e) {}
          el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: text, inputType: 'insertText' }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, method: 'react-value-setter', value: String(el.value || '').slice(0, 400) };
        }

        // contenteditable / role=textbox (chat)
        if (!append) {
          try {
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(el);
            sel.removeAllRanges();
            sel.addRange(range);
            document.execCommand('delete');
          } catch (e) {}
        }
        let ok = false;
        try {
          ok = document.execCommand('insertText', false, text);
        } catch (e) {}
        if (!ok) {
          try {
            el.dispatchEvent(
              new InputEvent('beforeinput', {
                bubbles: true,
                cancelable: true,
                inputType: 'insertText',
                data: text,
              }),
            );
          } catch (e) {}
          // Fallback: text node
          if (!(el.innerText || '').includes(text.slice(0, 8))) {
            el.textContent = (append ? el.textContent || '' : '') + text;
          }
        }
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: text, inputType: 'insertText' }));
        return {
          ok: true,
          method: ok ? 'execCommand-insertText' : 'contenteditable-fallback',
          value: String(el.innerText || el.textContent || '').slice(0, 400),
        };
      },
      { text: t, append },
    );
    methods.push(r?.method || 'dom');
    if (r?.ok) {
      return { ok: true, method: methods.join('+'), valueAfter: r.value };
    }
  } catch (e) {
    methods.push('dom-fail');
    console.warn('[BrowserService] DOM insert failed:', e?.message ?? e);
  }

  const valueAfter = await readActiveValue();
  return {
    ok: valueAfter != null && String(valueAfter).length > 0,
    method: methods.join('+') || 'none',
    valueAfter,
  };
}

/**
 * Press Enter / submit in chat apps: keyboard Enter, then Send button fallback.
 */
async function pressEnterOrSubmit(opts = {}) {
  if (!page) return { ok: false, error: 'no_browser' };

  // Ensure focus in composer if ref provided
  if (opts.ref || opts.selector || opts.label || opts.elementId != null) {
    const ed = resolveEditableLocator(opts);
    if (ed?.locator) {
      await ed.locator.click({ force: true, timeout: 4000 }).catch(() => {});
    }
  }

  const beforeUrl = page.url();
  const strategies = [];

  // 1) Enter key (most chat apps)
  try {
    await page.keyboard.press('Enter');
    strategies.push('Enter');
    await sleep(120);
  } catch (e) {
    strategies.push('Enter-fail');
  }

  // 2) NumpadEnter
  try {
    await page.keyboard.press('NumpadEnter');
    strategies.push('NumpadEnter');
  } catch {
    /* ignore */
  }

  await sleep(150);

  // 3) If still looks like text stuck in field, click Send/Submit near composer
  try {
    const send = page
      .getByRole('button', { name: /^(send|submit|search|go|post|reply|tweet|ask|generate)$/i })
      .or(page.locator('button[type="submit"]'))
      .or(page.locator('[data-testid*="send" i], [aria-label*="Send" i], [aria-label*="send" i]'))
      .first();
    if (await send.isVisible({ timeout: 600 }).catch(() => false)) {
      await send.click({ force: true, timeout: 3000 });
      strategies.push('send-button');
    }
  } catch {
    /* ignore */
  }

  // 4) form.requestSubmit on focused field
  try {
    await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return;
      const form = el.closest && el.closest('form');
      if (form) {
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
      }
      // Chat: dispatch keydown Enter on contenteditable (some only listen there)
      el.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }),
      );
      el.dispatchEvent(
        new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }),
      );
    });
    strategies.push('form-or-keydown');
  } catch {
    /* ignore */
  }

  await sleep(200);
  await captureOnce('after-enter');
  const afterUrl = page.url();
  console.log('[BrowserService] pressEnter strategies=', strategies.join('+'), 'nav=', beforeUrl !== afterUrl);

  return {
    ok: true,
    method: strategies.join('+'),
    navigated: beforeUrl !== afterUrl,
    url: afterUrl,
  };
}

async function smartType(opts = {}) {
  if (!(await ensureReady()) || !page) return { ok: false, error: 'no_browser' };

  const text = String(opts.text ?? '');
  const clearOnly = !!opts.clearOnly;
  if (!text && !clearOnly) return { ok: false, error: 'empty_text' };

  const append = !!opts.append;
  const shouldClear = !append && (!!opts.clearOnly || !!opts.clear || !!opts.replace);
  const pressEnter =
    opts.pressEnter === true ||
    opts.submit === true ||
    opts.enter === true ||
    String(opts.submit || '').toLowerCase() === 'true';

  console.log(
    `[BrowserService] smartType len=${text.length} clear=${shouldClear} append=${append} pressEnter=${pressEnter} ref=${opts.ref || '-'}`,
  );

  const resolved = resolveEditableLocator(opts);
  let focused = null;

  // Always try to focus an editable (chat composers often need an explicit click)
  if (resolved?.locator) {
    try {
      await resolved.locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await resolved.locator.click({ force: true, timeout: 5000 });
      focused = { ok: true, method: resolved.method || 'editable' };
    } catch (e) {
      console.warn('[BrowserService] focus editable failed:', e?.message ?? e);
      // Click center of page bottom (common chat bar) as last resort
      try {
        await page.mouse.click(BROWSER_W / 2, BROWSER_H - 48);
        focused = { ok: true, method: 'bottom-click-focus' };
      } catch {
        focused = { ok: false, error: String(e?.message ?? e) };
      }
    }
  } else {
    // No target: focus whatever is already active, or bottom composer
    try {
      const active = await page.evaluate(() => {
        const el = document.activeElement;
        return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      });
      if (!active) {
        await page.mouse.click(BROWSER_W / 2, BROWSER_H - 48);
      }
      focused = { ok: true, method: active ? 'already-focused' : 'bottom-click' };
    } catch {
      focused = { ok: false };
    }
  }

  try {
    if (shouldClear || clearOnly) {
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await sleep(30);
      await page.keyboard.press('Backspace');
      await page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return;
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          const proto = el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc?.set) desc.set.call(el, '');
          else el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (el.isContentEditable) {
          el.innerHTML = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
    }

    if (clearOnly) {
      await captureOnce('after-clear');
      return { ok: true, action: 'clear', focused };
    }

    const inserted = await insertTextIntoFocused(text, {
      locator: resolved?.locator || null,
      append,
    });

    // Verify; if empty, one more hard keyboard pass
    let valueAfter = inserted.valueAfter ?? (await readActiveValue());
    if (!valueAfter || (text.length > 2 && !String(valueAfter).includes(text.slice(0, 3)))) {
      console.warn('[BrowserService] type verify weak, re-type via keyboard');
      await page.keyboard.type(text, { delay: 15 });
      valueAfter = await readActiveValue();
      inserted.method = (inserted.method || '') + '+retype';
    }

    await sleep(50);
    await captureOnce('after-type');

    let enterResult = null;
    if (pressEnter) {
      enterResult = await pressEnterOrSubmit(opts);
    }

    console.log(
      `[BrowserService] type done method=${inserted.method} after=${String(valueAfter || '').slice(0, 50)} enter=${!!pressEnter}`,
    );

    return {
      ok: inserted.ok !== false || Boolean(valueAfter),
      action: pressEnter ? 'type+enter' : 'type',
      method: inserted.method,
      length: text.length,
      cleared: !!shouldClear,
      focused,
      valueAfter,
      pressEnter: !!pressEnter,
      enter: enterResult,
      ref: opts.ref,
      url: page.url(),
      title: await page.title().catch(() => lastTitle),
    };
  } catch (e) {
    console.error('[BrowserService] smartType error:', e);
    return { ok: false, error: String(e?.message ?? e) };
  }
}

async function smartKey(opts = {}) {
  if (!(await ensureReady()) || !page) return { ok: false, error: 'no_browser' };

  let key = String(opts.key || opts.chord || '').trim();
  if (!key) return { ok: false, error: 'missing_key' };

  const lower = key.toLowerCase();
  if (lower === 'delete_all' || lower === 'clear' || lower === 'select_all_delete') {
    if (opts.ref || opts.elementId != null || opts.selector || opts.label) {
      await smartType({ ...opts, clearOnly: true, text: '' });
    } else {
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await page.keyboard.press('Backspace');
    }
    await captureOnce('after-key-clear');
    return { ok: true, action: 'key', key: 'delete_all' };
  }

  if (lower === 'select_all') key = process.platform === 'darwin' ? 'Meta+A' : 'Control+A';
  if (lower === 'copy') key = process.platform === 'darwin' ? 'Meta+C' : 'Control+C';
  if (lower === 'paste') key = process.platform === 'darwin' ? 'Meta+V' : 'Control+V';
  if (lower === 'cut') key = process.platform === 'darwin' ? 'Meta+X' : 'Control+X';
  if (lower === 'undo') key = process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z';

  // Enter / submit — chat-aware multi-strategy
  if (lower === 'enter' || lower === 'return' || lower === 'submit' || lower === 'send') {
    const r = await pressEnterOrSubmit(opts);
    return { ok: true, action: 'key', key: 'Enter', ...r };
  }

  if (opts.ref || opts.elementId != null || opts.selector || opts.label || opts.x != null) {
    const ed = resolveEditableLocator(opts);
    if (ed?.locator) {
      await ed.locator.click({ force: true, timeout: 4000 }).catch(() =>
        smartClick({
          ref: opts.ref,
          elementId: opts.elementId,
          selector: opts.selector,
          text: opts.label,
          x: opts.x,
          y: opts.y,
          force: true,
        }),
      );
    } else {
      await smartClick({
        ref: opts.ref,
        elementId: opts.elementId,
        selector: opts.selector,
        text: opts.label,
        x: opts.x,
        y: opts.y,
        force: true,
      });
    }
  }

  const repeat = Math.max(1, Math.min(100, Number(opts.repeat) || Number(opts.count) || 1));
  const pwKey = key
    .replace(/^Cmd\+/i, 'Meta+')
    .replace(/^Command\+/i, 'Meta+')
    .replace(/^Ctrl\+/i, 'Control+');

  for (let i = 0; i < repeat; i++) {
    await page.keyboard.press(pwKey);
    if (repeat > 1) await sleep(25);
  }

  await sleep(40);
  await captureOnce('after-key');
  return { ok: true, action: 'key', key: pwKey, repeat, method: 'playwright-keyboard' };
}

/**
 * Multi-pane scroll: pages often have several scrollable regions (sidebar, chat
 * list, main column, modal body). Pick target by ref / selector / focus (x,y) /
 * largest nested scroller under the pointer, then scroll that element (not only
 * the document).
 */
async function smartScroll(opts = {}) {
  if (!(await ensureReady()) || !page) return { ok: false, error: 'no_browser' };

  const mode = String(opts.mode || opts.to || opts.direction || '').toLowerCase();
  const pages = Number(opts.pages);
  let dy = Number(opts.dy);
  let dx = Number(opts.dx) || 0;
  if (!Number.isFinite(dy)) dy = 0;
  if (!Number.isFinite(dx)) dx = 0;
  if (!dy && !dx && !mode && !Number.isFinite(pages) && Number.isFinite(Number(opts.amount))) {
    dy = Number(opts.amount);
  }
  // Semantic direction when only direction given
  if (!dy && !dx && !Number.isFinite(pages) && (mode === 'down' || mode === 'up')) {
    dy = mode === 'up' ? -480 : 480;
  }

  const nx = opts.x != null ? clamp01(opts.x) : 0.5;
  const ny = opts.y != null ? clamp01(opts.y) : 0.5;
  const focusPx = Math.round(nx * Math.max(BROWSER_W - 1, 1));
  const focusPy = Math.round(ny * Math.max(BROWSER_H - 1, 1));

  // Optional: scroll a specific element into view first (then scroll its container)
  if (opts.ref || opts.selector || opts.text || opts.name) {
    try {
      const resolved = resolveLocator({
        ref: opts.ref,
        selector: opts.selector,
        text: opts.text || opts.name,
        name: opts.name,
        role: opts.role,
      });
      if (resolved?.locator) {
        await resolved.locator.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }

  console.log(
    `[BrowserService] smartScroll mode=${mode || '-'} pages=${pages} dy=${dy} dx=${dx} focus=(${nx.toFixed(2)},${ny.toFixed(2)}) ref=${opts.ref || '-'}`,
  );

  // Move mouse into the target region so wheel hits the right pane
  try {
    await page.mouse.move(focusPx, focusPy);
  } catch {
    /* ignore */
  }

  const jsResult = await page.evaluate(
    ({ nx, ny, wantDx, wantDy, pages, mode, focusText }) => {
      const vw = window.innerWidth || 1;
      const vh = window.innerHeight || 1;
      const px = nx * vw;
      const py = ny * vh;

      function isScrollable(el) {
        if (!el || el.nodeType !== 1) return false;
        const st = window.getComputedStyle(el);
        const oy = st.overflowY;
        const ox = st.overflowX;
        const canY =
          (oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
          el.scrollHeight > el.clientHeight + 4;
        const canX =
          (ox === 'auto' || ox === 'scroll' || ox === 'overlay') &&
          el.scrollWidth > el.clientWidth + 4;
        // Also treat overflow:hidden with programmatic scroll (some chat UIs)
        if (!canY && !canX) {
          if (el.scrollHeight > el.clientHeight + 20 && (oy === 'hidden' || oy === 'auto')) {
            return true;
          }
        }
        return canY || canX;
      }

      function rootScrollEl() {
        return document.scrollingElement || document.documentElement || document.body;
      }

      function readPos(el) {
        if (!el) return { x: 0, y: 0, maxY: 0, maxX: 0, clientH: 0, clientW: 0 };
        const isDoc =
          el === document.documentElement ||
          el === document.body ||
          el === document.scrollingElement;
        if (isDoc) {
          const se = rootScrollEl();
          return {
            x: se.scrollLeft || window.scrollX || 0,
            y: se.scrollTop || window.scrollY || 0,
            maxY: Math.max(0, (se.scrollHeight || 0) - (se.clientHeight || 0)),
            maxX: Math.max(0, (se.scrollWidth || 0) - (se.clientWidth || 0)),
            clientH: se.clientHeight || vh,
            clientW: se.clientWidth || vw,
          };
        }
        return {
          x: el.scrollLeft,
          y: el.scrollTop,
          maxY: Math.max(0, el.scrollHeight - el.clientHeight),
          maxX: Math.max(0, el.scrollWidth - el.clientWidth),
          clientH: el.clientHeight,
          clientW: el.clientWidth,
        };
      }

      function listScrollers() {
        const out = [];
        const all = document.querySelectorAll(
          'div,main,section,article,aside,ul,ol,pre,textarea,nav,table,tbody,[role="listbox"],[role="grid"],[role="dialog"],[class*="scroll"],[class*="Scroll"],[class*="chat"],[class*="sidebar"],[class*="panel"]',
        );
        for (const el of all) {
          if (!isScrollable(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 30 || r.height < 30) continue;
          if (r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) continue;
          const st = window.getComputedStyle(el);
          out.push({
            el,
            tag: el.tagName.toLowerCase(),
            area: r.width * r.height,
            r,
            id: el.id || '',
            cls: typeof el.className === 'string' ? el.className.slice(0, 60) : '',
            role: el.getAttribute('role') || '',
            pos: readPos(el),
            z: parseInt(st.zIndex, 10) || 0,
          });
        }
        // Always include document
        const root = rootScrollEl();
        out.push({
          el: root,
          tag: 'document',
          area: vw * vh,
          r: { left: 0, top: 0, width: vw, height: vh, right: vw, bottom: vh },
          id: '',
          cls: '',
          role: 'document',
          pos: readPos(root),
          z: 0,
          isDocument: true,
        });
        return out;
      }

      function pickTarget() {
        const scrollers = listScrollers();
        // 1) Under focus point: walk up from elementFromPoint
        let hit = document.elementFromPoint(px, py);
        let depth = 0;
        while (hit && depth < 16) {
          if (isScrollable(hit)) {
            return {
              el: hit,
              kind: 'under-point',
              tag: hit.tagName.toLowerCase(),
              scrollers: scrollers.length,
            };
          }
          hit = hit.parentElement;
          depth++;
        }

        // 2) Scroller whose box contains the focus point (prefer nested/smaller area)
        const containing = scrollers
          .filter((s) => {
            const r = s.r;
            return px >= r.left && px <= r.right && py >= r.top && py <= r.bottom;
          })
          .sort((a, b) => {
            // Prefer non-document, then smaller area (more nested), then higher z
            if (a.isDocument !== b.isDocument) return a.isDocument ? 1 : -1;
            return a.area - b.area || b.z - a.z;
          });
        if (containing.length) {
          const s = containing[0];
          return {
            el: s.el,
            kind: 'contains-point',
            tag: s.tag,
            id: s.id,
            cls: s.cls,
            scrollers: scrollers.length,
          };
        }

        // 3) Largest non-document scroller visible
        const nested = scrollers
          .filter((s) => !s.isDocument)
          .sort((a, b) => b.area - a.area);
        if (nested.length) {
          return {
            el: nested[0].el,
            kind: 'largest-nested',
            tag: nested[0].tag,
            scrollers: scrollers.length,
          };
        }

        // 4) Optional text hint for container
        if (focusText) {
          const q = String(focusText).toLowerCase();
          for (const s of scrollers) {
            const label = (s.id + ' ' + s.cls + ' ' + (s.el.getAttribute('aria-label') || '')).toLowerCase();
            if (label.includes(q)) {
              return { el: s.el, kind: 'text-hint', tag: s.tag, scrollers: scrollers.length };
            }
          }
        }

        return {
          el: rootScrollEl(),
          kind: 'document',
          tag: 'document',
          scrollers: scrollers.length,
        };
      }

      function applyScroll(el, dx, dy, absolute) {
        const isDoc =
          el === document.documentElement ||
          el === document.body ||
          el === document.scrollingElement;
        if (absolute) {
          if (isDoc) {
            window.scrollTo({ left: dx, top: dy, behavior: 'instant' in window ? 'instant' : 'auto' });
          } else {
            el.scrollLeft = dx;
            el.scrollTop = dy;
          }
          return;
        }
        if (isDoc) {
          window.scrollBy(dx, dy);
        } else {
          el.scrollLeft += dx;
          el.scrollTop += dy;
        }
      }

      const picked = pickTarget();
      const el = picked.el;
      const before = readPos(el);

      let useDx = wantDx;
      let useDy = wantDy;
      let absolute = false;

      if (mode === 'top') {
        useDx = before.x;
        useDy = 0;
        absolute = true;
      } else if (mode === 'bottom') {
        useDx = before.x;
        useDy = before.maxY + 50;
        absolute = true;
      } else if (pages != null && pages !== 0 && isFinite(pages)) {
        const pageH = Math.max(120, (before.clientH || vh) * 0.85);
        useDy = pages * pageH;
        useDx = wantDx;
      } else if (!useDy && !useDx) {
        useDy = Math.max(200, (before.clientH || vh) * 0.7);
      }

      applyScroll(el, useDx, useDy, absolute);

      let after = readPos(el);
      let moved = Math.abs(after.y - before.y) > 1 || Math.abs(after.x - before.x) > 1;

      // If nested didn't move, try document as fallback (and vice versa)
      if (!moved && picked.kind !== 'document') {
        const root = rootScrollEl();
        const b2 = readPos(root);
        if (absolute) applyScroll(root, useDx, useDy, true);
        else applyScroll(root, useDx, useDy, false);
        const a2 = readPos(root);
        if (Math.abs(a2.y - b2.y) > 1 || Math.abs(a2.x - b2.x) > 1) {
          return {
            ok: true,
            method: 'js-document-fallback',
            target: 'document',
            kind: 'document-fallback',
            before: b2,
            after: a2,
            deltaY: a2.y - b2.y,
            deltaX: a2.x - b2.x,
            scrollers: picked.scrollers,
            requested: { dx: useDx, dy: useDy, absolute, pages, mode },
          };
        }
      }

      // List panes for agent debugging
      const panes = listScrollers()
        .filter((s) => !s.isDocument)
        .slice(0, 8)
        .map((s, i) => ({
          i,
          tag: s.tag,
          id: s.id,
          role: s.role,
          y: Math.round(s.pos.y),
          maxY: Math.round(s.pos.maxY),
          h: Math.round(s.r.height),
        }));

      return {
        ok: true,
        method: moved ? 'js-container' : 'js-no-move',
        target: picked.kind + ':' + picked.tag + (picked.id ? '#' + picked.id : ''),
        kind: picked.kind,
        tag: picked.tag,
        before,
        after,
        deltaY: after.y - before.y,
        deltaX: after.x - before.x,
        scrollers: picked.scrollers,
        panes,
        requested: { dx: useDx, dy: useDy, absolute, pages, mode },
      };
    },
    {
      nx,
      ny,
      wantDx: dx,
      wantDy: dy,
      pages: Number.isFinite(pages) ? pages : null,
      mode: mode === 'down' || mode === 'up' ? '' : mode,
      focusText: opts.container || opts.pane || opts.target || '',
    },
  );

  console.log(
    `[BrowserService] scroll js method=${jsResult?.method} target=${jsResult?.target} Δy=${jsResult?.deltaY} panes=${jsResult?.scrollers}`,
  );

  // Wheel fallback if JS didn't move (some custom scrollers only listen to wheel)
  const movedJs =
    jsResult && (Math.abs(jsResult.deltaY) > 1 || Math.abs(jsResult.deltaX) > 1);
  if (!movedJs && mode !== 'top' && mode !== 'bottom') {
    try {
      await page.mouse.move(focusPx, focusPy);
      const wheelDy =
        Number.isFinite(pages) && pages !== 0
          ? pages * 400
          : dy || 400;
      const wheelDx = dx || 0;
      // Playwright mouse.wheel: positive Y scrolls down
      const notches = Math.min(10, Math.max(1, Math.ceil(Math.abs(wheelDy) / 100)));
      const stepY = wheelDy / notches;
      const stepX = wheelDx / notches;
      for (let i = 0; i < notches; i++) {
        await page.mouse.wheel(stepX, stepY);
        await sleep(16);
      }
      // Keyboard PageDown/Up as extra fallback on focused pane
      if (Math.abs(wheelDy) >= 300) {
        const key = wheelDy > 0 ? 'PageDown' : 'PageUp';
        const times = Math.min(4, Math.ceil(Math.abs(wheelDy) / 500));
        for (let i = 0; i < times; i++) {
          await page.keyboard.press(key);
          await sleep(30);
        }
      }
      if (jsResult) {
        jsResult.method = (jsResult.method || 'js') + '+wheel+keys';
      }
    } catch (e) {
      console.warn('[BrowserService] wheel fallback:', e?.message ?? e);
    }
  }

  await sleep(100);
  await captureOnce('after-scroll');

  return {
    ok: true,
    method: jsResult?.method || 'playwright-scroll',
    target: jsResult?.target,
    kind: jsResult?.kind,
    tag: jsResult?.tag,
    deltaY: jsResult?.deltaY,
    deltaX: jsResult?.deltaX,
    before: jsResult?.before,
    after: jsResult?.after,
    scrollers: jsResult?.scrollers,
    panes: jsResult?.panes,
    requested: {
      dy,
      dx,
      pages,
      mode,
      x: nx,
      y: ny,
      ref: opts.ref,
    },
    instruction:
      jsResult?.method === 'js-no-move'
        ? 'No scroll movement — try x,y over the specific pane (e.g. sidebar 0.15,0.5 or chat 0.5,0.7), or pages=1, or mode=bottom.'
        : jsResult?.panes?.length > 1
          ? `Multiple scroll panes (${jsResult.panes.length}). Use browser_scroll with x,y focused on the pane you want (left sidebar ~x=0.15, main ~x=0.6).`
          : undefined,
  };
}

/**
 * Hover to reveal menus, tooltips, overflow actions (⋯), row actions.
 * Keeps pointer on target so CSS :hover / mouseenter menus stay open.
 * Optionally re-snapshots so new controls get refs.
 */
async function smartHover(opts = {}) {
  if (!(await ensureReady()) || !page) return { ok: false, error: 'no_browser' };

  const dwellMs = Math.max(50, Math.min(5000, Number(opts.dwellMs ?? opts.ms ?? opts.hoverMs) || 400));
  const resnapshot = opts.resnapshot !== false && opts.snapshot !== false;
  const candidates = buildLocatorCandidates(opts);
  console.log(
    `[BrowserService] hover candidates=${candidates.length} ref=${opts.ref || '-'} dwell=${dwellMs}ms`,
  );

  if (candidates.length === 0) {
    const snap = await captureAxSnapshot().catch(() => null);
    return {
      ok: false,
      error: 'no_target',
      candidates: snap?.elements?.slice?.(0, 12),
      axTree: snap?.axTree || lastAxTree,
    };
  }

  let used = null;
  let box = null;

  for (const c of candidates) {
    if (c.method === 'coords' && c.x != null) {
      try {
        await page.mouse.move(c.x, c.y, { steps: 8 });
        setCursorPosition(c.x, c.y, { force: true, phase: 'hover' });
        used = c;
        box = { x: c.x - 1, y: c.y - 1, width: 2, height: 2 };
        break;
      } catch {
        continue;
      }
    }
    if (!c.locator) continue;
    try {
      const vis = await c.locator.isVisible({ timeout: 500 }).catch(() => false);
      if (!vis) continue;
      await c.locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      box = await c.locator.boundingBox().catch(() => null);
      if (box) {
        setCursorPosition(box.x + box.width / 2, box.y + box.height / 2, {
          force: true,
          phase: 'hover',
        });
      }
      await c.locator.hover({ force: opts.force !== false, timeout: 2500 });
      // Extra mouse events for stubborn UIs
      await c.locator
        .evaluate((el) => {
          const r = el.getBoundingClientRect();
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          const o = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
          el.dispatchEvent(new MouseEvent('mouseover', o));
          el.dispatchEvent(new MouseEvent('mouseenter', { ...o, bubbles: false }));
        })
        .catch(() => {});
      used = c;
      break;
    } catch {
      if (box) {
        try {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
          setCursorPosition(box.x + box.width / 2, box.y + box.height / 2, {
            force: true,
            phase: 'hover',
          });
          used = c;
          break;
        } catch {
          /* next */
        }
      }
    }
  }

  if (!used) {
    return {
      ok: false,
      error: 'hover_no_target',
      tried: candidates.map((c) => c.method),
      axTree: lastAxTree,
    };
  }

  await sleep(dwellMs);
  // Optional: also click openers that need click-to-open not pure hover
  if (opts.clickToOpen === true || opts.open === true) {
    try {
      if (used.locator) {
        await used.locator.click({ force: true, timeout: 2000 });
        await sleep(250);
      }
    } catch {
      /* ignore */
    }
  }

  await captureOnce('after-hover');
  const ax = resnapshot ? await captureAxSnapshot().catch(() => null) : null;

  return {
    ok: true,
    method: `playwright-hover-${used.method}`,
    resolveMethod: used.method,
    ref: used.ref || opts.ref,
    label: opts.text || opts.name || opts.label,
    dwellMs,
    x: box ? (box.x + box.width / 2) / BROWSER_W : undefined,
    y: box ? (box.y + box.height / 2) / BROWSER_H : undefined,
    px: box
      ? { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
      : undefined,
    axTree: ax?.axTree,
    elements: ax?.elements?.slice?.(0, 40),
    modalBlocking: ax?.modalBlocking,
    url: page.url(),
    title: await page.title().catch(() => lastTitle),
    instruction:
      'Hover held. Click revealed menu items now with browser_click({ text: "Delete Message" }). If still missing, browser_hover with clickToOpen=true on the ⋯ button first.',
  };
}

async function smartSelect(opts = {}) {
  if (!(await ensureReady()) || !page) return { ok: false, error: 'no_browser' };

  const findText = opts.text != null ? String(opts.text) : opts.find != null ? String(opts.find) : '';
  const all = opts.all || opts.mode === 'all' || opts.mode === 'select_all';

  if (all) {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  } else if (findText) {
    // Triple-click style: locate text and select
    try {
      const loc = page.getByText(findText, { exact: false }).first();
      await loc.click({ clickCount: 3, force: true, timeout: 5000 });
    } catch {
      await page.evaluate((q) => {
        if (typeof window.find === 'function') window.find(q, false, false, true, false, false, false);
      }, findText);
    }
  } else if (opts.x1 != null) {
    const a = {
      x: Math.round(clamp01(opts.x1) * (BROWSER_W - 1)),
      y: Math.round(clamp01(opts.y1 ?? 0.2) * (BROWSER_H - 1)),
    };
    const b = {
      x: Math.round(clamp01(opts.x2 ?? 0.8) * (BROWSER_W - 1)),
      y: Math.round(clamp01(opts.y2 ?? 0.5) * (BROWSER_H - 1)),
    };
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 12 });
    await page.mouse.up();
  }

  let selection = '';
  try {
    selection = await page.evaluate(() => (window.getSelection && window.getSelection().toString()) || '');
  } catch {
    /* ignore */
  }

  if (opts.copy) {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C');
  }

  await captureOnce('after-select');
  return {
    ok: true,
    action: 'select',
    method: 'playwright',
    selection: String(selection).slice(0, 2000),
    copied: !!opts.copy,
  };
}

async function smartDismiss(opts = {}) {
  if (!(await ensureReady()) || !page) return { ok: false, error: 'no_browser' };

  const aggressive = opts.aggressive !== false;
  const steps = [];
  console.log('[BrowserService] PW dismiss aggressive=', aggressive);

  const before = await captureAxSnapshot().catch(() => null);
  const hadModal = !!before?.modalBlocking;

  // 1) Playwright getByRole dialog → close buttons
  try {
    const dialog = page.getByRole('dialog').or(page.getByRole('alertdialog')).first();
    if (await dialog.isVisible({ timeout: 800 }).catch(() => false)) {
      const closeBtn = dialog
        .getByRole('button', { name: /close|dismiss|cancel|no.?thanks|not.?now|reject|decline|got it|×|✕/i })
        .or(dialog.locator('[aria-label*="lose" i], [aria-label*="ismiss" i], .close, .btn-close'))
        .first();
      if (await closeBtn.count().catch(() => 0)) {
        await closeBtn.click({ force: true, timeout: 5000 });
        steps.push({ method: 'dialog-close-btn', ok: true });
        await sleep(300);
        const mid = await captureAxSnapshot().catch(() => null);
        if (mid && !mid.modalBlocking) {
          await captureOnce('after-dismiss');
          return { ok: true, method: 'dialog-close-btn', steps, modalBlocking: false, axTree: mid.axTree, elements: mid.elements?.slice?.(0, 40) };
        }
      }
    }
  } catch (e) {
    steps.push({ method: 'dialog-close-btn', ok: false, error: String(e?.message ?? e) });
  }

  // 2) CMP known patterns
  const cmpSelectors = [
    '#onetrust-reject-all-handler',
    '#onetrust-accept-btn-handler',
    '#CybotCookiebotDialogBodyButtonDecline',
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    '#didomi-notice-disagree-button',
    '#didomi-notice-agree-button',
    '.fc-cta-do-not-consent',
    '.fc-cta-consent',
    'button:has-text("Reject all")',
    'button:has-text("Reject All")',
    'button:has-text("No thanks")',
    'button:has-text("Not now")',
    'button:has-text("Accept all")',
    'button:has-text("Got it")',
    '[aria-label="Close"]',
    '[aria-label="close"]',
  ];
  for (const sel of cmpSelectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 400 }).catch(() => false)) {
        await loc.click({ force: true, timeout: 3000 });
        steps.push({ method: 'cmp', sel, ok: true });
        await sleep(250);
        const mid = await captureAxSnapshot().catch(() => null);
        if (mid && !mid.modalBlocking) {
          await captureOnce('after-dismiss');
          return { ok: true, method: 'cmp', sel, steps, modalBlocking: false, axTree: mid.axTree };
        }
      }
    } catch {
      /* next */
    }
  }

  // 3) Close refs from snapshot
  for (const ref of (before?.closeRefs || []).slice(0, 6)) {
    try {
      const r = await smartClick({ ref, force: true });
      steps.push({ method: 'close-ref', ref, ok: !!r?.ok });
      await sleep(200);
      const mid = await captureAxSnapshot().catch(() => null);
      if (mid && !mid.modalBlocking) {
        await captureOnce('after-dismiss');
        return { ok: true, method: 'close-ref', ref, steps, modalBlocking: false, axTree: mid.axTree };
      }
    } catch {
      /* next */
    }
  }

  // 4) Escape
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape');
    await sleep(80);
  }
  steps.push({ method: 'escape', count: 3 });

  // 5) Aggressive hide
  if (aggressive) {
    try {
      const hid = await page.evaluate(() => {
        let n = 0;
        const vw = window.innerWidth || 1;
        const vh = window.innerHeight || 1;
        document.querySelectorAll('dialog').forEach((d) => {
          try {
            if (typeof d.close === 'function') d.close();
            d.removeAttribute('open');
            n++;
          } catch (e) {}
        });
        document.querySelectorAll('div,section,aside,dialog').forEach((el) => {
          const st = window.getComputedStyle(el);
          const r = el.getBoundingClientRect();
          const z = parseInt(st.zIndex, 10) || 0;
          const covers = r.width * r.height > vw * vh * 0.2;
          const elevated = st.position === 'fixed' || st.position === 'sticky' || z >= 100;
          const looks =
            /modal|popup|overlay|consent|cookie|newsletter|subscribe|interstitial/i.test(
              (el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : ''),
            ) ||
            el.getAttribute('role') === 'dialog' ||
            el.getAttribute('aria-modal') === 'true';
          if (covers && elevated && looks) {
            el.style.setProperty('display', 'none', 'important');
            el.setAttribute('aria-hidden', 'true');
            n++;
          }
        });
        document.documentElement.style.overflow = '';
        document.body.style.overflow = '';
        return n;
      });
      steps.push({ method: 'dom-hide', hid });
    } catch (e) {
      steps.push({ method: 'dom-hide', error: String(e?.message ?? e) });
    }
  }

  await sleep(200);
  await captureOnce('after-dismiss');
  const after = await captureAxSnapshot().catch(() => null);
  const still = !!after?.modalBlocking;
  console.log('[BrowserService] PW dismiss done stillBlocked=', still);

  return {
    ok: !still || steps.some((s) => s.ok || s.hid),
    method: 'playwright-multi',
    steps,
    modalBlocking: still,
    modalCount: after?.modalCount ?? 0,
    closeRefs: after?.closeRefs || [],
    axTree: after?.axTree || lastAxTree,
    elements: after?.elements?.slice?.(0, 40),
    instruction: still
      ? 'Modal may remain. Click a [CLOSE] ref or browser_dismiss again.'
      : 'Overlay cleared if present. Use fresh refs.',
  };
}

function registerIpcOnce() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle('browser:navigate', async (_e, urlOrQuery) => {
    if (!(await ensureReady()) || !page) return { ok: false, error: 'no_browser' };
    const url = normalizeUrl(String(urlOrQuery || ''));
    guestReady = false;
    console.log('[BrowserService] navigate', url);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      guestReady = true;
      lastUrl = page.url();
      lastTitle = await page.title().catch(() => '');
      await sleep(300);
      await captureOnce('after-nav');
      refMap.clear();
      emitNav();
      return { ok: true, url: lastUrl, title: lastTitle, guestReady, engine: 'playwright-chromium' };
    } catch (e) {
      guestReady = true;
      return { ok: false, error: String(e?.message ?? e), url: page?.url?.() };
    }
  });

  ipcMain.handle('browser:back', async () => {
    if (!(await ensureReady()) || !page) return { ok: false, error: 'no_browser' };
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await sleep(200);
    lastUrl = page.url();
    lastTitle = await page.title().catch(() => '');
    await captureOnce('after-back');
    emitNav();
    return { ok: true, url: lastUrl, title: lastTitle };
  });

  ipcMain.handle('browser:forward', async () => {
    if (!(await ensureReady()) || !page) return { ok: false, error: 'no_browser' };
    await page.goForward({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await sleep(200);
    lastUrl = page.url();
    lastTitle = await page.title().catch(() => '');
    await captureOnce('after-forward');
    emitNav();
    return { ok: true, url: lastUrl, title: lastTitle };
  });

  ipcMain.handle('browser:reload', async () => {
    if (!(await ensureReady()) || !page) return { ok: false, error: 'no_browser' };
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await sleep(200);
    lastUrl = page.url();
    lastTitle = await page.title().catch(() => '');
    await captureOnce('after-reload');
    emitNav();
    return { ok: true, url: lastUrl, title: lastTitle };
  });

  ipcMain.handle('browser:click', async (_e, payload = {}) => {
    console.log('[BrowserService] click', JSON.stringify(payload).slice(0, 240));
    // If click payload looks like a checkbox intent, route to smartCheck
    const p = payload || {};
    if (
      p.checked !== undefined ||
      p.check !== undefined ||
      p.uncheck !== undefined ||
      p.toggle === true ||
      String(p.role || '').toLowerCase() === 'checkbox' ||
      String(p.role || '').toLowerCase() === 'switch' ||
      String(p.role || '').toLowerCase() === 'radio'
    ) {
      // Only auto-route when desired state or explicit checkbox role — not every click
      if (
        p.checked !== undefined ||
        p.check !== undefined ||
        p.uncheck !== undefined ||
        p.toggle === true
      ) {
        console.log('[BrowserService] click → smartCheck (checkbox intent)');
        return smartCheck(p);
      }
    }
    return smartClick(p);
  });

  ipcMain.handle('browser:check', async (_e, payload = {}) => {
    console.log('[BrowserService] check', JSON.stringify(payload).slice(0, 240));
    return smartCheck(payload || {});
  });

  ipcMain.handle('browser:hover', async (_e, payload = {}) => {
    console.log('[BrowserService] hover', JSON.stringify(payload).slice(0, 240));
    return smartHover(payload || {});
  });

  ipcMain.handle('browser:move', async (_e, payload = {}) => {
    console.log('[BrowserService] move', JSON.stringify(payload).slice(0, 200));
    return smartMove(payload || {});
  });

  ipcMain.handle('browser:scroll', async (_e, payload = {}) => {
    return smartScroll(payload || {});
  });

  ipcMain.handle('browser:type', async (_e, payload = {}) => {
    console.log('[BrowserService] type', JSON.stringify({
      ...payload,
      text: payload?.text != null ? String(payload.text).slice(0, 80) : undefined,
    }).slice(0, 300));
    return smartType(payload || {});
  });

  ipcMain.handle('browser:key', async (_e, payload = {}) => {
    return smartKey(payload || {});
  });

  ipcMain.handle('browser:select', async (_e, payload = {}) => {
    return smartSelect(payload || {});
  });

  ipcMain.handle('browser:dismiss', async (_e, payload = {}) => {
    return smartDismiss(payload || {});
  });

  ipcMain.handle('browser:drag', async (_e, payload = {}) => {
    return smartSelect({
      x1: payload.x1,
      y1: payload.y1,
      x2: payload.x2,
      y2: payload.y2,
      copy: payload.copy,
    });
  });

  ipcMain.handle('browser:getState', async (_e, opts = {}) => {
    await ensureReady().catch(() => {});
    const state = {
      ok: true,
      url: page?.url?.() ?? lastUrl,
      title: lastTitle,
      mode: 'playwright-chromium',
      canInput: true,
      targeting: 'playwright-locator+ref',
      engine: 'playwright-chromium',
      persistentProfile: true,
      profileDir: getProfileDir(),
      cdpAttached: true,
      guestReady,
      contentWidth: BROWSER_W,
      contentHeight: BROWSER_H,
      canGoBack: true,
      canGoForward: true,
    };
    if ((opts.includeElements || opts.includeAx) && page && guestReady) {
      try {
        const snap = await captureAxSnapshot();
        state.elements = Array.isArray(snap?.elements) ? snap.elements.slice(0, 60) : [];
        state.axTree = snap?.axTree || lastAxTree || '';
        state.scroll = snap?.scroll;
        state.textSample = opts.includeText ? snap?.textSample : undefined;
        state.elementCount = snap?.count ?? state.elements.length;
        state.modalBlocking = !!snap?.modalBlocking;
        state.modalCount = snap?.modalCount ?? 0;
        state.closeRefs = Array.isArray(snap?.closeRefs) ? snap.closeRefs : [];
        state.modals = snap?.modals;
      } catch (e) {
        state.elements = [];
        state.axTree = '';
        state.elementsError = String(e?.message ?? e);
      }
    }
    return state;
  });

  ipcMain.handle('browser:axSnapshot', async () => {
    await ensureReady().catch(() => {});
    const snap = await captureAxSnapshot();
    return {
      ok: !!snap?.ok,
      ...snap,
      url: page?.url?.() ?? lastUrl,
      title: lastTitle,
    };
  });

  ipcMain.handle('browser:executeJs', async (_e, code) => {
    if (!(await ensureReady()) || !page) return { ok: false, error: 'no_browser' };
    try {
      const result = await page.evaluate(String(code));
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });
}

export function disposeBrowserService() {
  console.log('[BrowserService] dispose Playwright (profile retained)');
  disposeBrowserInternals({ keepProfile: true }).catch(() => {});
}
