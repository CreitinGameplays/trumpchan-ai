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
                                "back to the neutral resting face. Use a short value for brief reactions (e.g. 2 for a " +
                                "quick surprised gasp) and a larger value to sustain a mood. Set to 0 to hold the " +
                                "expression indefinitely until you change it again.",
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

async function startAiServer() {
    console.log("Starting Gemini Live AI WebSocket Proxy...");
    const ai = new GoogleGenAI({ apiKey: geminiapiKey });
    const model = 'models/gemini-2.5-flash-native-audio-preview-12-2025';

    let sysInstruction = "You are a friendly VTuber named Trumpchan. Keep your responses engaging, short, and conversational.";
    try {
        sysInstruction = await fs.readFile('./SYSTEM.txt', 'utf-8');
    } catch (e) {
        console.log("SYSTEM.txt not found, using default instructions.");
    }

    const config: any = {
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
            parts: [{ text: sysInstruction }]
        },
        tools: aiTools,
    };

    try {
        session = await ai.live.connect({
            model,
            config,
            callbacks: {
                onopen: () => console.log('Gemini Live API: Connected successfully!'),
                onmessage: (msg: LiveServerMessage) => handleModelTurn(msg),
                onerror: (e) => console.error('Gemini Live API Error:', e),
                onclose: (e) => console.log('Gemini Live API Closed:', e)
            }
        });
    } catch (error) {
        console.error("Failed to connect to Gemini API:", error);
        return;
    }

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
            if (cmd.type === 'chatMessage' && cmd.text && session) {
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

                // Queue to Gemini Live
                session.sendClientContent({
                    turns: [cmd.text]
                });
            }
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
            // 0 (or omitted/invalid) means hold indefinitely.
            let duration = Number(functionCall.args?.duration);
            if (!Number.isFinite(duration) || duration < 0) duration = 0;

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
