import * as THREE from 'three';
import { CSS3DRenderer, CSS3DObject } from 'three/examples/jsm/renderers/CSS3DRenderer.js';

/**
 * Floating, fully-interactive browser window inside the 3D scene, complete with
 * a navigation toolbar (back / forward / reload) and a URL/search bar.
 *
 * Uses a CSS3DRenderer layered on top of the WebGL canvas. The window is real
 * DOM, so it is clickable/scrollable and can run JS. Because it lives in a
 * separate DOM layer composited over WebGL, it cannot be occluded by 3D meshes
 * (no true depth mixing) - fine for a floating window.
 *
 * Under Electron (run via `npm run dev:electron`) this uses a <webview>, which
 * loads pages as top-level navigations and works with essentially all sites.
 * In a plain browser tab it falls back to an <iframe>, which many sites block
 * via X-Frame-Options / CSP headers - use a permissive URL for testing there
 * (e.g. https://example.com, https://threejs.org).
 */
export function createBrowserWindow(scene, {
  url = 'https://example.com',
  // Window size in CSS pixels (rendered onto the 3D plane).
  widthPx = 1024,
  heightPx = 768,
  // Position in world units.
  position = new THREE.Vector3(1.6, 1.5, -0.4),
  // Euler rotation in radians.
  rotation = new THREE.Euler(0, -0.4, 0),
  // Scale factor: CSS pixels -> world units. Smaller = smaller window in scene.
  scale = 0.0015,
} = {}) {
  console.log('[BrowserWindow] Creating floating browser window ->', url);

  // --- CSS3D renderer layer (overlaid on top of the WebGL canvas) ---
  const cssRenderer = new CSS3DRenderer();
  const cssEl = cssRenderer.domElement;
  cssEl.style.position = 'absolute';
  cssEl.style.top = '0';
  cssEl.style.left = '0';
  cssEl.style.width = '100%';
  cssEl.style.height = '100%';
  // Let clicks fall through to the WebGL canvas (OrbitControls) everywhere
  // EXCEPT over the iframe itself, which re-enables pointer events below.
  cssEl.style.pointerEvents = 'none';
  cssEl.style.zIndex = '2';

  const mount = document.querySelector('#app') || document.body;
  mount.appendChild(cssEl);
  cssRenderer.setSize(mount.clientWidth || window.innerWidth, mount.clientHeight || window.innerHeight);

  // --- The actual browser view ---
  // Under Electron we use a <webview>, which loads pages as top-level
  // navigations and therefore ignores X-Frame-Options / CSP frame-ancestors,
  // so it works with essentially all sites. In a plain browser tab we fall
  // back to an <iframe> (blocked by those headers on many sites).
  const useWebview = isElectronWebviewAvailable();
  console.log(`[BrowserWindow] Using ${useWebview ? '<webview> (Electron, all sites)' : '<iframe> (browser tab, framing-restricted)'}`);

  let viewEl;
  if (useWebview) {
    viewEl = document.createElement('webview');
    viewEl.setAttribute('src', url);
    // allowpopups lets target=_blank / window.open work inside the view.
    viewEl.setAttribute('allowpopups', 'true');
    viewEl.addEventListener('did-finish-load', () => console.log('[BrowserWindow] webview loaded:', viewEl.getURL?.() ?? url));
    viewEl.addEventListener('did-fail-load', (e) => console.warn('[BrowserWindow] webview load failed:', e.errorCode, e.errorDescription, e.validatedURL));
  } else {
    viewEl = document.createElement('iframe');
    viewEl.src = url;
    viewEl.setAttribute('title', 'In-scene browser');
    viewEl.addEventListener('load', () => console.log('[BrowserWindow] iframe loaded:', viewEl.src));
    viewEl.addEventListener('error', (e) => console.warn('[BrowserWindow] iframe error:', e));
  }
  const TOOLBAR_H = 48; // px, height of the navigation chrome
  const viewH = heightPx - TOOLBAR_H;
  viewEl.style.width = `${widthPx}px`;
  viewEl.style.height = `${viewH}px`;
  viewEl.style.border = '0';
  viewEl.style.background = '#ffffff';
  viewEl.style.pointerEvents = 'auto'; // interactive
  if (useWebview) viewEl.style.display = 'inline-flex'; // webview sizes oddly as default inline

  // --- Navigation toolbar (back / forward / reload + URL bar) ---
  const toolbar = buildToolbar({
    useWebview,
    onBack: () => goBack(),
    onForward: () => goForward(),
    onReload: () => reload(),
    onNavigate: (value) => setUrl(normalizeInputToUrl(value)),
  });

  // A styled frame/bezel around the toolbar + view so it reads as a window.
  const wrapper = document.createElement('div');
  wrapper.style.width = `${widthPx}px`;
  wrapper.style.height = `${heightPx}px`;
  wrapper.style.display = 'flex';
  wrapper.style.flexDirection = 'column';
  wrapper.style.borderRadius = '14px';
  wrapper.style.overflow = 'hidden';
  wrapper.style.boxShadow = '0 30px 80px rgba(0,0,0,0.45)';
  wrapper.style.background = '#ffffff';
  wrapper.appendChild(toolbar.el);
  wrapper.appendChild(viewEl);
  toolbar.setValue(url);

  const cssObject = new CSS3DObject(wrapper);
  cssObject.name = 'FloatingBrowserWindow';
  cssObject.position.copy(position);
  cssObject.rotation.copy(rotation);
  cssObject.scale.setScalar(scale);
  scene.add(cssObject);

  // Optional: a subtle backing plane in the WebGL layer so the window has a
  // physical presence (and something behind semi-transparent pages).
  const planeW = widthPx * scale;
  const planeH = heightPx * scale;
  const backing = new THREE.Mesh(
    new THREE.PlaneGeometry(planeW, planeH),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      opacity: 0,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  backing.position.copy(position);
  backing.rotation.copy(rotation);
  scene.add(backing);

  function setSize(width, height) {
    cssRenderer.setSize(width, height);
  }

  function render(camera) {
    cssRenderer.render(scene, camera);
  }

  function setUrl(nextUrl) {
    console.log('[BrowserWindow] Navigating to', nextUrl);
    if (useWebview && typeof viewEl.loadURL === 'function') {
      viewEl.loadURL(nextUrl);
    } else {
      viewEl.src = nextUrl;
    }
    toolbar.setValue(nextUrl);
  }

  function goBack() {
    console.log('[BrowserWindow] Back');
    if (useWebview && typeof viewEl.goBack === 'function') {
      viewEl.goBack();
    } else {
      // iframe: same-origin history only; best-effort.
      try { viewEl.contentWindow?.history.back(); } catch (e) { console.warn('[BrowserWindow] iframe back blocked:', e); }
    }
  }

  function goForward() {
    console.log('[BrowserWindow] Forward');
    if (useWebview && typeof viewEl.goForward === 'function') {
      viewEl.goForward();
    } else {
      try { viewEl.contentWindow?.history.forward(); } catch (e) { console.warn('[BrowserWindow] iframe forward blocked:', e); }
    }
  }

  function reload() {
    console.log('[BrowserWindow] Reload');
    if (useWebview && typeof viewEl.reload === 'function') {
      viewEl.reload();
    } else {
      viewEl.src = viewEl.src; // eslint-disable-line no-self-assign
    }
  }

  // Keep the URL bar in sync with the actual page (webview only).
  if (useWebview) {
    const syncUrl = () => {
      const current = viewEl.getURL?.();
      if (current) toolbar.setValue(current);
      toolbar.setNavState({
        canGoBack: viewEl.canGoBack?.() ?? false,
        canGoForward: viewEl.canGoForward?.() ?? false,
      });
      // Intentionally does NOT notify the AI. Browser navigation is silent so
      // that loading a page never triggers an AI response.
    };
    viewEl.addEventListener('did-navigate', syncUrl);
    viewEl.addEventListener('did-navigate-in-page', syncUrl);
    viewEl.addEventListener('did-finish-load', syncUrl);
    viewEl.addEventListener('page-title-updated', syncUrl);
  }

  function dispose() {
    scene.remove(cssObject);
    scene.remove(backing);
    backing.geometry.dispose();
    backing.material.dispose();
    cssEl.remove();
    console.log('[BrowserWindow] Disposed');
  }

  return { cssObject, view: viewEl, render, setSize, setUrl, goBack, goForward, reload, dispose };
}

/**
 * Builds the navigation chrome: back, forward, reload buttons and a URL bar.
 * Returns { el, setValue, setNavState }.
 */
function buildToolbar({ useWebview, onBack, onForward, onReload, onNavigate }) {
  const el = document.createElement('div');
  el.style.cssText = [
    'display:flex',
    'align-items:center',
    'gap:6px',
    'height:48px',
    'padding:0 10px',
    'background:#f1f3f4',
    'border-bottom:1px solid #dadce0',
    'font-family:system-ui,-apple-system,Segoe UI,sans-serif',
    'pointer-events:auto',
  ].join(';');

  const makeButton = (label, title, onClick) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    b.style.cssText = [
      'flex:0 0 auto',
      'width:32px',
      'height:32px',
      'border:0',
      'border-radius:50%',
      'background:transparent',
      'color:#3c4043',
      'font-size:16px',
      'cursor:pointer',
      'line-height:32px',
      'text-align:center',
    ].join(';');
    b.addEventListener('mouseenter', () => { b.style.background = '#e0e3e7'; });
    b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
    b.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
    return b;
  };

  const backBtn = makeButton('\u2190', 'Back', onBack);
  const fwdBtn = makeButton('\u2192', 'Forward', onForward);
  const reloadBtn = makeButton('\u21bb', 'Reload', onReload);

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Search or enter address';
  input.spellcheck = false;
  input.style.cssText = [
    'flex:1 1 auto',
    'height:32px',
    'border:1px solid #dadce0',
    'border-radius:16px',
    'padding:0 14px',
    'font-size:13px',
    'color:#202124',
    'background:#fff',
    'outline:none',
  ].join(';');
  input.addEventListener('focus', () => { input.style.borderColor = '#1a73e8'; input.select(); });
  input.addEventListener('blur', () => { input.style.borderColor = '#dadce0'; });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onNavigate(input.value.trim());
    }
  });

  el.appendChild(backBtn);
  el.appendChild(fwdBtn);
  el.appendChild(reloadBtn);
  el.appendChild(input);

  return {
    el,
    setValue: (v) => { if (document.activeElement !== input) input.value = v; },
    setNavState: ({ canGoBack, canGoForward }) => {
      backBtn.style.opacity = canGoBack ? '1' : '0.4';
      fwdBtn.style.opacity = canGoForward ? '1' : '0.4';
      backBtn.style.cursor = canGoBack ? 'pointer' : 'default';
      fwdBtn.style.cursor = canGoForward ? 'pointer' : 'default';
    },
  };
}

/**
 * Turns a URL-bar entry into a navigable URL. Adds https:// to bare hosts and
 * routes free-text queries to a Google search.
 */
function normalizeInputToUrl(value) {
  if (!value) return 'about:blank';
  // Already a full URL.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  // Looks like a domain (has a dot, no spaces) -> assume https.
  if (/^[^\s]+\.[^\s]+$/.test(value) && !value.includes(' ')) {
    return `https://${value}`;
  }
  // Otherwise treat as a search query.
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

/**
 * True when running inside Electron with the <webview> tag enabled.
 * Detected via the Electron user-agent so no preload bridge is required.
 */
function isElectronWebviewAvailable() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return /Electron/i.test(ua);
}
