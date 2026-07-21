/**
 * Accessibility-style interactive snapshot for AI browser control.
 * Primary targeting: stable per-snapshot refs (e1, e2, …) + role/name.
 * Filters ads/overlays via hit-test occlusion when possible.
 */

export const AX_MAX_ELEMENTS = 60;

/**
 * Guest-page IIFE: returns { ok, elements, axTree, textSample, scroll, count, viewport }.
 */
export const BUILD_AX_SNAPSHOT_JS = `(() => {
  const MAX = ${AX_MAX_ELEMENTS};
  const vw = window.innerWidth || document.documentElement.clientWidth || 1;
  const vh = window.innerHeight || document.documentElement.clientHeight || 1;

  const INTERACTIVE_SEL = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'textarea',
    'select',
    'summary',
    'dialog',
    '[role="button"]',
    '[role="link"]',
    '[role="textbox"]',
    '[role="searchbox"]',
    '[role="combobox"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[role="switch"]',
    '[role="slider"]',
    '[role="dialog"]',
    '[role="alertdialog"]',
    '[aria-modal="true"]',
    '[contenteditable="true"]',
    '[contenteditable=""]',
    'label[for]',
  ].join(',');

  const AD_HINT = /ads?|advert|sponsor|promo|banner|cookie|consent|overlay|interstitial|popup|modal|backdrop|doubleclick|googlesyndication|taboola|outbrain|newsletter|subscribe/i;
  const CLOSE_HINT = /^(close|dismiss|cancel|no.?thanks|not.?now|maybe.?later|skip|×|✕|✖|⨯|x)$|close\\b|dismiss|got it|no thanks|not now|maybe later|skip for now|continue without|reject all|decline|i disagree|don't allow|nein|schließen|fermer|chiudi|cerrar/i;
  const MODAL_SEL = 'dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"],.modal,.Modal,.popup,.Popup,.overlay,.Overlay,[class*="modal"],[class*="Modal"],[class*="popup"],[class*="dialog"],[id*="modal"],[id*="popup"],[id*="consent"],[id*="cookie"]';

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 3 || r.height < 3) return false;
    const st = window.getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) return false;
    // Keep pointer-events:none nodes if they are inside a modal (often icon wrappers)
    // but skip fully non-interactive decorative layers outside modals later.
    if (r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) return false;
    return true;
  }

  /**
   * Deep query: light DOM + open shadow roots + same-origin iframes.
   * Cookie/CMP banners and complex modals often live in shadow trees.
   */
  function deepQueryAll(root, selector, out, depth) {
    if (!root || depth > 8 || out.length > 400) return;
    try {
      const nodes = root.querySelectorAll ? root.querySelectorAll(selector) : [];
      for (const n of nodes) out.push(n);
    } catch (e) {}
    // Open shadow roots under this root
    let hosts = [];
    try {
      hosts = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
    } catch (e) {
      hosts = [];
    }
    // Also walk children if root is a shadow root / element without query on *
    if (root === document) {
      // already covered
    }
    for (const host of hosts) {
      if (host.shadowRoot) {
        deepQueryAll(host.shadowRoot, selector, out, depth + 1);
      }
    }
    // Same-origin iframes
    try {
      const iframes = root.querySelectorAll ? root.querySelectorAll('iframe,frame') : [];
      for (const frame of iframes) {
        try {
          const doc = frame.contentDocument || frame.contentWindow?.document;
          if (doc) deepQueryAll(doc, selector, out, depth + 1);
        } catch (e) {
          /* cross-origin */
        }
      }
    } catch (e) {}
  }

  function deepQueryAllFromDocument(selector) {
    const out = [];
    deepQueryAll(document, selector, out, 0);
    // Also scan open shadow hosts that might not be under querySelector('*') edge cases
    try {
      const walk = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
      let node;
      let n = 0;
      while ((node = walk.nextNode()) && n < 5000) {
        n++;
        if (node.shadowRoot) deepQueryAll(node.shadowRoot, selector, out, 1);
      }
    } catch (e) {}
    return out;
  }

  function roleOf(el) {
    const ar = (el.getAttribute('role') || '').toLowerCase();
    if (ar) return ar;
    const tag = el.tagName.toLowerCase();
    if (tag === 'dialog') return 'dialog';
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'summary') return 'button';
    if (el.isContentEditable) return 'textbox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      if (t === 'search') return 'searchbox';
      if (t === 'range') return 'slider';
      return 'textbox';
    }
    if (tag === 'label') return 'label';
    return tag;
  }

  function isCloseControl(el, name, role) {
    const n = (name || '').trim();
    const aria = (el.getAttribute('aria-label') || '').trim();
    const title = (el.getAttribute('title') || '').trim();
    const testId = (el.getAttribute('data-testid') || el.getAttribute('data-test') || '').toLowerCase();
    const cls = typeof el.className === 'string' ? el.className : '';
    if (CLOSE_HINT.test(n) || CLOSE_HINT.test(aria) || CLOSE_HINT.test(title)) return true;
    if (/close|dismiss|cancel/.test(testId)) return true;
    if (/\\b(close|dismiss|btn-close|modal-close|popup-close)\\b/i.test(cls)) return true;
    // Icon-only × buttons often have empty name but tiny square geometry
    if ((role === 'button' || el.tagName === 'BUTTON') && (!n || n.length <= 2)) {
      const r = el.getBoundingClientRect();
      if (r.width > 8 && r.width < 56 && r.height > 8 && r.height < 56) {
        if (/close|dismiss|x-btn|icon-close/i.test(cls + ' ' + testId + ' ' + (el.id || ''))) return true;
        // Unicode close glyphs as sole content
        if (/^[×✕✖⨯xX]$/.test(n) || /^[×✕✖⨯xX]$/.test((el.textContent || '').trim())) return true;
      }
    }
    return false;
  }

  function findModalRoots() {
    const roots = [];
    const nodes = deepQueryAllFromDocument(MODAL_SEL);
    for (const el of nodes) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      // Large enough to be a real modal/overlay
      if (r.width < 80 || r.height < 60) continue;
      const st = window.getComputedStyle(el);
      const z = parseInt(st.zIndex, 10);
      const pos = st.position;
      const area = r.width * r.height;
      const covers = area > vw * vh * 0.12;
      const elevated = pos === 'fixed' || pos === 'absolute' || pos === 'sticky' || (Number.isFinite(z) && z >= 10);
      const isDialog = el.tagName === 'DIALOG' || el.getAttribute('role') === 'dialog' || el.getAttribute('role') === 'alertdialog' || el.getAttribute('aria-modal') === 'true';
      if (el.tagName === 'DIALOG' && !el.open) continue;
      if (isDialog || (covers && elevated) || (covers && AD_HINT.test(el.id + ' ' + (el.className || '')))) {
        roots.push({ el, r, area, z: Number.isFinite(z) ? z : 0, isDialog });
      }
    }
    // Also detect full-viewport fixed backdrops
    const all = document.querySelectorAll('div,section,aside');
    for (const el of all) {
      if (roots.some((x) => x.el === el || x.el.contains(el) || el.contains(x.el))) continue;
      if (!visible(el)) continue;
      const st = window.getComputedStyle(el);
      if (st.position !== 'fixed' && st.position !== 'sticky') continue;
      const r = el.getBoundingClientRect();
      if (r.width < vw * 0.5 || r.height < vh * 0.4) continue;
      const z = parseInt(st.zIndex, 10) || 0;
      if (z < 5 && st.position !== 'fixed') continue;
      roots.push({ el, r, area: r.width * r.height, z, isDialog: false });
    }
    roots.sort((a, b) => b.z - a.z || b.area - a.area);
    return roots.slice(0, 6);
  }

  function insideModal(el, modalRoots) {
    for (const m of modalRoots) {
      if (m.el === el || m.el.contains(el)) return m;
    }
    return null;
  }

  function nameOf(el) {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.replace(/\\s+/g, ' ').trim().slice(0, 120);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy.split(/\\s+/).map((id) => {
        const n = document.getElementById(id);
        return n ? (n.innerText || n.textContent || '').trim() : '';
      }).filter(Boolean);
      if (parts.length) return parts.join(' ').replace(/\\s+/g, ' ').slice(0, 120);
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const ph = el.getAttribute('placeholder');
      const lab = el.labels && el.labels[0]
        ? (el.labels[0].innerText || el.labels[0].textContent || '').trim()
        : '';
      const nm = el.getAttribute('name') || el.getAttribute('title') || '';
      const v = el.getAttribute('value') || '';
      const t = (el.getAttribute('type') || '').toLowerCase();
      if (t === 'submit' || t === 'button') return (v || ph || nm || t).slice(0, 120);
      return (lab || ph || nm || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
    }
    if (el.tagName === 'IMG') {
      return (el.getAttribute('alt') || el.getAttribute('title') || '').slice(0, 120);
    }
    const title = el.getAttribute('title');
    const raw = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (raw && raw.length <= 120) return raw;
    if (raw) return raw.slice(0, 117) + '…';
    return (title || el.getAttribute('name') || '').slice(0, 120);
  }

  function valueOf(el) {
    try {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
        return String(el.value ?? '').slice(0, 80);
      }
      if (el.isContentEditable) return String(el.innerText || '').slice(0, 80);
    } catch (e) {}
    return '';
  }

  function statesOf(el) {
    const s = [];
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') s.push('disabled');
    if (el.checked || el.getAttribute('aria-checked') === 'true') s.push('checked');
    if (el.getAttribute('aria-expanded') === 'true') s.push('expanded');
    if (el.getAttribute('aria-selected') === 'true') s.push('selected');
    if (el.getAttribute('aria-pressed') === 'true') s.push('pressed');
    if (document.activeElement === el) s.push('focused');
    if (el.readOnly) s.push('readonly');
    if (el.required || el.getAttribute('aria-required') === 'true') s.push('required');
    return s;
  }

  function isAdLike(el) {
    let n = el;
    let d = 0;
    while (n && d < 6) {
      const id = n.id || '';
      const cls = typeof n.className === 'string' ? n.className : '';
      if (AD_HINT.test(id) || AD_HINT.test(cls)) return true;
      if (n.getAttribute && AD_HINT.test(n.getAttribute('aria-label') || '')) return true;
      n = n.parentElement;
      d++;
    }
    return false;
  }

  function isOccluded(el, cx, cy) {
    try {
      const top = document.elementFromPoint(cx, cy);
      if (!top) return false;
      if (top === el || el.contains(top) || top.contains(el)) return false;
      const st = window.getComputedStyle(top);
      const pos = st.position;
      if ((pos === 'fixed' || pos === 'sticky' || pos === 'absolute') && isAdLike(top)) return true;
      const tr = top.getBoundingClientRect();
      if (tr.width * tr.height > vw * vh * 0.35 && Number(st.opacity) < 0.15) return true;
      return false;
    } catch (e) {
      return false;
    }
  }

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && parts.length < 7) {
      let part = n.tagName.toLowerCase();
      if (n.id) {
        parts.unshift('#' + CSS.escape(n.id));
        break;
      }
      const parent = n.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === n.tagName);
        if (siblings.length > 1) {
          part += ':nth-of-type(' + (siblings.indexOf(n) + 1) + ')';
        }
      }
      parts.unshift(part);
      n = parent;
      if (n === document.body || n === document.documentElement) break;
    }
    return parts.join(' > ');
  }

  const modalRoots = findModalRoots();
  const modalBlocking = modalRoots.length > 0;

  // Deep query pierces open shadow DOM + same-origin iframes (CMP banners, web components)
  const raw = deepQueryAllFromDocument(INTERACTIVE_SEL);
  // Extra: gather likely close icon buttons inside modals (incl. shadow)
  for (const m of modalRoots) {
    const extras = [];
    deepQueryAll(m.el, 'button,a,[role="button"],[aria-label],[title]', extras, 0);
    if (m.el.shadowRoot) deepQueryAll(m.el.shadowRoot, 'button,a,[role="button"],[aria-label],[title]', extras, 0);
    // Also shallow children for icon wrappers
    try {
      m.el.querySelectorAll('button,a,[role="button"],[aria-label],[title],svg').forEach((el) => extras.push(el));
    } catch (e) {}
    for (const el of extras) {
      if (raw.includes(el)) continue;
      const nm = nameOf(el);
      if (isCloseControl(el, nm, roleOf(el))) raw.push(el);
    }
  }

  const seen = new Set();
  const candidates = [];
  for (const el of raw) {
    if (seen.has(el)) continue;
    if (!visible(el)) continue;
    const role = roleOf(el);
    const name = nameOf(el);
    if (!name && role === 'link' && !(el.getAttribute('href') || '').trim() && !isCloseControl(el, name, role)) continue;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const occluded = isOccluded(el, cx, cy);
    const ad = isAdLike(el);
    const modal = insideModal(el, modalRoots);
    const isClose = isCloseControl(el, name, role);
    seen.add(el);
    candidates.push({ el, role, name, r, cx, cy, occluded, ad, inModal: !!modal, isClose });
  }

  // Priority: close buttons in modals first, then other modal controls, then non-occluded page
  candidates.sort((a, b) => {
    if (a.isClose !== b.isClose) return a.isClose ? -1 : 1;
    if (a.inModal !== b.inModal) return a.inModal ? -1 : 1;
    if (a.occluded !== b.occluded) return a.occluded ? 1 : -1;
    if (a.ad !== b.ad) return a.ad ? 1 : -1;
    return 0;
  });

  const elements = [];
  const lines = [];
  const closeRefs = [];
  for (let i = 0; i < candidates.length && elements.length < MAX; i++) {
    const c = candidates[i];
    const ref = 'e' + (elements.length + 1);
    const el = c.el;
    const r = c.r;
    const states = statesOf(el);
    const value = valueOf(el);
    const href = el.href || el.getAttribute('href') || null;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (c.isClose) closeRefs.push(ref);
    const item = {
      ref,
      id: elements.length,
      role: c.role,
      name: c.name || (c.isClose ? 'Close' : ''),
      tag,
      type,
      value,
      states,
      href,
      ad: c.ad,
      occluded: c.occluded,
      inModal: c.inModal,
      isClose: c.isClose,
      x: r.left / vw,
      y: r.top / vh,
      w: r.width / vw,
      h: r.height / vh,
      cx: (r.left + r.width / 2) / vw,
      cy: (r.top + r.height / 2) / vh,
      px: Math.round(r.left + r.width / 2),
      py: Math.round(r.top + r.height / 2),
      cssPath: cssPath(el),
    };
    elements.push(item);

    let line = '[' + ref + '] ' + c.role;
    if (item.name) line += ' "' + item.name.replace(/"/g, "'") + '"';
    if (value && (c.role === 'textbox' || c.role === 'searchbox' || c.role === 'combobox')) {
      line += ' value="' + String(value).replace(/"/g, "'").slice(0, 40) + '"';
    }
    if (states.length) line += ' (' + states.join(',') + ')';
    if (c.isClose) line += ' [CLOSE]';
    if (c.inModal) line += ' [modal]';
    if (c.occluded) line += ' [covered]';
    if (c.ad) line += ' [ad?]';
    if (href && c.role === 'link') {
      try {
        const u = new URL(href, location.href);
        line += ' → ' + (u.hostname + u.pathname).slice(0, 50);
      } catch (e) {}
    }
    lines.push(line);
  }

  const se = document.scrollingElement || document.documentElement;
  const scroll = {
    x: se.scrollLeft || window.scrollX || 0,
    y: se.scrollTop || window.scrollY || 0,
    maxY: Math.max(0, (se.scrollHeight || 0) - (se.clientHeight || 0)),
    maxX: Math.max(0, (se.scrollWidth || 0) - (se.clientWidth || 0)),
    clientH: se.clientHeight || vh,
    clientW: se.clientWidth || vw,
  };

  let textSample = '';
  try {
    textSample = (document.body && (document.body.innerText || document.body.textContent) || '')
      .replace(/\\s+/g, ' ')
      .trim()
      .slice(0, 1500);
  } catch (e) {}

  const modalInfo = modalRoots.map((m, i) => {
    const label = (m.el.getAttribute('aria-label') || m.el.getAttribute('aria-labelledby') || m.el.id || m.el.className || 'overlay').toString().slice(0, 60);
    return '#' + (i + 1) + ' ' + m.el.tagName.toLowerCase() + ' z=' + m.z + ' ' + String(label).replace(/\\s+/g, ' ').slice(0, 40);
  });

  let axTree = '';
  if (modalBlocking) {
    axTree += '⚠ MODAL/POPUP BLOCKING PAGE — call browser_dismiss or click a [CLOSE] ref first.\\n';
    axTree += 'Modals: ' + (modalInfo.join('; ') || 'detected') + '\\n';
    if (closeRefs.length) axTree += 'Suggested close refs: ' + closeRefs.slice(0, 5).join(', ') + '\\n';
  }
  axTree +=
    'Page interactive elements (use ref=eN with browser_click / browser_type):\\n' +
    (lines.length ? lines.join('\\n') : '(none visible)') +
    '\\nscroll y=' + Math.round(scroll.y) + '/' + Math.round(scroll.maxY);

  return {
    ok: true,
    elements,
    axTree,
    textSample,
    scroll,
    count: elements.length,
    viewport: { w: vw, h: vh },
    modalBlocking,
    modalCount: modalRoots.length,
    closeRefs,
    modals: modalInfo,
  };
})()`;

/**
 * Build guest script that resolves ref / role+name / text / selector / coords
 * against a live AX snapshot.
 */
export function buildResolveByRefScript(opts = {}) {
  const ref = opts.ref != null ? String(opts.ref).trim() : '';
  const elementId =
    opts.elementId != null && Number.isFinite(Number(opts.elementId))
      ? Number(opts.elementId)
      : null;
  const role = opts.role != null ? String(opts.role).trim().toLowerCase() : '';
  const name = opts.name != null ? String(opts.name).trim() : '';
  const text = opts.text != null ? String(opts.text).trim() : '';
  const selector = opts.selector != null ? String(opts.selector).trim() : '';
  const nx = opts.x != null && Number.isFinite(Number(opts.x)) ? Number(opts.x) : null;
  const ny = opts.y != null && Number.isFinite(Number(opts.y)) ? Number(opts.y) : null;
  const preferEditable = !!opts.preferEditable;

  return `(function(){
  const wantRef = ${JSON.stringify(ref)};
  const wantId = ${elementId == null ? 'null' : elementId};
  const wantRole = ${JSON.stringify(role)};
  const wantName = ${JSON.stringify(name)};
  const wantText = ${JSON.stringify(text)};
  const wantSel = ${JSON.stringify(selector)};
  let nx = ${nx == null ? 'null' : nx};
  let ny = ${ny == null ? 'null' : ny};
  const preferEditable = ${preferEditable ? 'true' : 'false'};

  const built = ${BUILD_AX_SNAPSHOT_JS};
  if (!built || !built.ok) return { ok: false, error: 'snapshot_failed' };
  const list = built.elements || [];

  function findByRef(r) {
    if (!r) return null;
    let key = String(r).replace(/^@/, '').trim();
    if (/^\\d+$/.test(key)) key = 'e' + key;
    return list.find((e) => e.ref === key || String(e.id) === key.replace(/^e/, '')) || null;
  }

  let item = null;
  let resolveMethod = 'none';

  if (wantRef) {
    item = findByRef(wantRef);
    if (item) resolveMethod = 'ref';
  }
  if (!item && wantId != null && list[wantId]) {
    item = list[wantId];
    resolveMethod = 'elementId';
  }
  if (!item && wantSel) {
    try {
      const el = document.querySelector(wantSel);
      if (el) {
        const r = el.getBoundingClientRect();
        const vw = window.innerWidth || 1, vh = window.innerHeight || 1;
        item = {
          ref: null, id: -1,
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          name: (el.getAttribute('aria-label') || el.innerText || '').slice(0, 80),
          tag: el.tagName.toLowerCase(),
          type: (el.getAttribute('type') || '').toLowerCase(),
          href: el.href || null,
          cx: (r.left + r.width / 2) / vw, cy: (r.top + r.height / 2) / vh,
          px: Math.round(r.left + r.width / 2), py: Math.round(r.top + r.height / 2),
          x: r.left / vw, y: r.top / vh, w: r.width / vw, h: r.height / vh,
          cssPath: null, _el: el,
        };
        resolveMethod = 'selector';
      }
    } catch (e) {}
  }
  if (!item && (wantRole || wantName || wantText)) {
    const qName = (wantName || wantText || '').toLowerCase();
    const qRole = wantRole;
    let best = null, bestScore = -1;
    for (const e of list) {
      if (preferEditable && e.role !== 'textbox' && e.role !== 'searchbox' && e.role !== 'combobox' && e.tag !== 'textarea' && e.tag !== 'input') continue;
      if (qRole && e.role !== qRole && e.tag !== qRole) continue;
      const lab = (e.name || '').toLowerCase();
      let score = 0;
      if (qName) {
        if (lab === qName) score = 100;
        else if (lab.startsWith(qName)) score = 80;
        else if (lab.includes(qName)) score = 50 - Math.min(20, lab.length / 20);
        else continue;
      } else if (qRole) {
        score = 30;
      }
      if (e.occluded) score -= 15;
      if (e.ad) score -= 10;
      if (score > bestScore) { bestScore = score; best = e; }
    }
    if (best) {
      item = best;
      resolveMethod = wantRole && (wantName || wantText) ? 'role+name' : (wantName || wantText ? 'name' : 'role');
    }
  }
  if (!item && nx != null && ny != null) {
    let nearest = null, bestD = Infinity;
    for (const e of list) {
      if (e.occluded) continue;
      const dx = e.cx - nx, dy = e.cy - ny;
      const d = dx * dx + dy * dy;
      if (d < bestD && d < 0.15 * 0.15) { bestD = d; nearest = e; }
    }
    if (!nearest) {
      for (const e of list) {
        const dx = e.cx - nx, dy = e.cy - ny;
        const d = dx * dx + dy * dy;
        if (d < bestD && d < 0.12 * 0.12) { bestD = d; nearest = e; }
      }
    }
    if (nearest) {
      item = nearest;
      resolveMethod = 'coords-snap';
    } else {
      const px = nx * (window.innerWidth || 1);
      const py = ny * (window.innerHeight || 1);
      const hit = document.elementFromPoint(px, py);
      if (hit) {
        const r = hit.getBoundingClientRect();
        const vw = window.innerWidth || 1, vh = window.innerHeight || 1;
        item = {
          ref: null, id: -1, role: hit.tagName.toLowerCase(),
          name: (hit.getAttribute('aria-label') || hit.innerText || '').slice(0, 80),
          tag: hit.tagName.toLowerCase(),
          type: (hit.getAttribute('type') || '').toLowerCase(),
          href: hit.href || null,
          cx: (r.left + r.width / 2) / vw, cy: (r.top + r.height / 2) / vh,
          px: Math.round(r.left + r.width / 2), py: Math.round(r.top + r.height / 2),
          cssPath: null, _el: hit,
        };
        resolveMethod = 'coords-hit';
      }
    }
  }

  if (!item) {
    return {
      ok: false,
      error: 'no_target',
      candidates: list.slice(0, 15).map((e) => ({
        ref: e.ref, id: e.id, role: e.role, name: e.name, tag: e.tag, cx: e.cx, cy: e.cy, occluded: e.occluded,
      })),
      axTree: built.axTree,
    };
  }

  let el = item._el || null;
  if (!el && item.cssPath) {
    try { el = document.querySelector(item.cssPath); } catch (e) {}
  }
  if (!el && item.ref) {
    const again = ${BUILD_AX_SNAPSHOT_JS};
    const match = (again.elements || []).find((e) => e.ref === item.ref);
    if (match && match.cssPath) {
      try { el = document.querySelector(match.cssPath); } catch (e) {}
      if (el) item = Object.assign({}, item, match);
    }
  }
  if (!el) {
    el = document.elementFromPoint(item.px, item.py);
  }
  if (!el) {
    return { ok: false, error: 'element_detached', ref: item.ref, axTree: built.axTree };
  }

  try {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  } catch (e) {
    try { el.scrollIntoView(true); } catch (e2) {}
  }

  const r2 = el.getBoundingClientRect();
  const vw = window.innerWidth || 1;
  const vh = window.innerHeight || 1;
  const px = Math.round(r2.left + r2.width / 2);
  const py = Math.round(r2.top + r2.height / 2);

  let path = item.cssPath || '';
  if (!path && el.id) path = '#' + CSS.escape(el.id);

  return {
    ok: true,
    resolveMethod,
    ref: item.ref,
    id: item.id,
    role: item.role || el.getAttribute('role') || el.tagName.toLowerCase(),
    name: item.name,
    label: item.name,
    tag: el.tagName.toLowerCase(),
    type: (el.getAttribute('type') || '').toLowerCase(),
    href: el.href || item.href || null,
    nx: Math.min(0.999, Math.max(0.001, px / vw)),
    ny: Math.min(0.999, Math.max(0.001, py / vh)),
    px, py,
    cssPath: path,
    occluded: !!item.occluded,
    ad: !!item.ad,
    axTree: built.axTree,
    count: list.length,
  };
})()`;
}
