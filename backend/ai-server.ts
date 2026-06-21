import { GoogleGenAI, LiveServerMessage, Modality, MediaResolution, Session } from '@google/genai';
import * as fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import WebSocket from 'ws';

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

const responseQueue: LiveServerMessage[] = [];
let currentGlobalCaption = "";
let captionClearTimeout: any = null;

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
        thinkingConfig: {
            thinkingBudget: 0
        },
        mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
        speechConfig: {
            voiceConfig: {
                prebuiltVoiceConfig: {
                    voiceName: 'Zephyr',
                }
            }
        },
        systemInstruction: {
            parts: [{ text: sysInstruction }]
        },
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

async function handleModelTurn(message: LiveServerMessage) {
    const sc = message.serverContent as any;

    // Handle audio chunks from modelTurn
    if (sc?.modelTurn?.parts) {
        for (const part of sc.modelTurn.parts) {
            if (part?.inlineData && part.inlineData.data) {
                if (aiWsClient && aiWsClient.readyState === WebSocket.OPEN) {
                    aiWsClient.send(JSON.stringify({
                        type: 'audio',
                        data: part.inlineData.data
                    }));
                }
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
    if (sc?.turnComplete === true && currentGlobalCaption.trim() !== '') {
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

    // Handle input transcription (log what user said via mic, if ever used)
    if (sc?.inputTranscription?.text) {
        console.log(`[USER-MIC]: ${sc.inputTranscription.text}`);
    }
}

// Start the sequence
startAiServer();
