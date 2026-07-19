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
    fallbackPlanFromTool,
    type SpatialStep,
} from './tools/robotics-planner.js';

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

// Reusable connection config builder (needs the AI client + system prompt).
let geminiClient: GoogleGenAI | undefined = undefined;
let geminiModel = '';
let geminiSysInstruction = '';

// Lightweight throttle + logging counters for the incoming vision stream.
let lastVisionFrameAt = 0;
let visionFrameCount = 0;
// Latest JPEG frame for Robotics-ER planning (base64, no data: prefix).
let lastVisionJpeg: string | null = null;
let lastVisionMime = 'image/jpeg';
let lastVisionMeta = { width: 0, height: 0 };

const roboticsPlanner = new RoboticsSpatialPlanner();

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
        ],
    },
];

/** Emotion: SILENT. Spatial: WHEN_IDLE so the model can narrate after moving. */
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
        const fr =
            mode === 'when_idle'
                ? spatialToolResponse(id, name, response)
                : silentToolResponse(id, name, response);
        session.sendToolResponse({ functionResponses: [fr] });
        console.log(`[AI-TOOL] Result ${name} (${mode}):`, JSON.stringify(response));
    } catch (e) {
        console.error('[AI-TOOL] Failed to send tool result:', e);
    }
}

const spatialBridge = new SpatialToolBridge(
    () => aiWsClient,
    (id, name, response) => sendToolResult(id, name, response, 'when_idle'),
);

const responseQueue: LiveServerMessage[] = [];
let currentGlobalCaption = "";
let captionClearTimeout: any = null;

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
        // MINIMAL keeps latency low while still allowing tool use.
        thinkingConfig: {
            thinkingLevel: ThinkingLevel.MINIMAL,
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
                    console.log(
                        sessionResumptionHandle
                            ? 'Gemini Live API: Reconnected (resumed session).'
                            : 'Gemini Live API: Connected successfully!'
                    );
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

                    // 1007 "invalid argument" on gemini-3.1-flash-live-preview is a
                    // known resumption-handle/context problem: retrying with the SAME
                    // handle reproduces it forever. Drop the handle and reconnect
                    // fresh. This is NOT a video-rejection, so don't count it toward
                    // the vision circuit breaker.
                    if (code === 1007) {
                        console.warn(`Gemini Live API Closed (code 1007): ${reason}. Dropping stale resumption handle and reconnecting fresh.`);
                        sessionResumptionHandle = undefined;
                    } else {
                        console.warn(`Gemini Live API Closed (code ${code}): ${reason}. Scheduling reconnect...`);
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

            // Only process incoming user chat messages
            if (cmd.type === 'chatMessage' && cmd.text) {
                if (!geminiReady || !session) {
                    console.warn('[USER] Dropped chat message: Gemini session not ready.');
                    return;
                }
                console.log(`[USER]: ${cmd.text}`);

                // Reset caption for a new turn
                currentGlobalCaption = "";
                if (aiWsClient && aiWsClient.readyState === WebSocket.OPEN) {
                    aiWsClient.send(JSON.stringify({ type: 'caption', text: '' }));
                }

                // Track in history
                const history = await loadHistory();
                history.push({ role: 'user', text: cmd.text, timestamp: new Date().toISOString() });
                await saveHistory(history);

                // Queue to Gemini Live. On the Gemini 3.x Live models,
                // sendClientContent is only for seeding initial history;
                // mid-conversation text must be sent via sendRealtimeInput.
                try {
                    session.sendRealtimeInput({ text: cmd.text });
                } catch (e) {
                    console.error('[USER] Failed to send chat to Gemini:', e);
                }
            }

            // Live vision frames from the Electron capture loop. Each frame is
            // the full composited window (3D avatar + the floating browser and
            // whatever page it shows), so the model can actually SEE the scene.
            else if (cmd.type === 'visionFrame' && cmd.data) {
                // Silently drop frames while the session is down/reconnecting -
                // sending into a closed session is what killed the socket before.
                if (!geminiReady || !session) return;
                // Respect the circuit breaker: if vision was disabled after a
                // burst of failures, stop forwarding frames entirely.
                if (!visionEnabled) return;

                const now = Date.now();
                // Safety throttle: never forward faster than ~1 FPS even if the
                // client bursts frames (the Live API only accepts ~1 FPS video).
                if (now - lastVisionFrameAt < 900) {
                    return;
                }
                lastVisionFrameAt = now;
                visionFrameCount++;
                // Cache for Robotics-ER spatial planning (primary navigation brain).
                lastVisionJpeg = String(cmd.data);
                lastVisionMime = cmd.mimeType || 'image/jpeg';
                lastVisionMeta = {
                    width: Number(cmd.width) || 0,
                    height: Number(cmd.height) || 0,
                };

                try {
                    session.sendRealtimeInput({
                        video: {
                            data: cmd.data,
                            mimeType: cmd.mimeType || 'image/jpeg',
                        },
                    });
                    // Log sparingly so we don't spam the console every second.
                    if (visionFrameCount === 1 || visionFrameCount % 15 === 0) {
                        console.log(`[VISION] Forwarded frame #${visionFrameCount} to Gemini (${cmd.width}x${cmd.height}).`);
                    }
                } catch (e) {
                    console.error('[VISION] Failed to forward frame to Gemini:', e);
                }
            }

            // Frontend finished a spatial tool (walk/turn/look/etc.).
            // Result includes pose/distances for closed-loop navigation.
            else if (cmd.type === 'spatialResult' && cmd.id && cmd.name) {
                const pending = spatialBridge.resolvePending(String(cmd.id));
                if (!pending) {
                    console.warn('[SPATIAL] Unexpected result for id', cmd.id);
                    return;
                }
                const result =
                    cmd.result && typeof cmd.result === 'object'
                        ? (cmd.result as Record<string, unknown>)
                        : { ok: true, result: cmd.result };
                sendToolResult(String(cmd.id), String(cmd.name), result, 'when_idle');
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

    // Fast path: simple tools never need ER (look/turn/stop/reset).
    if (!shouldUseRoboticsPlanner(name) || !lastVisionJpeg || !roboticsPlanner.isAvailable()) {
        const plan = fallbackPlanFromTool(name, args);
        const ok = dispatchSpatialPlan(id, name, plan.steps, {
            planner: plan.source,
            reasoning: plan.reasoning,
        });
        if (!ok) {
            sendToolResult(id, name, { ok: false, error: 'visualizer_offline' }, 'when_idle');
        }
        return;
    }

    const goal =
        name === 'inspect_browser'
            ? 'Look at / approach the floating browser panel and get ready to describe the page.'
            : name === 'walk_toward'
              ? `Walk toward ${String(args.target || 'browser')}.`
              : name === 'walk'
                ? `Walk ${String(args.direction || 'forward')} for a short step.`
                : `Execute spatial action ${name} with args ${JSON.stringify(args)}`;

    console.log(`[SPATIAL] Robotics-ER primary plan for ${name}…`);
    const plan = await roboticsPlanner.planFromFrame({
        jpegBase64: lastVisionJpeg,
        mimeType: lastVisionMime,
        goal,
        sceneHint: `frame ${lastVisionMeta.width}x${lastVisionMeta.height}; live tool was ${name}`,
    });

    const steps =
        plan.ok && plan.steps.length > 0
            ? plan.steps
            : fallbackPlanFromTool(name, args).steps;

    if (!plan.ok) {
        console.warn(`[SPATIAL] ER failed (${plan.error}); using Live tool fallback for ${name}.`);
    }

    const ok = dispatchSpatialPlan(id, name, steps, {
        planner: plan.ok ? 'robotics-er' : 'fallback',
        reasoning: plan.reasoning,
        erError: plan.error,
        erLatencyMs: plan.latencyMs,
    });
    if (!ok) {
        sendToolResult(id, name, { ok: false, error: 'visualizer_offline' }, 'when_idle');
    }
}

function handleToolCalls(functionCalls: any[]) {
    const immediateResponses: any[] = [];

    for (const functionCall of functionCalls) {
        console.log(`[AI-TOOL] ${functionCall.name} args:`, JSON.stringify(functionCall.args));

        if (functionCall.name === 'set_emotion') {
            immediateResponses.push(handleSetEmotion(functionCall));
            continue;
        }

        if (isSpatialTool(functionCall.name)) {
            // Fire-and-forget async planner+dispatch (does not block other tools).
            handleSpatialToolWithPlanner(functionCall).catch((e) => {
                console.error('[SPATIAL] Planner dispatch error:', e);
                sendToolResult(
                    String(functionCall.id),
                    String(functionCall.name),
                    { ok: false, error: String(e?.message ?? e) },
                    'when_idle',
                );
            });
            continue;
        }

        console.warn(`[AI-TOOL] Unknown tool call: ${functionCall.name}`);
        immediateResponses.push(silentToolResponse(functionCall.id, functionCall.name, {
            ok: false,
            error: 'unknown_tool',
        }));
    }

    if (immediateResponses.length === 0) return;
    try {
        session?.sendToolResponse({ functionResponses: immediateResponses });
    } catch (e) {
        console.error('[AI-TOOL] Failed to send tool response:', e);
    }
}

async function handleModelTurn(message: LiveServerMessage) {
    // Track the latest session resumption handle so we could reconnect
    // transparently after the Live API resets the connection (~10 min).
    if (message.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate.newHandle) {
        sessionResumptionHandle = message.sessionResumptionUpdate.newHandle;
        console.log('[SESSION] Stored new resumption handle.');
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
        voiceChanger.reset();
        if (aiWsClient && aiWsClient.readyState === WebSocket.OPEN) {
            aiWsClient.send(JSON.stringify({ type: 'interrupted' }));
        }
        return;
    }

    // Handle audio chunks from modelTurn
    if (sc?.modelTurn?.parts) {
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
        voiceChanger.reset();
        if (currentGlobalCaption.trim() !== '') {
            console.log(`[AI]: ${currentGlobalCaption.trim()}`);

            // Save turn to memory
            const capturedCaption = currentGlobalCaption.trim();
            loadHistory().then(history => {
                history.push({ role: 'model', text: capturedCaption, timestamp: new Date().toISOString() });
                saveHistory(history);
            });

            // Clear any stale rolling timeout
            if (captionClearTimeout) clearTimeout(captionClearTimeout);

            // Hold caption on screen for 3s after AI stops, then hide
            captionClearTimeout = setTimeout(() => {
                currentGlobalCaption = "";
                if (aiWsClient && aiWsClient.readyState === WebSocket.OPEN) {
                    aiWsClient.send(JSON.stringify({ type: 'caption', text: '' }));
                }
            }, 3000);
        }
    }

    // Handle input transcription (log what user said via mic, if ever used)
    if (sc?.inputTranscription?.text) {
        console.log(`[USER-MIC]: ${sc.inputTranscription.text}`);
    }
}

// Start the sequence
startAiServer();
