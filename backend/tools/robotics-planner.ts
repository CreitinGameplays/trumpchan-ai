/**
 * Vision spatial / click planner (generateContent, NOT Live).
 *
 * Model: gemini-3.1-flash-lite (fast, vision-capable, lighter rate limits than Robotics-ER).
 * Sends the newest FPV JPEG (with coordinate rulers) + goal → JSON plan of avatar steps.
 * Live spatial tools remain the executor + fallback if the planner fails.
 *
 * Provider: GoogleGenerativeAI with custom baseUrl (XINJIANYA / aihub).
 */
import { GoogleGenerativeAI } from '@google/generative-ai';

export type SpatialStep = {
  name: string;
  args: Record<string, unknown>;
};

export type RoboticsPlan = {
  ok: boolean;
  source: 'flash-lite' | 'fallback';
  reasoning?: string;
  steps: SpatialStep[];
  error?: string;
  latencyMs?: number;
  model?: string;
};

const ALLOWED_STEPS = new Set([
  'look_at',
  'turn',
  'walk',
  'walk_toward',
  'stop_moving',
  'inspect_browser',
  'reset_pose',
  'view_click',
  'view_look',
  'view_go',
]);

const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const DEFAULT_BASE_URL = 'https://aihub.071129.xyz';

const PLANNER_PROMPT = `You are a spatial + FPV-click planner for a VTuber avatar in a simple 3D room.
The attached image is the CURRENT first-person camera frame WITH yellow 0.0–1.0 coordinate rulers overlaid.
Coordinate system: (0,0)=top-left, (1,0)=top-right, (0,1)=bottom-left, (1,1)=bottom-right of the FULL image.
PRIMARY click targeting is numeric x,y (NOT letter cells). Example: view_click with "x": 0.42, "y": 0.61.
Read the rulers carefully and aim at the visual center of the UI control.

Return ONLY valid JSON (no markdown fences) with this shape:
{
  "reasoning": "one short sentence",
  "steps": [
    { "name": "<tool>", "args": { ... } }
  ]
}

Allowed tools (name) and args:
- look_at: { "target": "user"|"browser"|"home"|"left"|"right"|"forward"|"back", "duration"?: number }
- turn: { "mode": "face_target"|"by_degrees", "target"?: same as look_at targets, "degrees"?: number }
- walk: { "direction": "forward"|"back", "seconds"?: number }
- walk_toward: { "target": "user"|"browser"|"home", "seconds"?: number }
- stop_moving: {}
- inspect_browser: { "seconds"?: number }
- reset_pose: {}
- view_click: { "x": 0-1, "y": 0-1, "clickCount"?: 1|2 }  // REQUIRED: x and y floats from the image
- view_look: { "x": 0-1, "y": 0-1 }
- view_go: { "x": 0-1, "y": 0-1 }

Rules:
1. Prefer 1–4 short steps. Prefer face_target over by_degrees.
2. For "look at / use / describe the browser page": position in front of the panel first — prefer inspect_browser when far/small.
3. For normal chat facing the user: turn face_target user + look_at user (do not walk unless asked).
4. Do not invent tools. Do not include speech text.
5. If the browser is already large/close and facing the avatar, prefer look_at browser only (unless the goal is a click).
6. seconds for walks: 1.5–4.0 typically.
7. CLICKS: when the goal is view_click, prefer outputting the SAME x,y Live suggested if they land on a control. Only change x,y if Live clearly missed (off-panel or empty space). Do NOT invent a different Discord channel/button than the pointed spot. Always output both "x" and "y".
8. Do NOT re-interpret the user's target (e.g. do not switch F3/icon aim to "#general" or "Friends"). Aim where Live pointed.
9. If the panel is small/far, put inspect_browser (or walk_toward browser) BEFORE view_click.
10. For inspect_browser goals: ALWAYS include inspect_browser or walk_toward browser — never look_at alone when the user asked to inspect/get close.
11. view_look / view_go only when the goal is look/walk toward a seen point — not for button clicks.
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

function sanitizeSteps(raw: unknown): SpatialStep[] {
  if (!Array.isArray(raw)) return [];
  const steps: SpatialStep[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const name = String((item as any).name || '').trim();
    if (!ALLOWED_STEPS.has(name)) continue;
    const args =
      (item as any).args && typeof (item as any).args === 'object'
        ? { ...(item as any).args }
        : {};
    // Coerce view coords to numbers in 0–1 when present
    if (isViewSpatialTool(name)) {
      if (args.x != null) {
        let x = Number(args.x);
        if (Number.isFinite(x) && x > 1.5) x = x / 1280;
        if (Number.isFinite(x)) args.x = Math.max(0, Math.min(1, x));
      }
      if (args.y != null) {
        let y = Number(args.y);
        if (Number.isFinite(y) && y > 1.5) y = y / 720;
        if (Number.isFinite(y)) args.y = Math.max(0, Math.min(1, y));
      }
    }
    steps.push({ name, args });
    if (steps.length >= 6) break;
  }
  return steps;
}

/**
 * Vision spatial planner (class name kept for import compatibility).
 * Uses gemini-3.1-flash-lite by default — not Robotics-ER.
 */
export class RoboticsSpatialPlanner {
  private model: ReturnType<GoogleGenerativeAI['getGenerativeModel']> | null = null;
  private enabled: boolean;
  private modelId: string = DEFAULT_MODEL;
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
      process.env.VISION_PLANNER_BASE_URL ||
      process.env.ROBOTICS_ER_BASE_URL ||
      process.env.XINJIANYA_BASE_URL ||
      DEFAULT_BASE_URL;
    this.modelId =
      process.env.VISION_PLANNER_MODEL ||
      process.env.SPATIAL_PLANNER_MODEL ||
      process.env.ROBOTICS_ER_MODEL ||
      DEFAULT_MODEL;

    // VISION_PLANNER_ENABLED / SPATIAL_PLANNER_ENABLED / ROBOTICS_ER_ENABLED=0 disables
    this.enabled = Boolean(
      key &&
        process.env.VISION_PLANNER_ENABLED !== '0' &&
        process.env.SPATIAL_PLANNER_ENABLED !== '0' &&
        process.env.ROBOTICS_ER_ENABLED !== '0',
    );

    if (!this.enabled) {
      console.warn(
        '[VisionPlanner] Disabled (no key or ENABLED=0). Live spatial/click fallback only.',
      );
      return;
    }

    try {
      const genAI = new GoogleGenerativeAI(key);
      this.model = genAI.getGenerativeModel(
        { model: this.modelId },
        baseUrl ? { baseUrl } : (undefined as any),
      );
      console.log(
        `[VisionPlanner] Ready model=${this.modelId} baseUrl=${baseUrl || 'default'} ` +
          `(replaces Robotics-ER; same FPV JPEG plan flow)`,
      );
    } catch (e) {
      console.error('[VisionPlanner] Failed to init client:', e);
      this.enabled = false;
      this.model = null;
    }
  }

  isAvailable(): boolean {
    if (!this.enabled || !this.model) return false;
    // Short cool-down after burst failures (flash-lite recovers faster than Robotics-ER)
    if (this.consecutiveFailures >= 4 && Date.now() - this.lastErrorAt < 30_000) {
      return false;
    }
    return true;
  }

  /**
   * Plan discrete spatial steps from a JPEG frame + natural language goal.
   * JPEG should be the FPV frame with coordinate overlay already baked in.
   */
  async planFromFrame(params: {
    jpegBase64: string;
    mimeType?: string;
    goal: string;
    sceneHint?: string;
  }): Promise<RoboticsPlan> {
    if (!this.isAvailable() || !this.model) {
      return {
        ok: false,
        source: 'fallback',
        steps: [],
        error: 'planner_unavailable',
        model: this.modelId,
      };
    }

    const started = Date.now();
    const mime = params.mimeType || 'image/jpeg';
    const goal = String(params.goal || '').slice(0, 800);
    const sceneHint = params.sceneHint ? `\nCurrent pose / frame hint: ${params.sceneHint}` : '';

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
                text:
                  `${PLANNER_PROMPT}\n\nUser goal: ${goal}${sceneHint}\n` +
                  `The image above is the exact FPV frame with coordinate lines — use those rulers for x,y.`,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.25,
          maxOutputTokens: 1024,
        },
      });

      const text = result.response?.text?.() ?? '';
      if (!text.trim()) {
        throw new Error('empty_response');
      }

      const parsed = JSON.parse(stripJsonFence(text));
      const steps = sanitizeSteps(parsed.steps);
      if (steps.length === 0) {
        throw new Error('no_valid_steps');
      }

      this.consecutiveFailures = 0;
      const plan: RoboticsPlan = {
        ok: true,
        source: 'flash-lite',
        reasoning: String(parsed.reasoning || '').slice(0, 300),
        steps,
        latencyMs: Date.now() - started,
        model: this.modelId,
      };
      console.log(
        `[VisionPlanner] Plan ok in ${plan.latencyMs}ms model=${this.modelId} ` +
          `steps=${steps.map((s) => s.name).join('→')} reason=${plan.reasoning}`,
      );
      return plan;
    } catch (e: any) {
      this.consecutiveFailures++;
      this.lastErrorAt = Date.now();
      const msg = e?.message ?? String(e);
      console.warn(`[VisionPlanner] Plan failed (${this.consecutiveFailures}):`, msg);
      return {
        ok: false,
        source: 'fallback',
        steps: [],
        error: msg,
        latencyMs: Date.now() - started,
        model: this.modelId,
      };
    }
  }
}

/** Tools that go through the vision planner first (nav + all FPV clicks). */
export function shouldUseRoboticsPlanner(toolName: string): boolean {
  return (
    toolName === 'inspect_browser' ||
    toolName === 'walk_toward' ||
    toolName === 'walk' ||
    toolName === 'view_click' ||
    toolName === 'view_look' ||
    toolName === 'view_go'
  );
}

export function isViewSpatialTool(name: string): boolean {
  return name === 'view_click' || name === 'view_look' || name === 'view_go';
}

function num01(v: unknown): number | null {
  let n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n > 1.5) n = n / 1280;
  return Math.max(0, Math.min(1, n));
}

/**
 * Merge vision-planner plan with Live view_* call.
 * When Live already sent valid x,y, KEEP them (flash-lite often invents wrong Discord rows).
 * Planner may still contribute non-view prefix steps (inspect/walk) if refine mode is on.
 */
export function mergeViewToolPlan(
  liveName: string,
  liveArgs: Record<string, unknown>,
  erPlan: RoboticsPlan,
): SpatialStep[] {
  const liveStep: SpatialStep = { name: liveName, args: { ...(liveArgs ?? {}) } };
  const liveX = num01(liveArgs?.x);
  const liveY = num01(liveArgs?.y);
  const liveHasXY = liveX != null && liveY != null;

  if (!erPlan.ok || !erPlan.steps?.length) {
    return [liveStep];
  }

  const prefix = erPlan.steps.filter((s) => !isViewSpatialTool(s.name));

  if (isViewSpatialTool(liveName) && liveHasXY) {
    const clickArgs: Record<string, unknown> = {
      ...liveArgs,
      x: liveX,
      y: liveY,
    };
    delete clickArgs.cell;
    delete clickArgs.sub;
    console.log(
      `[VisionPlanner] Keeping Live ${liveName} x=${liveX!.toFixed(3)} y=${liveY!.toFixed(3)} ` +
        `(ignore planner re-aim)`,
    );
    return [...prefix, { name: liveName, args: clickArgs }];
  }

  const steps = erPlan.steps.map((s) => {
    if (!isViewSpatialTool(s.name)) return s;
    const merged = { ...(liveArgs ?? {}), ...(s.args ?? {}) };
    const px = num01(s.args?.x);
    const py = num01(s.args?.y);
    if (px != null) merged.x = px;
    if (py != null) merged.y = py;
    if (s.args?.cell != null && merged.x == null) merged.cell = s.args.cell;
    if (s.args?.sub != null) merged.sub = s.args.sub;
    if (s.args?.clickCount != null) merged.clickCount = s.args.clickCount;
    if (merged.x != null && merged.y != null) {
      delete merged.cell;
      delete merged.sub;
    }
    return { name: s.name, args: merged };
  });

  const hasView = steps.some((s) => isViewSpatialTool(s.name));
  if (hasView) return steps;
  if (isViewSpatialTool(liveName)) return [...steps, liveStep];
  return steps.length ? steps : [liveStep];
}

/** Force real approach when planner returns only look_at for inspect_browser. */
export function ensureInspectPlan(steps: SpatialStep[], originalName: string): SpatialStep[] {
  if (originalName !== 'inspect_browser') return steps;
  const hasApproach = steps.some(
    (s) => s.name === 'inspect_browser' || s.name === 'walk_toward' || s.name === 'walk',
  );
  if (hasApproach) return steps;
  console.warn('[VisionPlanner] inspect_browser plan had no approach; forcing inspect_browser step');
  return [{ name: 'inspect_browser', args: { seconds: 3 } }];
}

/** Build a fallback single-step plan that mirrors the original Live tool call. */
export function fallbackPlanFromTool(
  name: string,
  args: Record<string, unknown>,
): RoboticsPlan {
  return {
    ok: true,
    source: 'fallback',
    steps: [{ name, args: args ?? {} }],
    reasoning: 'Live tool fallback (VisionPlanner unavailable or failed).',
  };
}
