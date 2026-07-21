/**
 * In-scene browser control tools (navigate, type, scroll, keys, read).
 *
 * CLICKS: spatial tool view_click ({x,y} 0–1 on FPV) only.
 * Typing/scroll/snapshot still use ref= / labels.
 */
import { Type, Behavior, FunctionResponseScheduling } from '@google/genai';
import type WebSocket from 'ws';

/** Tools exposed to Gemini Live (no browser_click / browser_dblclick). */
export const BROWSER_TOOL_NAMES = [
  'use_browser',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_hover',
  'browser_move',
  'browser_check',
  'browser_scroll',
  'browser_type',
  'browser_key',
  'browser_select',
  'browser_dismiss',
  'browser_read',
  'browser_snapshot',
  'run_browser_plan',
] as const;

/** Legacy click tools — not in Live declarations; may appear in old plans. */
export const DEPRECATED_BROWSER_CLICK_TOOLS = ['browser_click', 'browser_dblclick'] as const;

export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];

export function isBrowserTool(name: string): boolean {
  return (
    (BROWSER_TOOL_NAMES as readonly string[]).includes(name) ||
    name === 'run_browser_plan' ||
    (DEPRECATED_BROWSER_CLICK_TOOLS as readonly string[]).includes(name)
  );
}

export function isDeprecatedBrowserClickTool(name: string): boolean {
  return (DEPRECATED_BROWSER_CLICK_TOOLS as readonly string[]).includes(name);
}

const REF_DESC =
  'Element ref from browser_snapshot axTree, e.g. "e3" or "e12". For typing/focus only — CLICKS use view_click({x,y}) on FPV.';

const COORD_DESC =
  'Normalized 0–1 over PAGE CONTENT (below toolbar). Prefer view_click({x,y}) on FPV for clicks; these coords only for hover/move/scroll aim.';

export const browserToolDeclarations = [
  {
    name: 'use_browser',
    description:
      'High-level multi-step web tasks (search, navigate, type, scroll). ' +
      'IMPORTANT: stand at the panel first (inspect_browser). ' +
      'CLICKING is NOT done here — after the plan, or for any click, use spatial tool view_click({x,y}) with FPV image coords 0–1 ((0,0)=top-left). ' +
      'This tool is for navigate/type/scroll/snapshot/dismiss. After results, re-check vision; SPEAK only about observed content.',
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      required: ['goal'],
      properties: {
        goal: {
          type: Type.STRING,
          description:
            'What to do, e.g. "open duckduckgo and search minecraft". Do not rely on this tool alone for precise clicks — use view_click on the FPV grid.',
        },
      },
    },
  },
  {
    name: 'browser_navigate',
    description:
      'Open a URL or run a search query in the floating in-scene browser. ' +
      'Use query for free-text search (DuckDuckGo — avoid Google bot/CAPTCHA walls). ' +
      'Use url for a full or bare host URL. Prefer direct site URLs over search when possible. ' +
      'After the result: re-check vision + url/title; do not invent page content. ' +
      'Does not auto-speak when the page loads — only speak after the tool result if the user asked you.',
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: {
          type: Type.STRING,
          description: 'URL to open, e.g. https://example.com or example.com',
        },
        query: {
          type: Type.STRING,
          description: 'Search query if you do not have a URL (DuckDuckGo search).',
        },
      },
    },
  },
  {
    name: 'browser_back',
    description: 'Go back in browser history.',
    behavior: Behavior.NON_BLOCKING,
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'browser_forward',
    description: 'Go forward in browser history.',
    behavior: Behavior.NON_BLOCKING,
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'browser_reload',
    description: 'Reload the current page.',
    behavior: Behavior.NON_BLOCKING,
    parameters: { type: Type.OBJECT, properties: {} },
  },
  // browser_click / browser_dblclick REMOVED from Live tools — use view_click (FPV grid).
  {
    name: 'browser_check',
    description:
      'Check/uncheck/toggle checkbox, switch, radio, or "I\'m not a robot" captcha checkbox only. ' +
      'For captcha IMAGE TILES or any normal button/link click: use view_click({x,y}) on FPV instead. ' +
      'Pass checked=true/false or toggle=true; captcha=true + text="I\'m not a robot" for the anchor checkbox.',
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      properties: {
        checked: {
          type: Type.BOOLEAN,
          description: 'Desired state: true = checked/on, false = unchecked/off.',
        },
        check: {
          type: Type.BOOLEAN,
          description: 'Alias for checked=true.',
        },
        uncheck: {
          type: Type.BOOLEAN,
          description: 'Alias for checked=false.',
        },
        toggle: {
          type: Type.BOOLEAN,
          description: 'Flip current state regardless of desired value.',
        },
        state: {
          type: Type.STRING,
          description: 'on/off/checked/unchecked/true/false as string alternative to checked=.',
        },
        captcha: {
          type: Type.BOOLEAN,
          description:
            'Treat as captcha / reCAPTCHA / hCaptcha / "I\'m not a robot". Uses frame-aware mouse click instead of setChecked.',
        },
        recaptcha: {
          type: Type.BOOLEAN,
          description: 'Alias for captcha=true (Google reCAPTCHA).',
        },
        ref: { type: Type.STRING, description: REF_DESC },
        role: {
          type: Type.STRING,
          description: 'checkbox (default), switch, or radio.',
        },
        name: { type: Type.STRING, description: 'Accessible name of the control.' },
        text: {
          type: Type.STRING,
          description: 'Visible label (e.g. "Remember me", "I\'m not a robot").',
        },
        label: { type: Type.STRING, description: 'Alias for text/name.' },
        field: { type: Type.STRING, description: 'Alias for label.' },
        elementId: { type: Type.NUMBER },
        selector: { type: Type.STRING, description: 'CSS selector e.g. input[name=agree].' },
        x: { type: Type.NUMBER, description: COORD_DESC + ' Useful for captcha boxes.' },
        y: { type: Type.NUMBER, description: COORD_DESC + ' Useful for captcha boxes.' },
      },
    },
  },
  {
    name: 'browser_move',
    description:
      'Move the visible in-scene mouse cursor (and Playwright pointer) over the page without clicking. ' +
      'Use to aim before click/hover/check, or to show intentional pointer motion. ' +
      'Target by ref, text/role, or x,y (0–1). Avatar plays a reach-arm animation.',
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      properties: {
        ref: { type: Type.STRING, description: REF_DESC },
        role: { type: Type.STRING },
        name: { type: Type.STRING },
        text: { type: Type.STRING },
        label: { type: Type.STRING },
        elementId: { type: Type.NUMBER },
        selector: { type: Type.STRING },
        x: { type: Type.NUMBER, description: COORD_DESC },
        y: { type: Type.NUMBER, description: COORD_DESC },
        steps: {
          type: Type.NUMBER,
          description: 'Smooth move steps (default 12). Higher = slower visible motion.',
        },
      },
    },
  },
  {
    name: 'browser_hover',
    description:
      'Move the mouse over an element and HOLD it so hover-only UI appears: menus, tooltips, overflow actions (⋯), row "more" buttons, CSS :hover dropdowns. ' +
      'Pointer stays on the target so the menu does not close. Re-snapshots by default. ' +
      'Then click revealed items with view_click({x,y}) on the FPV point over that item (not browser_click).',
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      properties: {
        ref: { type: Type.STRING, description: REF_DESC },
        role: { type: Type.STRING, description: 'ARIA role, e.g. "button", "menuitem", "link".' },
        name: { type: Type.STRING, description: 'Accessible name / label to hover.' },
        text: { type: Type.STRING, description: 'Visible text to hover (e.g. "More", "⋯").' },
        label: { type: Type.STRING, description: 'Alias for text/name.' },
        elementId: { type: Type.NUMBER },
        selector: { type: Type.STRING },
        x: { type: Type.NUMBER, description: COORD_DESC },
        y: { type: Type.NUMBER, description: COORD_DESC },
        dwellMs: {
          type: Type.NUMBER,
          description: 'How long to keep the pointer on the element in ms (default 400). Increase for slow menus.',
        },
        ms: { type: Type.NUMBER, description: 'Alias for dwellMs.' },
        force: {
          type: Type.BOOLEAN,
          description: 'Force hover even if element is partially covered (default true).',
        },
        resnapshot: {
          type: Type.BOOLEAN,
          description: 'Refresh axTree after hover so new menu items get refs (default true).',
        },
        clickToOpen: {
          type: Type.BOOLEAN,
          description:
            'Also click the target after hover (for ⋯ / More buttons that need click, not pure hover, to open the menu).',
        },
        open: {
          type: Type.BOOLEAN,
          description: 'Alias for clickToOpen.',
        },
      },
    },
  },
  {
    name: 'browser_scroll',
    description:
      'Scroll a specific region when the page has MULTIPLE scrollable panes (sidebar, chat list, main column, modal). ' +
      'Pass x,y (0–1) over the pane you want (e.g. left sidebar x=0.15, main content x=0.6, chat list y=0.4). ' +
      'Engine picks the nested scroller under that point, not only the document. ' +
      'Prefer pages=1, direction=down/up, or mode=top/bottom. Positive dy = down. Returns panes list if several exist.',
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      properties: {
        dy: { type: Type.NUMBER, description: 'Vertical delta in CSS pixels. Positive = down.' },
        dx: { type: Type.NUMBER, description: 'Horizontal delta in CSS pixels.' },
        pages: { type: Type.NUMBER, description: 'Screenfuls to scroll (1 = one page down, -1 = up). Preferred for reading.' },
        direction: {
          type: Type.STRING,
          enum: ['down', 'up', 'top', 'bottom'],
          description: 'Semantic scroll direction. top/bottom jump to edges of the chosen pane.',
        },
        mode: {
          type: Type.STRING,
          enum: ['top', 'bottom'],
          description: 'Jump to top or bottom of the chosen scroll container.',
        },
        to: {
          type: Type.STRING,
          enum: ['top', 'bottom'],
          description: 'Alias for mode top/bottom.',
        },
        amount: { type: Type.NUMBER, description: 'Optional pixel amount if dy omitted.' },
        x: {
          type: Type.NUMBER,
          description:
            'Normalized 0–1 X focus — CRITICAL on multi-pane pages to choose which scroller (sidebar vs main).',
        },
        y: {
          type: Type.NUMBER,
          description: 'Normalized 0–1 Y focus over the target scroll pane.',
        },
        ref: {
          type: Type.STRING,
          description: 'Optional element ref to scroll into view / whose container to scroll.',
        },
        selector: { type: Type.STRING, description: 'Optional CSS selector of element inside the pane to scroll.' },
        container: {
          type: Type.STRING,
          description: 'Hint for pane name (e.g. "sidebar", "chat", "messages").',
        },
        pane: { type: Type.STRING, description: 'Alias for container.' },
      },
    },
  },
  {
    name: 'browser_type',
    description:
      'Type into a text field or chat composer. BEST: ref of textbox/searchbox/contenteditable. ' +
      'Uses Playwright fill + keyboard.insertText + React value setter (works in chat apps). ' +
      'Set pressEnter=true (or submit=true) to send the message / submit search after typing (Enter + Send button fallback). ' +
      'clear/replace to replace; append to keep existing; clearOnly only clears.',
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      properties: {
        text: { type: Type.STRING, description: 'Text to type (required unless clearOnly).' },
        clear: { type: Type.BOOLEAN, description: 'Select-all and delete before typing.' },
        replace: { type: Type.BOOLEAN, description: 'Same as clear=true then type.' },
        append: { type: Type.BOOLEAN, description: 'Do not clear; insert at caret / end.' },
        clearOnly: { type: Type.BOOLEAN, description: 'Only clear the field; do not type.' },
        pressEnter: {
          type: Type.BOOLEAN,
          description:
            'After typing, press Enter to send/submit (chat message, search). Preferred over a separate browser_key call.',
        },
        submit: {
          type: Type.BOOLEAN,
          description: 'Alias for pressEnter=true.',
        },
        enter: {
          type: Type.BOOLEAN,
          description: 'Alias for pressEnter=true.',
        },
        ref: { type: Type.STRING, description: REF_DESC + ' Prefer a textbox/searchbox/chat composer ref.' },
        role: { type: Type.STRING, description: 'Usually "textbox" or "searchbox".' },
        name: { type: Type.STRING, description: 'Accessible name of the field.' },
        label: { type: Type.STRING, description: 'Visible field label / placeholder to focus first.' },
        field: { type: Type.STRING, description: 'Alias for label.' },
        placeholder: { type: Type.STRING, description: 'Alias for label (match placeholder).' },
        selector: { type: Type.STRING, description: 'CSS selector of the field.' },
        elementId: { type: Type.NUMBER, description: 'Interactive element id from snapshot.' },
        x: { type: Type.NUMBER, description: 'Focus click x 0–1 if needed (fallback).' },
        y: { type: Type.NUMBER, description: 'Focus click y 0–1 if needed (fallback).' },
      },
    },
  },
  {
    name: 'browser_key',
    description:
      'Press a key/chord. Enter/Return/submit/send: chat-aware (Enter + NumpadEnter + Send button + form submit). ' +
      'Also: Tab, Escape, Backspace, arrows, Meta+A/C/V/X, aliases delete_all, select_all, copy, paste. ' +
      'For chat: prefer browser_type with pressEnter=true instead of type then key separately.',
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      required: ['key'],
      properties: {
        key: {
          type: Type.STRING,
          description:
            'Key, chord (Meta+C), or alias: Enter, submit, send, delete_all, copy, paste, select_all.',
        },
        repeat: { type: Type.NUMBER, description: 'How many times to press (default 1, max 100).' },
        count: { type: Type.NUMBER, description: 'Alias for repeat.' },
        ref: { type: Type.STRING, description: REF_DESC + ' Focus this field before key (e.g. chat box).' },
        label: { type: Type.STRING, description: 'Optional field to focus first.' },
        elementId: { type: Type.NUMBER },
        selector: { type: Type.STRING },
        x: { type: Type.NUMBER },
        y: { type: Type.NUMBER },
      },
    },
  },
  {
    name: 'browser_dismiss',
    description:
      'Close big modals, cookie banners, newsletter popups, and ad overlays blocking the page. ' +
      'Runs a multi-step strategy: click Close/×, Escape, native dialog.close(), hide overlays, corner click. ' +
      'Call this FIRST when snapshot shows "MODAL/POPUP BLOCKING" or the page is covered by a large dialog. ' +
      'Prefer this over guessing coords on the X button.',
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      properties: {
        aggressive: {
          type: Type.BOOLEAN,
          description:
            'If true (default), also force-hide large fixed overlays that look like modals/ads. Set false for gentler Escape+close only.',
        },
      },
    },
  },
  {
    name: 'browser_select',
    description:
      'Select text smartly. Prefer text="phrase on page" to find+select, or mode="all"/all=true for select-all in a field or page. ' +
      'Or drag between x1,y1–x2,y2. Set copy=true to copy selection.',
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      properties: {
        text: { type: Type.STRING, description: 'Find and select this exact phrase on the page.' },
        find: { type: Type.STRING, description: 'Alias for text (find phrase).' },
        mode: {
          type: Type.STRING,
          enum: ['all', 'select_all', 'field'],
          description: 'all/select_all = select entire field or page; field = active field.',
        },
        all: { type: Type.BOOLEAN, description: 'Select all in focused field (or body).' },
        inField: { type: Type.BOOLEAN, description: 'Force select-all inside a field (use with label/elementId).' },
        copy: { type: Type.BOOLEAN, description: 'Copy selection to clipboard after selecting.' },
        label: { type: Type.STRING, description: 'Field to focus before select-all.' },
        elementId: { type: Type.NUMBER },
        selector: { type: Type.STRING },
        x1: { type: Type.NUMBER, description: 'Drag start x 0–1.' },
        y1: { type: Type.NUMBER, description: 'Drag start y 0–1.' },
        x2: { type: Type.NUMBER, description: 'Drag end x 0–1.' },
        y2: { type: Type.NUMBER, description: 'Drag end y 0–1.' },
      },
    },
  },
  {
    name: 'browser_read',
    description:
      'Read structured page info without inventing content: selection, url, title, elements (interactive list), or visible_text (truncated sample).',
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      properties: {
        what: {
          type: Type.STRING,
          enum: ['selection', 'url', 'title', 'elements', 'visible_text'],
          description: 'What to read. Default selection.',
        },
      },
    },
  },
  {
    name: 'browser_snapshot',
    description:
      'Refresh page metadata + accessibility-style axTree with refs (e1, e2, …). ' +
      'Call to list page structure / text fields. For CLICKS use view_click (FPV grid). For typing use browser_type with ref=. ' +
      'Refs go stale after navigation or major DOM changes — snapshot again.',
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      properties: {
        includeElements: {
          type: Type.BOOLEAN,
          description: 'Include interactive element list + axTree. Default true.',
        },
      },
    },
  },
];

export type BrowserPending = {
  id: string;
  name: string;
  timer: ReturnType<typeof setTimeout>;
};

/** Max concurrent browser tool ids awaiting frontend (prevents timeout storms). */
export const BROWSER_MAX_PENDING = 4;
/** Per-tool wait; queue runs serially so deep queues need headroom. */
export const BROWSER_TOOL_TIMEOUT_MS = 90000;

export class BrowserToolBridge {
  private pending = new Map<string, BrowserPending>();
  private readonly timeoutMs: number;
  private readonly maxPending: number;

  constructor(
    private getWs: () => WebSocket | undefined,
    private onTimeoutResult: (id: string, name: string, response: Record<string, unknown>) => void,
    timeoutMs = BROWSER_TOOL_TIMEOUT_MS,
    maxPending = BROWSER_MAX_PENDING,
  ) {
    this.timeoutMs = timeoutMs;
    this.maxPending = maxPending;
  }

  dispatch(id: string, name: string, args: Record<string, unknown>): boolean {
    const ws = this.getWs();
    if (!ws || ws.readyState !== 1) {
      console.warn('[BROWSER] WS not ready; cannot dispatch', name);
      return false;
    }

    // Cap in-flight tools so the serial frontend queue cannot grow unbounded.
    // Return true after replying — caller must not send a second offline error.
    if (!this.pending.has(id) && this.pending.size >= this.maxPending) {
      console.warn(
        `[BROWSER] Reject dispatch ${name} id=${id}: pending=${this.pending.size} >= max=${this.maxPending}`,
      );
      this.onTimeoutResult(id, name, {
        ok: false,
        error: 'queue_full',
        pendingCount: this.pending.size,
      });
      return true;
    }

    this.clearPending(id);

    const timer = setTimeout(() => {
      if (!this.pending.has(id)) return;
      this.pending.delete(id);
      console.warn(`[BROWSER] Tool ${name} (${id}) timed out after ${this.timeoutMs}ms.`);
      // Ask frontend to drop this id if still queued
      try {
        ws.send(JSON.stringify({ type: 'browserCancel', id, reason: 'timeout' }));
      } catch {
        /* ignore */
      }
      this.onTimeoutResult(id, name, {
        ok: false,
        error: 'timeout',
      });
    }, this.timeoutMs);

    this.pending.set(id, { id, name, timer });

    ws.send(
      JSON.stringify({
        type: 'browserCommand',
        id,
        name,
        args: args ?? {},
      }),
    );
    console.log(
      `[BROWSER] Dispatched ${name} id=${id} pending=${this.pending.size}`,
      JSON.stringify(args ?? {}).slice(0, 400),
    );
    return true;
  }

  resolvePending(id: string): BrowserPending | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    return entry;
  }

  clearPending(id: string) {
    const entry = this.pending.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
    }
  }

  clearAll() {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
  }

  /**
   * Cancel every pending tool: notify frontend + send cancelled results to Live.
   * Used for user cancel steers ("nevermind") so work does not keep draining.
   */
  cancelAll(reason = 'cancelled_by_user'): number {
    const entries = [...this.pending.values()];
    this.clearAll();
    const ws = this.getWs();
    if (ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify({ type: 'browserCancel', all: true, reason }));
      } catch {
        /* ignore */
      }
    }
    for (const entry of entries) {
      this.onTimeoutResult(entry.id, entry.name, {
        ok: false,
        error: 'cancelled',
      });
    }
    console.log(`[BROWSER] cancelAll reason=${reason} n=${entries.length}`);
    return entries.length;
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  pendingIds(): string[] {
    return [...this.pending.keys()];
  }
}

export function browserToolResponse(
  id: string,
  name: string,
  response: Record<string, unknown>,
) {
  return {
    id,
    name,
    response,
    scheduling: FunctionResponseScheduling.WHEN_IDLE,
  };
}
