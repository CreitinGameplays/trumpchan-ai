/**
 * OpenAI-format tool declarations for the alternative (non-Live) AI backend.
 *
 * The Gemini Live backend declares tools with `@google/genai` `Type.*` enums
 * (which are the strings "OBJECT" / "STRING" / "NUMBER" / ...). The OpenAI
 * Chat Completions API expects standard JSON Schema (lowercase types) wrapped
 * in `{ type: 'function', function: { name, description, parameters } }`.
 *
 * This module re-uses the SAME tool set (emotion + spatial + browser) so the
 * OpenAI backend exposes every capability the Live API version has, just in the
 * format the OpenAI SDK expects.
 */
import { spatialToolDeclarations } from './spatial.js';
import { browserToolDeclarations } from './browser.js';

// VRM native expression presets the avatar can display in real time.
export const VALID_EMOTIONS = ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised'] as const;

/** Gemini-style declaration (subset we actually use). */
type GeminiParamSchema = {
  type?: unknown;
  description?: string;
  enum?: unknown[];
  properties?: Record<string, GeminiParamSchema>;
  required?: string[];
  items?: GeminiParamSchema;
};

type GeminiToolDecl = {
  name: string;
  description?: string;
  behavior?: unknown;
  parameters?: GeminiParamSchema;
};

export type OpenAITool = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

/**
 * `@google/genai` Type enum values are already the JSON-schema words in
 * UPPERCASE ("OBJECT", "STRING", ...). Convert to lowercase for JSON Schema,
 * which is what OpenAI-compatible APIs expect.
 */
function normalizeType(t: unknown): string {
  const s = String(t ?? 'string').toLowerCase();
  // Map any Gemini-specific spellings to JSON-schema types.
  switch (s) {
    case 'object':
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'array':
      return s;
    default:
      return 'string';
  }
}

/** Recursively convert a Gemini parameter schema → JSON Schema. */
function convertSchema(schema?: GeminiParamSchema): Record<string, unknown> {
  if (!schema) return { type: 'object', properties: {} };

  const out: Record<string, unknown> = { type: normalizeType(schema.type) };

  if (schema.description) out.description = schema.description;
  if (Array.isArray(schema.enum)) out.enum = schema.enum;

  if (out.type === 'object') {
    const props: Record<string, unknown> = {};
    const inProps = schema.properties ?? {};
    for (const [k, v] of Object.entries(inProps)) {
      props[k] = convertSchema(v);
    }
    out.properties = props;
    if (Array.isArray(schema.required) && schema.required.length) {
      out.required = schema.required;
    }
  }

  if (out.type === 'array' && schema.items) {
    out.items = convertSchema(schema.items);
  }

  return out;
}

/** Convert a single Gemini tool declaration → OpenAI tool. */
export function toOpenAITool(decl: GeminiToolDecl): OpenAITool {
  return {
    type: 'function',
    function: {
      name: decl.name,
      description: decl.description ?? '',
      parameters: convertSchema(
        decl.parameters ?? { type: 'object', properties: {} },
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Emotion tool (declared inline here in Gemini shape, then converted).
// Mirrors the emotionToolDeclaration in the Live backend so both share behavior.
// ---------------------------------------------------------------------------
const emotionToolGemini: GeminiToolDecl = {
  name: 'set_emotion',
  description:
    "Set the avatar's facial expression in real time to match the emotional tone of what you are saying. " +
    "Call this the instant your mood shifts (cheerful, sad, angry, shocked, calm). " +
    'You can call it multiple times within one reply as your tone changes. This only changes the face; it does not speak.',
  parameters: {
    type: 'OBJECT',
    required: ['emotion', 'duration'],
    properties: {
      emotion: {
        type: 'STRING',
        enum: [...VALID_EMOTIONS],
        description:
          "Emotion preset: 'happy' (joy/excited/playful), 'sad' (sorrow/disappointed), " +
          "'angry' (annoyed/frustrated), 'surprised' (shocked/amazed), " +
          "'relaxed' (calm/cozy/content), 'neutral' (natural resting face).",
      },
      intensity: {
        type: 'NUMBER',
        description: 'Optional strength 0.0–1.0. Defaults to 1.0. Use ~0.5 for a subtle expression.',
      },
      duration: {
        type: 'NUMBER',
        description:
          'Required. Seconds to hold the expression before easing back to neutral. Must be > 0. ' +
          'Short (~2) for quick reactions, larger to sustain a mood.',
      },
    },
  },
};

/**
 * Full OpenAI tool list = emotion + spatial + browser.
 * These are the exact same tools available in the Gemini Live backend.
 */
export function buildOpenAITools(): OpenAITool[] {
  const tools: OpenAITool[] = [];
  tools.push(toOpenAITool(emotionToolGemini));
  for (const d of spatialToolDeclarations as unknown as GeminiToolDecl[]) {
    tools.push(toOpenAITool(d));
  }
  for (const d of browserToolDeclarations as unknown as GeminiToolDecl[]) {
    tools.push(toOpenAITool(d));
  }
  return tools;
}
