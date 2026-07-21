import * as THREE from 'three';
import { CSS3DRenderer, CSS3DObject } from 'three/examples/jsm/renderers/CSS3DRenderer.js';

/**
 * Floating browser in the 3D scene.
 *
 * Electron (preferred): main-process OFFSCREEN paints → WebGL **physical panel**
 * (BoxGeometry chassis + depth-tested page/toolbar planes). No CSS3D toolbar
 * overlay (that ignored depth and drew the search bar on top of the avatar).
 *
 * Browser tab fallback: CSS3D + iframe (many sites block framing).
 *
 * AI control goes through the same surface API used by BrowserController.
 */

const DEFAULT_CONTENT_W = 1024;
const DEFAULT_CONTENT_H = 720;
const TOOLBAR_H = 48;

export function createBrowserWindow(scene, {
  url = 'https://example.com',
  widthPx = DEFAULT_CONTENT_W,
  heightPx = DEFAULT_CONTENT_H + TOOLBAR_H,
  // Defaults: TV-like — lower center (~1m), faces avatar at home from +Z
  position = new THREE.Vector3(0, 1.0, 1.85),
  rotation = new THREE.Euler(0, Math.PI, 0),
  scale = 0.0017,
} = {}) {
  const electronApi =
    typeof window !== 'undefined' && window.electronBrowser ? window.electronBrowser : null;
  const useOffscreen = Boolean(electronApi && typeof electronApi.navigate === 'function');

  console.log(
    `[BrowserWindow] Mode: ${useOffscreen ? 'offscreen (main-process, stable)' : 'iframe (tab fallback)'}`,
    'electronBrowser=',
    !!electronApi,
  );

  if (useOffscreen) {
    return createOffscreenPlaneBrowser(scene, {
      url,
      widthPx,
      heightPx,
      position,
      rotation,
      scale,
      electronApi,
    });
  }

  return createIframeCss3dBrowser(scene, {
    url,
    widthPx,
    heightPx,
    position,
    rotation,
    scale,
  });
}

// ---------------------------------------------------------------------------
// Electron: WebGL plane + offscreen paints
// ---------------------------------------------------------------------------

function createOffscreenPlaneBrowser(scene, {
  url,
  widthPx,
  heightPx,
  position,
  rotation,
  scale,
  electronApi,
}) {
  const contentW = widthPx;
  const contentH = heightPx - TOOLBAR_H;

  // --- Physical WebGL unit (depth-tested). CSS3D toolbar was a DOM overlay and
  // drew ON TOP of the avatar with no depth test — search bar "through" the model.
  const planeW = contentW * scale;
  const planeH = contentH * scale;
  const barH = TOOLBAR_H * scale;
  const bodyDepth = 0.045; // solid panel thickness (meters)
  const framePad = 0.018;

  const root = new THREE.Group();
  root.name = 'FloatingBrowserPhysical';
  root.position.copy(position);
  root.rotation.copy(rotation);
  scene.add(root);

  // Solid chassis (Box) — true 3D volume, occludes avatar correctly
  const chassisH = planeH + barH + framePad * 2;
  const chassisW = planeW + framePad * 2;
  const chassis = new THREE.Mesh(
    new THREE.BoxGeometry(chassisW, chassisH, bodyDepth),
    new THREE.MeshStandardMaterial({
      color: 0x2a2d32,
      roughness: 0.72,
      metalness: 0.18,
      depthTest: true,
      depthWrite: true,
    }),
  );
  chassis.name = 'FloatingBrowserChassis';
  // Content face sits slightly in front of chassis front
  chassis.position.set(0, barH / 2, -bodyDepth / 2 - 0.001);
  chassis.castShadow = false;
  chassis.receiveShadow = true;
  root.add(chassis);

  // Soft edge lip on front (slightly larger dark plate)
  const lip = new THREE.Mesh(
    new THREE.BoxGeometry(chassisW + 0.008, chassisH + 0.008, 0.006),
    new THREE.MeshStandardMaterial({
      color: 0x15171a,
      roughness: 0.85,
      metalness: 0.05,
      depthTest: true,
      depthWrite: true,
    }),
  );
  lip.name = 'FloatingBrowserLip';
  lip.position.set(0, barH / 2, 0.001);
  root.add(lip);

  // Toolbar as WebGL canvas (depth-tested) — NOT CSS3D
  const toolbarCanvas = document.createElement('canvas');
  toolbarCanvas.width = contentW;
  toolbarCanvas.height = TOOLBAR_H;
  const toolbarCtx = toolbarCanvas.getContext('2d');
  const toolbarTexture = new THREE.CanvasTexture(toolbarCanvas);
  toolbarTexture.colorSpace = THREE.SRGBColorSpace;
  toolbarTexture.minFilter = THREE.LinearFilter;
  toolbarTexture.magFilter = THREE.LinearFilter;

  let addressText = url;
  let canGoBack = false;
  let canGoForward = false;

  function paintToolbar() {
    const w = contentW;
    const h = TOOLBAR_H;
    const ctx2 = toolbarCtx;
    ctx2.fillStyle = '#f1f3f4';
    ctx2.fillRect(0, 0, w, h);
    ctx2.strokeStyle = '#dadce0';
    ctx2.beginPath();
    ctx2.moveTo(0, h - 0.5);
    ctx2.lineTo(w, h - 0.5);
    ctx2.stroke();

    const btnY = 8;
    const btnS = 32;
    const drawBtn = (x, label, enabled) => {
      ctx2.fillStyle = enabled ? '#e8eaed' : '#f1f3f4';
      ctx2.beginPath();
      ctx2.arc(x + btnS / 2, btnY + btnS / 2, btnS / 2, 0, Math.PI * 2);
      ctx2.fill();
      ctx2.fillStyle = enabled ? '#3c4043' : '#bdc1c6';
      ctx2.font = '16px system-ui,sans-serif';
      ctx2.textAlign = 'center';
      ctx2.textBaseline = 'middle';
      ctx2.fillText(label, x + btnS / 2, btnY + btnS / 2 + 1);
    };
    drawBtn(8, '←', canGoBack);
    drawBtn(46, '→', canGoForward);
    drawBtn(84, '↻', true);

    // Address field
    const ax = 126;
    const aw = w - ax - 12;
    const ay = 8;
    const ah = 32;
    ctx2.fillStyle = '#ffffff';
    ctx2.strokeStyle = '#dadce0';
    ctx2.lineWidth = 1;
    roundRect(ctx2, ax, ay, aw, ah, 16);
    ctx2.fill();
    ctx2.stroke();
    ctx2.fillStyle = '#202124';
    ctx2.font = '13px system-ui,sans-serif';
    ctx2.textAlign = 'left';
    ctx2.textBaseline = 'middle';
    const shown =
      addressText.length > 72 ? addressText.slice(0, 69) + '…' : addressText || 'Search or enter address';
    ctx2.fillText(shown, ax + 14, ay + ah / 2);
    toolbarTexture.needsUpdate = true;
  }
  paintToolbar();

  const toolbarMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(planeW, barH),
    new THREE.MeshBasicMaterial({
      map: toolbarTexture,
      side: THREE.DoubleSide,
      toneMapped: false,
      depthTest: true,
      depthWrite: true,
    }),
  );
  toolbarMesh.name = 'FloatingBrowserToolbar';
  toolbarMesh.position.set(0, planeH / 2 + barH / 2, 0.006);
  toolbarMesh.renderOrder = 3;
  toolbarMesh.frustumCulled = false;
  root.add(toolbarMesh);

  // Content plane (WebGL texture) — front face of the panel
  const canvas = document.createElement('canvas');
  canvas.width = contentW;
  canvas.height = contentH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, contentW, contentH);
  ctx.fillStyle = '#5f6368';
  ctx.font = '16px system-ui,sans-serif';
  ctx.fillText('Loading browser…', 24, 40);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(planeW, planeH),
    new THREE.MeshBasicMaterial({
      map: texture,
      // DoubleSide so FPV view_click rays still hit if facing is slightly off
      side: THREE.DoubleSide,
      toneMapped: false,
      depthTest: true,
      depthWrite: true,
    }),
  );
  mesh.name = 'FloatingBrowserContent';
  mesh.position.set(0, 0, 0.006);
  mesh.renderOrder = 2;
  mesh.frustumCulled = false;
  mesh.layers.enableAll();
  // Reliable UV for raycast → page coords
  mesh.geometry.computeBoundingBox();
  root.add(mesh);

  // Thin inner bezel around content (local, in front of chassis)
  const bezel = new THREE.Mesh(
    new THREE.PlaneGeometry(planeW + 0.01, planeH + 0.01),
    new THREE.MeshBasicMaterial({
      color: 0x202124,
      side: THREE.FrontSide,
      depthTest: true,
      depthWrite: true,
    }),
  );
  bezel.name = 'FloatingBrowserBezel';
  bezel.position.set(0, 0, 0.004);
  bezel.renderOrder = 1;
  root.add(bezel);

  console.log(
    `[BrowserWindow] Physical panel ${planeW.toFixed(3)}x${(planeH + barH).toFixed(3)}m ` +
      `depth=${bodyDepth}m @`,
    position.toArray().map((n) => +n.toFixed(2)),
    'rotY=',
    rotation.y.toFixed(2),
    '(WebGL toolbar — no CSS3D overlay)',
  );

  // HTML address overlay (fixed screen UI) — only while editing, not in 3D
  const addressOverlay = document.createElement('div');
  addressOverlay.style.cssText = [
    'display:none',
    'position:fixed',
    'left:50%',
    'top:18%',
    'transform:translateX(-50%)',
    'z-index:50',
    'width:min(720px,92vw)',
    'padding:12px 14px',
    'border-radius:12px',
    'background:rgba(32,33,36,0.96)',
    'box-shadow:0 12px 40px rgba(0,0,0,0.4)',
    'font:14px system-ui,sans-serif',
  ].join(';');
  const addressInput = document.createElement('input');
  addressInput.type = 'text';
  addressInput.style.cssText =
    'width:100%;box-sizing:border-box;height:40px;border-radius:8px;border:1px solid #5f6368;' +
    'padding:0 12px;font:14px system-ui,sans-serif;background:#fff;color:#202124';
  addressOverlay.appendChild(addressInput);
  (document.querySelector('#app') || document.body).appendChild(addressOverlay);
  addressInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = addressInput.value.trim();
      hideAddressOverlay();
      if (v) setUrl(normalizeInputToUrl(v));
    } else if (e.key === 'Escape') {
      hideAddressOverlay();
    }
  });
  function showAddressOverlay() {
    addressInput.value = addressText || '';
    addressOverlay.style.display = 'block';
    addressInput.focus();
    addressInput.select();
    console.log('[BrowserWindow] Address overlay open');
  }
  function hideAddressOverlay() {
    addressOverlay.style.display = 'none';
  }

  // Raycast toolbar / content for human clicks (spectator)
  const _raycaster = new THREE.Raycaster();
  const _pointer = new THREE.Vector2();
  let lastCamera = null;

  function onCanvasPointer(e) {
    if (!lastCamera) return;
    const canvasEl = document.querySelector('#scene');
    if (!canvasEl) return;
    const rect = canvasEl.getBoundingClientRect();
    _pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    _pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    _raycaster.setFromCamera(_pointer, lastCamera);
    const hits = _raycaster.intersectObjects([toolbarMesh, mesh], false);
    if (!hits.length) return;
    const hit = hits[0];
    const uv = hit.uv;
    if (!uv) return;
    if (hit.object === toolbarMesh) {
      e.preventDefault();
      e.stopPropagation();
      // UV: 0..1 left→right, bottom→top in three.js
      const nx = uv.x;
      const ny = 1 - uv.y;
      // Button hit regions matching paintToolbar layout (px / contentW)
      const px = nx * contentW;
      if (px < 42) {
        if (canGoBack) goBack();
      } else if (px < 80) {
        if (canGoForward) goForward();
      } else if (px < 118) {
        reload();
      } else {
        showAddressOverlay();
      }
      return;
    }
    // Content clicks: optional human click-through later
  }
  const canvasEl = document.querySelector('#scene');
  canvasEl?.addEventListener('pointerdown', onCanvasPointer, true);

  // In-scene AI mouse cursor (OS cursor is not in offscreen paints)
  const cursor = createBrowserCursorMesh();
  cursor.mesh.visible = false;
  mesh.add(cursor.mesh);
  // Local plane: center origin, X right, Y up — map UV nx,ny → local
  let cursorNx = 0.5;
  let cursorNy = 0.5;
  let cursorTargetNx = 0.5;
  let cursorTargetNy = 0.5;
  let cursorVisibleUntil = 0;
  let cursorClickPulse = 0;

  function applyCursorLocal() {
    const lx = (cursorNx - 0.5) * planeW;
    const ly = (0.5 - cursorNy) * planeH;
    cursor.mesh.position.set(lx, ly, 0.004);
    const pulse = 1 + cursorClickPulse * 0.35;
    cursor.mesh.scale.setScalar(pulse);
  }
  applyCursorLocal();

  let lastUrl = url;
  let lastTitle = '';
  let guestReady = false;
  let unsubPaint = null;
  let unsubNav = null;
  let unsubCursor = null;
  let paintCount = 0;

  const applyPaint = (frame) => {
    if (!frame?.data) return;
    const img = new Image();
    img.onload = () => {
      try {
        ctx.drawImage(img, 0, 0, contentW, contentH);
        texture.needsUpdate = true;
        paintCount++;
      } catch (e) {
        console.warn('[BrowserWindow] paint draw failed:', e?.message ?? e);
      }
    };
    img.onerror = () => {
      console.warn('[BrowserWindow] paint image decode failed');
    };
    img.src = `data:${frame.mimeType || 'image/jpeg'};base64,${frame.data}`;
  };

  unsubPaint = electronApi.onPaint?.(applyPaint);
  unsubNav = electronApi.onNav?.((info) => {
    if (info?.url) {
      const next = String(info.url);
      if (next !== lastUrl) {
        lastUrl = next;
        addressText = next;
        paintToolbar();
      }
    }
    if (info?.title != null) lastTitle = info.title;
    if (info?.guestReady != null) guestReady = !!info.guestReady;
    if (info?.canGoBack != null || info?.canGoForward != null) {
      canGoBack = !!info?.canGoBack;
      canGoForward = !!info?.canGoForward;
      paintToolbar();
    }
  });
  unsubCursor = electronApi.onCursor?.((info) => {
    if (!info) return;
    if (Number.isFinite(info.x) && Number.isFinite(info.y)) {
      setCursorNormalized(info.x, info.y, { phase: info.phase || 'move' });
    }
  });

  // Initial navigation
  electronApi.navigate(url).then((r) => {
    if (r?.url) {
      lastUrl = r.url;
      addressText = r.url;
      paintToolbar();
    }
    guestReady = !!r?.guestReady || !!r?.ok;
  }).catch((e) => console.warn('[BrowserWindow] initial navigate:', e));

  function setSize(_width, _height) {
    // Physical WebGL panel — no CSS3D resize needed
  }

  function setCursorNormalized(nx, ny, { phase = 'move', immediate = false } = {}) {
    cursorTargetNx = clamp01(nx);
    cursorTargetNy = clamp01(ny);
    if (immediate) {
      cursorNx = cursorTargetNx;
      cursorNy = cursorTargetNy;
      applyCursorLocal();
    }
    cursor.mesh.visible = true;
    cursorVisibleUntil = performance.now() + 12000;
    if (phase === 'click' || phase === 'check' || phase === 'dblclick') {
      cursorClickPulse = 1;
    }

  }

  function updateCursor(delta = 1 / 60) {
    const dt = Math.min(0.05, Math.max(0, Number(delta) || 0.016));
    const k = 1 - Math.exp(-14 * dt);
    cursorNx += (cursorTargetNx - cursorNx) * k;
    cursorNy += (cursorTargetNy - cursorNy) * k;
    if (cursorClickPulse > 0) {
      cursorClickPulse = Math.max(0, cursorClickPulse - dt * 4);
    }
    applyCursorLocal();
    if (cursor.mesh.visible && performance.now() > cursorVisibleUntil) {
      cursor.mesh.visible = false;
    }
  }

  /**
   * Per-frame updates (cursor). Panel is pure WebGL — no CSS3D pass.
   */
  function render(camera, { delta = 1 / 60 } = {}) {
    if (camera) lastCamera = camera;
    updateCursor(delta);
  }

  async function setUrl(nextUrl) {
    addressText = nextUrl;
    paintToolbar();
    const r = await electronApi.navigate(nextUrl);
    if (r?.url) {
      lastUrl = r.url;
      addressText = r.url;
      paintToolbar();
    }
    guestReady = r?.guestReady !== false && r?.ok !== false;
    return r;
  }

  async function goBack() {
    console.log('[BrowserWindow] Back');
    return electronApi.goBack();
  }

  async function goForward() {
    console.log('[BrowserWindow] Forward');
    return electronApi.goForward();
  }

  async function reload() {
    console.log('[BrowserWindow] Reload');
    return electronApi.reload();
  }

  function dispose() {
    unsubPaint?.();
    unsubNav?.();
    unsubCursor?.();
    canvasEl?.removeEventListener('pointerdown', onCanvasPointer, true);
    hideAddressOverlay();
    addressOverlay.remove();
    scene.remove(root);
    chassis.geometry.dispose();
    chassis.material.dispose();
    lip.geometry.dispose();
    lip.material.dispose();
    toolbarMesh.geometry.dispose();
    toolbarMesh.material.dispose();
    toolbarTexture.dispose();
    mesh.geometry.dispose();
    mesh.material.dispose();
    texture.dispose();
    bezel.geometry.dispose();
    bezel.material.dispose();
    cursor.dispose();
    console.log('[BrowserWindow] Disposed (physical WebGL panel)');
  }

  /**
   * Ensure the page CanvasTexture is uploaded before an offscreen FPV pass.
   * Without this, some GPU paths can sample a stale/empty map on the first RT render.
   */
  function prepareForVisionCapture() {
    try {
      texture.needsUpdate = true;
      toolbarTexture.needsUpdate = true;
      mesh.visible = true;
      bezel.visible = true;
      toolbarMesh.visible = true;
      chassis.visible = true;
      root.updateMatrixWorld(true);
      // Expected until first Playwright paint after navigate — log once, not every FPV frame
      if (paintCount === 0 && !prepareForVisionCapture._warned) {
        prepareForVisionCapture._warned = true;
        console.warn(
          '[BrowserWindow] prepareForVisionCapture: no paints yet (loading plane until first browser:paint)',
        );
      }
      if (paintCount > 0) prepareForVisionCapture._warned = false;
    } catch (e) {
      console.warn('[BrowserWindow] prepareForVisionCapture:', e?.message ?? e);
    }
  }

  /** Debug: world-space center of the content plane (for FPV diagnostics). */
  function getContentWorldCenter(out = new THREE.Vector3()) {
    mesh.getWorldPosition(out);
    return out;
  }

  function getCapabilities() {
    return {
      mode: 'offscreen',
      canInput: true,
      canExecuteJs: true,
      contentWidth: contentW,
      contentHeight: contentH,
      toolbarHeight: TOOLBAR_H,
    };
  }

  function isGuestReady() {
    return guestReady;
  }

  async function waitForLoad(timeoutMs = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (guestReady) return true;
      const st = await electronApi.getState({}).catch(() => null);
      if (st?.guestReady) {
        guestReady = true;
        return true;
      }
      await delay(150);
    }
    return guestReady;
  }

  async function normalizedToContentPx(nx, ny) {
    const x = Math.round(clamp01(nx) * Math.max(contentW - 1, 1));
    const y = Math.round(clamp01(ny) * Math.max(contentH - 1, 1));
    return { x, y, contentWidth: contentW, contentHeight: contentH };
  }

  async function sendMouseClick(x, y, { button = 'left', clickCount = 1 } = {}) {
    const nx = contentW > 0 ? x / contentW : 0.5;
    const ny = contentH > 0 ? y / contentH : 0.5;
    setCursorNormalized(nx, ny, { phase: 'click' });
    return electronApi.click({ x: nx, y: ny, button, clickCount });
  }

  /** Full smart-click payload (preferred). */
  async function sendClickSmart(payload) {
    const p = payload || {};
    if (p.x != null && p.y != null) {
      setCursorNormalized(p.x, p.y, { phase: 'click' });
    }
    return electronApi.click(p);
  }

  async function hoverSmart(payload) {
    if (typeof electronApi.hover === 'function') {
      console.log('[BrowserWindow] hoverSmart', payload);
      const p = payload || {};
      if (p.x != null && p.y != null) {
        setCursorNormalized(p.x, p.y, { phase: 'hover' });
      }
      return electronApi.hover(p);
    }
    // Fallback: click without completing is wrong — just no-op with error
    return { ok: false, error: 'hover_unavailable' };
  }

  async function moveSmart(payload) {
    const p = payload || {};
    if (p.x != null && p.y != null) {
      setCursorNormalized(p.x, p.y, { phase: 'move' });
    }
    if (typeof electronApi.move === 'function') {
      console.log('[BrowserWindow] moveSmart', p);
      return electronApi.move(p);
    }
    // Soft fallback: hover at coords
    if (p.x != null && p.y != null && typeof electronApi.hover === 'function') {
      return electronApi.hover({ x: p.x, y: p.y, dwellMs: 50, resnapshot: false });
    }
    return { ok: false, error: 'move_unavailable' };
  }

  async function sendMouseDrag(x1, y1, x2, y2) {
    await electronApi.drag({
      x1: x1 / contentW,
      y1: y1 / contentH,
      x2: x2 / contentW,
      y2: y2 / contentH,
    });
  }

  async function sendScroll(x, y, deltaX, deltaY) {
    return electronApi.scroll({
      x: contentW > 0 ? x / contentW : 0.5,
      y: contentH > 0 ? y / contentH : 0.5,
      dx: deltaX,
      dy: deltaY,
    });
  }

  /** Full smart-scroll payload (preferred). */
  async function sendScrollSmart(payload) {
    return electronApi.scroll(payload || {});
  }

  async function sendKey(keyName) {
    return electronApi.key({ key: keyName });
  }

  async function sendKeyChord(chord) {
    return electronApi.key({ key: chord });
  }

  async function sendKeySmart(payload) {
    return electronApi.key(payload || {});
  }

  async function typeText(text, { charDelayMs: _d } = {}) {
    return electronApi.type({ text: String(text) });
  }

  async function typeSmart(payload) {
    return electronApi.type(payload || {});
  }

  async function selectSmart(payload) {
    if (typeof electronApi.select === 'function') {
      return electronApi.select(payload || {});
    }
    return electronApi.drag(payload || {});
  }

  async function dismissSmart(payload) {
    if (typeof electronApi.dismiss === 'function') {
      console.log('[BrowserWindow] dismissSmart', payload);
      return electronApi.dismiss(payload || {});
    }
    // Fallback: Escape
    return electronApi.key({ key: 'Escape' });
  }

  async function checkSmart(payload) {
    const p = payload || {};
    if (p.x != null && p.y != null) {
      setCursorNormalized(p.x, p.y, { phase: 'check' });
    }
    if (typeof electronApi.check === 'function') {
      console.log('[BrowserWindow] checkSmart', p);
      return electronApi.check(p);
    }
    // Fallback: click with checked intent
    return electronApi.click({ ...p, force: true });
  }

  async function getPageState({ includeElements = false, includeAx = false, includeText = false } = {}) {
    const st = await electronApi.getState({
      includeElements: includeElements || includeAx,
      includeAx: includeAx || includeElements,
      includeText,
    });
    if (st?.url) lastUrl = st.url;
    if (st?.title != null) lastTitle = st.title;
    if (st?.guestReady != null) guestReady = !!st.guestReady;

    return {
      url: st?.url ?? lastUrl,
      title: st?.title ?? lastTitle,
      mode: st?.mode || 'playwright-chromium',
      canInput: true,
      targeting: st?.targeting || 'playwright-locator+ref',
      engine: st?.engine || 'playwright-chromium',
      cdpAttached: !!st?.cdpAttached,
      guestReady,
      contentWidth: contentW,
      contentHeight: contentH,
      elements: st?.elements,
      axTree: st?.axTree,
      scroll: st?.scroll,
      textSample: st?.textSample,
      elementCount: st?.elementCount,
      modalBlocking: !!st?.modalBlocking,
      modalCount: st?.modalCount ?? 0,
      closeRefs: st?.closeRefs || [],
      modals: st?.modals,
      elementsError: st?.elementsError,
      canGoBack: st?.canGoBack,
      canGoForward: st?.canGoForward,
    };
  }

  async function getAxSnapshot() {
    if (typeof electronApi.axSnapshot === 'function') {
      const snap = await electronApi.axSnapshot({});
      console.log('[BrowserWindow] axSnapshot count=', snap?.count);
      return snap;
    }
    return getPageState({ includeElements: true, includeAx: true, includeText: true });
  }

  async function getElementBox(elementIdOrRef) {
    const st = await getPageState({ includeElements: true });
    const key = elementIdOrRef;
    let el = null;
    if (typeof key === 'string' && key.startsWith('e')) {
      el = (st.elements || []).find((e) => e.ref === key);
    } else {
      el = st.elements?.[Number(key)];
      if (!el && typeof key === 'string') {
        el = (st.elements || []).find((e) => e.ref === key || e.ref === `e${key}`);
      }
    }
    if (!el) return null;
    return {
      cx: el.cx,
      cy: el.cy,
      x: el.x,
      y: el.y,
      w: el.w,
      h: el.h,
      label: el.label || el.name,
      ref: el.ref,
      role: el.role,
    };
  }

  async function getSelectedText() {
    const r = await electronApi.executeJs(
      `(window.getSelection && window.getSelection().toString()) || ''`,
    );
    return r?.ok ? String(r.result || '') : '';
  }

  async function getVisibleTextSample(maxLen = 4000) {
    const r = await electronApi.executeJs(`
      (function(){
        const t = (document.body && (document.body.innerText || document.body.textContent) || '').replace(/\\s+/g,' ').trim();
        return t.slice(0, ${Number(maxLen) || 4000});
      })()
    `);
    return r?.ok ? String(r.result || '') : '';
  }

  async function captureContentJpeg() {
    // Offscreen already streams paints; vision uses full window capture.
    // Optional: return last paint is complex; skip.
    return null;
  }

  async function executeJavaScript(code) {
    const r = await electronApi.executeJs(code);
    if (!r?.ok) throw new Error(r?.error || 'execute_failed');
    return r.result;
  }

  // Anchor for spatial look_at — content plane world pose
  const cssObject = root;

  return {
    cssObject,
    contentMesh: mesh,
    toolbarMesh,
    panelRoot: root,
    view: null,
    render,
    setSize,
    setUrl,
    goBack,
    goForward,
    reload,
    dispose,
    prepareForVisionCapture,
    getContentWorldCenter,
    getCapabilities,
    isGuestReady,
    waitForLoad,
    executeJavaScript,
    normalizedToContentPx,
    sendMouseClick,
    sendClickSmart,
    hoverSmart,
    moveSmart,
    setCursorNormalized,
    getCursorNormalized: () => ({ x: cursorNx, y: cursorNy, targetX: cursorTargetNx, targetY: cursorTargetNy }),
    updateCursor,
    sendMouseDrag,
    sendScroll,
    sendScrollSmart,
    sendKey,
    sendKeyChord,
    sendKeySmart,
    typeText,
    typeSmart,
    selectSmart,
    dismissSmart,
    checkSmart,
    getPageState,
    getAxSnapshot,
    getElementBox,
    getSelectedText,
    getVisibleTextSample,
    captureContentJpeg,
  };
}

/** Canvas 2D rounded rect helper for WebGL toolbar paint. */
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// Tab fallback: iframe CSS3D (limited sites)
// ---------------------------------------------------------------------------

function createIframeCss3dBrowser(scene, {
  url,
  widthPx,
  heightPx,
  position,
  rotation,
  scale,
}) {
  console.log('[BrowserWindow] Creating iframe CSS3D fallback ->', url);

  const cssRenderer = new CSS3DRenderer();
  const cssEl = cssRenderer.domElement;
  cssEl.style.position = 'absolute';
  cssEl.style.top = '0';
  cssEl.style.left = '0';
  cssEl.style.width = '100%';
  cssEl.style.height = '100%';
  cssEl.style.pointerEvents = 'none';
  cssEl.style.zIndex = '2';

  const mount = document.querySelector('#app') || document.body;
  mount.appendChild(cssEl);
  cssRenderer.setSize(mount.clientWidth || window.innerWidth, mount.clientHeight || window.innerHeight);

  const contentH = heightPx - TOOLBAR_H;
  const viewEl = document.createElement('iframe');
  viewEl.src = url;
  viewEl.setAttribute('title', 'In-scene browser');
  viewEl.style.width = `${widthPx}px`;
  viewEl.style.height = `${contentH}px`;
  viewEl.style.border = '0';
  viewEl.style.background = '#ffffff';
  viewEl.style.pointerEvents = 'auto';

  const toolbar = buildToolbar({
    useWebview: false,
    onBack: () => goBack(),
    onForward: () => goForward(),
    onReload: () => reload(),
    onNavigate: (value) => setUrl(normalizeInputToUrl(value)),
  });
  toolbar.setValue(url);

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

  const cssObject = new CSS3DObject(wrapper);
  cssObject.name = 'FloatingBrowserWindow';
  cssObject.position.copy(position);
  cssObject.rotation.copy(rotation);
  cssObject.scale.setScalar(scale);
  scene.add(cssObject);

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
    }),
  );
  backing.position.copy(position);
  backing.rotation.copy(rotation);
  scene.add(backing);

  function setSize(width, height) {
    cssRenderer.setSize(width, height);
  }

  /** Spectator camera only — never FPV vision camera (toolbar flicker). */
  function render(camera, { updateCss3d = true } = {}) {
    if (updateCss3d !== false && camera) {
      cssRenderer.render(scene, camera);
    }
  }

  function setUrl(nextUrl) {
    console.log('[BrowserWindow] iframe navigate', nextUrl);
    viewEl.src = nextUrl;
    toolbar.setValue(nextUrl);
  }

  function goBack() {
    try {
      viewEl.contentWindow?.history.back();
    } catch (e) {
      console.warn('[BrowserWindow] iframe back blocked:', e);
    }
  }

  function goForward() {
    try {
      viewEl.contentWindow?.history.forward();
    } catch (e) {
      console.warn('[BrowserWindow] iframe forward blocked:', e);
    }
  }

  function reload() {
    viewEl.src = viewEl.src; // eslint-disable-line no-self-assign
  }

  function dispose() {
    scene.remove(cssObject);
    scene.remove(backing);
    backing.geometry.dispose();
    backing.material.dispose();
    cssEl.remove();
  }

  function getCapabilities() {
    return {
      mode: 'iframe',
      canInput: false,
      canExecuteJs: false,
      contentWidth: widthPx,
      contentHeight: contentH,
      toolbarHeight: TOOLBAR_H,
    };
  }

  return {
    cssObject,
    view: viewEl,
    render,
    setSize,
    setUrl,
    goBack,
    goForward,
    reload,
    dispose,
    getCapabilities,
    isGuestReady: () => true,
    waitForLoad: async () => true,
    executeJavaScript: async () => {
      throw new Error('iframe_js_blocked');
    },
    normalizedToContentPx: async (nx, ny) => ({
      x: Math.round(clamp01(nx) * (widthPx - 1)),
      y: Math.round(clamp01(ny) * (contentH - 1)),
      contentWidth: widthPx,
      contentHeight: contentH,
    }),
    sendMouseClick: async () => {
      throw new Error('input_requires_electron');
    },
    sendMouseDrag: async () => {
      throw new Error('input_requires_electron');
    },
    sendScroll: async () => {
      throw new Error('input_requires_electron');
    },
    sendKey: async () => {
      throw new Error('input_requires_electron');
    },
    sendKeyChord: async () => {
      throw new Error('input_requires_electron');
    },
    typeText: async () => {
      throw new Error('input_requires_electron');
    },
    getPageState: async () => ({
      url: viewEl.src,
      title: null,
      mode: 'iframe',
      canInput: false,
      guestReady: true,
      contentWidth: widthPx,
      contentHeight: contentH,
    }),
    getElementBox: async () => null,
    getSelectedText: async () => '',
    getVisibleTextSample: async () => '',
    captureContentJpeg: async () => null,
  };
}

// ---------------------------------------------------------------------------
// Shared UI helpers
// ---------------------------------------------------------------------------

/** Classic arrow pointer as a small textured mesh (parented to browser plane). */
function createBrowserCursorMesh() {
  const size = 48;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  g.clearRect(0, 0, size, size);
  // Arrow pointer (hotspot ~ top-left of arrow)
  g.beginPath();
  g.moveTo(4, 2);
  g.lineTo(4, 36);
  g.lineTo(14, 28);
  g.lineTo(20, 44);
  g.lineTo(26, 42);
  g.lineTo(20, 26);
  g.lineTo(34, 26);
  g.closePath();
  g.fillStyle = '#ffffff';
  g.strokeStyle = '#111111';
  g.lineWidth = 2;
  g.lineJoin = 'round';
  g.fill();
  g.stroke();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;

  const world = 0.055;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(world, world),
    new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
  );
  mesh.name = 'BrowserCursor';
  mesh.renderOrder = 10;
  // Hotspot offset so tip is at UV point
  mesh.geometry.translate(world * 0.22, -world * 0.22, 0);

  console.log('[BrowserWindow] 3D cursor mesh created');

  return {
    mesh,
    dispose() {
      mesh.geometry.dispose();
      mesh.material.dispose();
      tex.dispose();
    },
  };
}

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
    b.addEventListener('mouseenter', () => {
      b.style.background = '#e0e3e7';
    });
    b.addEventListener('mouseleave', () => {
      b.style.background = 'transparent';
    });
    b.addEventListener('click', (e) => {
      e.preventDefault();
      onClick();
    });
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
  input.addEventListener('focus', () => {
    input.style.borderColor = '#1a73e8';
    input.select();
  });
  input.addEventListener('blur', () => {
    input.style.borderColor = '#dadce0';
  });
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

  let lastNavBack = null;
  let lastNavFwd = null;
  let lastValue = '';

  return {
    el,
    setValue: (v) => {
      const s = v == null ? '' : String(v);
      // Skip no-op writes — reassigning input.value can flash caret/layout in CSS3D
      if (s === lastValue && document.activeElement !== input) return;
      if (document.activeElement === input) return;
      lastValue = s;
      input.value = s;
    },
    setNavState: ({ canGoBack, canGoForward }) => {
      const back = !!canGoBack;
      const fwd = !!canGoForward;
      if (back === lastNavBack && fwd === lastNavFwd) return;
      lastNavBack = back;
      lastNavFwd = fwd;
      backBtn.style.opacity = back ? '1' : '0.4';
      fwdBtn.style.opacity = fwd ? '1' : '0.4';
      backBtn.style.cursor = back ? 'pointer' : 'default';
      fwdBtn.style.cursor = fwd ? 'pointer' : 'default';
    },
  };
}

function normalizeInputToUrl(value) {
  if (!value) return 'about:blank';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  if (/^[^\s]+\.[^\s]+$/.test(value) && !value.includes(' ')) return `https://${value}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(value)}`;
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
