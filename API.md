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

Sets the **base (idle) layer** Mixamo `.fbx` animation for the model. The base layer is what plays while the avatar is *not* speaking (idle, walking, dancing, etc.). It cross-fades in over the current base and never snaps.

**Request Body:**
```json
{
  "type": "loadAnimation",
  "url": "/path/to/animation.fbx"
}
```
- `url` (String): URL resolving to a valid Mixamo `.fbx` animation file.

> The co-speech **talking gesture layer** is separate and automatic (see [Talking Gestures](#talking-gestures)); it plays on top of the base layer whenever the AI is speaking and does not need an API call.

### 5. Reset Position

Resets the model's position back to the origin, which is useful if the model has drifted due to walking/root-motion animations.

**Request Body:**
```json
{
  "type": "resetPosition"
}
```

---

## Talking Gestures

Co-speech hand/body gestures are handled automatically on the frontend (`src/gestureSystem.js`) — no API calls required. Motion is **generated at runtime from a library of target keyposes**, blended in time with the avatar's speech, rather than replayed from pre-made talking clips. Pre-made clips animate the arms *constantly* (excessive on simple replies); this approach lets gesture density **emerge from the speech**, so a calm reply gets a couple of sparse gestures while an animated, loud passage gestures more.

This mirrors how real co-speech-motion systems are structured (e.g. the "plan-then-infill" split of semantic keyposes + prosody-driven timing): pick a *readable pose*, then time it to the voice.

### How it works

- A `GestureController` owns a single `AnimationMixer` for the **base layer** (the persistent idle/walk/etc. clip set via [Load Animation](#4-load-animation)) and applies an **additive gesture layer** on top.
- **Keypose library** (`POSES`): each entry is a real, readable gesture — `raiseHand`, `openPalmOut`, `pointUp`, `toChest`, `chopDown`, `shrug`, `bigSpread`, `relaxedTalk` — authored as target joint angles for the right side (auto-mirrored to the left). Poses include a **hand shape** (`open` / `relaxed` / `point`) that curls the finger bones.
- **Gesture envelope**: while speaking, the controller picks a pose and plays it through **attack → hold → release** (ease-in with slight overshoot, brief sustain, ease-out back to idle). The next gesture is **not** on a timer: it waits for a prosodic onset (loudness rise) after a minimum rest floor, and sometimes skips an onset entirely. Density is therefore irregular and sparse — matching how real co-speech gestures cluster around emphasis rather than ticking at fixed intervals.
- **Accent beats**: **loudness onsets** (rising edges in the speech envelope = emphasis) fire small spring-driven elbow/wrist flicks *on top of* the held pose, so a sustained gesture stays alive and syncs to vocal stress.
- **Sway**: a tiny continuous sway keeps a held pose breathing rather than frozen.
- **Speech detection** comes from the audio playback schedule (the frontend knows when queued PCM is still playing). On speech start the layer eases in; on speech end the active gesture releases and the layer eases out to the pure idle pose.
- **Mood coupling**: the current emotion (from [Set Emotion](#1b-set-emotion-ai-driven)) selects an energy **tier** (`angry`/`happy`/`surprised` → high, `sad`/`relaxed` → low) that biases pose selection, hold length, and rest gaps. Smoothed speech loudness shortens gaps and scales accents.
- **Mostly one-handed**: natural co-speech is predominantly unimanual; two-handed poses (`shrug`, `bigSpread`) are rare and gated on high energy + loud speech + a long cooldown, so "both arms up" does not fire out of context.
- All offsets are composed on top of whatever pose the base clip produces using the same post-multiply technique as the head-idle layer, on the VRM **normalized** humanoid bones (T-pose = identity), so poses are model-independent and never fight the base animation or snap to a T-pose.
- **Rest-pose rebuild (no drift)**: offsets are composed as `finalRotation = baseRotation × offset` each frame. Bones the base clip animates (arms) are refreshed by the mixer; bones it does **not** animate are reset to a cached rest rotation every frame before offsetting. Without this, additive offsets on un-animated bones compound frame over frame and stick. The layer detects which bones the current clip drives via its track names and only resets the rest.
- **Fingers are never retargeted**: Mixamo→VRM finger retargeting is unreliable — the two skeletons have different finger rest poses, so the retargeted *absolute* rotation planted the fingers in a fixed twisted/backward pose that also stuck after speech (the bones counted as "animated", so the rest-rebuild skipped them). `loadMixamoAnimation` now drops all finger tracks (`excludeFingers`, default on); Mixamo idle finger motion is only a couple of degrees anyway. Fingers therefore sit in the VRM's natural rest pose and are posed exclusively by the gesture layer's hand shapes, which compose cleanly. Curl is a rotation about **Z** in normalized space, **negative on the left / positive on the right** (fingers extend along ±X with palm down per the VRM T-pose spec, so flexion into the palm is −Y).
- **Body-midline guard**: to keep a hand from crossing *through* the body, each hand is constrained to its own side. The lateral (shoulder-to-shoulder) axis is measured from the live rig each frame, and the wrist's signed offset from the body centre is checked; if a hand crosses past a small inner allowance toward the far side, that arm is abducted outward (integral correction, driven until the hand clears) and relaxed once it's back. This is convention-free (axes come from the rig, not guessed) and side/pose/animation-independent. A resting arm hangs well on its own side, so the guard never fires at rest — unlike a fat torso capsule, which can't distinguish a resting arm from a hand crossing the chest.

### Tuning

Everything is driven by named constants / tables at the top of `src/gestureSystem.js`:
- `POSES` — the gesture library. Add a pose by listing its DOFs (`armRaise`, `armOut`, `elbowBend`, `wristPitch`, ...), a `tier`, an optional `twoHand`, and a `fingers` shape.
- `DOF_AXIS` — maps each DOF to a bone + local axis + per-side sign. **If a joint bends the wrong way on your rig, flip its sign here** (one line).
- `ATTACK_RANGE` / `HOLD_RANGE` / `RELEASE_RANGE` / `GAP_BY_TIER` — gesture timing and how sparse each tier is. Longer attack/release = softer, slower reach and relax. `easeOutBack`'s `c1` sets how much the reach overshoots (small = glides in, large = snappy).
- `WEIGHT_RAMP_UP` / `WEIGHT_RAMP_DOWN` — how fast the whole gesture layer fades in/out with speech. Lower = softer.
- `SPRING_STIFFNESS` / `SPRING_DAMPING` / `SWAY_AMOUNT` — accent-beat springiness and idle breathing. Lower stiffness + higher damping = gentler beats; smaller sway = calmer hold.
- `FINGER_SHAPES` / `FINGER_CURL_AXIS` / `FINGER_CURL_SIGN` — hand shapes and curl direction (Z axis; `{ left: -1, right: 1 }`). Flip a sign only if a specific rig splays fingers outward instead of curling into the palm.
- `excludeFingers` (option to `loadMixamoAnimation`, default `true`) — drop finger tracks from a retargeted clip. Leave on for co-speech gestures; set `false` only if you have a clip whose finger animation retargets cleanly and you want to keep it.
- `ONSET_DELTA_THRESHOLD` / `ACCENT_KICK` — emphasis sensitivity and accent strength.
- `MIDLINE_ALLOWANCE_SCALE` / `PUSH_OUT_GAIN` / `PUSH_OUT_MAX` / `PUSH_OUT_RELAX` — the body-midline guard: how far past centre a hand may reach, and how firmly/smoothly a crossing hand is pushed back out and relaxed. `DEBUG_COLLISION` logs crossing events for tuning.

No animation assets are required for gestures; the `files/talking_animations/` clips are no longer used.

## Outgoing Messages (server → frontend)

Beyond `audio`, `caption`, and `emotion`, the server emits:

### `interrupted`

Sent when the Gemini Live API reports the user barged in over the model (`serverContent.interrupted`). The frontend drops any queued audio and fast-settles the avatar's body back to idle so a half-finished gesture never freezes mid-air.

```json
{ "type": "interrupted" }
```

---

## Vision (Live Scene Streaming)

The avatar has always-on vision. The app streams live images of the whole scene to the Gemini Live API so the model can literally *see* its 3D room, itself, and the content of the floating in-scene browser window. This is real image understanding via the model's vision, not URL fetching or DOM scraping.

### Pipeline

1. **Capture (Electron main process, `electron/main.js`)** — A timer calls `webContents.capturePage()` on the main window at ~1 FPS. Because Electron composites the WebGL 3D canvas and the `<webview>` browser into one surface, a single capture contains the avatar, the room, and whatever page the floating browser is showing. Each frame is downscaled to ≤1024px on the longest side and JPEG-encoded (quality 88) so browser text/UI stays readable.
2. **Transport** — The main process opens its own WebSocket to the hub (`ws://localhost:3000`) and broadcasts each frame as a `visionFrame` message.
3. **Forward (`backend/ai-server.ts`)** — The AI server receives `visionFrame`, throttles to ~1 FPS, and forwards it to Gemini via `session.sendRealtimeInput({ video: { data, mimeType } })`. Session `mediaResolution` is set to `MEDIA_RESOLUTION_HIGH` so the model uses more detail from each frame.

> Vision requires Electron (`npm run dev:electron`). In a plain browser tab there is no `capturePage`, so no frames are streamed.

### `visionFrame` (WebSocket message)

Sent by the Electron main process into the hub; consumed by the AI server.
```json
{
  "type": "visionFrame",
  "mimeType": "image/jpeg",
  "data": "<base64-encoded JPEG>",
  "width": 1024,
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

Session notes for **`gemini-3.1-flash-live-preview`**:
- **`sessionResumption`** is enabled so ~10-minute connection resets can reconnect without losing as much state.
- **`contextWindowCompression` is NOT set** — on this model it is a documented cause of WebSocket **1007** (`Request contains an invalid argument`). Without it, long audio+video sessions may end sooner; reconnect still works.
- Thinking uses **`thinkingLevel: MINIMAL`** (not `thinkingBudget`, which is the 2.5-era field).

### Reconnect / error handling

The server auto-reconnects with exponential backoff when the Live connection drops:
- **Backoff** only resets after a session has stayed open longer than 15s, so a connect-then-immediately-die loop keeps backing off instead of hammering the API.
- **Close code `1007`** (`Request contains an invalid argument`) on `gemini-3.1-flash-live-preview` is a known stale-resumption-handle/context problem. Retrying with the same handle reproduces it forever, so the server **drops the resumption handle and reconnects fresh** on 1007. These closes are excluded from the vision circuit breaker.
- **Vision circuit breaker**: if non-1007 closes burst rapidly (4 within 60s) while video is streaming, the server disables vision frame forwarding to keep audio/text alive, then requires a restart to re-enable vision.
