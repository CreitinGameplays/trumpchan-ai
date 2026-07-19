# Trumpchan

Simple browser-based AI anime assistant surface for Trumpchan, built with Three.js.

## What it does

- Starts a local dev server on `localhost`
- Presents Trumpchan as a simple in-browser anime assistant surface
- Displays the character with basic lighting and orbit controls
- Automatically loads `files/trumpchan.vrm` on startup
- Automatically applies `files/Standing-Idle.fbx` on startup
- Keeps vertical motion and floor movement enabled by default
- Renders a floating, interactive browser window inside the 3D scene, with a URL/search bar and back/forward/reload controls
- Auto-starts the AI backend (Gemini Live proxy) alongside the dev server

## Requirements

- Node.js 18+ recommended
- ffmpeg

On macOS, install ffmpeg with [Homebrew](https://brew.sh):

```bash
brew install ffmpeg
```

## Install

```bash
npm install
```

## Run locally

There are two ways to run the app, depending on how you want the in-scene
browser window to behave (see [In-scene browser window](#in-scene-browser-window)).

### Browser tab (Vite dev server)

```bash
npm run dev
```

This starts three processes together: the Vite dev server, the backend
WebSocket/API server, and the AI backend (Gemini Live proxy). Output is
labelled `vite`, `server`, and `ai`. The AI server waits for the main server
on port 3000 before connecting.

Then open the local URL shown in the terminal, usually:

```text
http://localhost:5173
```

In this mode the in-scene browser is an `<iframe>`, which many sites block from
being embedded. Good for a quick look with permissive test pages.

### Electron (recommended for the in-scene browser)

```bash
npm run dev:electron
```

This starts the Vite dev server, the backend WebSocket/API server, the AI
backend, and an Electron window all at once. Electron uses a `<webview>` for the
in-scene browser, which loads pages as top-level navigations and works with
essentially all sites.

A `GEMINI_API_KEY` in `.env` is required for the AI backend to start (see the
[`.env` template](#env-template) below).

## How to use

1. Start the app with `npm run dev` (browser tab) or `npm run dev:electron` (Electron).
2. Trumpchan loads automatically.
3. The idle loop from `Standing-Idle.fbx` starts automatically.
4. Orbit, pan, and zoom the camera with your mouse.
5. A floating browser window appears beside Trumpchan. Click and scroll inside it to interact.

## In-scene browser window

The scene renders a real, interactive browser window floating in 3D space,
implemented in `src/browserWindow.js` using Three.js `CSS3DRenderer`.

- It includes a navigation toolbar: back, forward, and reload buttons plus a URL/search bar. Type a full URL, a bare domain (auto-prefixed with `https://`), or free text (routed to a Google search) and press Enter.
- Under Electron (`npm run dev:electron`) it uses a `<webview>`, so it works with essentially all websites and the back/forward history is fully functional.
- In a plain browser tab (`npm run dev`) it falls back to an `<iframe>`, which many sites block via `X-Frame-Options` / CSP headers. Back/forward is limited to same-origin history. Use permissive test URLs such as `https://example.com` or `https://threejs.org`.
- Because the window lives in a DOM layer composited over the WebGL canvas, it always draws on top and cannot be occluded by the 3D model.

Change the default URL in `src/main.js` where `createBrowserWindow` is called,
or drive it at runtime from the devtools console:

```js
browserWindow.setUrl('https://threejs.org')
browserWindow.goBack()
browserWindow.goForward()
browserWindow.reload()
```

## Mixamo notes

- Best result: export the Mixamo animation as `FBX Binary` and `Without Skin`
- `Allow vertical motion` is enabled by default in this build
- `Allow floor movement` is enabled by default in this build
- `Allow floor movement` replays Mixamo forward motion on the viewer floor for walk cycles and similar clips

## Project files

- `index.html` - app shell
- `src/main.js` - Three.js + Trumpchan viewer logic
- `src/loadMixamoAnimation.js` - Mixamo FBX retargeting for VRM humanoid bones
- `src/mixamoVRMRigMap.js` - Mixamo-to-VRM bone mapping
- `src/browserWindow.js` - floating in-scene browser window with nav toolbar (CSS3D + webview/iframe)
- `src/style.css` - page styling
- `electron/main.js` - Electron main process (enables the `<webview>` in-scene browser)
- `backend/server.js` - HTTP + WebSocket command server
- `backend/ai-server.ts` - Gemini Live AI proxy
- `backend/voice-changer.ts` - ffmpeg-based voice effect
- `package.json` - scripts and dependencies

## Build for production

```bash
npm run build
```

To run the built app inside Electron:

```bash
npm run build
npm run electron
```

The production files will be created in `dist/`.

## npm scripts

- `npm run dev` - Vite + backend server + AI backend (browser-tab mode)
- `npm run dev:electron` - same as above plus an Electron window (webview in-scene browser)
- `npm run dev:vite` - Vite dev server only
- `npm run dev:server` - backend WebSocket/API server only
- `npm run dev:ai` - AI backend only (waits for the server on port 3000)
- `npm run electron` - launch Electron against the built `dist/` (run `npm run build` first)
- `npm run build` - production build to `dist/`
- `npm run preview` - preview the production build

## `.env` template

```
GEMINI_API_KEY=api-key-here
FFMPEG_BINARY=ffmpeg
VOICE_CHANGER_CONFIG=./voice-changer-config.json
VOICE_CHANGER_ENABLED=true/false
XINJIANYA_KEY=key
```
