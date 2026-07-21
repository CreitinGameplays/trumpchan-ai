/**
 * Agentic click executor: flash-lite sees FPV, decides where to click,
 * executes, verifies with a new FPV, loops until the goal is met.
 *
 * No max-attempt cap — loops until flash-lite says "done" or an unrecoverable
 * error occurs (offline, page crash, etc.).
 */
import { GoogleGenerativeAI } from '@google/generative-ai';

const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const DEFAULT_BASE_URL = 'https://aihub.071129.xyz';

export interface ClickAttempt {
  x: number;
  y: number;
  reasoning: string;
  result?: {
    ok: boolean;
    hit?: string;
    page?: { x: number; y: number };
    error?: string;
  };
}

export interface ClickAgentResult {
  ok: boolean;
  done: boolean;
  goal: string;
  attempts: ClickAttempt[];
  totalMs: number;
  finalReasoning?: string;
  error?: string;
}

const CLICK_PROMPT = `You are a precise UI click agent. You see a FIRST-PERSON screenshot of a 3D scene with a floating browser panel. Yellow rulers show x,y coordinates 0–1 ((0,0)=top-left, (1,1)=bottom-right).

Your job: determine the EXACT x,y (0–1, 2 decimals) to click to achieve the user's goal, OR declare the goal is already done.

Return ONLY valid JSON (no markdown):
{
  "status": "click" | "done" | "need_approach",
  "reasoning": "one short sentence",
  "x": 0.42,
  "y": 0.61
}

- "click": you identified the target → output x,y to click it.
- "done": the goal is already achieved (e.g. page changed, button activated, expected result visible).
- "need_approach": the browser panel is too small/far to identify the target. The system will run inspect_browser automatically.

Rules:
1. Read the yellow rulers carefully. Estimate x,y at the CENTER of the target control.
2. If you already clicked and the page changed (new content visible), consider if the goal is met → "done".
3. If the target is not visible or you cannot identify it, say "done" with reasoning explaining why.
4. Never guess blindly — if the panel is too small, say "need_approach".
5. Use 2 decimal places (e.g. 0.35, 0.72).
`;

const VERIFY_PROMPT = `You are verifying whether a click action succeeded.

Previous goal: "{goal}"
Previous click: x={prevX}, y={prevY}
Previous reasoning: "{prevReason}"

Look at this NEW screenshot taken AFTER the click. Did the goal succeed?

Return ONLY valid JSON:
{
  "status": "done" | "retry",
  "reasoning": "one short sentence",
  "x": 0.42,
  "y": 0.61
}

- "done": the click achieved the goal (page changed, button activated, menu opened, etc.)
- "retry": the click missed or didn't work → provide new x,y to try again.

Rules:
1. Compare this frame to what was expected. If UI changed in the expected way → "done".
2. If the same state persists → "retry" with corrected coordinates.
3. If the target is gone (navigated away, popup appeared), evaluate if the goal was achieved.
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

export class ClickAgent {
  private model: ReturnType<GoogleGenerativeAI['getGenerativeModel']> | null = null;
  private enabled = false;

  constructor() {
    const key =
      process.env.XINJIANYA_KEY ||
      process.env.VISION_PLANNER_API_KEY ||
      process.env.GEMINI_API_KEY ||
      '';
    const baseUrl =
      process.env.VISION_PLANNER_BASE_URL ||
      process.env.XINJIANYA_BASE_URL ||
      DEFAULT_BASE_URL;
    const modelId =
      process.env.CLICK_AGENT_MODEL ||
      process.env.VISION_PLANNER_MODEL ||
      DEFAULT_MODEL;

    this.enabled = Boolean(key);
    if (!this.enabled) {
      console.warn('[ClickAgent] No API key; disabled.');
      return;
    }

    try {
      const genAI = new GoogleGenerativeAI(key);
      this.model = genAI.getGenerativeModel(
        { model: modelId },
        baseUrl ? { baseUrl } : (undefined as any),
      );
      console.log(`[ClickAgent] Ready model=${modelId}`);
    } catch (e) {
      console.error('[ClickAgent] Init failed:', e);
      this.enabled = false;
    }
  }

  isAvailable(): boolean {
    return this.enabled && this.model != null;
  }

  /**
   * Ask flash-lite where to click (or if done) given an FPV JPEG.
   */
  async planClick(params: {
    jpegBase64: string;
    goal: string;
    attemptHistory?: ClickAttempt[];
  }): Promise<{ status: 'click' | 'done' | 'need_approach'; x?: number; y?: number; reasoning: string }> {
    if (!this.model) throw new Error('click_agent_unavailable');

    const historyCtx = params.attemptHistory?.length
      ? `\nPrevious attempts (${params.attemptHistory.length}):\n` +
        params.attemptHistory
          .map((a, i) => `  ${i + 1}. x=${a.x} y=${a.y} → ${a.result?.ok ? 'hit ' + a.result.hit : 'miss'} (${a.reasoning})`)
          .join('\n')
      : '';

    const result = await this.model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: params.jpegBase64 } },
            { text: `${CLICK_PROMPT}\n\nGoal: ${params.goal}${historyCtx}` },
          ],
        },
      ],
      generationConfig: { temperature: 0.15, maxOutputTokens: 256 },
    });

    const text = result.response?.text?.() ?? '';
    const parsed = JSON.parse(stripJsonFence(text));
    return {
      status: parsed.status || 'done',
      x: parsed.x != null ? Math.max(0, Math.min(1, Number(parsed.x))) : undefined,
      y: parsed.y != null ? Math.max(0, Math.min(1, Number(parsed.y))) : undefined,
      reasoning: String(parsed.reasoning || '').slice(0, 300),
    };
  }

  /**
   * Ask flash-lite to verify if the click succeeded given a POST-click FPV.
   */
  async verifyClick(params: {
    jpegBase64: string;
    goal: string;
    prevX: number;
    prevY: number;
    prevReason: string;
  }): Promise<{ status: 'done' | 'retry'; x?: number; y?: number; reasoning: string }> {
    if (!this.model) throw new Error('click_agent_unavailable');

    const prompt = VERIFY_PROMPT
      .replace('{goal}', params.goal)
      .replace('{prevX}', params.prevX.toFixed(2))
      .replace('{prevY}', params.prevY.toFixed(2))
      .replace('{prevReason}', params.prevReason);

    const result = await this.model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: params.jpegBase64 } },
            { text: prompt },
          ],
        },
      ],
      generationConfig: { temperature: 0.15, maxOutputTokens: 256 },
    });

    const text = result.response?.text?.() ?? '';
    const parsed = JSON.parse(stripJsonFence(text));
    return {
      status: parsed.status === 'retry' ? 'retry' : 'done',
      x: parsed.x != null ? Math.max(0, Math.min(1, Number(parsed.x))) : undefined,
      y: parsed.y != null ? Math.max(0, Math.min(1, Number(parsed.y))) : undefined,
      reasoning: String(parsed.reasoning || '').slice(0, 300),
    };
  }
}
