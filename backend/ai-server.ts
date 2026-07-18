import { GoogleGenAI, LiveServerMessage, Modality, MediaResolution, Session, Type, Behavior, FunctionResponseScheduling } from '@google/genai';
import * as fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import WebSocket from 'ws';
import { VoiceChanger } from './voice-changer.js';

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

// VRM native expression presets the avatar can display in real time.
// These map 1:1 to @pixiv/three-vrm VRMExpressionPresetName emotion presets.
const VALID_EMOTIONS = ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised'] as const;

// Function-call tools exposed to the model. We use NON_BLOCKING behaviour so the
// emote calls never pause/interrupt the audio (TTS) generation. Parsing emotes
// out of the spoken text would break the TTS, so we rely on tool calls instead.
const aiTools = [
    {
        functionDeclarations: [
            {
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
            },
        ],
    },
];

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
    return {
        responseModalities: [Modality.AUDIO],
        outputAudioTranscription: {},
        inputAudioTranscription: {},
        // Low thinking mode: give the model a small reasoning budget so it can
        // briefly reason (e.g. pick the right emotion / tool call) without adding
        // noticeable latency to the live audio. Set to 0 to fully disable.
        thinkingConfig: {
            thinkingBudget: 0 // setting this to a higher value cause a bug in the model that makes it output "<ctrl46><ctrl46>" every turn.
        },
        mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
        speechConfig: {
            voiceConfig: {
                prebuiltVoiceConfig: {
                    voiceName: 'Laomedeia',
                }
            }
        },
        systemInstruction: {
            parts: [{ text: geminiSysInstruction }]
        },
        tools: aiTools,
        // Vision is always on: the frontend streams ~1 FPS video frames of the
        // whole scene (avatar + floating browser). Audio+video sessions are
        // capped at 2 minutes WITHOUT compression, so we MUST enable context
        // window compression (sliding window) to keep the session alive.
        contextWindowCompression: {
            triggerTokens: '16000',
            slidingWindow: { targetTokens: '4000' },
        },
        // The Live connection resets roughly every 10 minutes and the native-audio
        // preview model also throws intermittent 1011 "internal errors". Session
        // resumption lets us reconnect and continue the same conversation.
        // Passing a stored handle (if any) resumes the previous session.
        sessionResumption: sessionResumptionHandle
            ? { handle: sessionResumptionHandle }
            : {},
    };
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

            // NOTE: Browser interactions (page loads / navigation) must NOT
            // trigger the AI. We deliberately do not accept any grounding-text
            // message here, so loading a webpage never provokes a response. The
            // AI still passively sees the page via the vision frames above and
            // only reacts when the user actually speaks/types.
        } catch (e) {
            console.error('Error handling WS command from main Server', e);
        }
    });

    aiWsClient.on('close', () => {
        console.log("Disconnected from Main API WebSockets. Quitting AI.");
        process.exit();
    });
}

function handleToolCalls(functionCalls: any[]) {
    const functionResponses = functionCalls.map((functionCall) => {
        console.log(`[AI-TOOL] ${functionCall.name} args:`, JSON.stringify(functionCall.args));

        if (functionCall.name === 'set_emotion') {
            const rawEmotion = String(functionCall.args?.emotion ?? '').toLowerCase().trim();
            const emotion = (VALID_EMOTIONS as readonly string[]).includes(rawEmotion)
                ? rawEmotion
                : 'neutral';

            // Clamp intensity to [0, 1], default to full expression.
            let intensity = Number(functionCall.args?.intensity);
            if (!Number.isFinite(intensity)) intensity = 1.0;
            intensity = Math.max(0, Math.min(1, intensity));

            // Duration in seconds to hold before auto-reverting to neutral.
            // Must be greater than 0; if omitted/invalid/<=0, fall back to a
            // sensible default so the expression always eases back on its own.
            const DEFAULT_EMOTION_DURATION = 2;
            let duration = Number(functionCall.args?.duration);
            if (!Number.isFinite(duration) || duration <= 0) duration = DEFAULT_EMOTION_DURATION;

            if (rawEmotion !== emotion) {
                console.warn(`[AI-TOOL] Unknown emotion "${rawEmotion}", falling back to "neutral".`);
            }

            // Forward the emotion to the frontend visualizer over WebSocket.
            if (aiWsClient && aiWsClient.readyState === WebSocket.OPEN) {
                aiWsClient.send(JSON.stringify({
                    type: 'emotion',
                    emotion,
                    intensity,
                    duration,
                }));
                console.log(`[AI-TOOL] Sent emotion "${emotion}" (intensity ${intensity}, duration ${duration}s) to visualizer.`);
            } else {
                console.warn('[AI-TOOL] Visualizer WS not connected; emotion not delivered.');
            }
        } else {
            console.warn(`[AI-TOOL] Received unknown tool call: ${functionCall.name}`);
        }

        // Respond SILENT so the tool result never triggers extra model output
        // and never interrupts the ongoing audio (TTS) stream.
        return {
            id: functionCall.id,
            name: functionCall.name,
            response: { result: 'ok' },
            scheduling: FunctionResponseScheduling.SILENT,
        };
    });

    try {
        session?.sendToolResponse({ functionResponses });
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
