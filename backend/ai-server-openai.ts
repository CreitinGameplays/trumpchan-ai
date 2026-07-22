/**
 * Alternative AI backend — OpenAI SDK (Chat Completions) + any multimodal/omni model
 * instead of the Gemini Live API.
 *
 * Provider + model are fully swappable via env (any OpenAI-compatible endpoint):
 *   • OPENAI_BASE_URL / CUSTOM_OPENAI_BASE_URL  — default https://ai.dext.top/v1
 *   • OPENAI_MODEL / CUSTOM_OPENAI_MODEL        — default step-3.7-flash
 *   • CUSTOM_OPENAI_KEY / OPENAI_API_KEY        — API key for that provider
 * Examples: OpenAI (gpt-4o, gpt-4.1, o4-mini), StepFun (step-3.7-flash),
 * OpenRouter, local vLLM/Ollama openai-compat proxies, etc. Prefer models that
 * accept image_url (+ tools) so FPV vision and spatial/browser tools work.
 *
 * WHY: Gemini Live gives native streaming audio + always-on video. A plain
 * OpenAI-compatible multimodal model does NOT have a "live" mode, so this
 * backend REPLICATES the live behavior with conventional pieces:
 *
 *   • Vision (replaces continuous video): the newest avatar FPV JPEG is cached
 *     and attached as an `image_url` (base64) on each user turn + fed back into
 *     the tool loop so the model always reasons over the CURRENT frame. This is
 *     "live vision" sampled per request instead of a video stream.
 *   • Audio (replaces native TTS): the model streams TEXT; we synthesize speech
 *     sentence-by-sentence via Fish Audio (s2.1-pro-free) as 24 kHz PCM →
 *     frontend `audio` messages directly (no voice changer). Captions stream live.
 *   • Tools: the SAME emotion / spatial / browser tools as the Live backend,
 *     converted to OpenAI `tools` format, run in an agentic multi-step loop.
 *   • Steering: user messages arriving mid-turn are queued/coalesced, identical
 *     UX to the Live backend.
 *
 * Switch backends: package.json `dev:ai:openai` / `dev:electron:openai`.
 * The Gemini Live backend (backend/ai-server.ts) is left fully intact.
 */
import OpenAI from 'openai';
import * as fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import WebSocket from 'ws';
import {
    isSpatialTool,
    SpatialToolBridge,
} from './tools/spatial.js';
import {
    isBrowserTool,
    BrowserToolBridge,
} from './tools/browser.js';
import { buildOpenAITools, VALID_EMOTIONS } from './tools/openai-tools.js';
import { FishTTS } from './fish-tts.js';

dotenv.config();

// ---------------------------------------------------------------------------
// Config — fully env-driven so any OpenAI-compatible provider/model works.
// Defaults: step-3.7-flash @ https://ai.dext.top/v1 (override freely).
// ---------------------------------------------------------------------------
const API_KEY =
    process.env.CUSTOM_OPENAI_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.STEP_API_KEY ||
    '';
if (!API_KEY) {
    console.error(
        'Critical Error: set CUSTOM_OPENAI_KEY or OPENAI_API_KEY in .env ' +
            '(key for your OpenAI-compatible provider).',
    );
    process.exit(1);
}
/** Base URL must be OpenAI-compatible (…/v1). Trailing slashes stripped. */
function normalizeBaseUrl(raw: string): string {
    let u = String(raw || '').trim().replace(/\/+$/, '');
    if (!u) u = 'https://ai.dext.top/v1';
    return u;
}
const BASE_URL = normalizeBaseUrl(
    process.env.OPENAI_BASE_URL ||
        process.env.CUSTOM_OPENAI_BASE_URL ||
        process.env.OPENAI_API_BASE ||
        'https://ai.dext.top/v1',
);
/** Multimodal / omni model id as the provider exposes it (not hardcoded beyond default). */
const MODEL = (
    process.env.OPENAI_MODEL ||
    process.env.CUSTOM_OPENAI_MODEL ||
    process.env.CHAT_MODEL ||
    'step-3.7-flash'
).trim();
/**
 * Optional reasoning_effort (StepFun / some reasoning models).
 * Set OPENAI_REASONING_EFFORT=low|medium|high, or empty / "off" to omit
 * (recommended for plain OpenAI gpt-4o / non-reasoning models).
 */
const REASONING_EFFORT_RAW = (process.env.OPENAI_REASONING_EFFORT ?? 'low').trim().toLowerCase();
const REASONING_EFFORT =
    !REASONING_EFFORT_RAW ||
    REASONING_EFFORT_RAW === '0' ||
    REASONING_EFFORT_RAW === 'off' ||
    REASONING_EFFORT_RAW === 'none' ||
    REASONING_EFFORT_RAW === 'false'
        ? ''
        : REASONING_EFFORT_RAW;
const MAX_HISTORY_TURNS = Number(process.env.OPENAI_MAX_HISTORY_TURNS) || 12;

// TTS config (Fish Audio — no voice changer; PCM24k goes straight to frontend).
const TTS_ENABLED = process.env.TTS_ENABLED !== '0' && process.env.FISH_TTS_ENABLED !== '0';
const FISH_KEY = process.env.FISHAUDIO_KEY || process.env.FISH_API_KEY || '';
const FISH_MODEL = process.env.FISH_TTS_MODEL || 's2.1-pro-free';
const FISH_VOICE = process.env.FISH_TTS_REFERENCE_ID || process.env.FISH_VOICE_ID || '';
const FISH_LATENCY = (process.env.FISH_TTS_LATENCY || 'balanced') as 'balanced' | 'normal' | 'low';

const MEMORY_DIR = path.resolve('memory');
const HISTORY_FILE = path.join(MEMORY_DIR, 'history.json');
if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// OpenAI client + tools
// ---------------------------------------------------------------------------
const client = new OpenAI({ apiKey: API_KEY, baseURL: BASE_URL });
const openaiTools = buildOpenAITools();
let systemInstruction =
    'You are a friendly VTuber named Trumpchan. Keep your responses engaging, short, and conversational.';

let aiWsClient: WebSocket | undefined = undefined;

// ---------------------------------------------------------------------------
// Vision: cache the newest FPV frame; attach it to each request (per-turn "live").
// ---------------------------------------------------------------------------
let lastVisionJpeg: string | null = null; // base64, no data: prefix
let lastVisionMime = 'image/jpeg';
let lastVisionMeta = { width: 0, height: 0, ts: 0, seq: 0 };
let visionRecvCount = 0;

function ingestVisionFrame(frame: {
    data: string;
    mimeType: string;
    width: number;
    height: number;
    ts: number;
    seq: number;
}) {
    if (!frame.data) return;
    const prevSeq = lastVisionMeta.seq || 0;
    const prevTs = lastVisionMeta.ts || 0;
    if (frame.seq > 0 && prevSeq > 0 && frame.seq < prevSeq) return;
    if (frame.ts > 0 && prevTs > 0 && frame.ts < prevTs - 250) return;

    visionRecvCount++;
    lastVisionJpeg = frame.data;
    lastVisionMime = frame.mimeType || 'image/jpeg';
    lastVisionMeta = {
        width: frame.width || 0,
        height: frame.height || 0,
        ts: frame.ts || Date.now(),
        seq: frame.seq || visionRecvCount,
    };
}

/** Build an OpenAI image content part from the newest FPV frame (or null). */
function currentVisionPart(): any | null {
    if (!lastVisionJpeg) return null;
    const mime = lastVisionMime || 'image/jpeg';
    return {
        type: 'image_url',
        image_url: {
            url: `data:${mime};base64,${lastVisionJpeg}`,
            detail: 'high',
        },
    };
}

// ---------------------------------------------------------------------------
// Fish Audio TTS. Model text → Fish Audio → 24 kHz PCM → frontend `audio`.
// No voice changer (that is Gemini-Live only); PCM goes straight to the client.
// ---------------------------------------------------------------------------
const tts = new FishTTS(
    {
        apiKey: FISH_KEY,
        model: FISH_MODEL,
        referenceId: FISH_VOICE || undefined,
        latency: FISH_LATENCY,
        enabled: TTS_ENABLED,
    },
    (pcm: Buffer) => {
        if (aiWsClient && aiWsClient.readyState === WebSocket.OPEN) {
            aiWsClient.send(JSON.stringify({ type: 'audio', data: pcm.toString('base64') }));
        }
    },
);

// ---------------------------------------------------------------------------
// Conversation history (kept in-process for context; persisted to memory file).
// ---------------------------------------------------------------------------
type ChatMsg = OpenAI.Chat.Completions.ChatCompletionMessageParam;
const convo: ChatMsg[] = [];

async function loadHistoryFile(): Promise<any[]> {
    try {
        if (existsSync(HISTORY_FILE)) return JSON.parse(await fs.readFile(HISTORY_FILE, 'utf-8'));
    } catch (e) {
        console.error('Error loading history:', e);
    }
    return [];
}
async function appendHistoryFile(entry: any) {
    try {
        const h = await loadHistoryFile();
        h.push({ ...entry, timestamp: new Date().toISOString() });
        await fs.writeFile(HISTORY_FILE, JSON.stringify(h, null, 2), 'utf-8');
    } catch (e) {
        console.error('Error saving history:', e);
    }
}

/** Trim convo to the last N turns (keep pairs roughly), preserving tool chains. */
function trimConvo() {
    // Count user turns; drop oldest complete turns beyond the window.
    const maxMsgs = MAX_HISTORY_TURNS * 4; // rough: user+assistant+tool calls
    while (convo.length > maxMsgs) convo.shift();
}

// ---------------------------------------------------------------------------
// Emotion tool (frontend expression control).
// ---------------------------------------------------------------------------
function handleSetEmotion(args: any): Record<string, unknown> {
    const rawEmotion = String(args?.emotion ?? '').toLowerCase().trim();
    const emotion = (VALID_EMOTIONS as readonly string[]).includes(rawEmotion) ? rawEmotion : 'neutral';
    let intensity = Number(args?.intensity);
    if (!Number.isFinite(intensity)) intensity = 1.0;
    intensity = Math.max(0, Math.min(1, intensity));
    let duration = Number(args?.duration);
    if (!Number.isFinite(duration) || duration <= 0) duration = 2;

    if (aiWsClient && aiWsClient.readyState === WebSocket.OPEN) {
        aiWsClient.send(JSON.stringify({ type: 'emotion', emotion, intensity, duration }));
        console.log(`[AI-TOOL] Emotion "${emotion}" (i=${intensity}, d=${duration}s).`);
    }
    return { ok: true, emotion, intensity, duration };
}

// ---------------------------------------------------------------------------
// Tool bridges → frontend visualizer (identical protocol to the Live backend).
// Each dispatch resolves through a Promise so the agentic loop can await results.
// ---------------------------------------------------------------------------
const pendingToolResolvers = new Map<string, (result: Record<string, unknown>) => void>();

const spatialBridge = new SpatialToolBridge(
    () => aiWsClient,
    (id, _name, response) => resolvePendingTool(id, response),
);
const browserBridge = new BrowserToolBridge(
    () => aiWsClient,
    (id, _name, response) => resolvePendingTool(id, response),
);

function resolvePendingTool(id: string, response: Record<string, unknown>) {
    const r = pendingToolResolvers.get(id);
    if (r) {
        pendingToolResolvers.delete(id);
        r(response);
    }
}

/** Sanitize tool result payloads before feeding back to the model (facts only). */
function sanitizeToolResult(response: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...response };
    delete out.cropData;
    delete out.jpeg;
    delete out.data;
    delete out.instruction;
    delete out.reobserve;
    delete out.prefer;
    delete out.hint;
    delete out.message;
    if (out.error != null && typeof out.error !== 'string') out.error = String(out.error);
    if (typeof out.error === 'string' && out.error.length > 120) out.error = out.error.slice(0, 120);
    if (Array.isArray(out.elements) && out.elements.length > 24) {
        out.elements = out.elements.slice(0, 24).map((el: any) => ({
            ref: el?.ref, role: el?.role, name: el?.name || el?.label,
            x: el?.x, y: el?.y, w: el?.w, h: el?.h,
        }));
    }
    if (typeof out.text === 'string' && out.text.length > 4000) out.text = out.text.slice(0, 4000);
    if (typeof out.axTree === 'string' && out.axTree.length > 3000) out.axTree = out.axTree.slice(0, 3000);
    return out;
}

/** Normalize view_click args (pixels→0-1, button aliases) like the Live backend. */
function normalizeSpatialArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
    const a = { ...args };
    if (name === 'view_click' || name === 'view_look' || name === 'view_go') {
        if (a.x != null) {
            let x = Number(a.x);
            if (Number.isFinite(x) && x > 1.5) x = x / 1920;
            if (Number.isFinite(x)) a.x = Math.max(0, Math.min(1, x));
        }
        if (a.y != null) {
            let y = Number(a.y);
            if (Number.isFinite(y) && y > 1.5) y = y / 1080;
            if (Number.isFinite(y)) a.y = Math.max(0, Math.min(1, y));
        }
    }
    if (name === 'view_click') {
        const b = String(a.button || 'left').toLowerCase().trim();
        a.button =
            b === 'right' || b === 'context' || b === 'contextmenu' || b === 'secondary' || b === '2'
                ? 'right'
                : b === 'middle' || b === 'aux' || b === 'auxiliary' || b === '1'
                  ? 'middle'
                  : 'left';
        if (a.button !== 'left') a.clickCount = 1;
    }
    return a;
}

const TOOL_TIMEOUT_MS = 60000;

/** Dispatch a spatial/browser tool to the frontend and await its result. */
function dispatchToolAndWait(
    kind: 'spatial' | 'browser',
    id: string,
    name: string,
    args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
        let settled = false;
        const done = (r: Record<string, unknown>) => {
            if (settled) return;
            settled = true;
            resolve(r);
        };
        pendingToolResolvers.set(id, done);

        // Wrap as a single-step run_plan so the frontend's existing executor handles it.
        const bridge = kind === 'spatial' ? spatialBridge : browserBridge;
        const ok = bridge.dispatch(id, 'run_plan', {
            steps: [{ name, args }],
            originalName: name,
            planner: 'openai',
        });
        if (!ok) {
            pendingToolResolvers.delete(id);
            done({ ok: false, error: 'visualizer_offline' });
            return;
        }
        // Safety timeout (bridge also has its own timeout → onTimeoutResult).
        setTimeout(() => done({ ok: false, error: 'timeout' }), TOOL_TIMEOUT_MS + 2000);
    });
}

/** use_browser: expand a free-text goal to a concrete first step (Live-style). */
function browserGoalToSteps(goal: string): Array<{ name: string; args: Record<string, unknown> }> {
    const g = String(goal || '').trim();
    if (/^https?:\/\//i.test(g) || /^[^\s]+\.[^\s]+$/.test(g)) {
        return [{ name: 'browser_navigate', args: { url: g } }];
    }
    if (g && /\b(type|click|press|enter|scroll|select|check|uncheck|toggle|dismiss|close|fill|send|submit|tap|hover)\b/i.test(g)) {
        return [{ name: 'browser_snapshot', args: { includeElements: true } }];
    }
    if (g) {
        return [
            { name: 'browser_navigate', args: { query: g } },
            { name: 'browser_snapshot', args: { includeElements: true } },
        ];
    }
    return [{ name: 'browser_snapshot', args: {} }];
}

/**
 * Execute one tool call and return a JSON-string result for the tool message.
 * Emotion runs locally; spatial/browser dispatch to the frontend and await.
 */
async function executeToolCall(name: string, rawArgs: any, callId: string): Promise<string> {
    let args: Record<string, unknown> = {};
    try {
        args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs || {};
    } catch {
        args = {};
    }

    if (name === 'set_emotion') {
        return JSON.stringify(handleSetEmotion(args));
    }

    if (name === 'browser_click' || name === 'browser_dblclick') {
        return JSON.stringify({ ok: false, error: 'deprecated_use_view_click' });
    }

    if (isSpatialTool(name)) {
        const a = normalizeSpatialArgs(name, args);
        const res = await dispatchToolAndWait('spatial', callId, name, a);
        return JSON.stringify(sanitizeToolResult(res));
    }

    if (isBrowserTool(name) || name === 'use_browser') {
        if (name === 'use_browser') {
            // Run each expanded step; return the last result.
            const steps = browserGoalToSteps(String(args.goal || ''));
            let last: Record<string, unknown> = { ok: true };
            for (let i = 0; i < steps.length; i++) {
                const s = steps[i];
                last = await dispatchToolAndWait('browser', `${callId}_${i}`, s.name, s.args);
            }
            return JSON.stringify(sanitizeToolResult(last));
        }
        const res = await dispatchToolAndWait('browser', callId, name, args);
        return JSON.stringify(sanitizeToolResult(res));
    }

    return JSON.stringify({ ok: false, error: 'unknown_tool' });
}

// ---------------------------------------------------------------------------
// Turn runner: stream text (+ speak), run tool loop until the model stops.
// This is the "live" replacement — one call per user turn, vision attached,
// tools executed, audio synthesized from streamed text.
// ---------------------------------------------------------------------------
let turnActive = false;
let currentCaption = '';

function sendCaption(text: string) {
    if (aiWsClient && aiWsClient.readyState === WebSocket.OPEN) {
        aiWsClient.send(JSON.stringify({ type: 'caption', text }));
    }
}

/** Build the messages array for one model call: system + trimmed convo. */
function buildMessages(): ChatMsg[] {
    return [{ role: 'system', content: systemInstruction }, ...convo];
}

/** Attach the newest FPV frame to the latest user message (multimodal turn). */
function attachVisionToLastUser() {
    for (let i = convo.length - 1; i >= 0; i--) {
        const m = convo[i] as any;
        if (m.role === 'user') {
            const visionPart = currentVisionPart();
            if (!visionPart) return;
            let textContent = '';
            if (typeof m.content === 'string') {
                textContent = m.content;
            } else if (Array.isArray(m.content)) {
                // Already multimodal — keep first text part, replace image.
                const textPart = m.content.find((p: any) => p?.type === 'text');
                textContent = textPart?.text || '';
            }
            m.content = [
                { type: 'text', text: textContent || '(look at the current view)' },
                visionPart,
            ];
            return;
        }
    }
}

/** Stable ids so assistant.tool_calls[i].id === tool.tool_call_id for every result. */
function ensureToolCallIds(
    calls: Array<{ id: string; name: string; args: string }>,
): Array<{ id: string; name: string; args: string }> {
    const stamp = Date.now();
    return calls.map((t, i) => ({
        id: t.id && String(t.id).trim() ? String(t.id) : `call_${stamp}_${i}`,
        name: t.name,
        args: t.args && t.args.trim() ? t.args : '{}',
    }));
}

async function runTurn(reason: string) {
    if (turnActive) {
        console.log(`[TURN] Already active; skip (${reason}).`);
        return;
    }
    turnActive = true;
    currentCaption = '';
    sendCaption('');
    tts.reset();

    console.log(`[TURN] Start (${reason}) (no max tool-round cap)`);

    try {
        // Attach current vision to the newest user message (per-turn live vision).
        attachVisionToLastUser();

        let round = 0;
        let emptyAfterToolsNudges = 0;
        while (true) {
            round += 1;
            trimConvo();
            const messages = buildMessages();
            console.log(
                `[TURN] Round ${round} messages=${messages.length} ` +
                    `tools=${openaiTools.length} vision=${Boolean(lastVisionJpeg)}`,
            );

            let stream: any;
            try {
                stream = await client.chat.completions.create({
                    model: MODEL,
                    stream: true,
                    messages,
                    tools: openaiTools,
                    tool_choice: 'auto',
                    // step-3.7-flash reasoning effort (ignored by models that don't support it).
                    ...(REASONING_EFFORT ? { reasoning_effort: REASONING_EFFORT as any } : {}),
                } as any);
            } catch (e: any) {
                // Non-stream fallback if streaming tool-calls fail on the proxy.
                console.warn(
                    `[TURN] Stream create failed round ${round}: ${e?.message ?? e}; retry non-stream`,
                );
                const completion = await client.chat.completions.create({
                    model: MODEL,
                    stream: false,
                    messages,
                    tools: openaiTools,
                    tool_choice: 'auto',
                    ...(REASONING_EFFORT ? { reasoning_effort: REASONING_EFFORT as any } : {}),
                } as any);
                const choice = completion.choices?.[0];
                const msg = choice?.message as any;
                const assistantText = String(msg?.content || '');
                const rawCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
                const validToolCalls = ensureToolCallIds(
                    rawCalls
                        .filter((tc: any) => tc?.function?.name)
                        .map((tc: any) => ({
                            id: String(tc.id || ''),
                            name: String(tc.function.name),
                            args: String(tc.function.arguments || '{}'),
                        })),
                );
                const finishReason = choice?.finish_reason ?? null;
                console.log(
                    `[TURN] Round ${round} (non-stream) finish=${finishReason} ` +
                        `textLen=${assistantText.length} tools=${validToolCalls.map((t) => t.name).join(',') || 'none'}`,
                );

                const cont = await settleRound(
                    assistantText,
                    validToolCalls,
                    finishReason,
                    round,
                    { emptyAfterToolsNudges, onEmptyNudge: () => { emptyAfterToolsNudges += 1; } },
                );
                if (!cont) break;
                continue;
            }

            let assistantText = '';
            // Use a dense map by index — stream indices are not always 0..n contiguous.
            const toolCallMap = new Map<number, { id: string; name: string; args: string }>();
            let finishReason: string | null = null;

            for await (const chunk of stream as any) {
                const choice = chunk.choices?.[0];
                if (!choice) continue;
                const delta = choice.delta || {};

                // Streamed visible text → caption + TTS (only speak real dialogue text).
                if (typeof delta.content === 'string' && delta.content) {
                    assistantText += delta.content;
                    currentCaption += delta.content;
                    sendCaption(currentCaption);
                    tts.pushDelta(delta.content);
                }

                // Some reasoning proxies put visible text here (ignore for speech; log length only).
                if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
                    // no TTS — thinking is internal
                }

                // Streamed tool calls (assembled incrementally by index).
                if (Array.isArray(delta.tool_calls)) {
                    for (const tc of delta.tool_calls) {
                        const idx = Number.isFinite(tc.index) ? Number(tc.index) : 0;
                        let entry = toolCallMap.get(idx);
                        if (!entry) {
                            entry = { id: '', name: '', args: '' };
                            toolCallMap.set(idx, entry);
                        }
                        if (tc.id) entry.id = String(tc.id);
                        if (tc.function?.name) entry.name += String(tc.function.name);
                        if (tc.function?.arguments) entry.args += String(tc.function.arguments);
                    }
                }

                if (choice.finish_reason) finishReason = choice.finish_reason;
            }

            // Sort by index so order matches the model's planned call sequence.
            const rawList = [...toolCallMap.entries()]
                .sort((a, b) => a[0] - b[0])
                .map(([, v]) => v)
                .filter((t) => t && t.name);
            const validToolCalls = ensureToolCallIds(rawList);

            console.log(
                `[TURN] Round ${round} finish=${finishReason} ` +
                    `textLen=${assistantText.length} tools=${validToolCalls.map((t) => t.name).join(',') || 'none'}`,
            );

            const cont = await settleRound(
                assistantText,
                validToolCalls,
                finishReason,
                round,
                { emptyAfterToolsNudges, onEmptyNudge: () => { emptyAfterToolsNudges += 1; } },
            );
            if (!cont) break;
        }
    } catch (e: any) {
        console.error('[TURN] Error:', e?.message ?? e);
        if (e?.stack) console.error(e.stack.split('\n').slice(0, 6).join('\n'));
        // If the model died mid-tool, still try to speak a short fallback only when empty.
        if (!currentCaption.trim()) {
            sendCaption('');
        }
    } finally {
        turnActive = false;
        // Hold caption briefly then clear.
        setTimeout(() => {
            if (!turnActive) sendCaption('');
        }, 3000);
        flushSteerQueue('turn-complete');
        console.log(`[TURN] End (${reason})`);
    }
}

/**
 * Apply one assistant round: either execute tools and return true (loop again),
 * or finalize text and return false (stop the turn).
 */
async function settleRound(
    assistantText: string,
    validToolCalls: Array<{ id: string; name: string; args: string }>,
    finishReason: string | null,
    round: number,
    opts: { emptyAfterToolsNudges: number; onEmptyNudge: () => void } = {
        emptyAfterToolsNudges: 0,
        onEmptyNudge: () => {},
    },
): Promise<boolean> {
    if (validToolCalls.length > 0) {
        // Assistant message MUST list tool_calls; empty string content is safer than null
        // for many OpenAI-compatible proxies (incl. aihub / step).
        convo.push({
            role: 'assistant',
            content: assistantText.trim() ? assistantText : '',
            tool_calls: validToolCalls.map((t) => ({
                id: t.id,
                type: 'function' as const,
                function: { name: t.name, arguments: t.args || '{}' },
            })),
        } as any);

        // Execute every tool with THE SAME id, then append role:tool results in order.
        notifyToolsBusy(true);
        for (const t of validToolCalls) {
            console.log(`[AI-TOOL] ${t.name} id=${t.id} args: ${t.args?.slice(0, 200)}`);
            let resultStr: string;
            try {
                resultStr = await executeToolCall(t.name, t.args, t.id);
            } catch (e: any) {
                resultStr = JSON.stringify({ ok: false, error: String(e?.message ?? e) });
            }
            console.log(`[AI-TOOL] ${t.name} result: ${resultStr.slice(0, 180)}`);
            convo.push({
                role: 'tool',
                tool_call_id: t.id,
                content: resultStr,
            } as any);
        }
        notifyToolsBusy(false);

        // After tools, continue the loop so the model can speak / call more tools.
        // No max round cap — stop only when the model returns speech with no tools.
        console.log(
            `[TURN] Round ${round} tools done → continue (finish was ${finishReason})`,
        );
        return true;
    }

    // No tool calls → final text answer for this turn.
    if (assistantText.trim()) {
        convo.push({ role: 'assistant', content: assistantText });
        tts.flush();
        console.log(`[AI]: ${assistantText.trim().slice(0, 200)}`);
        appendHistoryFile({ role: 'model', text: assistantText.trim() });
        return false;
    }

    // Empty response after tools (model sometimes returns nothing). Nudge once so we
    // don't hang forever if it keeps returning empty.
    const lastIsTool = convo.length > 0 && (convo[convo.length - 1] as any).role === 'tool';
    if (lastIsTool && opts.emptyAfterToolsNudges < 1) {
        opts.onEmptyNudge();
        console.warn('[TURN] Empty reply after tools; nudging model to continue speaking.');
        convo.push({
            role: 'user',
            content:
                '[System] Tool results are ready. Continue the conversation out loud now ' +
                '(brief spoken reply to the user). Do not re-run the same tool unless needed.',
        } as any);
        return true;
    }

    console.warn(`[TURN] Round ${round} produced no text and no tools; stopping.`);
    return false;
}

function notifyToolsBusy(busy: boolean) {
    if (aiWsClient && aiWsClient.readyState === WebSocket.OPEN) {
        aiWsClient.send(JSON.stringify({ type: 'steerStatus', kind: busy ? 'tools_busy' : 'tools_idle' }));
    }
}

// ---------------------------------------------------------------------------
// Steering: queue user messages that arrive mid-turn; flush when idle.
// (Mirrors the Live backend UX without a persistent socket.)
// ---------------------------------------------------------------------------
const steerQueue: string[] = [];
const recentUserNorms: { norm: string; at: number }[] = [];
const DEDUPE_WINDOW_MS = 8000;
const MAX_STEER_QUEUE = 6;

function normalizeUserText(t: string): string {
    return String(t || '').trim().replace(/\s+/g, ' ').toLowerCase();
}
function isDuplicate(norm: string): boolean {
    if (!norm) return true;
    const now = Date.now();
    while (recentUserNorms.length && now - recentUserNorms[0].at > DEDUPE_WINDOW_MS) recentUserNorms.shift();
    if (recentUserNorms.some((e) => e.norm === norm)) return true;
    if (steerQueue.some((q) => normalizeUserText(q) === norm)) return true;
    return false;
}
function rememberUser(norm: string) {
    recentUserNorms.push({ norm, at: Date.now() });
    if (recentUserNorms.length > 24) recentUserNorms.shift();
}

function acceptUserChat(rawText: string) {
    const text = String(rawText || '').trim();
    if (!text) return;
    const norm = normalizeUserText(text);
    if (isDuplicate(norm)) {
        console.log(`[STEER] Duplicate dropped: "${text.slice(0, 60)}"`);
        return;
    }
    rememberUser(norm);
    appendHistoryFile({ role: 'user', text });

    if (turnActive) {
        // Queue as steer; flush after the current turn completes.
        while (steerQueue.length >= MAX_STEER_QUEUE) steerQueue.shift();
        steerQueue.push(text);
        console.log(`[STEER] Queued (${steerQueue.length}) while turn active: "${text.slice(0, 60)}"`);
        notifySteer('queued', text);
        return;
    }

    convo.push({ role: 'user', content: text });
    notifySteer('sent', text);
    runTurn('user-chat');
}

function flushSteerQueue(reason: string) {
    if (steerQueue.length === 0 || turnActive) return;
    const batch = steerQueue.splice(0, steerQueue.length);
    const combined = batch.length === 1 ? batch[0] : batch.map((t, i) => `(${i + 1}) ${t}`).join('\n');
    convo.push({ role: 'user', content: combined });
    console.log(`[STEER] Flushed ${batch.length} msg(s) after ${reason}.`);
    notifySteer('flushed', combined);
    runTurn('steer-flush');
}

function notifySteer(kind: string, text: string) {
    if (aiWsClient && aiWsClient.readyState === WebSocket.OPEN) {
        aiWsClient.send(JSON.stringify({
            type: 'steerStatus', kind, queueLen: steerQueue.length,
            toolsInFlight: false, modelTurnActive: turnActive, textPreview: text.slice(0, 120),
        }));
    }
}

// ---------------------------------------------------------------------------
// WebSocket hub connection (same protocol as the Live backend).
// ---------------------------------------------------------------------------
async function startServer() {
    console.log(
        `Starting OpenAI-compatible AI backend ` +
            `(model=${MODEL}, base=${BASE_URL}` +
            `${REASONING_EFFORT ? `, reasoning_effort=${REASONING_EFFORT}` : ''})...`,
    );
    console.log(
        '[AI] Switch model: OPENAI_MODEL / CUSTOM_OPENAI_MODEL. ' +
            'Switch provider: OPENAI_BASE_URL / CUSTOM_OPENAI_BASE_URL (any OpenAI-compatible /v1).',
    );
    console.log(`[TTS] Fish Audio ${TTS_ENABLED ? `enabled (model=${FISH_MODEL})` : 'disabled'}.`);

    try {
        systemInstruction = await fs.readFile('./SYSTEM.txt', 'utf-8');
    } catch {
        console.log('SYSTEM.txt not found; using default instructions.');
    }

    aiWsClient = new WebSocket('ws://localhost:3000');

    aiWsClient.on('open', () => {
        console.log('Connected to Main API WebSockets');
    });

    aiWsClient.on('message', async (data) => {
        let cmd: any;
        try {
            cmd = JSON.parse(data.toString());
        } catch {
            return;
        }
        try {
            if (cmd.type === 'chatMessage' && cmd.text) {
                console.log(`[USER]: ${cmd.text}`);
                acceptUserChat(String(cmd.text));
            } else if (cmd.type === 'steerMessage' && cmd.text) {
                console.log(`[USER-STEER]: ${cmd.text}`);
                acceptUserChat(String(cmd.text));
            } else if (cmd.type === 'visionFrame' && cmd.data) {
                ingestVisionFrame({
                    data: String(cmd.data),
                    mimeType: cmd.mimeType || 'image/jpeg',
                    width: Number(cmd.width) || 0,
                    height: Number(cmd.height) || 0,
                    ts: Number(cmd.ts) || Date.now(),
                    seq: Number(cmd.seq) || 0,
                });
            } else if (cmd.type === 'spatialResult' && cmd.id && cmd.name) {
                // Clear bridge timeout bookkeeping; always resolve the awaiting tool Promise.
                spatialBridge.resolvePending(String(cmd.id));
                const result =
                    cmd.result && typeof cmd.result === 'object'
                        ? (cmd.result as Record<string, unknown>)
                        : { ok: true, result: cmd.result };
                resolvePendingTool(String(cmd.id), result);
            } else if (cmd.type === 'browserResult' && cmd.id && cmd.name) {
                browserBridge.resolvePending(String(cmd.id));
                const result =
                    cmd.result && typeof cmd.result === 'object'
                        ? (cmd.result as Record<string, unknown>)
                        : { ok: true, result: cmd.result };
                resolvePendingTool(String(cmd.id), result);
            }
        } catch (e) {
            console.error('Error handling WS command:', e);
        }
    });

    aiWsClient.on('close', () => {
        console.log('Disconnected from Main API WebSockets. Quitting AI.');
        process.exit();
    });

    aiWsClient.on('error', (e) => {
        console.error('[WS] Error:', (e as any)?.message ?? e);
    });
}

startServer();
