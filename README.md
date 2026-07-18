# Trumpchan

Simple browser-based AI anime assistant surface for Trumpchan, built with Three.js.

## What it does

- Starts a local dev server on `localhost`
- Presents Trumpchan as a simple in-browser anime assistant surface
- Displays the character with basic lighting and orbit controls
- Automatically loads `files/trumpchan.vrm` on startup
- Automatically applies `files/Standing-Idle.fbx` on startup
- Keeps vertical motion and floor movement enabled by default
- Does not include any AI or LLM backend yet

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

```bash
npm run dev
```

Then open the local URL shown in the terminal, usually:

```text
http://localhost:5173
```

## How to use

1. Start the dev server.
2. Open the app in your browser.
3. Trumpchan loads automatically.
4. The idle loop from `Standing-Idle.fbx` starts automatically.
5. Orbit, pan, and zoom the camera with your mouse.

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
- `src/style.css` - page styling
- `package.json` - scripts and dependencies

## Build for production

```bash
npm run build
```

## `.env` template:
```
GEMINI_API_KEY=api-key-here
FFMPEG_BINARY=ffmpeg
VOICE_CHANGER_CONFIG=./voice-changer-config.json
VOICE_CHANGER_ENABLED=true/false
```

The production files will be created in `dist/`.
