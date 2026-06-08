# VRM Viewer Starter

Small local web app for previewing a bundled Vroid `.vrm` model in the browser with Three.js.

## What it does

- Starts a local dev server on `localhost`
- Displays the model with basic lighting and orbit controls
- Automatically loads `files/trumpchan.vrm` on startup
- Automatically applies `files/Standing-Idle.fbx` on startup
- Keeps vertical motion and floor movement enabled by default

## Requirements

- Node.js 18+ recommended

## Install

On Windows PowerShell, use:

```powershell
npm.cmd install
```

If your shell allows the normal npm command, this also works:

```powershell
npm install
```

## Run locally

```powershell
npm.cmd run dev
```

Then open the local URL shown in the terminal, usually:

```text
http://localhost:5173
```

## How to use

1. Start the dev server.
2. Open the app in your browser.
3. The viewer loads `trumpchan.vrm` automatically.
4. The idle loop from `Standing-Idle.fbx` starts automatically.
5. Orbit, pan, and zoom the camera with your mouse.
6. Press `R` if you want to reset the avatar back to its starting position.

## Mixamo notes

- Best result: export the Mixamo animation as `FBX Binary` and `Without Skin`
- `Allow vertical motion` is enabled by default in this build
- `Allow floor movement` is enabled by default in this build
- `Allow floor movement` replays Mixamo forward motion on the viewer floor for walk cycles and similar clips

## Project files

- `index.html` - app shell
- `src/main.js` - Three.js + VRM viewer logic
- `src/loadMixamoAnimation.js` - Mixamo FBX retargeting for VRM humanoid bones
- `src/mixamoVRMRigMap.js` - Mixamo-to-VRM bone mapping
- `src/style.css` - page styling
- `package.json` - scripts and dependencies

## Build for production

```powershell
npm.cmd run build
```

The production files will be created in `dist/`.
