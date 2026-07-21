/**
 * BrowserController — AI-driven control of the in-scene floating browser.
 *
 * Primary targeting: Playwright locators + AX refs (ref=e1, e2, …).
 * Vision coords x,y are fallback only.
 * Input: Playwright click/fill/keyboard via main-process browserService.
 *
 * Electron: Playwright Chromium screenshots → WebGL plane. No <webview>.
 * iframe tab mode: navigate only.
 *
 * Commands are queued and run serially (including multi-step run_plan).
 */

const MAX_PLAN_STEPS = 10;
/** Cap serial queue so AI parallel tool storms cannot pile up forever. */
const MAX_QUEUE = 6;
const TYPE_CHAR_DELAY_MS = 18;
const AFTER_NAV_SETTLE_MS = 500;
const AFTER_CLICK_SETTLE_MS = 280;
/** Extra pause after load before optional guest JS / capture. */
const AFTER_LOAD_READY_MS = 400;
/** Prefer DDG — Google often serves /sorry bot walls to Playwright. */
const SEARCH_ENGINE_URL = (q) =>
  `https://duckduckgo.com/?q=${encodeURIComponent(q)}`;

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** True if already on target site (path prefixes / known SPA redirects). */
function urlsEffectivelySame(current, requested) {
  try {
    const a = new URL(String(current || ''));
    const b = new URL(String(requested || ''));
    if (a.origin !== b.origin) return false;
    // Exact match
    if (a.pathname === b.pathname) return true;
    // Discord SPA: /app, /login, /channels/* are the same "app"
    if (/(^|\.)discord\.com$/i.test(a.hostname)) {
      const ap = a.pathname.replace(/\/$/, '') || '/';
      const bp = b.pathname.replace(/\/$/, '') || '/';
      const discordApp =
        /^\/(app|channels|login|store|shop|activities|discovery|quest-home)/i;
      if (discordApp.test(ap) && (discordApp.test(bp) || bp === '/' || bp === '/app')) {
        return true;
      }
    }
    // Generic: requested path is prefix of current (e.g. /app → /app/foo)
    if (b.pathname !== '/' && a.pathname.startsWith(b.pathname.replace(/\/$/, ''))) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export class BrowserController {
  /**
   * @param {object} opts
   * @param {() => any} opts.getBrowserWindow - return value of createBrowserWindow
   * @param {(msg: object) => void} opts.sendResult
   * @param {() => import('./gestureSystem.js').GestureController|null} [opts.getGesture]
   */
  constructor(opts) {
    this.opts = opts;
    /** @type {Array<{id:string,name:string,args:object,cancelled?:boolean}>} */
    this.queue = [];
    this.busy = false;
    /** Ids the bridge already timed out / cancelled — skip finish if still running. */
    this.cancelledIds = new Set();
    console.log('[BrowserCtrl] Controller created.');
  }

  /** Reach / click arm pose when interacting with the in-scene browser. */
  _playArm(kind, args = {}) {
    try {
      const g = this.opts.getGesture?.();
      if (!g || typeof g.playBrowserInteract !== 'function') return;
      g.playBrowserInteract(kind, { side: args.side === 'left' ? 'left' : 'right' });

    } catch (e) {
      console.warn('[BrowserCtrl] Arm pose failed:', e?.message ?? e);
    }
  }

  /** Keep 3D cursor in sync when results include coords. */
  _syncCursor(bw, result, phase = 'move') {
    if (!bw || !result) return;
    try {
      if (typeof bw.setCursorNormalized === 'function') {
        if (result.x != null && result.y != null) {
          bw.setCursorNormalized(result.x, result.y, { phase });
        } else if (result.px && result.px.x != null) {
          const caps = bw.getCapabilities?.() || {};
          const w = caps.contentWidth || 1024;
          const h = caps.contentHeight || 720;
          bw.setCursorNormalized(result.px.x / Math.max(w - 1, 1), result.px.y / Math.max(h - 1, 1), {
            phase
          });
        }
      }
    } catch (e) {
      console.warn('[BrowserCtrl] cursor sync:', e?.message ?? e);
    }
  }

  handleCommand(cmd) {
    const id = String(cmd.id);
    if (this.cancelledIds.has(id)) {
      console.log(`[BrowserCtrl] Ignore already-cancelled ${cmd.name} ${id}`);
      return;
    }

    // Drop excess work with an immediate failure so Live is not left hanging.
    if (this.queue.length >= MAX_QUEUE) {
      console.warn(
        `[BrowserCtrl] Queue full (${this.queue.length}); rejecting ${cmd.name} ${id}`,
      );
      this.opts.sendResult?.({
        type: 'browserResult',
        id,
        name: String(cmd.name),
        result: {
          ok: false,
          error: 'queue_full',
          message:
            'Browser queue full. Stop issuing parallel browser tools; wait and use one multi-step plan.',
          queueLen: this.queue.length
        }
      });
      return;
    }

    this.queue.push({
      id,
      name: String(cmd.name),
      args: cmd.args && typeof cmd.args === 'object' ? cmd.args : {}
    });

    this._pumpQueue();
  }

  /**
   * Cancel one id or the entire queue (from AI bridge timeout / user cancel).
   * @param {{ id?: string, all?: boolean, reason?: string }} opts
   */
  cancel(opts = {}) {
    const reason = String(opts.reason || 'cancelled');
    if (opts.all) {
      const dropped = this.queue.splice(0, this.queue.length);
      for (const q of dropped) {
        this.cancelledIds.add(q.id);
        this.opts.sendResult?.({
          type: 'browserResult',
          id: q.id,
          name: q.name,
          result: { ok: false, error: 'cancelled', message: reason }
        });
      }
      // Mark current run as cancelled so _finish is skipped / reported cancelled
      this.currentId = null;
      console.log(`[BrowserCtrl] cancel all n=${dropped.length} reason=${reason}`);
      return;
    }
    if (opts.id) {
      const id = String(opts.id);
      this.cancelledIds.add(id);
      const before = this.queue.length;
      this.queue = this.queue.filter((q) => {
        if (q.id !== id) return true;
        this.opts.sendResult?.({
          type: 'browserResult',
          id: q.id,
          name: q.name,
          result: { ok: false, error: 'cancelled', message: reason }
        });
        return false;
      });
      console.log(
        `[BrowserCtrl] cancel id=${id} removed=${before - this.queue.length} reason=${reason}`,
      );
    }
  }

  dispose() {
    this.queue = [];
    this.busy = false;
    this.cancelledIds.clear();
    console.log('[BrowserCtrl] Disposed.');
  }

  _pumpQueue() {
    if (this.busy || this.queue.length === 0) return;
    const next = this.queue.shift();
    if (this.cancelledIds.has(next.id)) {
      console.log(`[BrowserCtrl] Skip cancelled ${next.name} ${next.id}`);
      this._pumpQueue();
      return;
    }
    this.busy = true;
    this.currentId = next.id;
    this._runCommand(next)
      .catch((e) => {
        console.error('[BrowserCtrl] Command error:', e);
        this._finish(next.id, next.name, { ok: false, error: String(e?.message ?? e) });
      })
      .finally(() => {
        // _finish clears busy for top-level; nested steps keep busy via run_plan
      });
  }

  async _runCommand(cmd) {
    const { id, name, args } = cmd;
    if (this.cancelledIds.has(id)) {
      this.busy = false;
      this.currentId = null;
      this._pumpQueue();
      return;
    }


    if (name === 'run_plan' || name === 'use_browser') {
      await this._cmdRunPlan(id, name === 'use_browser' ? 'use_browser' : String(args.originalName || 'run_plan'), args);
      return;
    }

    const result = await this._executeStep(name, args);
    this._finish(id, name, result);
  }

  async _cmdRunPlan(id, originalName, args) {
    const steps = Array.isArray(args.steps) ? args.steps : [];
    const planner = String(args.planner || 'unknown');
    const reasoning = args.reasoning ? String(args.reasoning) : '';

    console.log(
      `[BrowserCtrl] run_plan planner=${planner} steps=${steps.map((s) => s?.name).join('→') || '(empty)'} reason=${reasoning}`,
    );

    if (steps.length === 0) {
      this._finish(id, originalName, {
        ok: false,
        error: 'empty_plan',
        planner,
        ...(await this._pageState())
      });
      return;
    }

    const limited = steps.slice(0, MAX_PLAN_STEPS);
    const stepResults = [];
    for (let i = 0; i < limited.length; i++) {
      const step = limited[i];
      const stepName = String(step?.name || '');
      const stepArgs = step?.args && typeof step.args === 'object' ? step.args : {};
      if (!stepName) continue;

      const result = await this._executeStep(stepName, stepArgs);
      stepResults.push({ name: stepName, ok: result?.ok !== false, error: result?.error });
      if (result?.ok === false && result?.fatal) {
        console.warn('[BrowserCtrl] Fatal step error; aborting plan.', result.error);
        break;
      }
    }

    const state = await this._pageState({ includeElements: true });
    this._finish(id, originalName, {
      ok: true,
      planner,
      reasoning,
      stepsRun: stepResults.map((s) => s.name),
      stepResults,
      ...state
    });
  }

  async _executeStep(name, args) {
    const bw = this.opts.getBrowserWindow?.();
    if (!bw) {
      return { ok: false, error: 'no_browser', fatal: true };
    }

    try {
      switch (name) {
        case 'browser_navigate':
          return await this._nav(bw, args);
        case 'browser_back':
          bw.goBack();
          await delay(AFTER_NAV_SETTLE_MS);
          if (typeof bw.waitForLoad === 'function') await bw.waitForLoad(12000).catch(() => false);
          await delay(AFTER_LOAD_READY_MS);
          return { ok: true, action: 'back', ...(await this._pageState()) };
        case 'browser_forward':
          bw.goForward();
          await delay(AFTER_NAV_SETTLE_MS);
          if (typeof bw.waitForLoad === 'function') await bw.waitForLoad(12000).catch(() => false);
          await delay(AFTER_LOAD_READY_MS);
          return { ok: true, action: 'forward', ...(await this._pageState()) };
        case 'browser_reload':
          bw.reload();
          await delay(AFTER_NAV_SETTLE_MS);
          if (typeof bw.waitForLoad === 'function') await bw.waitForLoad(12000).catch(() => false);
          await delay(AFTER_LOAD_READY_MS);
          return { ok: true, action: 'reload', ...(await this._pageState()) };
        case 'browser_click':
          this._playArm('click', args);
          return await this._click(bw, args, 1);
        case 'browser_dblclick':
          this._playArm('dblclick', args);
          return await this._click(bw, args, 2);
        case 'browser_hover':
          this._playArm('hover', args);
          return await this._hover(bw, args);
        case 'browser_move':
        case 'browser_cursor':
          this._playArm('move', args);
          return await this._move(bw, args);
        case 'browser_scroll':
          this._playArm('scroll', args);
          return await this._scroll(bw, args);
        case 'browser_type':
          this._playArm('type', args);
          return await this._type(bw, args);
        case 'browser_key':
          this._playArm('key', args);
          return await this._key(bw, args);
        case 'browser_select':
          this._playArm('select', args);
          return await this._select(bw, args);
        case 'browser_check':
        case 'browser_uncheck':
        case 'browser_toggle':
          this._playArm('check', args);
          return await this._check(bw, {
            ...args,
            ...(name === 'browser_uncheck' ? { checked: false } : {}),
            ...(name === 'browser_toggle' ? { toggle: true } : {}),
            ...(name === 'browser_check' && args.checked === undefined && args.toggle !== true
              ? { checked: true }
              : {})
          });
        case 'browser_dismiss':
          this._playArm('click', args);
          return await this._dismiss(bw, args);
        case 'browser_read':
          return await this._read(bw, args);
        case 'browser_snapshot':
          return await this._snapshot(bw, args);
        default:
          return { ok: false, error: `unknown_browser_step:${name}` };
      }
    } catch (e) {
      console.error(`[BrowserCtrl] Step ${name} failed:`, e);
      return { ok: false, error: String(e?.message ?? e), ...(await this._pageState()) };
    }
  }

  async _nav(bw, args) {
    let url = args.url != null ? String(args.url).trim() : '';
    const query = args.query != null ? String(args.query).trim() : '';
    if (!url && query) {
      // DuckDuckGo avoids Google /sorry bot interstitials in headless/Playwright.
      url = SEARCH_ENGINE_URL(query);
    }
    if (!url) {
      return { ok: false, error: 'missing_url_or_query' };
    }
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && /^[^\s]+\.[^\s]+$/.test(url) && !url.includes(' ')) {
      url = `https://${url}`;
    }
    // Rewrite google search URLs to DDG (model often hardcodes google.com/search).
    try {
      const u = new URL(url);
      if (
        /(^|\.)google\.[a-z.]+$/i.test(u.hostname) &&
        (u.pathname.startsWith('/search') || u.pathname === '/')
      ) {
        const q = u.searchParams.get('q') || query;
        if (q) {
          console.log('[BrowserCtrl] Rewrite Google search → DuckDuckGo', q);
          url = SEARCH_ENGINE_URL(q);
        }
      }
    } catch {
      /* keep url */
    }

    // Skip full reload when already on same app/site (e.g. discord.com/app → /channels/@me)
    try {
      const cur = await this._pageState({ includeElements: false });
      if (urlsEffectivelySame(cur?.url, url)) {
        console.log(
          `[BrowserCtrl] Skip navigate — already on ${cur.url} (requested ${url})`,
        );
        const full = await this._pageState({ includeElements: true });
        return {
          ok: true,
          action: 'navigate',
          skipped: true,
          alreadyThere: true,
          requestedUrl: url,
          ...full,
          elements: full.elements || []
        };
      }
    } catch {
      /* proceed with navigate */
    }

    console.log('[BrowserCtrl] Navigate →', url);

    // Offscreen path: setUrl awaits main-process loadURL (no renderer guest V8).
    const navResult = await Promise.resolve(bw.setUrl(url)).catch((e) => ({
      ok: false,
      error: String(e?.message ?? e)
    }));
    if (navResult && navResult.ok === false) {
      return { ok: false, action: 'navigate', requestedUrl: url, ...navResult };
    }

    await delay(AFTER_LOAD_READY_MS);
    // Single AX snapshot (was double-called and logged twice per navigate)
    let state = {};
    try {
      state = await this._pageState({ includeElements: true });
    } catch (e) {
      console.warn('[BrowserCtrl] post-nav state failed:', e?.message ?? e);
      state = await this._pageState({ includeElements: false }).catch(() => ({}));
    }

    const finalUrl = String(state.url || '');
    const captchaWall = /google\.[^/]+\/sorry|recaptcha|hcaptcha|challenges\.cloudflare|cdn-cgi\/challenge/i.test(
      finalUrl,
    );

    return {
      ok: true,
      action: 'navigate',
      requestedUrl: url,
      captchaWall,
      ...state,
      elements: state.elements || [],
      axTree: state.axTree
    };
  }

  async _click(bw, args, clickCount) {
    const caps = bw.getCapabilities?.() ?? {};
    if (!caps.canInput) {
      return {
        ok: false,
        fatal: true,
        error: 'input_requires_electron',
        ...(await this._pageState())
      };
    }

    const ref = args.ref != null ? String(args.ref).trim() : '';
    const elementId = args.elementId != null ? Number(args.elementId) : null;
    const role = args.role != null ? String(args.role) : '';
    const name = args.name != null ? String(args.name) : '';
    const text = args.text != null ? String(args.text) : args.label != null ? String(args.label) : '';
    const selector = args.selector != null ? String(args.selector) : '';
    const button = String(args.button || 'left');

    let x = args.x;
    let y = args.y;

    // Pre-resolve ref/elementId box for logging only
    if ((ref || Number.isFinite(elementId)) && x == null && y == null) {
      const box = await bw.getElementBox?.(ref || elementId);
      if (box) {
        x = box.cx;
        y = box.cy;
      }
    }

    const hoverFirst =
      args.hover === true || args.hoverFirst === true || args.hoverBefore === true;

    const payload = {
      ref: ref || undefined,
      role: role || undefined,
      name: name || undefined,
      x: x != null ? clamp01(x) : undefined,
      y: y != null ? clamp01(y) : undefined,
      elementId: Number.isFinite(elementId) ? elementId : undefined,
      text: text || undefined,
      selector: selector || undefined,
      button,
      clickCount,
      force: args.force !== false,
      hover: hoverFirst,
      hoverFirst,
      hoverMs: args.hoverMs != null ? Number(args.hoverMs) : undefined
    };

    console.log(
      `[BrowserCtrl] Click smart count=${clickCount} ref=${payload.ref || '-'} id=${payload.elementId ?? '-'} ` +
        `role=${role || '-'} text=${(text || name || '-').slice(0, 40)} hover=${hoverFirst} ` +
        `xy=${payload.x != null ? payload.x.toFixed(3) : '-'},${payload.y != null ? payload.y.toFixed(3) : '-'}`,
    );

    let result = null;
    if (typeof bw.sendClickSmart === 'function') {
      result = await bw.sendClickSmart(payload);
    } else {
      const nx = clamp01(x ?? 0.5);
      const ny = clamp01(y ?? 0.5);
      const px = await bw.normalizedToContentPx(nx, ny);
      await bw.sendMouseClick(px.x, px.y, { button, clickCount });
      result = { ok: true, method: 'legacy', x: nx, y: ny, px };
    }

    await delay(AFTER_CLICK_SETTLE_MS);
    await this._pushBrowserVision(bw);
    this._syncCursor(bw, result, clickCount > 1 ? 'dblclick' : 'click');

    if (result?.ok === false) {
      return {
        ok: false,
        action: clickCount > 1 ? 'dblclick' : 'click',
        error: result.error || 'click_failed',
        candidates: result.candidates,
        axTree: result.axTree,
        ...(await this._pageState({ includeElements: true }))
      };
    }

    return {
      ok: true,
      action: clickCount > 1 ? 'dblclick' : 'click',
      method: result.method,
      resolveMethod: result.resolveMethod,
      ref: result.ref,
      role: result.role,
      label: result.label,
      tag: result.tag,
      href: result.href,
      x: result.x,
      y: result.y,
      px: result.px,
      axTree: result.axTree,
      ...(await this._pageState({ includeElements: true }))
    };
  }

  async _move(bw, args) {
    const caps = bw.getCapabilities?.() ?? {};
    if (!caps.canInput) {
      return {
        ok: false,
        fatal: true,
        error: 'input_requires_electron',
        ...(await this._pageState())
      };
    }

    // Pre-resolve ref for visual cursor path
    let x = args.x != null ? clamp01(args.x) : undefined;
    let y = args.y != null ? clamp01(args.y) : undefined;
    const ref = args.ref != null ? String(args.ref).trim() : '';
    if ((ref || args.elementId != null) && x == null) {
      const box = await bw.getElementBox?.(ref || args.elementId);
      if (box) {
        x = box.cx;
        y = box.cy;
      }
    }
    if (x != null && y != null && typeof bw.setCursorNormalized === 'function') {
      bw.setCursorNormalized(x, y, { phase: 'move' });
    }

    const payload = {
      ref: ref || undefined,
      role: args.role != null ? String(args.role) : undefined,
      name: args.name != null ? String(args.name) : undefined,
      text: args.text != null ? String(args.text) : args.label != null ? String(args.label) : undefined,
      label: args.label,
      elementId: args.elementId != null ? Number(args.elementId) : undefined,
      selector: args.selector,
      x,
      y,
      steps: args.steps != null ? Number(args.steps) : 12,
      force: args.force !== false,
      capture: args.capture !== false
    };

    console.log(
      `[BrowserCtrl] Move ref=${payload.ref || '-'} xy=${x != null ? x.toFixed(3) : '-'},${y != null ? y.toFixed(3) : '-'}`,
    );

    let result = null;
    if (typeof bw.moveSmart === 'function') {
      result = await bw.moveSmart(payload);
    } else if (typeof bw.hoverSmart === 'function') {
      result = await bw.hoverSmart({ ...payload, dwellMs: 40, resnapshot: false });
    } else {
      result = { ok: false, error: 'move_unavailable' };
    }

    this._syncCursor(bw, result, 'move');
    await delay(80);
    return {
      ok: result?.ok !== false,
      action: 'move',
      method: result?.method,
      x: result?.x ?? x,
      y: result?.y ?? y,
      px: result?.px,
      error: result?.error,
      ...(await this._pageState())
    };
  }

  async _check(bw, args) {
    const caps = bw.getCapabilities?.() ?? {};
    if (!caps.canInput) {
      return {
        ok: false,
        fatal: true,
        error: 'input_requires_electron',
        ...(await this._pageState())
      };
    }

    const payload = {
      ref: args.ref != null ? String(args.ref) : undefined,
      role: args.role != null ? String(args.role) : undefined,
      name: args.name != null ? String(args.name) : undefined,
      text: args.text != null ? String(args.text) : args.label != null ? String(args.label) : undefined,
      label: args.label || args.field || args.text,
      field: args.field,
      elementId: args.elementId != null ? Number(args.elementId) : undefined,
      selector: args.selector,
      x: args.x != null ? clamp01(args.x) : undefined,
      y: args.y != null ? clamp01(args.y) : undefined,
      checked: args.checked,
      check: args.check,
      uncheck: args.uncheck,
      toggle: args.toggle,
      state: args.state,
      value: args.value,
      captcha: args.captcha === true || args.recaptcha === true || args.hcaptcha === true,
      recaptcha: args.recaptcha === true
    };

    console.log(
      `[BrowserCtrl] Check desired=${payload.checked ?? payload.toggle ?? 'default'} captcha=${payload.captcha} label=${(payload.label || '-').slice(0, 40)} ref=${payload.ref || '-'}`,
    );

    let result = null;
    if (typeof bw.checkSmart === 'function') {
      result = await bw.checkSmart(payload);
    } else {
      result = await bw.sendClickSmart?.({
        ...payload,
        force: true
      });
    }

    await delay(150);
    this._syncCursor(bw, result, 'check');
    return {
      ok: result?.ok !== false,
      action: 'check',
      method: result?.method,
      checked: result?.checked,
      before: result?.before,
      after: result?.after,
      desired: result?.desired,
      kind: result?.kind,
      name: result?.name,
      captcha: result?.captcha ?? payload.captcha,
      error: result?.error,
      message: result?.message,
      axTree: result?.axTree,
      x: result?.x,
      y: result?.y,
      px: result?.px,
      ...(await this._pageState({ includeElements: true, includeAx: true }))
    };
  }

  async _hover(bw, args) {
    const caps = bw.getCapabilities?.() ?? {};
    if (!caps.canInput) {
      return {
        ok: false,
        fatal: true,
        error: 'input_requires_electron',
        ...(await this._pageState())
      };
    }

    const payload = {
      ref: args.ref != null ? String(args.ref) : undefined,
      role: args.role != null ? String(args.role) : undefined,
      name: args.name != null ? String(args.name) : undefined,
      text: args.text != null ? String(args.text) : args.label != null ? String(args.label) : undefined,
      label: args.label,
      elementId: args.elementId != null ? Number(args.elementId) : undefined,
      selector: args.selector,
      x: args.x != null ? clamp01(args.x) : undefined,
      y: args.y != null ? clamp01(args.y) : undefined,
      dwellMs: args.dwellMs != null ? Number(args.dwellMs) : args.ms != null ? Number(args.ms) : undefined,
      hoverMs: args.hoverMs != null ? Number(args.hoverMs) : undefined,
      force: args.force !== false,
      resnapshot: args.resnapshot !== false,
      clickToOpen: args.clickToOpen === true || args.open === true,
      open: args.clickToOpen === true || args.open === true
    };

    console.log(
      `[BrowserCtrl] Hover ref=${payload.ref || '-'} text=${(payload.text || '-').slice(0, 40)} dwell=${payload.dwellMs || 400}`,
    );

    let result = null;
    if (typeof bw.hoverSmart === 'function') {
      result = await bw.hoverSmart(payload);
    } else {
      // Fallback: move via click at coords without releasing is not available — use click with hover only path missing
      result = { ok: false, error: 'hover_unavailable' };
    }

    await delay(Math.min(800, Number(payload.dwellMs) || 400));
    this._syncCursor(bw, result, 'hover');
    return {
      ok: result?.ok !== false,
      action: 'hover',
      method: result?.method,
      resolveMethod: result?.resolveMethod,
      ref: result?.ref,
      label: result?.label,
      dwellMs: result?.dwellMs,
      x: result?.x,
      y: result?.y,
      axTree: result?.axTree,
      elements: result?.elements,
      error: result?.error,
      ...(await this._pageState({ includeElements: true, includeAx: true }))
    };
  }

  async _scroll(bw, args) {
    const caps = bw.getCapabilities?.() ?? {};
    if (!caps.canInput && !caps.canExecuteJs) {
      return { ok: false, fatal: true, error: 'scroll_unavailable', ...(await this._pageState()) };
    }

    const dy = Number(args.dy);
    const dx = Number(args.dx) || 0;
    const pages = Number(args.pages);
    const amount = Number(args.amount);
    let mode = args.mode != null ? String(args.mode) : '';
    const to = args.to != null ? String(args.to) : '';
    if (!mode && to) mode = to;
    // direction: "down"|"up"|"top"|"bottom"
    const direction = args.direction != null ? String(args.direction).toLowerCase() : '';
    if (!mode && direction === 'top') mode = 'top';
    if (!mode && direction === 'bottom') mode = 'bottom';

    let deltaY = Number.isFinite(dy) ? dy : 0;
    let deltaX = Number.isFinite(dx) ? dx : 0;
    if (!deltaY && Number.isFinite(amount)) deltaY = amount;
    if (!deltaY && Number.isFinite(pages)) {
      // leave dy=0; main process resolves page height from viewport
    } else if (!deltaY && !deltaX && !mode && !Number.isFinite(pages)) {
      if (direction === 'up') deltaY = -480;
      else deltaY = 480; // default down
    }
    if (direction === 'up' && deltaY > 0) deltaY = -deltaY;
    if (direction === 'down' && deltaY < 0) deltaY = -deltaY;

    const nx = clamp01(args.x ?? 0.5);
    const ny = clamp01(args.y ?? 0.5);
    console.log(
      `[BrowserCtrl] Scroll smart dy=${deltaY} dx=${deltaX} pages=${pages} mode=${mode || '-'} dir=${direction || '-'} @(${nx.toFixed(2)},${ny.toFixed(2)})`,
    );

    // Prefer electronApi.scroll with full payload (multi-pane smartScroll).
    let result = null;
    if (typeof bw.sendScrollSmart === 'function') {
      result = await bw.sendScrollSmart({
        x: nx,
        y: ny,
        dx: deltaX,
        dy: deltaY,
        pages: Number.isFinite(pages) ? pages : undefined,
        mode: mode || undefined,
        to: to || undefined,
        direction: direction || undefined,
        amount: Number.isFinite(amount) ? amount : undefined,
        ref: args.ref,
        selector: args.selector,
        text: args.text || args.container || args.pane,
        container: args.container || args.pane,
        target: args.target
      });
    } else {
      const px = await bw.normalizedToContentPx(nx, ny);
      await bw.sendScroll(px.x, px.y, deltaX, deltaY);
      result = { ok: true, method: 'legacy' };
    }

    await delay(200);
    return {
      ok: result?.ok !== false,
      action: 'scroll',
      method: result?.method,
      target: result?.target,
      kind: result?.kind,
      deltaY: result?.deltaY,
      deltaX: result?.deltaX,
      scrollY: result?.after?.y,
      scrollX: result?.after?.x,
      panes: result?.panes,
      scrollers: result?.scrollers,
      requested: { dy: deltaY, dx: deltaX, pages, mode, direction, x: nx, y: ny },
      ...(await this._pageState())
    };
  }

  async _type(bw, args) {
    const caps = bw.getCapabilities?.() ?? {};
    if (!caps.canInput && !caps.canExecuteJs) {
      return { ok: false, fatal: true, error: 'type_unavailable', ...(await this._pageState()) };
    }

    const text = String(args.text ?? '');
    const clearOnly = !!args.clearOnly;
    if (!text && !clearOnly) return { ok: false, error: 'empty_text' };

    // clear policy: append → never clear; clear/replace → clear; else leave as-is
    let clear = false;
    if (args.append) clear = false;
    else if (args.clearOnly || args.clear || args.replace) clear = true;

    const pressEnter =
      args.pressEnter === true ||
      args.submit === true ||
      args.enter === true ||
      String(args.pressEnter || args.submit || '').toLowerCase() === 'true';

    const payload = {
      text: clearOnly ? '' : text,
      clear,
      replace: !!args.replace,
      append: !!args.append,
      clearOnly,
      pressEnter,
      submit: pressEnter,
      enter: pressEnter,
      ref: args.ref != null ? String(args.ref) : undefined,
      role: args.role != null ? String(args.role) : undefined,
      name: args.name != null ? String(args.name) : undefined,
      x: args.x != null ? clamp01(args.x) : undefined,
      y: args.y != null ? clamp01(args.y) : undefined,
      elementId: args.elementId != null ? Number(args.elementId) : undefined,
      selector: args.selector,
      label: args.label || args.field || args.placeholder,
      field: args.field,
      placeholder: args.placeholder
    };

    console.log(
      `[BrowserCtrl] Type smart len=${text.length} clear=${clear} replace=${!!args.replace} ` +
        `append=${!!args.append} pressEnter=${pressEnter} ref=${payload.ref || '-'} field=${payload.label || payload.elementId || '-'}`,
    );

    let result = null;
    if (typeof bw.typeSmart === 'function') {
      result = await bw.typeSmart(payload);
    } else {
      if (args.x != null || args.elementId != null || args.label || args.ref) {
        await this._click(
          bw,
          { x: args.x, y: args.y, elementId: args.elementId, text: args.label, ref: args.ref },
          1,
        );
      }
      if (clear) {
        await bw.sendKeyChord(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
        await delay(40);
        await bw.sendKey('Backspace');
      }
      if (!clearOnly) await bw.typeText(text, { charDelayMs: TYPE_CHAR_DELAY_MS });
      if (pressEnter) await bw.sendKey?.('Enter');
      result = { ok: true, method: 'legacy', length: text.length };
    }

    await delay(pressEnter ? 280 : 120);
    return {
      ok: result?.ok !== false,
      action: clearOnly ? 'clear' : pressEnter ? 'type+enter' : 'type',
      method: result?.method,
      length: result?.length ?? text.length,
      cleared: result?.cleared,
      valueAfter: result?.valueAfter,
      focused: result?.focused,
      pressEnter: !!result?.pressEnter || pressEnter,
      enter: result?.enter,
      error: result?.error,
      ...(await this._pageState())
    };
  }

  async _key(bw, args) {
    const caps = bw.getCapabilities?.() ?? {};
    if (!caps.canInput) {
      return { ok: false, fatal: true, error: 'key_requires_electron', ...(await this._pageState()) };
    }
    const key = String(args.key || args.chord || '').trim();
    if (!key) return { ok: false, error: 'missing_key' };

    const payload = {
      key,
      repeat: args.repeat != null ? Number(args.repeat) : args.count != null ? Number(args.count) : undefined,
      count: args.count != null ? Number(args.count) : undefined,
      ref: args.ref != null ? String(args.ref) : undefined,
      x: args.x != null ? clamp01(args.x) : undefined,
      y: args.y != null ? clamp01(args.y) : undefined,
      elementId: args.elementId != null ? Number(args.elementId) : undefined,
      selector: args.selector,
      text: args.label || args.field,
      label: args.label || args.field
    };

    console.log(`[BrowserCtrl] Key smart ${key} repeat=${payload.repeat || 1}`);

    let result = null;
    if (typeof bw.sendKeySmart === 'function') {
      result = await bw.sendKeySmart(payload);
    } else if (key.includes('+')) {
      await bw.sendKeyChord(key);
      result = { ok: true, method: 'legacy-chord' };
    } else {
      await bw.sendKey(key);
      result = { ok: true, method: 'legacy-key' };
    }

    await delay(80);
    return {
      ok: result?.ok !== false,
      action: 'key',
      key: result?.key || key,
      method: result?.method,
      repeat: result?.repeat,
      clear: result?.clear,
      error: result?.error,
      ...(await this._pageState())
    };
  }

  async _select(bw, args) {
    const caps = bw.getCapabilities?.() ?? {};
    if (!caps.canInput) {
      return { ok: false, fatal: true, error: 'select_requires_electron', ...(await this._pageState()) };
    }

    const payload = {
      mode: args.mode || (args.all ? 'all' : undefined),
      all: !!args.all,
      text: args.text || args.find,
      find: args.find || args.text,
      copy: !!args.copy,
      inField: !!args.inField,
      x1: args.x1 != null ? clamp01(args.x1) : args.x != null ? clamp01(args.x) : undefined,
      y1: args.y1 != null ? clamp01(args.y1) : args.y != null ? clamp01(args.y) : undefined,
      x2: args.x2 != null ? clamp01(args.x2) : undefined,
      y2: args.y2 != null ? clamp01(args.y2) : undefined,
      elementId: args.elementId != null ? Number(args.elementId) : undefined,
      selector: args.selector,
      label: args.label || args.field
    };

    console.log(
      `[BrowserCtrl] Select smart mode=${payload.mode || '-'} find=${(payload.find || '-').toString().slice(0, 40)} copy=${payload.copy}`,
    );

    let result = null;
    if (typeof bw.selectSmart === 'function') {
      result = await bw.selectSmart(payload);
    } else {
      const x1 = clamp01(args.x1 ?? args.x ?? 0.2);
      const y1 = clamp01(args.y1 ?? args.y ?? 0.2);
      const x2 = clamp01(args.x2 ?? 0.8);
      const y2 = clamp01(args.y2 ?? 0.5);
      const a = await bw.normalizedToContentPx(x1, y1);
      const b = await bw.normalizedToContentPx(x2, y2);
      await bw.sendMouseDrag(a.x, a.y, b.x, b.y);
      if (args.copy) {
        await bw.sendKeyChord(process.platform === 'darwin' ? 'Meta+C' : 'Control+C');
      }
      const selection = await bw.getSelectedText?.();
      result = { ok: true, method: 'legacy-drag', selection };
    }

    await delay(80);
    return {
      ok: result?.ok !== false,
      action: 'select',
      method: result?.method,
      selection: result?.selection ? String(result.selection).slice(0, 2000) : '',
      copied: result?.copied,
      error: result?.error,
      ...(await this._pageState())
    };
  }

  async _dismiss(bw, args) {
    const caps = bw.getCapabilities?.() ?? {};
    if (!caps.canInput && !caps.canExecuteJs) {
      return { ok: false, fatal: true, error: 'dismiss_unavailable', ...(await this._pageState()) };
    }
    console.log('[BrowserCtrl] Dismiss modal/popup aggressive=', args.aggressive !== false);
    let result = null;
    if (typeof bw.dismissSmart === 'function') {
      result = await bw.dismissSmart({
        aggressive: args.aggressive !== false
      });
    } else {
      await bw.sendKey?.('Escape');
      result = { ok: true, method: 'escape-fallback' };
    }
    await delay(250);
    const state = await this._pageState({ includeElements: true, includeAx: true });
    return {
      ok: result?.ok !== false,
      action: 'dismiss',
      method: result?.method,
      steps: result?.steps,
      modalBlocking: result?.modalBlocking ?? state.modalBlocking,
      closeRefs: result?.closeRefs || state.closeRefs,
      axTree: result?.axTree || state.axTree,
      error: result?.error,
      ...state
    };
  }

  async _read(bw, args) {
    const what = String(args.what || 'selection');
    console.log('[BrowserCtrl] Read', what);
    if (what === 'selection') {
      const selection = await bw.getSelectedText?.();
      return {
        ok: true,
        action: 'read',
        what,
        text: selection ? String(selection).slice(0, 4000) : '',
        ...(await this._pageState())
      };
    }
    if (what === 'url' || what === 'title') {
      const st = await this._pageState();
      return { ok: true, action: 'read', what, text: what === 'url' ? st.url : st.title, ...st };
    }
    if (what === 'elements') {
      return {
        ok: true,
        action: 'read',
        what,
        ...(await this._pageState({ includeElements: true, includeAx: true }))
      };
    }
    // visible text sample (truncated)
    const text = await bw.getVisibleTextSample?.(4000);
    return {
      ok: true,
      action: 'read',
      what: 'visible_text',
      text: text ? String(text).slice(0, 4000) : '',
      ...(await this._pageState())
    };
  }

  async _snapshot(bw, args) {
    const includeElements = args.includeElements !== false;
    let state = await this._pageState({ includeElements, includeAx: true });
    if (typeof bw.getAxSnapshot === 'function' && !state.axTree) {
      try {
        const snap = await bw.getAxSnapshot();
        if (snap?.ok !== false) {
          state = {
            ...state,
            elements: snap.elements || state.elements,
            axTree: snap.axTree || state.axTree,
            scroll: snap.scroll || state.scroll,
            textSample: snap.textSample,
            elementCount: snap.count ?? state.elementCount
          };
        }
      } catch (e) {
        console.warn('[BrowserCtrl] getAxSnapshot failed:', e?.message ?? e);
      }
    }
    const crop = await this._pushBrowserVision(bw);
    console.log(
      `[BrowserCtrl] Snapshot elements=${state.elements?.length ?? 0} axLen=${(state.axTree || '').length}`,
    );
    return {
      ok: true,
      action: 'snapshot',
      ...state,
      hasCrop: Boolean(crop?.data),
      cropMeta: crop ? { width: crop.width, height: crop.height, mimeType: crop.mimeType } : null
    };
  }

  /**
   * Capture webview JPEG and send to hub as browserVisionFrame (planner cache only).
   * Never attaches base64 to tool results.
   */
  async _pushBrowserVision(bw) {
    // Prefer full-window Electron vision for Live; guest capturePage is optional
    // and historically crashy mid-navigation — only attempt when guest is ready.
    if (typeof bw.captureContentJpeg !== 'function') return null;
    if (bw.isGuestReady && !bw.isGuestReady()) {
      console.log('[BrowserCtrl] Skip browser crop (guest not ready)');
      return null;
    }
    try {
      const crop = await bw.captureContentJpeg();
      if (crop?.data) {
        this.opts.sendResult?.({
          type: 'browserVisionFrame',
          mimeType: crop.mimeType || 'image/jpeg',
          data: crop.data,
          width: crop.width,
          height: crop.height,
          ts: Date.now()
        });
      }
      return crop;
    } catch (e) {
      console.warn('[BrowserCtrl] browser vision push failed:', e?.message ?? e);
      return null;
    }
  }

  async _pageState({ includeElements = false, includeAx = false } = {}) {
    const bw = this.opts.getBrowserWindow?.();
    if (!bw) {
      return { url: null, title: null, mode: 'none' };
    }
    try {
      const st = await bw.getPageState({
        includeElements: includeElements || includeAx,
        includeAx: includeAx || includeElements
      });
      return st;
    } catch (e) {
      console.warn('[BrowserCtrl] getPageState failed:', e?.message ?? e);
      return { url: null, title: null, error: String(e?.message ?? e) };
    }
  }

  _finish(id, name, result) {
    // Bridge already timed out / cancelled this id — do not send a second result.
    if (this.cancelledIds.has(String(id))) {
      console.log(`[BrowserCtrl] Suppress late result for cancelled ${name} ${id}`);
      if (!String(id).includes('__step')) {
        this.busy = false;
        this.currentId = null;
        this._pumpQueue();
      }
      return;
    }

    const pageUrl = result?.url != null ? String(result.url) : '';
    const captchaWall =
      result?.captchaWall === true ||
      /google\.[^/]+\/sorry|recaptcha|hcaptcha|challenges\.cloudflare/i.test(pageUrl);

    const elementCount = Array.isArray(result?.elements) ? result.elements.length : undefined;
    const refs = Array.isArray(result?.elements)
      ? result.elements
          .slice(0, 12)
          .map((el) => el?.ref)
          .filter(Boolean)
      : undefined;

    // Factual browser state only — strip coaching before send (AI server also strips).
    const stripKeys = ['instruction', 'reobserve', 'prefer', 'hint', 'message'];
    const factResult = { ...(result && typeof result === 'object' ? result : {}) };
    for (const k of stripKeys) delete factResult[k];
    if (factResult.grounding && typeof factResult.grounding === 'object') {
      const g = { ...factResult.grounding };
      for (const k of stripKeys) delete g[k];
      delete g.rules;
      factResult.grounding = g;
    }
    const payload = {
      ok: result?.ok !== false,
      ...factResult,
      ...(captchaWall ? { captchaWall: true } : {}),
      grounding: {
        schema: 'trumpchan.browser.v1',
        ts: Date.now(),
        url: pageUrl || null,
        title: result?.title ?? null,
        captchaWall: Boolean(captchaWall),
        elementCount: elementCount ?? null,
        sampleRefs: refs || null
      }
    };
    this.opts.sendResult?.({
      type: 'browserResult',
      id,
      name,
      result: payload
    });
    if (String(id).includes('__step')) return;
    this.busy = false;
    this.currentId = null;
    this._pumpQueue();
  }
}
