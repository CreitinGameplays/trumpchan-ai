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

## Spatial Navigation (Embodied Avatar)

The avatar moves in the 3D room using **Gemini Live vision** directly:

1. **Gemini Live** decides when to call spatial tools based on what it sees in the FPV stream.
2. **Executor** (`src/spatialController.js`): runs the dispatched tool (look / turn / walk).

Tools are declared in `backend/tools/spatial.ts`.

### Flow

1. Live model calls e.g. `inspect_browser`.
2. Server dispatches `{ type: "spatialCommand", name: "run_plan", steps: [...] }`.
3. Frontend runs steps serially; replies `{ type: "spatialResult", ... }` with pose.
4. Server sends tool response with **`WHEN_IDLE`** so the Live model can speak about what it sees.

### Tools (model → server)

| Tool | Purpose |
|------|---------|
| `look_at` | Gaze at `user` / `browser` / `home` / relative dirs |
| `turn` | Rotate in place (`by_degrees` or `face_target`) |
| `walk` | Short forward/back walk (seconds) |
| `walk_toward` | Face + walk toward `user` / `browser` / `home` |
| `stop_moving` | Cancel walk, idle |
| `inspect_browser` | Face, approach, look at floating browser |
| `reset_pose` | Home center, face user |

### WS messages

**`spatialCommand`** (server → frontend):
```json
{ "type": "spatialCommand", "id": "…", "name": "walk_toward", "args": { "target": "browser", "seconds": 2 } }
```

**`spatialResult`** (frontend → server):
```json
{ "type": "spatialResult", "id": "…", "name": "walk_toward", "result": { "ok": true, "x": 0.4, "z": -0.2, "yawDeg": 30, "distanceToBrowser": 1.1 } }
```

Floor radius ≈ 4.2 m. Walk uses `files/Walking.fbx` via the gesture controller base layer.

### Locomotion (executor)

- **World-space translation** on `avatarRoot.position` (XZ). Yaw on `avatarRoot.rotation.y`, normalized to (−π, π].
- **Forward** each frame: `(sin(yaw), cos(yaw))` at ~0.72 m/s. Turn never changes position.
- **`motionRoot` stays at origin**; Mixamo floor root-motion is disabled (`allowFloorMotion: false`) so walk clips cannot drag the body.
- **`walk_toward` / `inspect_browser`** compute duration from remaining distance (arrive by `nearRadius`), not a fixed short timer alone.

## Browser control (in-scene offscreen browser)

The AI operates a floating browser via tools in `backend/tools/browser.ts`. Gemini Live vision handles all browser reasoning directly.

**Architecture (Electron + Playwright Chromium):** main process launches **Playwright Chromium** with a **persistent user profile** (`launchPersistentContext` → `userData/playwright-browser-profile`). Cookies, localStorage, and logins survive app restarts. JPEG screenshots stream to the renderer (`preload.cjs` → `browser:paint`) and paint a **WebGL texture plane**. There is **no `<webview>`**. Profile is never wiped on close.

**Targeting (primary):** Playwright locators — `getByRole`, `getByText`, `getByLabel`, `aria-ref`, plus DOM `axTree` refs (`e1`, `e2`, …) from `electron/axSnapshot.js`. Resolve order: **ref → role+name → text → selector → coords**.

**Input (primary):** Playwright actions with auto-wait:
- Clicks: `locator.click({ force: true })` with evaluate fallback
- Typing: `locator.fill()` then `keyboard.type`
- Dismiss: dialog role + CMP selectors + Escape + DOM hide
- **3D cursor:** main process emits `browser:cursor` on move/click/hover/check; renderer draws an arrow mesh on the browser plane (`src/browserWindow.js`)
- **Arm poses:** `BrowserController` calls `GestureController.playBrowserInteract` (reach/click/type) on interaction tools

Executor: `src/browserController.js` + `src/browserWindow.js` (plane + toolbar + cursor).

### Targeting priority

1. **`ref`** from `browser_snapshot` `axTree` (e.g. `{ "ref": "e3" }`) — most accurate
2. **`role` + `name`** / **`text`** label match
3. **`elementId`** / CSS **`selector`**
4. **Normalized coords** `x,y ∈ [0,1]` — fallback only; snaps to nearest interactive

Refs are valid only until the next navigation or major DOM change — snapshot again after those.

### Modals / popups (definitive path)

Complex modals fail for three reasons: (1) **shadow DOM / CMP iframes** hide buttons from normal queries, (2) **transparent overlays** intercept pointer hit-tests, (3) frameworks ignore synthetic mouse without a full event chain.

**What we do:**
1. Snapshots **pierce open shadow roots + same-origin iframes** so CMP/web-component controls appear as refs.
2. **`browser_click` force-activates by default**: climb to real button, temporarily fix `pointer-events:none`, fire pointer/mouse chain + `.click()` + Enter, then CDP trusted mouse.
3. **`browser_dismiss`**: known CMP selectors (OneTrust, Cookiebot, Usercentrics, Didomi, …) → force-click `[CLOSE]` refs → labels → Escape → `dialog.close()` → hide fixed overlays.

When a large dialog covers the page:
1. Snapshot may report `modalBlocking` and mark `[CLOSE]` / `[modal]`.
2. Call **`browser_dismiss`** first (preferred).
3. Or `browser_click({ ref: "eN", force: true })` on a modal control.

Do not rely on bare coordinates for modal buttons.

### Tools

| Tool | Purpose |
|------|---------|
| `use_browser` | High-level goal → multi-step plan (navigate/click/type/…) |
| `browser_navigate` | Open `url` or Google `query` |
| `browser_back` / `forward` / `reload` | History / reload |
| `browser_click` / `dblclick` | Prefer `ref`; optional `hover:true` before click for hover menus; moves visible 3D cursor + arm pose |
| `browser_hover` | Hold mouse over element to reveal menus/tooltips/⋯; re-snapshots |
| `browser_move` | Move the visible in-scene mouse cursor (Playwright pointer) without clicking |
| `browser_check` | Check/uncheck/toggle checkbox, switch, radio, or captcha (`captcha:true` / “I'm not a robot”) |
| `browser_scroll` | Multi-pane scroll: picks nested scroller under `x,y` (sidebar/chat/main); `pages`/`dy`/`mode` |
| `browser_type` | Prefer `ref` of textbox/chat; Playwright fill+insertText; `pressEnter`/`submit` to send |
| `browser_key` | `Enter`/`submit`/`send` chat-aware; also chords (`Meta+C`, …) |
| `browser_select` | Find phrase / select-all / drag-select; optional `copy` |
| `browser_dismiss` | Close modals / cookie banners / ad popups (multi-strategy) |
| `browser_read` | `selection` / `url` / `title` / `elements` / `visible_text` |
| `browser_snapshot` | Metadata + `axTree` + interactive element boxes with refs; flags `modalBlocking` |

`inspect_browser` remains **spatial only** (approach + look). Interaction requires browser tools. The system prompt instructs the model to **stand in front of the panel first** (`inspect_browser` / `walk_toward browser`) so first-person vision can read the page before describing or clicking.

### WS messages

**`browserCommand`** (server → frontend):
```json
{ "type": "browserCommand", "id": "…", "name": "run_plan", "args": { "steps": […], "originalName": "use_browser", "planner": "live" } }
```

**`browserResult`** (frontend → server):
```json
{ "type": "browserResult", "id": "…", "name": "use_browser", "result": { "ok": true, "url": "…", "title": "…", "stepsRun": ["browser_navigate","browser_click"] } }
```

Tool responses use **`WHEN_IDLE`** so the Live model can speak after acting. Page navigation alone never starts a turn.

### 3D mouse cursor

Offscreen JPEG paints do not include Chromium’s OS cursor. A synthetic pointer is parented to the content plane:

1. Playwright `page.mouse.move` / click / hover / check updates `lastMouseX/Y` in `electron/browserService.js`.
2. Main → renderer: `browser:cursor` (`x,y` normalized 0–1, `phase`: move|hover|click|check).
3. `browserWindow` lerps a white arrow mesh to that UV on the WebGL plane.
4. AI tool `browser_move` aims without activating; click/hover/check also move the cursor.

### Checkboxes & captchas

`browser_check` uses `setChecked`, real mouse clicks, label matching, and captcha-aware paths:

- `captcha: true` or labels like “I'm not a robot” → reCAPTCHA/hCaptcha iframe / anchor selectors + mouse click (not only setChecked).
- `x,y` coords work when vision sees the box but AX refs do not.
- Challenge grids after the anchor click still need `browser_click` on tiles.

### Capability notes

- **Electron + Playwright Chromium**: full click/type/scroll/keys via Playwright locators + screenshot stream to the 3D plane. Snapshot IPC: `browser:axSnapshot` / `getState({ includeElements: true })`. Engine field: `playwright-chromium`. Cursor IPC: `browser:move`, `browser:cursor` events.
- **Browser-tab iframe**: navigate only; input tools return `input_requires_electron`.
- Install: `npx playwright install chromium` (also `postinstall`).


## Outgoing Messages (server → frontend)

Beyond `audio`, `caption`, and `emotion`, the server emits:

### `interrupted`

Sent when the Gemini Live API reports the user barged in over the model (`serverContent.interrupted`). The frontend drops any queued audio and fast-settles the avatar's body back to idle so a half-finished gesture never freezes mid-air.

```json
{ "type": "interrupted" }
```

### Mid-turn steering (`chatMessage` / `steerMessage` / `steerStatus`)

While spatial/browser **tools are in flight**, a new user `chatMessage` must **not** restart the task (request loop). The AI server implements Codex-style **steer**:

| Situation | Behavior |
|-----------|----------|
| Idle (no pending tools) | `chatMessage` → `sendRealtimeInput({ text })` as a normal user turn |
| Model speaking, no tools | Inject as **steer** (framed guidance: continue current work) |
| Tools in flight (`spatial` / `browser` pending) | **Queue** the text; flush **once** when all tools complete/timeout |
| Same text within ~8s | **Dropped as duplicate** (no second Live send) |
| Stale/duplicate `spatialResult` / `browserResult` | **Ignored** (no second `sendToolResponse`) |
| Duplicate Gemini `toolCall` id | **Ignored** |

**Inbound (frontend → hub → AI):**

```json
{ "type": "chatMessage", "text": "click the login button" }
```

Optional explicit steer (always framed as mid-task guidance when idle):

```json
{ "type": "steerMessage", "text": "don't restart — just scroll down" }
```

**Outbound status (AI → hub → clients):**

```json
{
  "type": "steerStatus",
  "kind": "queued|flushed|steered_now|sent|duplicate|tools_busy",
  "queueLen": 1,
  "toolsInFlight": true,
  "textPreview": "…"
}
```

Flushed steers are coalesced into **one** Live text injection with a `[STEER — mid-task guidance…]` prefix so the model continues the open plan instead of re-calling `use_browser` / `inspect_browser` from scratch.

**Cancel steers** (`nevermind`, `stop`, `cancel`, …) immediately `browserCancel` all pending browser tools and inject a stop instruction (no more click storms).

**Browser queue hardening**

| Guard | Detail |
|-------|--------|
| Max pending tools (AI bridge) | 4 (`BROWSER_MAX_PENDING`) |
| Max frontend queue | 6 |
| Tool timeout | 90s (was 45s; queue depth needed headroom) |
| Deprecated `browser_click` | Rejected; model must use `view_click` (FPV grid) |
| Search | DuckDuckGo (Google `/sorry` bot walls avoided) |
| Late results after timeout | Suppressed (`Unexpected result` no longer double-fires) |

Implementation: `acceptUserChatText` / `flushSteerQueue` / `coalesceBrowserToolCalls` / `BrowserToolBridge` / `BrowserController` in `backend/ai-server.ts`, `backend/tools/browser.ts`, `src/browserController.js`.

### Live WebSocket 1007 (`Request contains an invalid argument`)

**Cause (known Live API / `gemini-3.1-flash-live-preview`):** Session **resumption after audio+video** (avatar FPV frames) often invalidates the resumption handle. Reconnecting **with** that handle loops 1007. See [python-genai#2290](https://github.com/googleapis/python-genai/issues/2290). Other 1007 causes already avoided: `contextWindowCompression`, bad setup fields.

**Recovery (`backend/ai-server.ts`):**

1. On close **code 1007** → drop `sessionResumptionHandle`, clear pending tools, hold video ~2.5s, reconnect **fresh**.
2. Remember last user `chatMessage` continuously.
3. On successful open after 1007 → **re-inject** last user text (with a short system prefix) + flush newest FPV so the model continues the request.
4. User messages while offline are **queued** (not dropped) and flushed post-reconnect.
5. Only store resumption handles when `resumable === true`.

Look for logs: `[REPLAY] Re-injected last user message after 1007_invalid_argument`.

### Room physics (Rapier)

The 3D room uses **`@dimforge/rapier3d-compat`** for collision (not full ragdoll):

| Body | Type | Role |
|------|------|------|
| Floor + 4 walls | Fixed | Soft room bounds (~4.3 m) |
| Browser panel | Fixed box | Avatar cannot walk through the TV panel |
| Avatar | Kinematic capsule + CharacterController | Walk slides along obstacles |

- Implemented in `src/physicsWorld.js`; walk steps go through `SpatialController._applyWalkDesired` → `moveAvatarCapsule`.
- Mixamo / gestures still drive bones; locomotion capsule owns **root XZ**.
- **VRM body colliders** (`src/vrmBodyPhysics.js`): kinematic spheres/capsules on hips, torso, head, arms, legs — updated every frame from humanoid bones so the body volume collides with the room/panel/props while animation stays in control.
- Soft ragdoll burst (optional): Ctrl/Cmd+Shift+R or `activateRagdoll()` — body parts go dynamic ~2s then return to kinematic. Not a full visual ragdoll (skeleton still animates unless you freeze gestures).
- SpringBone hair/cloth remains VRM secondary animation, with **boosted gravity** (especially tail) via `configureVrmSpringGravity` in `src/vrmSpringPhysics.js` — world-down gravity + softer stiffness on joints matching tail/fox-tail bone names.
- Walk uses Rapier `KinematicCharacterController` with **`filterGroups` + `EXCLUDE_KINEMATIC`** so the loco capsule never treats VRM body bone colliders as walls (that bug froze movement at spawn).
- Browser paint: serialized `page.screenshot` with **6s timeout** (Discord-heavy pages used to hit Playwright’s 12–30s default and spam errors).
- `browser_navigate` skips reload when already on the same SPA (e.g. Discord `/app` ↔ `/channels/@me`) and takes **one** AX snapshot (was double).
- Live captions: cleared on every new user message; `[AI]:` lines are deduped so late `turnComplete` cannot re-log an old reply.

### Hybrid vision grounding (scene graph + FPV)

Accuracy pattern: **structured world + UI metadata as ground truth**, Live FPV as confirmation.

| Source | Role |
|--------|------|
| `spatialResult.grounding` / `entities` | Named scene inventory (avatar, browser, user, home; extensible for future props) |
| `browserResult.grounding` | url, title, captchaWall, sampleRefs; prefer `ref=` for clicks |
| Newest `visionFrame` | What is actually in the first-person view right now |
| Tool `reobserve` / `instruction` | Closed-loop: re-check before next claim |

On every spatial/browser tool response the AI server also flushes the **newest FPV** to Live (`pre-tool-result`) so the model is not answering from a stale picture.

System policy (`SYSTEM.txt`): observed vs inferred; do not invent props/UI; scene graph over memory.

### FPV grid + view tools (visual grounding)

AI vision JPEGs use high JPEG quality (~0.94) and a **numeric coordinate overlay** (x,y in **0–1**, origin **top-left**; yellow rulers at 0.1 steps). Primary targeting is floats, not letter cells. Tools:

| Tool | Args | Effect |
|------|------|--------|
| `view_click` | **`x`,`y`** 0–1 (preferred); legacy `cell` optional | Ray from FPV → browser page click, toolbar, or floor |
| `view_look` | same | Face/look toward ray hit |
| `view_go` | same | Walk to floor hit, or approach browser if panel hit |

Example: `view_click({ x: 0.42, y: 0.61 })`. Pixel values (e.g. 0–1280) are accepted and normalized.

Implementation: overlay in `drawVisionGroundingGrid` (`src/main.js`); raycast in `resolveViewRay` / `handleViewClick`; tools in `backend/tools/spatial.ts`.

**Clicks:** `view_click` executes Live x,y directly. Gemini Live vision handles all spatial reasoning and click targeting natively.

**`browser_click` / `browser_dblclick` are deprecated** and removed from Live tool declarations. If the model still emits them, the AI server rejects with `deprecated_use_view_click`. Typing still uses `browser_type` + `ref=`.

---

## Vision (Live Scene Streaming)

The avatar has always-on vision in **first-person**: Gemini Live sees the 3D world **from the avatar’s head**, not the spectator orbit camera. To see the floating browser clearly, the model must `walk_toward` / `inspect_browser` / `look_at` so the panel is in front of its eyes—like being inside the room.

### Pipeline (default: avatar first-person)

1. **Capture (renderer, `src/main.js`)** — Each frame the FPV camera is placed in **world space** at the eyes (`VRMLookAt.getLookAtWorldPosition`, fallback head bone) aiming at the browser center when in front, else body yaw. Renders into **1280×720** offscreen RT at ~1 FPS, FOV **`VISION_FOV` (58°)**. Spatial stop for the browser uses **floor XZ distance** (`NEAR_BROWSER` ≈ **1.35 m** → eye–panel ≈1.4–1.5 m, ~75–80% frame fill; 0.75 m was too close and clipped the panel). Full RT viewport/scissor. Avatar mesh hidden; floating browser **WebGL content plane** included (`prepareForVisionCapture`). CSS3D toolbar is **not** in FPV (DOM-only). JPEG → `visionFrame` (`source: "avatar-first-person"`).
2. **Transport** — Renderer → hub (`ws://localhost:3000`) → AI server (`visionFrame` with `ts` + monotonic `seq`).
3. **Forward (`backend/ai-server.ts`)** — **Always caches the newest frame**; only *sends* to Live at ~1 FPS. Mid-interval frames update the cache and schedule a deferred flush of the latest picture (never leave Gemini on an older frame). Stale out-of-order `seq`/`ts` are dropped.

### Manual POV screenshot (debug)

Save the **exact** first-person frame the AI uses (same camera, FOV, resolution, render path):

| Shortcut | Action |
|----------|--------|
| **Ctrl+Shift+V** (Windows/Linux) or **Cmd+Shift+V** (macOS) | Download JPEG (same quality as Live stream) |
| **Ctrl/Cmd+Shift+P** | Same as V (POV alias) |
| **+ Alt** (e.g. Ctrl+Shift+Alt+V) | Download PNG instead |

File name: `avatar-pov_<timestamp>_1280x720.jpg`. Toast confirms save. Does not require the hub WebSocket. Implementation: `renderAvatarPovFrame()` + `saveAvatarPovScreenshot()` in `src/main.js`.

### Fallback: full-window (third-person)

Set `TRUMPCHAN_VISION_MODE=window` for Electron to use `webContents.capturePage()` on the main window (old spectator view). Default is `avatar` (first-person); window capture is off unless that env is set.

> First-person vision works whenever the Three.js app is running and connected to the hub (Electron recommended). Browser page pixels still come from the Playwright texture on the plane—only the **viewpoint** changed.

### `visionFrame` (WebSocket message)

Sent by the Electron main process into the hub; consumed by the AI server.
```json
{
  "type": "visionFrame",
  "mimeType": "image/jpeg",
  "data": "<base64-encoded JPEG>",
  "width": 1280,
  "height": 720,
  "ts": 1718900000000,
  "source": "avatar-first-person"
}
```
- `data` (String): Base64-encoded JPEG from the avatar head camera (or full window if `TRUMPCHAN_VISION_MODE=window`).
- `source` (String, optional): `"avatar-first-person"` for FPV; omitted/window capture for third-person.
- `mimeType` / `width` / `height` / `ts`: as before.

> Browser interactions are silent for chat: navigation does not auto-speak. The AI only *sees* the page when the avatar is oriented toward the panel (FPV). Tool control of the browser is independent of vision.

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
