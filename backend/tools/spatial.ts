/**
 * Spatial navigation tools for the embodied avatar.
 * The model sees the 3D scene via Live vision frames, then calls these tools
 * to look, turn, walk, and inspect named anchors (user, browser, home).
 */
import { Type, Behavior, FunctionResponseScheduling } from '@google/genai';
import type WebSocket from 'ws';

export const SPATIAL_TOOL_NAMES = [
  'look_at',
  'turn',
  'walk',
  'walk_toward',
  'stop_moving',
  'inspect_browser',
  'reset_pose',
  // Internal multi-step plan from Robotics-ER (or Live fallback).
  'run_plan',
] as const;

export type SpatialToolName = (typeof SPATIAL_TOOL_NAMES)[number];

export function isSpatialTool(name: string): name is SpatialToolName {
  return (SPATIAL_TOOL_NAMES as readonly string[]).includes(name);
}

const NAMED_TARGETS = ['user', 'browser', 'home', 'left', 'right', 'forward', 'back'] as const;

/** Function declarations merged into the Live session tools list. */
export const spatialToolDeclarations = [
  {
    name: 'look_at',
    description:
      "Look toward a named place in the 3D room (eyes/head). Use when you want to glance at the floating browser, face the user, or look around. " +
      "Does not walk. Prefer this before commenting on what you see on the browser.",
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      required: ['target'],
      properties: {
        target: {
          type: Type.STRING,
          enum: [...NAMED_TARGETS],
          description:
            "'user' = face the camera/user, 'browser' = floating web panel, 'home' = room center, " +
            "'left'/'right'/'forward'/'back' = relative to your current facing.",
        },
        duration: {
          type: Type.NUMBER,
          description: 'Optional seconds to hold the gaze before natural gaze resumes. Default 4.',
        },
      },
    },
  },
  {
    name: 'turn',
    description:
      "Rotate your body in place without walking. Prefer mode=face_target with target=user or browser. " +
      "Avoid guessing degrees; use face_target whenever you know what to face.",
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      required: ['mode'],
      properties: {
        mode: {
          type: Type.STRING,
          enum: ['face_target', 'by_degrees'],
          description: "Prefer 'face_target'. Use 'by_degrees' only for small relative turns.",
        },
        degrees: {
          type: Type.NUMBER,
          description: "For mode=by_degrees only: positive = left, negative = right. |degrees| <= 180.",
        },
        target: {
          type: Type.STRING,
          enum: [...NAMED_TARGETS],
          description: "For mode=face_target: named place to face (user, browser, home, ...).",
        },
      },
    },
  },
  {
    name: 'walk',
    description:
      "Walk forward or back along your current facing (short step). Prefer walk_toward or inspect_browser " +
      "when going to the browser/user. Auto-stops at floor edge.",
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      required: ['direction'],
      properties: {
        direction: {
          type: Type.STRING,
          enum: ['forward', 'back'],
          description: 'Walk forward (your facing) or back.',
        },
        seconds: {
          type: Type.NUMBER,
          description: 'How long to walk, 0.5–4 seconds. Default 2.0.',
        },
      },
    },
  },
  {
    name: 'walk_toward',
    description:
      "Face a named target and walk toward it until close or time runs out. " +
      "Use for 'go to the browser' or 'come closer'. After it finishes, describe what you see if relevant.",
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      required: ['target'],
      properties: {
        target: {
          type: Type.STRING,
          enum: ['user', 'browser', 'home'],
          description: "Where to go: 'browser' floating panel, 'user' camera, 'home' room center.",
        },
        seconds: {
          type: Type.NUMBER,
          description: 'Max walk time 1–5 seconds. Default 2.5.',
        },
      },
    },
  },
  {
    name: 'stop_moving',
    description: 'Immediately stop walking and return to idle stance.',
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'inspect_browser',
    description:
      "BEST tool when the user asks you to look at the browser / page. " +
      "Faces the floating browser, walks closer if needed, looks at the screen. " +
      "When the tool result returns, you MUST speak and describe what you actually see on the page " +
      "(use your vision frames). Do not stay silent after this tool.",
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      properties: {
        seconds: {
          type: Type.NUMBER,
          description: 'Max approach time 1.5–5s. Default 3.5.',
        },
      },
    },
  },
  {
    name: 'reset_pose',
    description: 'Return to the home spot in the center of the room, face the user, idle stance.',
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
];

export type SpatialPending = {
  id: string;
  name: string;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Routes a spatial tool call to the visualizer over WebSocket and tracks
 * pending async results. Call resolvePending when the frontend reports done.
 */
export class SpatialToolBridge {
  private pending = new Map<string, SpatialPending>();
  private readonly timeoutMs: number;

  constructor(
    private getWs: () => WebSocket | undefined,
    private onTimeoutResult: (id: string, name: string, response: Record<string, unknown>) => void,
    timeoutMs = 8000,
  ) {
    this.timeoutMs = timeoutMs;
  }

  /** Dispatch tool to frontend; returns true if async (caller must not reply yet). */
  dispatch(id: string, name: string, args: Record<string, unknown>): boolean {
    const ws = this.getWs();
    if (!ws || ws.readyState !== 1) {
      console.warn('[SPATIAL] WS not ready; cannot dispatch', name);
      return false;
    }

    // Clear any prior pending with same id (shouldn't happen)
    this.clearPending(id);

    const timer = setTimeout(() => {
      if (!this.pending.has(id)) return;
      this.pending.delete(id);
      console.warn(`[SPATIAL] Tool ${name} (${id}) timed out waiting for frontend.`);
      this.onTimeoutResult(id, name, {
        ok: false,
        error: 'timeout',
        message: 'Movement timed out; assume you stayed roughly where you were.',
      });
    }, this.timeoutMs);

    this.pending.set(id, { id, name, timer });

    const payload = {
      type: 'spatialCommand',
      id,
      name,
      args: args ?? {},
    };
    ws.send(JSON.stringify(payload));
    console.log(`[SPATIAL] Dispatched ${name} id=${id}`, JSON.stringify(args ?? {}));
    return true;
  }

  /** Frontend completed a spatial command. Returns the pending entry if matched. */
  resolvePending(id: string): SpatialPending | undefined {
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
}

/** Emotion tools: never interrupt TTS. */
export function silentToolResponse(
  id: string,
  name: string,
  response: Record<string, unknown>,
) {
  return {
    id,
    name,
    response,
    scheduling: FunctionResponseScheduling.SILENT,
  };
}

/**
 * Spatial tools: WHEN_IDLE so after a move finishes the model can speak about
 * what it sees. SILENT left the model silent after inspect_browser (no reply).
 */
export function spatialToolResponse(
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
