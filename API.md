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
- `duration` (Number, **required** for AI function calls): Seconds to hold the expression before it automatically eases back to `neutral`. Set to `0` to hold indefinitely until the next emotion command. When sending the command manually over HTTP it may be omitted, in which case it defaults to `0`.

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
