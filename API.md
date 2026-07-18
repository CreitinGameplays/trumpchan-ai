# VRoid Visualizer API Documentation

The VRoid Visualizer exposes an HTTP server and a WebSocket connection for interacting with the 3D VRM model in real time. The backend API server listens on port `3000`.

## Architecture
- **HTTP Server**: Accepts `POST` requests to trigger commands.
- **WebSocket Server (`ws://localhost:3000`)**: The visualizer connects to this WebSocket to receive the commands continuously. Sending a POST to the HTTP Server automatically broadcasts the command to all connected WebSocket frontend visualization clients.

---

## Endpoint: Command API

**`POST /api/command`**

This endpoint accepts a JSON body containing a command to execute on the model.

### 1. Set Expression

Changes the model's facial expression/blendshape. Standard VRM expressions include `aa`, `ee`, `ih`, `oh`, `ou`, `blink`, `joy`, `angry`, `sorrow`, `fun`.

**Request Body:**
```json
{
  "type": "expression",
  "expression": "aa",
  "value": 1.0
}
```
- `expression` (String): The name of the expression preset.
- `value` (Number): The weight of the expression, usually from `0.0` (off) to `1.0` (fully active).

### 1b. Set Emotion (AI-driven)

Sets a native VRM emotion preset on the avatar's face, blended smoothly over a few frames so it eases between moods instead of snapping. This is the command the AI drives in real time through the Gemini Live `set_emotion` function call, but it can also be sent manually.

Only one emotion is active at a time; sending a new emotion eases the previous one out. Lip-sync (`aa`, `ee`, `ih`, `oh`, `ou`) and blinking are handled independently, so they are never overridden by emotions.

**Request Body:**
```json
{
  "type": "emotion",
  "emotion": "happy",
  "intensity": 1.0,
  "duration": 2.0
}
```
- `emotion` (String): One of `happy`, `angry`, `sad`, `relaxed`, `surprised`, or `neutral`. `neutral` clears any active emotion back to a resting face. Unknown values are ignored by the visualizer.
- `intensity` (Number, optional): Expression weight from `0.0` to `1.0`. Defaults to `1.0`. Use a lower value (e.g. `0.5`) for a subtle look.
- `duration` (Number, **required** for AI function calls): Seconds to hold the expression before it automatically eases back to `neutral`. Must be greater than `0`; if the AI omits it or passes a value `<= 0`, the server falls back to a default of `2` seconds.

> Note: The AI emits these via a Gemini Live **function call** (`set_emotion`) rather than inline text tags. This keeps expression control fully separate from the spoken audio so it never corrupts or interrupts the TTS stream. Tool responses are sent back with `SILENT` scheduling and the function is declared `NON_BLOCKING`.

### 2. Look At Target

Overrides the model's natural gaze to make it look at a specific 3D coordinate in the world space.

**Request Body:**
```json
{
  "type": "lookAt",
  "target": {
    "x": 2.0,
    "y": 1.5,
    "z": 2.0
  }
}
```
- `target` (Object): The `x, y, z` world coordinates where the model should point its eyes and head.

### 3. Load VRM

Loads an entirely new VRM model into the scene.

**Request Body:**
```json
{
  "type": "loadVrm",
  "url": "/path/to/model.vrm"
}
```
- `url` (String): URL resolving to a valid `.vrm` valid.

### 4. Load Animation

Loads a new Mixamo `.fbx` animation for the model.

**Request Body:**
```json
{
  "type": "loadAnimation",
  "url": "/path/to/animation.fbx"
}
```
- `url` (String): URL resolving to a valid Mixamo `.fbx` animation file.

### 5. Reset Position

Resets the model's position back to the origin, which is useful if the model has drifted due to walking/root-motion animations.

**Request Body:**
```json
{
  "type": "resetPosition"
}
```

---

## Vision (Live Scene Streaming)

The avatar has always-on vision. The app streams live images of the whole scene to the Gemini Live API so the model can literally *see* its 3D room, itself, and the content of the floating in-scene browser window. This is real image understanding via the model's vision, not URL fetching or DOM scraping.

### Pipeline

1. **Capture (Electron main process, `electron/main.js`)** — A timer calls `webContents.capturePage()` on the main window at ~1 FPS. Because Electron composites the WebGL 3D canvas and the `<webview>` browser into one surface, a single capture contains the avatar, the room, and whatever page the floating browser is showing. Each frame is downscaled to ≤768px on the longest side and JPEG-encoded (quality 70).
2. **Transport** — The main process opens its own WebSocket to the hub (`ws://localhost:3000`) and broadcasts each frame as a `visionFrame` message.
3. **Forward (`backend/ai-server.ts`)** — The AI server receives `visionFrame`, throttles to ~1 FPS, and forwards it to Gemini via `session.sendRealtimeInput({ video: { data, mimeType } })`.

> Vision requires Electron (`npm run dev:electron`). In a plain browser tab there is no `capturePage`, so no frames are streamed.

### `visionFrame` (WebSocket message)

Sent by the Electron main process into the hub; consumed by the AI server.
```json
{
  "type": "visionFrame",
  "mimeType": "image/jpeg",
  "data": "<base64-encoded JPEG>",
  "width": 768,
  "height": 480,
  "ts": 1718900000000
}
```
- `data` (String): Base64-encoded JPEG of the full composited window.
- `mimeType` (String): Image MIME type (always `image/jpeg`).
- `width` / `height` (Number): Pixel dimensions of the sent frame.
- `ts` (Number): Capture timestamp (ms since epoch).

> Browser interactions are silent: loading a page or navigating in the in-scene browser does **not** send any message to the AI and never triggers a response. The AI still passively sees whatever page is on screen through the vision frames above, but it only reacts when the user actually speaks or types.

### Session configuration notes

Because audio+video Live sessions are capped at **2 minutes** without compression, the AI server enables:
- **`contextWindowCompression`** (sliding window) so the session runs indefinitely.
- **`sessionResumption`** so the ~10-minute connection resets don't drop conversation state.

### Reconnect / error handling

The server auto-reconnects with exponential backoff when the Live connection drops:
- **Backoff** only resets after a session has stayed open longer than 15s, so a connect-then-immediately-die loop keeps backing off instead of hammering the API.
- **Close code `1007`** (`Request contains an invalid argument`) on `gemini-3.1-flash-live-preview` is a known stale-resumption-handle/context problem. Retrying with the same handle reproduces it forever, so the server **drops the resumption handle and reconnects fresh** on 1007. These closes are excluded from the vision circuit breaker.
- **Vision circuit breaker**: if non-1007 closes burst rapidly (4 within 60s) while video is streaming, the server disables vision frame forwarding to keep audio/text alive, then requires a restart to re-enable vision.
