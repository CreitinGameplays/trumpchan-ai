import { GoogleGenAI, LiveServerMessage, Modality, MediaResolution, Session, Type, Behavior, FunctionResponseScheduling, ThinkingLevel } from '@google/genai';
import * as fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import WebSocket from 'ws';
import { VoiceChanger } from './voice-changer.js';
import {
    spatialToolDeclarations,
    isSpatialTool,
    SpatialToolBridge,
    silentToolResponse,
    spatialToolResponse,
} from './tools/spatial.js';
import {
    RoboticsSpatialPlanner,
    shouldUseRoboticsPlanner,
    isViewSpatialTool,
    mergeViewToolPlan,
    ensureInspectPlan,
    fallbackPlanFromTool,
    type SpatialStep,
} from './tools/robotics-planner.js';
import {
    browserToolDeclarations,
    isBrowserTool,
    BrowserToolBridge,
    browserToolResponse,
} from './tools/browser.js';
import {
    BrowserActionPlanner,
    shouldUseBrowserPlanner,
    fallbackBrowserPlanFromTool,
    type BrowserStep,
} from './tools/browser-planner.js';

// Load environment variables
dotenv.config();

const geminiapiKey = process.env.GEMINI_API_KEY;
if (!geminiapiKey) {
    console.error("Critical Error: GEMINI_API_KEY is not defined in .env");
    process.exit(1);
}

const MEMORY_DIR = path.resolve('memory');
const HISTORY_FILE = path.join(MEMORY_DIR, 'history.json');

// Ensure memory directory exists
if (!existsSync(MEMORY_DIR)) {
    mkdirSync(MEMORY_DIR, { recursive: true });
}

let session: Session | undefined = undefined;
let aiWsClient: WebSocket | undefined = undefined;

// Latest session resumption handle, used to reconnect transparently when the
// Live API periodically resets the underlying WebSocket (~every 10 min) or
// throws a 1011 "internal error" (a known native-audio preview instability).
let sessionResumptionHandle: string | undefined = undefined;

// True only while the Gemini Live session is connected and safe to send to.
// Guards every outbound send so we never push into a dead/closing socket.
let geminiReady = false;
// Prevents overlapping reconnect attempts.
let reconnecting = false;
// Reconnect backoff state.
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY_MS = 15000;
// Timestamp of the last successful onopen. Used to tell a healthy long-lived
// session (whose backoff should reset) apart from a connect->immediately-die
// loop (whose backoff must keep growing).
let lastConnectedAt = 0;
// A session must stay open at least this long before we consider it "stable"
// and reset the backoff counter.
const STABLE_SESSION_MS = 15000;

// Vision circuit breaker. If the session dies repeatedly and quickly AND the
// closes are NOT the 1007/handle protocol error (which we fix by reconnecting
// fresh), video is the likely trigger, so we disable vision forwarding to keep
// audio/text alive. 1007 closes are excluded because they are a resumption-
// handle/context problem, not a video-rejection problem.
let visionEnabled = true;
let recentCloseTimestamps: number[] = [];
const CLOSE_BURST_WINDOW_MS = 60000; // look at closes within the last minute
const CLOSE_BURST_THRESHOLD = 4;     // this many rapid closes trips the breaker

// ---------------------------------------------------------------------------
// 1007 recovery + last-user replay
// gemini-3.1-flash-live-preview often closes with 1007 "invalid argument" when
// resuming an audio+video session (known Live API multimodal resumption bug).
// We drop the handle, reconnect FRESH, then re-inject the last user request.
// ---------------------------------------------------------------------------
/** Last non-empty user chat text (for post-1007 / fresh reconnect replay). */
let lastUserMessageText = '';
let lastUserMessageAt = 0;
/** Set when we closed with 1007 and need to replay after open. */
let pendingUserReplayAfterReconnect = false;
/** Why the next open should replay (logged). */
let pendingReplayReason = '';
/** After 1007 fresh start, delay video briefly so setup settles (reduces re-1007). */
let visionHoldUntil = 0;
const VISION_HOLD_AFTER_1007_MS = 2500;
/** Max age of last user msg to auto-replay after reconnect. */
const REPLAY_MAX_AGE_MS = 10 * 60 * 1000;

// Reusable connection config builder (needs the AI client + system prompt).
let geminiClient: GoogleGenAI | undefined = undefined;
let geminiModel = '';
let geminiSysInstruction = '';

// Vision: always keep the newest frame; only throttle *sends* to Live (~1 FPS).
// Previously we dropped mid-throttle frames entirely, so planners/Live could lag.
let lastVisionSentAt = 0;
let visionFrameCount = 0;
let visionRecvCount = 0;
// Latest JPEG for VisionPlanner / browser planners + Live (base64, no data: prefix).
let lastVisionJpeg: string | null = null;
let lastVisionMime = 'image/jpeg';
let lastVisionMeta = { width: 0, height: 0, ts: 0, seq: 0 };
/** Client ts of last frame that was actually sent to Gemini Live. */
let lastVisionSentClientTs = 0;
let visionFlushTimer: ReturnType<typeof setTimeout> | null = null;
const VISION_MIN_SEND_MS = 900;

const roboticsPlanner = new RoboticsSpatialPlanner();
const browserPlanner = new BrowserActionPlanner();
// Optional higher-res crop of the in-scene browser (from Electron / frontend).
let lastBrowserJpeg: string | null = null;
let lastBrowserMime = 'image/jpeg';
let lastBrowserTs = 0;

/**
 * Always store the newest FPV frame. Schedule a Live send of whatever is latest
 * when the ~1 FPS budget allows — never leave Gemini on an older picture.
 */
function ingestVisionFrame(frame: {
    data: string;
    mimeType: string;
    width: number;
    height: number;
    ts: number;
    seq: number;
    source: string;
}) {
    if (!frame.data) return;

    // Reject clearly older frames if client sends out-of-order (seq or ts).
    const prevSeq = lastVisionMeta.seq || 0;
    const prevTs = lastVisionMeta.ts || 0;
    if (frame.seq > 0 && prevSeq > 0 && frame.seq < prevSeq) {
        console.warn(
            `[VISION] Drop stale seq ${frame.seq} < ${prevSeq} (keeping newest)`,
        );
        return;
    }
    if (frame.ts > 0 && prevTs > 0 && frame.ts < prevTs - 250) {
        console.warn(
            `[VISION] Drop stale ts ${frame.ts} << ${prevTs} (keeping newest)`,
        );
        return;
    }

    visionRecvCount++;
    lastVisionJpeg = frame.data;
    lastVisionMime = frame.mimeType || 'image/jpeg';
    lastVisionMeta = {
        width: frame.width || 0,
        height: frame.height || 0,
        ts: frame.ts || Date.now(),
        seq: frame.seq || visionRecvCount,
    };

    // Always try to push newest to Live (may schedule for next budget window).
    scheduleVisionSendToLive();
}

function scheduleVisionSendToLive() {
    if (!visionEnabled || !geminiReady || !session || !lastVisionJpeg) return;
    if (Date.now() < visionHoldUntil) {
        // After 1007, hold video briefly; still schedule a later flush.
        if (visionFlushTimer) return;
        const wait = Math.max(50, visionHoldUntil - Date.now());
        visionFlushTimer = setTimeout(() => {
            visionFlushTimer = null;
            flushNewestVisionToLive('post-hold');
        }, wait);
        return;
    }

    const now = Date.now();
    const elapsed = now - lastVisionSentAt;
    if (elapsed >= VISION_MIN_SEND_MS) {
        flushNewestVisionToLive('immediate');
        return;
    }
    // Coalesce: only one pending flush; always sends *latest* cache when it fires.
    if (visionFlushTimer) return;
    const wait = Math.max(20, VISION_MIN_SEND_MS - elapsed);
    visionFlushTimer = setTimeout(() => {
        visionFlushTimer = null;
        flushNewestVisionToLive('deferred');
    }, wait);
}

function flushNewestVisionToLive(reason: string) {
    if (!visionEnabled || !geminiReady || !session || !lastVisionJpeg) return;
    if (Date.now() < visionHoldUntil) {
        scheduleVisionSendToLive();
        return;
    }

    // Already sent this exact client frame.
    if (
        lastVisionMeta.ts > 0 &&
        lastVisionMeta.ts === lastVisionSentClientTs
    ) {
        return;
    }

    const now = Date.now();
    if (now - lastVisionSentAt < VISION_MIN_SEND_MS - 5) {
        scheduleVisionSendToLive();
        return;
    }

    try {
        session.sendRealtimeInput({
            video: {
                data: lastVisionJpeg,
                mimeType: lastVisionMime || 'image/jpeg',
            },
        });
        lastVisionSentAt = now;
        lastVisionSentClientTs = lastVisionMeta.ts || now;
        visionFrameCount++;
        // Quiet: only log every 60 frames
        if (visionFrameCount === 1 || visionFrameCount % 60 === 0) {
            console.log(`[VISION] Forwarded #${visionFrameCount} (${lastVisionMeta.width}x${lastVisionMeta.height})`);
        }
    } catch (e) {
        console.error('[VISION] Failed to forward frame to Gemini:', e);
    }
}

// VRM native expression presets the avatar can display in real time.
// These map 1:1 to @pixiv/three-vrm VRMExpressionPresetName emotion presets.
const VALID_EMOTIONS = ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised'] as const;

// Function-call tools exposed to the model. We use NON_BLOCKING behaviour so the
// emote calls never pause/interrupt the audio (TTS) generation. Parsing emotes
// out of the spoken text would break the TTS, so we rely on tool calls instead.
const emotionToolDeclaration = {
    name: 'set_emotion',
    description:
        "Set the avatar's facial expression in real time to match the emotional tone of what you are currently saying. " +
        "Call this the instant your mood shifts (e.g. right before saying something cheerful, sad, angry, shocked, or calm). " +
        "You can call it multiple times within a single reply as your tone changes. This only changes the face; it does not speak.",
    behavior: Behavior.NON_BLOCKING,
    parameters: {
        type: Type.OBJECT,
        required: ['emotion', 'duration'],
        properties: {
            emotion: {
                type: Type.STRING,
                enum: [...VALID_EMOTIONS],
                description:
                    "The emotion preset to display: " +
                    "'happy' (joy, smiling, excited, playful), " +
                    "'sad' (sorrow, disappointed, sympathetic), " +
                    "'angry' (annoyed, frustrated, mock-pouting), " +
                    "'surprised' (shocked, amazed, caught off guard), " +
                    "'relaxed' (calm, cozy, content, soothing), " +
                    "'neutral' (reset back to a natural resting face).",
            },
            intensity: {
                type: Type.NUMBER,
                description:
                    "Optional strength of the expression from 0.0 to 1.0. Defaults to 1.0 (full). " +
                    "Use a lower value (e.g. 0.5) for a subtle expression.",
            },
            duration: {
                type: Type.NUMBER,
                description:
                    "Required. Duration in seconds to hold the expression before it automatically eases " +
                    "back to the neutral resting face. Must be greater than 0. Use a short value for brief " +
                    "reactions (e.g. 2 for a quick surprised gasp) and a larger value to sustain a mood.",
            },
        },
    },
};

const aiTools = [
    {
        functionDeclarations: [
            emotionToolDeclaration,
            ...spatialToolDeclarations,
            ...browserToolDeclarations,
        ],
    },
];

/** Emotion: SILENT. Spatial/browser: WHEN_IDLE so the model can narrate after acting. */
function sendToolResult(
    id: string,
    name: string,
    response: Record<string, unknown>,
    mode: 'silent' | 'when_idle' = 'silent',
) {
    if (!geminiReady || !session) {
        console.warn('[AI-TOOL] Cannot send tool result; session not ready.', name);
        return;
    }
    try {
        // Closed-loop vision: push newest FPV before the model reads the tool result.
        flushNewestVisionToLive(`pre-tool-result:${name}`);
        // Strip huge fields before sending to Live (elements keep; no base64 dumps).
        const safe = sanitizeToolResultPayload(response);
        // Ensure hybrid grounding fields survive even if caller omitted them.
        if (!safe.reobserve) {
            safe.reobserve =
                'Use your newest first-person frame + this result before the next claim or tool.';
        }
        const fr =
            mode === 'when_idle'
                ? isBrowserTool(name)
                    ? browserToolResponse(id, name, safe)
                    : spatialToolResponse(id, name, safe)
                : silentToolResponse(id, name, safe);
        session.sendToolResponse({ functionResponses: [fr] });
        console.log(`[AI-TOOL] Result ${name} (${mode}):`, JSON.stringify(safe).slice(0, 500));
    } catch (e) {
        console.error('[AI-TOOL] Failed to send tool result:', e);
    }
}

function sanitizeToolResultPayload(response: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...response };
    // Never send multi-MB crops into the tool response.
    delete out.cropData;
    delete out.jpeg;
    delete out.data;
    if (Array.isArray(out.elements) && out.elements.length > 24) {
        // Keep compact SoM-style list for grounding (ref + role + label).
        out.elements = out.elements.slice(0, 24).map((el: any) => ({
            ref: el?.ref,
            role: el?.role,
            name: el?.name || el?.label,
            x: el?.x,
            y: el?.y,
            w: el?.w,
            h: el?.h,
        }));
    }
    if (Array.isArray(out.entities) && out.entities.length > 20) {
        out.entities = out.entities.slice(0, 20);
    }
    if (typeof out.text === 'string' && out.text.length > 4000) {
        out.text = out.text.slice(0, 4000);
    }
    if (typeof out.selection === 'string' && out.selection.length > 2000) {
        out.selection = out.selection.slice(0, 2000);
    }
    if (typeof out.axTree === 'string' && out.axTree.length > 3000) {
        out.axTree = out.axTree.slice(0, 3000);
    }
    return out;
}

const spatialBridge = new SpatialToolBridge(
    () => aiWsClient,
    (id, name, response) => {
        sendToolResult(id, name, response, 'when_idle');
        onToolPipelineMaybeIdle('spatial-timeout');
    },
);

const browserBridge = new BrowserToolBridge(
    () => aiWsClient,
    (id, name, response) => {
        sendToolResult(id, name, response, 'when_idle');
        onToolPipelineMaybeIdle('browser-timeout');
    },
);

const responseQueue: LiveServerMessage[] = [];
let currentGlobalCaption = "";
/** Last caption string we already printed as [AI]: — prevents late turnComplete re-logs. */
let lastLoggedCaption = "";
let captionClearTimeout: any = null;

// ---------------------------------------------------------------------------
// Mid-turn steering (Codex-style): user messages while tools are in flight are
// queued and injected once — not as a competing new turn that restarts work.
// Duplicates (same text) are coalesced so spam/double-submit cannot loop.
// ---------------------------------------------------------------------------
type SteerEntry = {
    id: string;
    text: string;
    norm: string;
    enqueuedAt: number;
    source: 'chat' | 'mic';
};

/** Pending steers / follow-ups waiting for tools to finish. */
const steerQueue: SteerEntry[] = [];
/** Recent accepted user/steer texts for dedupe. */
const recentUserNorms: { norm: string; at: number }[] = [];
const DEDUPE_WINDOW_MS = 8000;
const MAX_STEER_QUEUE = 6;
let steerSeq = 0;
/** True while model audio/text is streaming this turn (cleared on turnComplete/interrupted). */
let modelTurnActive = false;
/** True after we saw toolCall until pending bridges empty + short settle. */
let toolsBusy = false;
let toolsIdleFlushTimer: ReturnType<typeof setTimeout> | null = null;

function normalizeUserText(text: string): string {
    return String(text || '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function isDuplicateUserText(norm: string): boolean {
    if (!norm) return true;
    const now = Date.now();
    // Drop expired
    while (recentUserNorms.length && now - recentUserNorms[0].at > DEDUPE_WINDOW_MS) {
        recentUserNorms.shift();
    }
    if (recentUserNorms.some((e) => e.norm === norm)) return true;
    if (steerQueue.some((e) => e.norm === norm)) return true;
    return false;
}

function rememberUserText(norm: string) {
    recentUserNorms.push({ norm, at: Date.now() });
    if (recentUserNorms.length > 24) recentUserNorms.shift();
}

function rememberLastUserMessage(text: string) {
    const t = String(text || '').trim();
    if (!t) return;
    lastUserMessageText = t;
    lastUserMessageAt = Date.now();
}

/**
 * After a hard reconnect (esp. 1007 fresh session), re-send the last user ask
 * so the model continues the request instead of sitting idle with empty context.
 */
function replayLastUserMessageIfNeeded(reason: string) {
    if (!pendingUserReplayAfterReconnect) return;
    if (!geminiReady || !session) return;

    const text = lastUserMessageText.trim();
    const age = Date.now() - lastUserMessageAt;
    pendingUserReplayAfterReconnect = false;
    const why = pendingReplayReason || reason;
    pendingReplayReason = '';

    if (!text || age > REPLAY_MAX_AGE_MS) {
        console.log(
            `[REPLAY] Skip (${why}): no recent user message ` +
                `(age=${age}ms textLen=${text.length})`,
        );
        return;
    }

    // Brief delay so Live setup + first vision frame can land first.
    const delayMs = Math.max(400, visionHoldUntil - Date.now());
    setTimeout(() => {
        if (!geminiReady || !session) {
            // Session died again — re-arm replay for next open
            pendingUserReplayAfterReconnect = true;
            pendingReplayReason = why;
            console.warn('[REPLAY] Session not ready; will retry on next open.');
            return;
        }
        try {
            // Clear dedupe so the same text is allowed after crash recovery
            const norm = normalizeUserText(text);
            for (let i = recentUserNorms.length - 1; i >= 0; i--) {
                if (recentUserNorms[i].norm === norm) recentUserNorms.splice(i, 1);
            }
            const payload =
                `[SYSTEM — Live session was reset (${why}). ` +
                `You lost in-progress tool state. Continue helping the user from this last request. ` +
                `Do not apologize at length; act.]\n${text}`;
            session.sendRealtimeInput({ text: payload });
            rememberUserText(norm);
            flushNewestVisionToLive('post-reconnect-replay');
            console.log(
                `[REPLAY] Re-injected last user message after ${why}: "${text.slice(0, 120)}"`,
            );
            if (aiWsClient && aiWsClient.readyState === WebSocket.OPEN) {
                try {
                    aiWsClient.send(
                        JSON.stringify({
                            type: 'sessionReplay',
                            reason: why,
                            textPreview: text.slice(0, 160),
                        }),
                    );
                } catch {
                    /* ignore */
                }
            }
        } catch (e) {
            console.error('[REPLAY] Failed to re-inject user message:', e);
            pendingUserReplayAfterReconnect = true;
            pendingReplayReason = why;
        }
    }, delayMs);
}

function toolsInFlight(): boolean {
    return spatialBridge.hasPending() || browserBridge.hasPending() || toolsBusy;
}

function looksLikeCancelSteer(text: string): boolean {
    const t = normalizeUserText(text);
    return (
        /\b(never ?mind|nevermind|cancel|stop|forget it|abort|don't bother|dont bother|give up|skip it|leave it)\b/.test(
            t,
        ) || /^(stop|cancel|nm)\.?$/.test(t)
    );
}

function buildSteerPayload(userText: string): string {
    const cancel = looksLikeCancelSteer(userText);
    if (cancel) {
        return (
            `[STEER — CANCEL / STOP current browser and spatial work. ` +
            `Acknowledge briefly, do NOT retry clicks, captchas, or navigation unless the user starts a new request. ` +
            `User said:]\n${userText}`
        );
    }
    // Explicit framing so Live treats this as course-correction, not a new task.
    return (
        `[STEER — mid-task guidance from the user. ` +
        `Continue the work you were already doing (including any open tool plan). ` +
        `Do NOT restart from scratch, re-run the same browser/spatial plan, or ignore progress ` +
        `unless the user clearly asks to cancel or change goals. ` +
        `Clicks only via view_click (FPV grid); never browser_click. ` +
        `Incorporate this guidance now:]\n${userText}`
    );
}

/** Drop in-flight browser work when the user cancels mid-task. */
function cancelBrowserWorkForSteer(reason: string) {
    const n = browserBridge.cancelAll(reason);
    if (n > 0) {
        console.log(`[STEER] Cancelled ${n} browser tool(s) (${reason})`);
        notifySteerStatus('browser_cancelled', { count: n, reason });
    }
    onToolPipelineMaybeIdle('browser-cancel');
}

function notifySteerStatus(kind: string, detail: Record<string, unknown> = {}) {
    if (aiWsClient && aiWsClient.readyState === WebSocket.OPEN) {
        try {
            aiWsClient.send(
                JSON.stringify({
                    type: 'steerStatus',
                    kind,
                    queueLen: steerQueue.length,
                    toolsInFlight: toolsInFlight(),
                    modelTurnActive,
                    ...detail,
                }),
            );
        } catch {
            /* ignore */
        }
    }
}

/**
 * Accept a user chat line: send now, or queue as steer if tools are busy.
 * Returns how it was handled.
 */
function acceptUserChatText(rawText: string, source: 'chat' | 'mic' = 'chat'): {
    ok: boolean;
    action: 'sent' | 'steered_now' | 'queued' | 'duplicate' | 'dropped';
    reason?: string;
} {
    const text = String(rawText || '').trim();
    if (!text) return { ok: false, action: 'dropped', reason: 'empty' };

    const norm = normalizeUserText(text);
    if (isDuplicateUserText(norm)) {
        console.log(`[STEER] Dropped duplicate user text (${source}): "${text.slice(0, 80)}"`);
        notifySteerStatus('duplicate', { textPreview: text.slice(0, 120) });
        return { ok: true, action: 'duplicate', reason: 'deduped' };
    }

    // Always remember for 1007 / reconnect replay (even if we queue).
    rememberLastUserMessage(text);

    if (!geminiReady || !session) {
        // Queue instead of drop — will flush after reconnect (+ optional replay).
        while (steerQueue.length >= MAX_STEER_QUEUE) steerQueue.shift();
        steerSeq += 1;
        steerQueue.push({
            id: `steer_${steerSeq}_${Date.now()}`,
            text,
            norm,
            enqueuedAt: Date.now(),
            source,
        });
        rememberUserText(norm);
        pendingUserReplayAfterReconnect = true;
        pendingReplayReason = pendingReplayReason || 'session_not_ready';
        console.warn(
            `[STEER] Session not ready — queued user text for post-reconnect (${steerQueue.length}).`,
        );
        notifySteerStatus('queued', { textPreview: text.slice(0, 120), offline: true });
        return { ok: true, action: 'queued', reason: 'session_not_ready' };
    }

    // Cancel steers interrupt browser work immediately, then inject (or queue).
    if (looksLikeCancelSteer(text) && (browserBridge.hasPending() || toolsBusy)) {
        cancelBrowserWorkForSteer('user_cancel_steer');
    }

    // Tools running → queue (Codex Tab-like default). Do not inject mid-tool so we
    // don't spawn a parallel "start browsing again" loop while run_plan is open.
    // Cancel messages still inject ASAP after cancel so the model can stop talking about retries.
    if (toolsInFlight() && !looksLikeCancelSteer(text)) {
        // Cap queue: newest wins if full (drop oldest)
        while (steerQueue.length >= MAX_STEER_QUEUE) {
            const dropped = steerQueue.shift();
            console.warn(`[STEER] Queue full; dropped oldest: "${dropped?.text.slice(0, 60)}"`);
        }
        steerSeq += 1;
        const entry: SteerEntry = {
            id: `steer_${steerSeq}_${Date.now()}`,
            text,
            norm,
            enqueuedAt: Date.now(),
            source,
        };
        steerQueue.push(entry);
        rememberUserText(norm);
        console.log(
            `[STEER] Queued (${steerQueue.length}) while tools busy ` +
                `spatial=${spatialBridge.pendingCount()} browser=${browserBridge.pendingCount()}: ` +
                `"${text.slice(0, 100)}"`,
        );
        notifySteerStatus('queued', { id: entry.id, textPreview: text.slice(0, 120) });
        return { ok: true, action: 'queued' };
    }

    // Idle or only speaking → inject as steer if a turn was active, else plain user msg.
    const asSteer = modelTurnActive;
    const payload = asSteer ? buildSteerPayload(text) : text;
    try {
        session.sendRealtimeInput({ text: payload });
        rememberUserText(norm);
        console.log(
            `[STEER] ${asSteer ? 'Injected mid-turn steer' : 'Sent user message'} (${source}): ` +
                `"${text.slice(0, 100)}"`,
        );
        notifySteerStatus(asSteer ? 'steered_now' : 'sent', { textPreview: text.slice(0, 120) });
        return { ok: true, action: asSteer ? 'steered_now' : 'sent' };
    } catch (e) {
        console.error('[STEER] Failed to send to Gemini:', e);
        return { ok: false, action: 'dropped', reason: String((e as Error)?.message ?? e) };
    }
}

/** Flush queued steers once tools are idle (one combined message to avoid multi-fire). */
function flushSteerQueue(reason: string) {
    if (toolsIdleFlushTimer) {
        clearTimeout(toolsIdleFlushTimer);
        toolsIdleFlushTimer = null;
    }
    if (steerQueue.length === 0) return;
    if (!geminiReady || !session) {
        console.warn('[STEER] Cannot flush; session not ready.');
        return;
    }
    if (toolsInFlight()) {
        console.log(`[STEER] Flush deferred (${reason}); tools still in flight.`);
        return;
    }

    // Coalesce all queued steers into one injection (prevents multi-prompt blast).
    const batch = steerQueue.splice(0, steerQueue.length);
    const unique: SteerEntry[] = [];
    const seen = new Set<string>();
    for (const e of batch) {
        if (seen.has(e.norm)) continue;
        seen.add(e.norm);
        unique.push(e);
    }
    if (unique.length === 0) return;

    const combined =
        unique.length === 1
            ? unique[0].text
            : unique.map((e, i) => `(${i + 1}) ${e.text}`).join('\n');

    const payload = buildSteerPayload(combined);
    try {
        session.sendRealtimeInput({ text: payload });
        console.log(
            `[STEER] Flushed ${unique.length} message(s) after ${reason}: "${combined.slice(0, 140)}"`,
        );
        notifySteerStatus('flushed', {
            count: unique.length,
            reason,
            textPreview: combined.slice(0, 120),
        });
    } catch (e) {
        console.error('[STEER] Flush failed; re-queueing:', e);
        // Put back (unique only) at front
        steerQueue.unshift(...unique);
    }
}

/**
 * Called when a tool result returns or times out. After a short settle (so
 * multi-tool batches can finish), flush steers if nothing is pending.
 */
function onToolPipelineMaybeIdle(reason: string) {
    const still = spatialBridge.hasPending() || browserBridge.hasPending();
    if (still) {
        toolsBusy = true;
        return;
    }
    // Brief settle so concurrent toolCall batches don't race flush mid-dispatch.
    if (toolsIdleFlushTimer) clearTimeout(toolsIdleFlushTimer);
    toolsIdleFlushTimer = setTimeout(() => {
        toolsIdleFlushTimer = null;
        if (spatialBridge.hasPending() || browserBridge.hasPending()) {
            toolsBusy = true;
            return;
        }
        toolsBusy = false;
        flushSteerQueue(reason);
    }, 120);
}

function markToolsBusyFromToolCall() {
    toolsBusy = true;
    if (toolsIdleFlushTimer) {
        clearTimeout(toolsIdleFlushTimer);
        toolsIdleFlushTimer = null;
    }
}

const ffmpegBinary = process.env.FFMPEG_BINARY || 'ffmpeg';
const voiceChangerConfigPath = process.env.VOICE_CHANGER_CONFIG || path.resolve('voice-changer-config.json');
const voiceChanger = new VoiceChanger(ffmpegBinary, voiceChangerConfigPath, (processedPcm: Buffer) => {
    if (aiWsClient && aiWsClient.readyState === WebSocket.OPEN) {
        aiWsClient.send(JSON.stringify({
            type: 'audio',
            data: processedPcm.toString('base64')
        }));
    }
});

async function loadHistory() {
    try {
        if (existsSync(HISTORY_FILE)) {
            const data = await fs.readFile(HISTORY_FILE, 'utf-8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.error("Error loading context history:", e);
    }
    return [];
}

async function saveHistory(history: any[]) {
    try {
        await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
    } catch (e) {
        console.error("Error saving context history:", e);
    }
}

// Build the Live API session config. Rebuilt on every (re)connect so it can
// pick up the latest session resumption handle.
function buildLiveConfig(): any {
    // gemini-3.1-flash-live-preview rejects several 2.5-era setup fields with
    // WebSocket close 1007 "Request contains an invalid argument":
    //   - contextWindowCompression  → 1007
    //   - thinkingBudget            → use thinkingLevel instead
    //   - proactivity / affective dialog → 1007/1011
    // See google/adk-python#5075 and the Live API 3.1 migration notes.
    const config: any = {
        responseModalities: [Modality.AUDIO],
        outputAudioTranscription: {},
        inputAudioTranscription: {},
        // Gemini 3.x Live uses thinkingLevel (not thinkingBudget).
        // This keeps latency low while still allowing tool use smartly.
        thinkingConfig: {
            thinkingLevel: ThinkingLevel.MEDIUM, // reasoning enabled makes the model rarely hallucinate tool calls
        },
        // HIGH so the model can read more detail from the 3D scene / in-scene
        // browser (text, UI). Costs more tokens per frame than MEDIUM.
        mediaResolution: MediaResolution.MEDIA_RESOLUTION_HIGH,
        speechConfig: {
            voiceConfig: {
                prebuiltVoiceConfig: {
                    voiceName: 'Zephyr',
                }
            }
        },
        systemInstruction: {
            parts: [{ text: geminiSysInstruction }]
        },
        tools: aiTools,
    };

    // Session resumption: only include a handle when we have one. An empty
    // sessionResumption object is fine for enabling updates; a stale handle
    // is what causes 1007 reconnect loops (we drop it on 1007 in onclose).
    if (sessionResumptionHandle) {
        config.sessionResumption = { handle: sessionResumptionHandle };
    } else {
        config.sessionResumption = {};
    }

    // NOTE: Do NOT set contextWindowCompression on gemini-3.1-flash-live-preview —
    // it is a documented 1007 cause. Audio+video sessions may be shorter without
    // it; session resumption still helps across connection resets.

    return config;
}

// (Re)connect the Gemini Live session. Safe to call repeatedly; it tears down
// any previous session and gates sends via `geminiReady` until connected.
async function connectGemini(): Promise<boolean> {
    if (!geminiClient) {
        console.error('[GEMINI] connectGemini called before client init.');
        return false;
    }

    geminiReady = false;

    // Best-effort close of any prior session so we don't leak sockets.
    if (session) {
        try { session.close(); } catch { /* ignore */ }
        session = undefined;
    }

    try {
        session = await geminiClient.live.connect({
            model: geminiModel,
            config: buildLiveConfig(),
            callbacks: {
                onopen: () => {
                    geminiReady = true;
                    lastConnectedAt = Date.now();
                    const resumed = Boolean(sessionResumptionHandle);
                    console.log(
                        resumed
                            ? 'Gemini Live API: Reconnected (resumed session).'
                            : 'Gemini Live API: Connected successfully!',
                    );
                    // Push newest cached FPV (may be held briefly after 1007).
                    lastVisionSentClientTs = 0;
                    scheduleVisionSendToLive();
                    // Fresh session after 1007 / offline: re-ask last user request.
                    if (pendingUserReplayAfterReconnect || !resumed) {
                        // Only auto-replay when we planned to (1007) or had offline queue.
                        if (pendingUserReplayAfterReconnect) {
                            replayLastUserMessageIfNeeded(pendingReplayReason || 'reconnect');
                        }
                    }
                    // Drain any steers queued while offline (after short settle).
                    setTimeout(() => {
                        if (steerQueue.length > 0 && !toolsInFlight()) {
                            flushSteerQueue('post-reconnect');
                        }
                    }, 600);
                },
                onmessage: (msg: LiveServerMessage) => handleModelTurn(msg),
                onerror: (e) => console.error('Gemini Live API Error:', (e as any)?.message ?? e),
                onclose: (e: any) => {
                    geminiReady = false;
                    const code = Number(e?.code ?? e?.[Symbol.for('kCode')] ?? 0);
                    const reason = e?.reason ?? e?.[Symbol.for('kReason')] ?? '';

                    // Only reset the backoff counter if the session actually stayed
                    // up for a while. A connect->immediately-die loop must keep
                    // backing off instead of hammering the API.
                    const wasStable = lastConnectedAt > 0 && (Date.now() - lastConnectedAt) > STABLE_SESSION_MS;
                    if (wasStable) reconnectAttempts = 0;

                    // 1007 "invalid argument" on gemini-3.1-flash-live-preview:
                    // Known Live API bug: session resumption after audio+video
                    // (FPV frames) often invalidates the handle. Retrying WITH
                    // the same handle loops 1007 forever. Drop handle, hold
                    // vision briefly, reconnect FRESH, replay last user msg.
                    // https://github.com/googleapis/python-genai/issues/2290
                    if (code === 1007) {
                        console.warn(
                            `Gemini Live API Closed (code 1007): ${reason}. ` +
                                `Dropping resumption handle (audio+video resume bug), ` +
                                `holding vision ${VISION_HOLD_AFTER_1007_MS}ms, ` +
                                `will replay last user message after fresh connect.`,
                        );
                        sessionResumptionHandle = undefined;
                        pendingUserReplayAfterReconnect = true;
                        pendingReplayReason = '1007_invalid_argument';
                        visionHoldUntil = Date.now() + VISION_HOLD_AFTER_1007_MS;
                        // Clear in-flight tool bookkeeping — old session tool ids are dead.
                        try {
                            spatialBridge.clearAll();
                            browserBridge.clearAll();
                            toolsBusy = false;
                        } catch {
                            /* ignore */
                        }
                    } else {
                        console.warn(
                            `Gemini Live API Closed (code ${code}): ${reason}. Scheduling reconnect...`,
                        );
                        // Non-1007 drops: still replay if we had an unanswered user ask recently.
                        if (lastUserMessageText && Date.now() - lastUserMessageAt < 120000) {
                            pendingUserReplayAfterReconnect = true;
                            pendingReplayReason = pendingReplayReason || `close_${code || 'unknown'}`;
                        }
                        trackCloseForBreaker();
                    }
                    scheduleGeminiReconnect();
                },
            }
        });
        return true;
    } catch (error) {
        console.error('[GEMINI] Failed to connect:', error);
        geminiReady = false;
        pendingUserReplayAfterReconnect = true;
        pendingReplayReason = pendingReplayReason || 'connect_failed';
        scheduleGeminiReconnect();
        return false;
    }
}

// Track non-1007 connection closes; if they burst while vision is on, trip the
// breaker and stop forwarding video so the (otherwise stable) audio/text
// session can stay up. This isolates whether the video stream is what the model
// rejects. 1007/handle errors are handled separately and never reach here.
function trackCloseForBreaker() {
    if (!visionEnabled) return; // already tripped; nothing to isolate
    const now = Date.now();
    recentCloseTimestamps.push(now);
    recentCloseTimestamps = recentCloseTimestamps.filter(t => now - t < CLOSE_BURST_WINDOW_MS);

    if (recentCloseTimestamps.length >= CLOSE_BURST_THRESHOLD) {
        visionEnabled = false;
        recentCloseTimestamps = [];
        console.error(
            `[VISION] Circuit breaker tripped: ${CLOSE_BURST_THRESHOLD} rapid session closes ` +
            `while streaming video. Disabling vision forwarding to keep audio/text alive. ` +
            `Restart the AI server to re-enable vision.`
        );
    }
}

// Reconnect with exponential backoff. Reuses the stored resumption handle so
// the conversation context survives the drop.
function scheduleGeminiReconnect() {
    if (reconnecting) return;
    reconnecting = true;

    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY_MS);
    reconnectAttempts++;
    console.log(`[GEMINI] Reconnecting in ${delay}ms (attempt ${reconnectAttempts}, handle ${sessionResumptionHandle ? 'present' : 'none'}).`);

    setTimeout(async () => {
        reconnecting = false;
        await connectGemini();
    }, delay);
}

async function startAiServer() {
    console.log("Starting Gemini Live AI WebSocket Proxy...");
    const ai = new GoogleGenAI({ apiKey: geminiapiKey });
    const model = 'models/gemini-3.1-flash-live-preview';

    let sysInstruction = "You are a friendly VTuber named Trumpchan. Keep your responses engaging, short, and conversational.";
    try {
        sysInstruction = await fs.readFile('./SYSTEM.txt', 'utf-8');
    } catch (e) {
        console.log("SYSTEM.txt not found, using default instructions.");
    }

    // Stash the pieces needed to (re)build a session so reconnects can reuse them.
    geminiClient = ai;
    geminiModel = model;
    geminiSysInstruction = sysInstruction;

    await connectGemini();

    // Connect to the localized Main Server (Visualizer WS Server)
    aiWsClient = new WebSocket('ws://localhost:3000');

    aiWsClient.on('open', async () => {
        console.log("Connected to Main API WebSockets");
        // Load past history context if any to set context (you could send bulk via content history)
        // For Gemini Live API, streaming past turns correctly usually requires specific turn structures.
        // We'll primarily focus on persistent history storage.
    });

    aiWsClient.on('message', async (data) => {
        try {
            const cmd = JSON.parse(data.toString());

            // User chat — steer/queue when tools are busy (no request-loop restart).
            if (cmd.type === 'chatMessage' && cmd.text) {
                console.log(`[USER]: ${cmd.text}`);

                // Always clear caption buffer on new user text so a late turnComplete
                // cannot re-log the previous reply as if it were the new answer.
                if (captionClearTimeout) {
                    clearTimeout(captionClearTimeout);
                    captionClearTimeout = null;
                }
                currentGlobalCaption = '';
                lastLoggedCaption = '';
                if (aiWsClient && aiWsClient.readyState === WebSocket.OPEN) {
                    try {
                        aiWsClient.send(JSON.stringify({ type: 'caption', text: '' }));
                    } catch {
                        /* ignore */
                    }
                }

                const handled = acceptUserChatText(String(cmd.text), 'chat');

                // History: store raw user text once (not steers that were dropped as dups).
                if (handled.action !== 'duplicate' && handled.action !== 'dropped') {
                    const history = await loadHistory();
                    history.push({
                        role: 'user',
                        text: String(cmd.text),
                        timestamp: new Date().toISOString(),
                        steer: handled.action === 'queued' || handled.action === 'steered_now',
                        steerAction: handled.action,
                    });
                    await saveHistory(history);
                }
            }

            // Explicit steer from UI (optional): always treat as mid-task guidance.
            else if (cmd.type === 'steerMessage' && cmd.text) {
                console.log(`[USER-STEER]: ${cmd.text}`);
                const text = String(cmd.text).trim();
                if (!text || !geminiReady || !session) return;
                const norm = normalizeUserText(text);
                if (isDuplicateUserText(norm)) {
                    console.log('[STEER] Dropped duplicate explicit steer.');
                    notifySteerStatus('duplicate', { textPreview: text.slice(0, 120) });
                    return;
                }
                if (toolsInFlight()) {
                    acceptUserChatText(text, 'chat');
                    return;
                }
                try {
                    session.sendRealtimeInput({ text: buildSteerPayload(text) });
                    rememberUserText(norm);
                    modelTurnActive = true;
                    notifySteerStatus('steered_now', { textPreview: text.slice(0, 120), explicit: true });
                    console.log(`[STEER] Explicit steer injected: "${text.slice(0, 100)}"`);
                } catch (e) {
                    console.error('[STEER] Explicit steer failed:', e);
                }
            }

            // Live vision frames (avatar FPV). Always cache newest; throttle Live send.
            else if (cmd.type === 'visionFrame' && cmd.data) {
                ingestVisionFrame({
                    data: String(cmd.data),
                    mimeType: cmd.mimeType || 'image/jpeg',
                    width: Number(cmd.width) || 0,
                    height: Number(cmd.height) || 0,
                    ts: Number(cmd.ts) || Date.now(),
                    seq: Number(cmd.seq) || 0,
                    source: String(cmd.source || 'avatar-first-person'),
                });
            }

            // Frontend finished a spatial tool (walk/turn/look/etc.).
            // Result includes pose/distances for closed-loop navigation.
            else if (cmd.type === 'spatialResult' && cmd.id && cmd.name) {
                const pending = spatialBridge.resolvePending(String(cmd.id));
                if (!pending) {
                    console.warn('[SPATIAL] Unexpected result for id', cmd.id);
                    // Stale/duplicate result — do not re-send tool response (avoids loops).
                    return;
                }
                const result =
                    cmd.result && typeof cmd.result === 'object'
                        ? (cmd.result as Record<string, unknown>)
                        : { ok: true, result: cmd.result };
                sendToolResult(String(cmd.id), String(cmd.name), result, 'when_idle');
                onToolPipelineMaybeIdle('spatial-result');
            }

            // Frontend finished a browser tool (navigate/click/type/...).
            else if (cmd.type === 'browserResult' && cmd.id && cmd.name) {
                const pending = browserBridge.resolvePending(String(cmd.id));
                if (!pending) {
                    console.warn('[BROWSER] Unexpected result for id', cmd.id);
                    // Stale/duplicate result — ignore (prevents double toolResponse).
                    return;
                }
                const result =
                    cmd.result && typeof cmd.result === 'object'
                        ? (cmd.result as Record<string, unknown>)
                        : { ok: true, result: cmd.result };
                // Optional crop attached separately via browserVisionFrame.
                sendToolResult(String(cmd.id), String(cmd.name), result, 'when_idle');
                onToolPipelineMaybeIdle('browser-result');
            }

            // High-res crop of the floating browser content (for browser planner only).
            // Never replaces FPV as Live video — that would show a stale non-head view.
            else if (cmd.type === 'browserVisionFrame' && cmd.data) {
                lastBrowserJpeg = String(cmd.data);
                lastBrowserMime = cmd.mimeType || 'image/jpeg';
                lastBrowserTs = Number(cmd.ts) || Date.now();
                console.log(
                    `[BROWSER-VISION] Cached browser crop ${cmd.width || '?'}x${cmd.height || '?'} ` +
                        `ts=${lastBrowserTs} (planner only; Live stays on newest FPV)`,
                );
            }

            // NOTE: Browser interactions (page loads / navigation) must NOT
            // trigger the AI. We deliberately do not accept chat-like grounding
            // for navigation events. Scene pose is passive context only.
        } catch (e) {
            console.error('Error handling WS command from main Server', e);
        }
    });

    aiWsClient.on('close', () => {
        console.log("Disconnected from Main API WebSockets. Quitting AI.");
        process.exit();
    });
}

function handleSetEmotion(functionCall: any) {
    const rawEmotion = String(functionCall.args?.emotion ?? '').toLowerCase().trim();
    const emotion = (VALID_EMOTIONS as readonly string[]).includes(rawEmotion)
        ? rawEmotion
        : 'neutral';

    let intensity = Number(functionCall.args?.intensity);
    if (!Number.isFinite(intensity)) intensity = 1.0;
    intensity = Math.max(0, Math.min(1, intensity));

    const DEFAULT_EMOTION_DURATION = 2;
    let duration = Number(functionCall.args?.duration);
    if (!Number.isFinite(duration) || duration <= 0) duration = DEFAULT_EMOTION_DURATION;

    if (rawEmotion !== emotion) {
        console.warn(`[AI-TOOL] Unknown emotion "${rawEmotion}", falling back to "neutral".`);
    }

    if (aiWsClient && aiWsClient.readyState === WebSocket.OPEN) {
        aiWsClient.send(JSON.stringify({
            type: 'emotion',
            emotion,
            intensity,
            duration,
        }));
        console.log(`[AI-TOOL] Sent emotion "${emotion}" (intensity ${intensity}, duration ${duration}s).`);
    } else {
        console.warn('[AI-TOOL] Visualizer WS not connected; emotion not delivered.');
    }

    return silentToolResponse(functionCall.id, functionCall.name, { result: 'ok', emotion, intensity, duration });
}

/**
 * Dispatch a multi-step spatial plan to the visualizer as one run_plan command.
 * The frontend executes steps serially and returns a single spatialResult.
 */
function dispatchSpatialPlan(
    toolCallId: string,
    originalName: string,
    steps: SpatialStep[],
    meta: Record<string, unknown>,
): boolean {
    return spatialBridge.dispatch(toolCallId, 'run_plan', {
        steps,
        originalName,
        ...meta,
    });
}

async function handleSpatialToolWithPlanner(functionCall: any) {
    const name = String(functionCall.name);
    const args = (functionCall.args ?? {}) as Record<string, unknown>;
    const id = String(functionCall.id);

    // Mark busy while planning so steers queue (logs showed spatial=0 during 5s plan)
    toolsBusy = true;

    try {
        // Fast path: look/turn/stop/reset never need planner. view_* + walk/inspect try flash-lite first.
        if (!shouldUseRoboticsPlanner(name) || !lastVisionJpeg || !roboticsPlanner.isAvailable()) {
            const plan = fallbackPlanFromTool(name, args);
            const ok = dispatchSpatialPlan(id, name, plan.steps, {
                planner: plan.source,
                reasoning:
                    plan.reasoning ||
                    (isViewSpatialTool(name)
                        ? 'Live view tool (VisionPlanner / flash-lite unavailable).'
                        : undefined),
            });
            if (!ok) {
                if (isViewSpatialTool(name)) {
                    const direct = spatialBridge.dispatch(id, name, args);
                    if (!direct) {
                        sendToolResult(id, name, { ok: false, error: 'visualizer_offline' }, 'when_idle');
                        onToolPipelineMaybeIdle('spatial-offline');
                    } else {
                        console.log(
                            `[SPATIAL] Direct ${name} (plan dispatch failed)`,
                            JSON.stringify(args).slice(0, 160),
                        );
                    }
                    return;
                }
                sendToolResult(id, name, { ok: false, error: 'visualizer_offline' }, 'when_idle');
                onToolPipelineMaybeIdle('spatial-offline');
            }
            return;
        }

        // view_click with Live x,y: skip planner refine of aim (still allow direct execute).
        // Optional short path — faster + avoids flash-lite inventing wrong Discord rows.
        const liveX = Number(args.x);
        const liveY = Number(args.y);
        const liveHasXY =
            isViewSpatialTool(name) &&
            Number.isFinite(liveX) &&
            Number.isFinite(liveY) &&
            liveX >= 0 &&
            liveX <= 1.5 &&
            liveY >= 0 &&
            liveY <= 1.5;

        if (name === 'view_click' && liveHasXY && process.env.VISION_PLANNER_CLICK_REFINE !== '1') {
            // Default: trust Live aim; planner invents wrong targets too often on Discord.
            flushNewestVisionToLive('pre-view-click');
            console.log(
                `[SPATIAL] view_click Live aim x=${liveX} y=${liveY} (planner refine off; set VISION_PLANNER_CLICK_REFINE=1 to enable)`,
            );
            const ok = dispatchSpatialPlan(
                id,
                name,
                [{ name, args: { ...args, x: liveX > 1.5 ? liveX / 1280 : liveX, y: liveY > 1.5 ? liveY / 720 : liveY } }],
                {
                    planner: 'live-aim',
                    reasoning: 'Execute Live x,y without flash-lite re-aim (Discord mis-click fix).',
                },
            );
            if (!ok) {
                spatialBridge.dispatch(id, name, args);
            }
            return;
        }

        const goal = isViewSpatialTool(name)
            ? name === 'view_click'
                ? `CLICK at Live coordinates (KEEP THESE unless clearly off-panel): ${JSON.stringify(args)}. ` +
                  `x,y are 0–1 FPV ((0,0)=top-left). Do not invent a different button/channel. ` +
                  `If panel is small/far, inspect_browser first then view_click with the SAME x,y.`
                : name === 'view_look'
                  ? `Look toward Live point: ${JSON.stringify(args)}. Keep x,y if present.`
                  : `Walk toward Live point: ${JSON.stringify(args)}.`
            : name === 'inspect_browser'
              ? 'MUST approach the floating browser: use inspect_browser (or walk_toward browser + look_at browser). Do NOT only look_at if still far.'
              : name === 'walk_toward'
                ? `Walk toward ${String(args.target || 'browser')}.`
                : name === 'walk'
                  ? `Walk ${String(args.direction || 'forward')} for a short step.`
                  : `Execute spatial action ${name} with args ${JSON.stringify(args)}`;

        flushNewestVisionToLive('pre-spatial-plan');
        console.log(
            `[SPATIAL] VisionPlanner (flash-lite) for ${name}… ` +
                `fpvSeq=${lastVisionMeta.seq} ageMs=${lastVisionMeta.ts ? Date.now() - lastVisionMeta.ts : '?'} ` +
                `${lastVisionMeta.width}x${lastVisionMeta.height}`,
        );
        const plan = await roboticsPlanner.planFromFrame({
            jpegBase64: lastVisionJpeg,
            mimeType: lastVisionMime,
            goal,
            sceneHint: `frame ${lastVisionMeta.width}x${lastVisionMeta.height} seq=${lastVisionMeta.seq}; live tool was ${name} args=${JSON.stringify(args).slice(0, 200)}`,
        });

        let steps: SpatialStep[];
        if (isViewSpatialTool(name)) {
            steps = mergeViewToolPlan(name, args, plan);
            if (!plan.ok) {
                console.warn(
                    `[SPATIAL] VisionPlanner failed for ${name} (${plan.error}); Live x,y fallback.`,
                );
            } else {
                console.log(
                    `[SPATIAL] VisionPlanner plan ${name}: steps=${steps.map((s) => s.name).join('→')} ` +
                        `lastArgs=${JSON.stringify(steps[steps.length - 1]?.args || {}).slice(0, 160)}`,
                );
            }
        } else {
            steps =
                plan.ok && plan.steps.length > 0
                    ? plan.steps
                    : fallbackPlanFromTool(name, args).steps;
            steps = ensureInspectPlan(steps, name);
            if (!plan.ok) {
                console.warn(
                    `[SPATIAL] VisionPlanner failed (${plan.error}); Live tool fallback for ${name}.`,
                );
            }
        }

        const ok = dispatchSpatialPlan(id, name, steps, {
            planner: plan.ok ? plan.source || 'flash-lite' : 'fallback',
            reasoning: plan.reasoning,
            plannerError: plan.error,
            plannerLatencyMs: plan.latencyMs,
            plannerModel: plan.model,
        });
        if (!ok) {
            if (isViewSpatialTool(name)) {
                const direct = spatialBridge.dispatch(id, name, args);
                if (direct) {
                    console.warn(`[SPATIAL] run_plan offline; direct ${name}`);
                    return;
                }
            }
            sendToolResult(id, name, { ok: false, error: 'visualizer_offline' }, 'when_idle');
            onToolPipelineMaybeIdle('spatial-offline');
        }
    } finally {
        // Bridge pending keeps toolsInFlight true after dispatch; if we never dispatched, clear.
        if (!spatialBridge.hasPending() && !browserBridge.hasPending()) {
            toolsBusy = false;
            onToolPipelineMaybeIdle('spatial-plan-end');
        }
    }
}

function dispatchBrowserPlan(
    toolCallId: string,
    originalName: string,
    steps: BrowserStep[],
    meta: Record<string, unknown>,
): boolean {
    return browserBridge.dispatch(toolCallId, 'run_plan', {
        steps,
        originalName,
        ...meta,
    });
}

/** Prefer newest available picture for planners (browser crop only if not stale). */
function newestPlannerFrame(): { jpeg: string | null; mime: string; label: string } {
    const visionAge = lastVisionMeta.ts ? Date.now() - lastVisionMeta.ts : Infinity;
    const browserAge = lastBrowserTs ? Date.now() - lastBrowserTs : Infinity;
    // Browser crop wins only if fresher than FPV (and < 5s old).
    if (
        lastBrowserJpeg &&
        lastBrowserTs > 0 &&
        browserAge < 5000 &&
        (browserAge <= visionAge || !lastVisionJpeg)
    ) {
        return { jpeg: lastBrowserJpeg, mime: lastBrowserMime, label: 'browser-crop' };
    }
    if (lastVisionJpeg) {
        return { jpeg: lastVisionJpeg, mime: lastVisionMime, label: 'fpv-latest' };
    }
    return { jpeg: lastBrowserJpeg, mime: lastBrowserMime, label: 'browser-fallback' };
}

async function handleBrowserToolWithPlanner(functionCall: any) {
    const name = String(functionCall.name);
    const args = (functionCall.args ?? {}) as Record<string, unknown>;
    const id = String(functionCall.id);

    // Multi-step vision plan for use_browser; other tools = one-step Live fallback.
    const wantPlan = shouldUseBrowserPlanner(name);
    // Ensure Live + planners see the absolute latest cached FPV before planning.
    flushNewestVisionToLive('pre-browser-plan');
    const pick = newestPlannerFrame();
    const jpeg = pick.jpeg;
    const mime = pick.mime;

    if (!wantPlan || !jpeg || !browserPlanner.isAvailable()) {
        const plan = fallbackBrowserPlanFromTool(name, args);
        const ok = dispatchBrowserPlan(id, name, plan.steps, {
            planner: plan.source,
            reasoning: plan.reasoning,
        });
        if (!ok) {
            sendToolResult(id, name, { ok: false, error: 'visualizer_offline' }, 'when_idle');
            onToolPipelineMaybeIdle('browser-offline');
        }
        return;
    }

    const goal =
        name === 'use_browser'
            ? String(args.goal || 'Interact with the browser page.')
            : `Execute ${name} with args ${JSON.stringify(args)}`;

    console.log(
        `[BROWSER] Vision planner for ${name} using ${pick.label} ` +
            `(fpvAge=${lastVisionMeta.ts ? Date.now() - lastVisionMeta.ts : '?'}ms ` +
            `browserAge=${lastBrowserTs ? Date.now() - lastBrowserTs : '?'}ms)`,
    );
    const plan = await browserPlanner.planFromFrame({
        jpegBase64: jpeg,
        mimeType: mime,
        goal,
        pageHint: `live tool=${name}; source=${pick.label}; frame ${lastVisionMeta.width}x${lastVisionMeta.height}`,
    });

    const steps =
        plan.ok && plan.steps.length > 0
            ? plan.steps
            : fallbackBrowserPlanFromTool(name, args).steps;

    if (!plan.ok) {
        console.warn(`[BROWSER] Planner failed (${plan.error}); Live fallback for ${name}.`);
    }

    const ok = dispatchBrowserPlan(id, name, steps, {
        planner: plan.ok ? 'browser-er' : 'fallback',
        reasoning: plan.reasoning,
        erError: plan.error,
        erLatencyMs: plan.latencyMs,
    });
    if (!ok) {
        sendToolResult(id, name, { ok: false, error: 'visualizer_offline' }, 'when_idle');
        onToolPipelineMaybeIdle('browser-offline');
    }
}

/** Deduplicate tool call ids within a short window (Live sometimes redelivers). */
const recentToolCallIds = new Set<string>();
const RECENT_TOOL_ID_TTL_MS = 60000;

function claimToolCallId(id: string): boolean {
    if (!id) return true;
    if (recentToolCallIds.has(id)) {
        console.warn(`[AI-TOOL] Duplicate tool call id ignored: ${id}`);
        return false;
    }
    recentToolCallIds.add(id);
    setTimeout(() => recentToolCallIds.delete(id), RECENT_TOOL_ID_TTL_MS);
    return true;
}

/**
 * Reject deprecated browser_click tools — model must use view_click (FPV grid).
 * Still ack so Live does not stall on unknown tool ids.
 */
function rewriteDeprecatedBrowserClicks(functionCalls: any[]): any[] {
    const out: any[] = [];
    for (const fc of functionCalls) {
        const n = String(fc?.name || '');
        if (n === 'browser_click' || n === 'browser_dblclick') {
            console.warn(
                `[BROWSER] Rejected deprecated ${n} id=${fc.id} — use view_click({x,y}) on FPV`,
            );
            try {
                session?.sendToolResponse({
                    functionResponses: [
                        silentToolResponse(fc.id, n, {
                            ok: false,
                            error: 'deprecated_use_view_click',
                            message:
                                'browser_click is deprecated. Use view_click({ x: 0.42, y: 0.61 }) with FPV image coords 0–1 ((0,0)=top-left). ' +
                                'Stand close with inspect_browser first; stay inside browserBounds minX/maxX/minY/maxY.',
                            prefer: 'view_click',
                        }),
                    ],
                });
            } catch (e) {
                console.warn('[BROWSER] Deprecation ack failed:', e);
            }
            if (fc.id) claimToolCallId(String(fc.id));
            continue;
        }
        out.push(fc);
    }
    return out;
}

function handleToolCalls(functionCalls: any[]) {
    const immediateResponses: any[] = [];
    let anyAsyncTool = false;

    // Drop deprecated browser_click (acks with use view_click)
    const calls = rewriteDeprecatedBrowserClicks(functionCalls);

    for (const functionCall of calls) {
        const id = String(functionCall.id || '');
        if (id && !claimToolCallId(id)) {
            continue;
        }

        console.log(`[AI-TOOL] ${functionCall.name} args:`, JSON.stringify(functionCall.args));

        if (functionCall.name === 'set_emotion') {
            immediateResponses.push(handleSetEmotion(functionCall));
            continue;
        }

        if (isSpatialTool(functionCall.name)) {
            anyAsyncTool = true;
            markToolsBusyFromToolCall();
            // Fire-and-forget async planner+dispatch (does not block other tools).
            handleSpatialToolWithPlanner(functionCall).catch((e) => {
                console.error('[SPATIAL] Planner dispatch error:', e);
                sendToolResult(
                    String(functionCall.id),
                    String(functionCall.name),
                    { ok: false, error: String(e?.message ?? e) },
                    'when_idle',
                );
                onToolPipelineMaybeIdle('spatial-error');
            });
            continue;
        }

        if (isBrowserTool(functionCall.name) || functionCall.name === 'use_browser') {
            anyAsyncTool = true;
            markToolsBusyFromToolCall();
            handleBrowserToolWithPlanner(functionCall).catch((e) => {
                console.error('[BROWSER] Planner dispatch error:', e);
                sendToolResult(
                    String(functionCall.id),
                    String(functionCall.name),
                    { ok: false, error: String(e?.message ?? e) },
                    'when_idle',
                );
                onToolPipelineMaybeIdle('browser-error');
            });
            continue;
        }

        console.warn(`[AI-TOOL] Unknown tool call: ${functionCall.name}`);
        immediateResponses.push(silentToolResponse(functionCall.id, functionCall.name, {
            ok: false,
            error: 'unknown_tool',
        }));
    }

    if (anyAsyncTool) {
        console.log(
            `[STEER] Tools in flight after toolCall spatial=${spatialBridge.pendingCount()} ` +
                `browser=${browserBridge.pendingCount()} queue=${steerQueue.length}`,
        );
        notifySteerStatus('tools_busy', {});
    }

    if (immediateResponses.length === 0) return;
    try {
        session?.sendToolResponse({ functionResponses: immediateResponses });
    } catch (e) {
        console.error('[AI-TOOL] Failed to send tool response:', e);
    }
}

async function handleModelTurn(message: LiveServerMessage) {
    // Only store handles when explicitly resumable — non-resumable updates are
    // common mid-turn; using them on reconnect causes 1007 invalid argument.
    if (message.sessionResumptionUpdate) {
        const u = message.sessionResumptionUpdate;
        if (u.resumable === true && u.newHandle) {
            sessionResumptionHandle = u.newHandle;
            console.log('[SESSION] Stored new resumption handle.');
        } else if (u.resumable === false) {
            // Server says this checkpoint is not safe — keep prior handle if any.
            console.log('[SESSION] Resumption update not resumable; keeping previous handle.');
        }
    }

    // Handle function/tool calls from the model (e.g. set_emotion).
    // These arrive on message.toolCall, separate from the audio stream.
    if (message.toolCall?.functionCalls?.length) {
        handleToolCalls(message.toolCall.functionCalls);
        return;
    }

    const sc = message.serverContent as any;

    // Barge-in: the Live API sets `interrupted` when the user speaks over the
    // model. Tell the frontend to drop any queued audio and settle the avatar
    // back to idle so a half-finished gesture doesn't freeze mid-air.
    if (sc?.interrupted === true) {
        console.log('[AI] Turn interrupted by user; signalling frontend to stop.');
        modelTurnActive = false;
        voiceChanger.reset();
        if (aiWsClient && aiWsClient.readyState === WebSocket.OPEN) {
            aiWsClient.send(JSON.stringify({ type: 'interrupted' }));
        }
        // Do not clear tool bridges or steer queue — tools may still complete;
        // steers flush when tools go idle (or next accept path).
        return;
    }

    // Handle audio chunks from modelTurn
    if (sc?.modelTurn?.parts) {
        // First audio of a new turn: drop leftover caption from prior reply
        if (!modelTurnActive) {
            currentGlobalCaption = '';
            lastLoggedCaption = '';
        }
        modelTurnActive = true;
        for (const part of sc.modelTurn.parts) {
            if (part?.inlineData && part.inlineData.data) {
                const pcmBuffer = Buffer.from(part.inlineData.data, 'base64');
                voiceChanger.process(pcmBuffer);
            }
        }
    }

    // Handle output transcription (captions) — accumulate incrementally
    if (sc?.outputTranscription?.text) {
        currentGlobalCaption += sc.outputTranscription.text;

        if (aiWsClient && aiWsClient.readyState === WebSocket.OPEN) {
            aiWsClient.send(JSON.stringify({
                type: 'caption',
                text: currentGlobalCaption
            }));
        }
    }

    // turnComplete = the model just truly finished speaking this turn
    if (sc?.turnComplete === true) {
        modelTurnActive = false;
        voiceChanger.reset();
        const capturedCaption = currentGlobalCaption.trim();
        // Dedupe: late/duplicate turnComplete must not re-print the same line
        if (capturedCaption && capturedCaption !== lastLoggedCaption) {
            lastLoggedCaption = capturedCaption;
            console.log(`[AI]: ${capturedCaption}`);

            loadHistory().then(history => {
                history.push({ role: 'model', text: capturedCaption, timestamp: new Date().toISOString() });
                saveHistory(history);
            });

            if (captionClearTimeout) clearTimeout(captionClearTimeout);
            // Hold caption on screen for 3s, then clear buffer
            captionClearTimeout = setTimeout(() => {
                currentGlobalCaption = "";
                if (aiWsClient && aiWsClient.readyState === WebSocket.OPEN) {
                    aiWsClient.send(JSON.stringify({ type: 'caption', text: '' }));
                }
            }, 3000);
        } else if (!capturedCaption) {
            // Empty complete — still clear flags so UI doesn't stick
            currentGlobalCaption = '';
        }
        // If tools already idle, promote any queued steers as the next guidance.
        onToolPipelineMaybeIdle('turn-complete');
    }

    // Mic transcription is already consumed by Live as audio — only log (do not
    // re-inject as text or we would duplicate the user's utterance).
    if (sc?.inputTranscription?.text) {
        console.log(`[USER-MIC]: ${sc.inputTranscription.text}`);
    }
}

// Start the sequence
startAiServer();
