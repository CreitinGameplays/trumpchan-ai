/**
 * Vision-based browser action planner (primary multi-step browser brain).
 * Mirrors spatial VisionPlanner: generateContent + JPEG → JSON steps (gemini-3.1-flash-lite).
 * Live browser tool args remain the executor fallback.
 */
import { GoogleGenerativeAI } from '@google/generative-ai';

export type BrowserStep = {
  name: string;
  args: Record<string, unknown>;
};

export type BrowserPlan = {
  ok: boolean;
  source: 'browser-er' | 'fallback';
  reasoning?: string;
  steps: BrowserStep[];
  error?: string;
  latencyMs?: number;
};

const ALLOWED = new Set([
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
  // browser_click / browser_dblclick removed — Live uses view_click (FPV grid)
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
]);

const PLANNER_PROMPT = `You are a browser-use planner for a VTuber who controls a floating in-scene web browser.
The image shows the CURRENT screen (3D room + browser panel). Focus on the browser page content.

Return ONLY valid JSON (no markdown fences):
{
  "reasoning": "one short sentence",
  "steps": [ { "name": "<tool>", "args": { ... } } ]
}

Allowed tools (NO browser_click — clicks are spatial view_click, planned by Live not this planner):
- browser_navigate: { "url"?: string, "query"?: string }  // query → DuckDuckGo (not Google)
- browser_back / browser_forward / browser_reload: {}
- browser_snapshot: { "includeElements"?: boolean }  // structure for type/read; not for clicking
- browser_dismiss: { "aggressive"?: boolean }  // CLOSE modals/cookie/ad popups when page is covered
- browser_hover: { "ref"|"text"|"name", "dwellMs"?: 400 } — reveal hover menus (Live then view_click the item)
- browser_move: { "ref"|"x","y" } — move 3D cursor only (no click)
- browser_check: { "checked": true|false, "label"|"text"|"ref", "captcha"?: true, "toggle"?: true } — checkbox/"I'm not a robot" only
- browser_scroll: { "pages"?: number, "dy"?: number, "direction"?: "down"|"up"|"top"|"bottom", "mode"?: "top"|"bottom", "x"?: number, "y"?: number }
- browser_type: BEST { "ref":"e1", "text":"…", "pressEnter"?: true }
- browser_key: { "key": "Enter"|"submit"|string, "repeat"?: number, "ref"?: string }
- browser_select: { "text"?: string, "mode"?: "all", "copy"?: boolean }
- browser_read: { "what": "selection"|"url"|"title"|"elements"|"visible_text" }

Rules:
1. Prefer 1–8 steps. Never invent tools. Never emit browser_click or browser_dblclick (deprecated — Live uses view_click on FPV grid).
2. This planner is for navigate/type/scroll/snapshot/dismiss only. Clicks are done by the Live model via view_click after you return.
3. If a large modal covers the page: first step browser_dismiss.
4. For search: browser_navigate with query (DuckDuckGo) OR browser_type into searchbox + pressEnter. Avoid google.com bot walls.
5. Do not include speech. Do not plan 3D walk/turn or view_click (spatial tools are separate).
6. Typing/chat: browser_type with ref or label; pressEnter=true to send.
7. Captcha checkbox: browser_check({ captcha: true, text: "I'm not a robot" }). Image tiles: leave for Live view_click.
8. If the goal is only to look/describe, return a single browser_snapshot step.
9. If the goal is primarily "click X", return browser_snapshot only (or navigate) so Live can view_click.
`;

function stripJsonFence(text: string): string {
  let t = text.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return t;
}

function sanitizeSteps(raw: unknown): BrowserStep[] {
  if (!Array.isArray(raw)) return [];
  const steps: BrowserStep[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    let name = String((item as any).name || '').trim();
    // Drop / rewrite deprecated click steps from stale planners
    if (name === 'browser_click' || name === 'browser_dblclick') {
      console.warn(`[BrowserER] Dropped deprecated plan step ${name} (use view_click)`);
      continue;
    }
    if (!ALLOWED.has(name)) continue;
    const args =
      (item as any).args && typeof (item as any).args === 'object'
        ? { ...(item as any).args }
        : {};
    for (const k of ['x', 'y', 'x1', 'y1', 'x2', 'y2']) {
      if (k in args && typeof args[k] === 'number') {
        args[k] = Math.max(0, Math.min(1, args[k] as number));
      }
    }
    steps.push({ name, args });
    if (steps.length >= 10) break;
  }
  return steps;
}

export class BrowserActionPlanner {
  private model: ReturnType<GoogleGenerativeAI['getGenerativeModel']> | null = null;
  private enabled: boolean;
  private lastErrorAt = 0;
  private consecutiveFailures = 0;

  constructor() {
    const key =
      process.env.XINJIANYA_KEY ||
      process.env.VISION_PLANNER_API_KEY ||
      process.env.ROBOTICS_ER_API_KEY ||
      process.env.GEMINI_API_KEY ||
      '';
    const baseUrl =
      process.env.BROWSER_ER_BASE_URL ||
      process.env.VISION_PLANNER_BASE_URL ||
      process.env.ROBOTICS_ER_BASE_URL ||
      process.env.XINJIANYA_BASE_URL ||
      'https://aihub.071129.xyz';
    // Same fast vision model as spatial click planner (not Robotics-ER)
    const modelId =
      process.env.BROWSER_ER_MODEL ||
      process.env.VISION_PLANNER_MODEL ||
      process.env.SPATIAL_PLANNER_MODEL ||
      'gemini-3.1-flash-lite';

    this.enabled = Boolean(
      key &&
        process.env.BROWSER_ER_ENABLED !== '0' &&
        process.env.VISION_PLANNER_ENABLED !== '0' &&
        process.env.ROBOTICS_ER_ENABLED !== '0',
    );

    if (!this.enabled) {
      console.warn('[BrowserER] Disabled; Live browser tool fallback only.');
      return;
    }

    try {
      const genAI = new GoogleGenerativeAI(key);
      this.model = genAI.getGenerativeModel(
        { model: modelId },
        baseUrl ? { baseUrl } : (undefined as any),
      );
      console.log(`[BrowserER] Planner ready model=${modelId} baseUrl=${baseUrl || 'default'}`);
    } catch (e) {
      console.error('[BrowserER] Init failed:', e);
      this.enabled = false;
      this.model = null;
    }
  }

  isAvailable(): boolean {
    if (!this.enabled || !this.model) return false;
    if (this.consecutiveFailures >= 3 && Date.now() - this.lastErrorAt < 60_000) return false;
    return true;
  }

  async planFromFrame(params: {
    jpegBase64: string;
    mimeType?: string;
    goal: string;
    pageHint?: string;
  }): Promise<BrowserPlan> {
    if (!this.isAvailable() || !this.model) {
      return { ok: false, source: 'fallback', steps: [], error: 'planner_unavailable' };
    }

    const started = Date.now();
    const mime = params.mimeType || 'image/jpeg';
    const goal = String(params.goal || '').slice(0, 800);
    const pageHint = params.pageHint ? `\nPage hint: ${params.pageHint}` : '';

    try {
      const result = await this.model.generateContent({
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: mime,
                  data: params.jpegBase64,
                },
              },
              {
                text: `${PLANNER_PROMPT}\n\nUser goal: ${goal}${pageHint}`,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.35,
          maxOutputTokens: 1400,
        },
      });

      const text = result.response?.text?.() ?? '';
      if (!text.trim()) throw new Error('empty_response');

      const parsed = JSON.parse(stripJsonFence(text));
      const steps = sanitizeSteps(parsed.steps);
      if (steps.length === 0) throw new Error('no_valid_steps');

      this.consecutiveFailures = 0;
      const plan: BrowserPlan = {
        ok: true,
        source: 'browser-er',
        reasoning: String(parsed.reasoning || '').slice(0, 400),
        steps,
        latencyMs: Date.now() - started,
      };
      console.log(
        `[BrowserER] Plan ok in ${plan.latencyMs}ms steps=${steps.map((s) => s.name).join('→')} reason=${plan.reasoning}`,
      );
      return plan;
    } catch (e: any) {
      this.consecutiveFailures++;
      this.lastErrorAt = Date.now();
      const msg = e?.message ?? String(e);
      console.warn(`[BrowserER] Plan failed (${this.consecutiveFailures}):`, msg);
      return {
        ok: false,
        source: 'fallback',
        steps: [],
        error: msg,
        latencyMs: Date.now() - started,
      };
    }
  }
}

/** Complex goals benefit from multi-step vision planning. */
export function shouldUseBrowserPlanner(toolName: string): boolean {
  return toolName === 'use_browser';
}

/** Detect if a use_browser goal is an on-page action (type/click/scroll) vs a search/navigate. */
function goalIsOnPageAction(goal: string): boolean {
  const lower = goal.toLowerCase();
  // Action verbs that indicate interacting with the current page, not navigating away
  return /\b(type|click|press|enter|scroll|select|check|uncheck|toggle|dismiss|close|fill|send|submit|tap|hover)\b/.test(lower);
}

/** Simple tools: execute as a one-step plan (Live args). */
export function fallbackBrowserPlanFromTool(
  name: string,
  args: Record<string, unknown>,
): BrowserPlan {
  // use_browser without planner: try navigate if goal looks like URL/search
  if (name === 'use_browser') {
    const goal = String(args.goal || '').trim();
    if (/^https?:\/\//i.test(goal) || /^[^\s]+\.[^\s]+$/.test(goal)) {
      return {
        ok: true,
        source: 'fallback',
        steps: [{ name: 'browser_navigate', args: { url: goal } }],
        reasoning: 'Fallback: treat goal as URL.',
      };
    }
    // If goal describes an on-page action, do NOT navigate away — snapshot instead
    // so the model can use the current page context.
    if (goal && goalIsOnPageAction(goal)) {
      console.warn(
        `[BrowserER] Fallback: goal is on-page action, NOT navigating away: "${goal.slice(0, 100)}"`,
      );
      return {
        ok: true,
        source: 'fallback',
        steps: [{ name: 'browser_snapshot', args: { includeElements: true } }],
        reasoning: 'Fallback: goal is an on-page action; snapshot current page (no navigation).',
      };
    }
    if (goal) {
      return {
        ok: true,
        source: 'fallback',
        steps: [
          { name: 'browser_navigate', args: { query: goal } },
          { name: 'browser_snapshot', args: { includeElements: true } },
        ],
        reasoning: 'Fallback: search goal + snapshot.',
      };
    }
    return {
      ok: true,
      source: 'fallback',
      steps: [{ name: 'browser_snapshot', args: {} }],
      reasoning: 'Fallback: snapshot only.',
    };
  }

  return {
    ok: true,
    source: 'fallback',
    steps: [{ name, args: args ?? {} }],
    reasoning: 'Live browser tool fallback.',
  };
}
