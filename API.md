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
