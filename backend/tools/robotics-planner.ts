/**
 * Gemini Robotics-ER 1.6 spatial planner (primary navigation brain).
 *
 * Uses generateContent (NOT Live) with a scene JPEG to produce a short plan of
 * discrete avatar actions. Live spatial tools remain the executor + fallback.
 *
 * Provider: GoogleGenerativeAI with optional custom baseUrl (XINJIANYA / aihub).
 */
import { GoogleGenerativeAI } from '@google/generative-ai';

export type SpatialStep = {
  name: string;
  args: Record<string, unknown>;
};

export type RoboticsPlan = {
  ok: boolean;
  source: 'robotics-er' | 'fallback';
  reasoning?: string;
  steps: SpatialStep[];
  error?: string;
  latencyMs?: number;
};

const ALLOWED_STEPS = new Set([
  'look_at',
  'turn',
  'walk',
  'walk_toward',
  'stop_moving',
  'inspect_browser',
  'reset_pose',
]);

const PLANNER_PROMPT = `You are a spatial planner for a VTuber avatar in a simple 3D room.
The image is the current camera view of the scene (avatar, floor grid, floating web browser panel).

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

Rules:
1. Prefer 1–4 short steps. Prefer face_target over by_degrees.
2. For "look at the browser / describe the page": use inspect_browser OR turn face_target browser + walk_toward browser + look_at browser.
3. For normal chat facing the user: turn face_target user + look_at user (do not walk unless asked).
4. Do not invent tools. Do not include speech text.
5. If the browser is already large/close in the image, prefer look_at browser only.
6. seconds for walks: 1.5–4.0 typically.
`;

function stripJsonFence(text: string): string {
  let t = text.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  }
  // Extract first {...} if model added prose
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
    steps.push({ name, args });
    if (steps.length >= 6) break;
  }
  return steps;
}

export class RoboticsSpatialPlanner {
  private model: ReturnType<GoogleGenerativeAI['getGenerativeModel']> | null = null;
  private enabled: boolean;
  private lastErrorAt = 0;
  private consecutiveFailures = 0;

  constructor() {
    const key =
      process.env.XINJIANYA_KEY ||
      process.env.ROBOTICS_ER_API_KEY ||
      process.env.GEMINI_API_KEY ||
      '';
    const baseUrl =
      process.env.ROBOTICS_ER_BASE_URL ||
      process.env.XINJIANYA_BASE_URL ||
      'https://aihub.071129.xyz';
    const modelId =
      process.env.ROBOTICS_ER_MODEL || 'gemini-robotics-er-1.6-preview';

    this.enabled = Boolean(key && process.env.ROBOTICS_ER_ENABLED !== '0');

    if (!this.enabled) {
      console.warn('[RoboticsER] Disabled (no key or ROBOTICS_ER_ENABLED=0). Using Live spatial fallback only.');
      return;
    }

    try {
      const genAI = new GoogleGenerativeAI(key);
      // Custom provider base URL (proxy). Official Google AI Studio works if baseUrl omitted.
      this.model = genAI.getGenerativeModel(
        { model: modelId },
        baseUrl ? { baseUrl } : undefined as any,
      );
      console.log(`[RoboticsER] Planner ready model=${modelId} baseUrl=${baseUrl || 'default'}`);
    } catch (e) {
      console.error('[RoboticsER] Failed to init client:', e);
      this.enabled = false;
      this.model = null;
    }
  }

  isAvailable(): boolean {
    if (!this.enabled || !this.model) return false;
    // Brief cool-down after repeated failures
    if (this.consecutiveFailures >= 3 && Date.now() - this.lastErrorAt < 60_000) {
      return false;
    }
    return true;
  }

  /**
   * Plan discrete spatial steps from a JPEG frame + natural language goal.
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
      };
    }

    const started = Date.now();
    const mime = params.mimeType || 'image/jpeg';
    const goal = String(params.goal || '').slice(0, 500);
    const sceneHint = params.sceneHint ? `\nCurrent pose hint: ${params.sceneHint}` : '';

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
                text: `${PLANNER_PROMPT}\n\nUser goal: ${goal}${sceneHint}`,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.4,
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
        source: 'robotics-er',
        reasoning: String(parsed.reasoning || '').slice(0, 300),
        steps,
        latencyMs: Date.now() - started,
      };
      console.log(
        `[RoboticsER] Plan ok in ${plan.latencyMs}ms steps=${steps.map((s) => s.name).join('→')} ` +
          `reason=${plan.reasoning}`,
      );
      return plan;
    } catch (e: any) {
      this.consecutiveFailures++;
      this.lastErrorAt = Date.now();
      const msg = e?.message ?? String(e);
      console.warn(`[RoboticsER] Plan failed (${this.consecutiveFailures}):`, msg);
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

/** Goals that benefit from ER planning (complex navigation). */
export function shouldUseRoboticsPlanner(toolName: string): boolean {
  return (
    toolName === 'inspect_browser' ||
    toolName === 'walk_toward' ||
    toolName === 'walk'
  );
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
    reasoning: 'Live tool fallback (Robotics-ER unavailable or failed).',
  };
}
