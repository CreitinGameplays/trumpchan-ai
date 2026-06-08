# VRM Viewer Starter

Small local web app for previewing a Vroid `.vrm` model in the browser with Three.js.
(For now)

## What it does

- Starts a local dev server on `localhost`
- Lets you choose a local `.vrm` file from the page
- Displays the model with basic lighting and orbit controls
- Lets you choose a Mixamo `.fbx` animation and play it on the loaded VRM

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
3. Click `Choose .vrm file`.
4. Pick your Vroid `.vrm` file from disk.
5. Optionally click `Choose Mixamo .fbx`.
6. Pick a Mixamo animation exported as `.fbx` to play it on the model.
7. Leave `Allow vertical motion` off for most idle/gesture clips if the avatar bobs awkwardly.
8. Turn on `Allow floor movement` if you want walking animations to move across the floor.
9. Use `Reset model position` to bring the avatar back to the starting point.

## Mixamo notes

- Best result: export the Mixamo animation as `FBX Binary` and `Without Skin`
- Load the VRM first, then the animation
- If you pick the animation first, the app will queue it and apply it after the VRM loads
- `Allow vertical motion` is useful for jump animations, but leaving it off usually keeps the avatar grounded
- `Allow floor movement` replays Mixamo forward motion on the viewer floor for walk cycles and similar clips

## Project files

- `index.html` - app shell
- `src/main.js` - Three.js + VRM viewer logic
- `src/loadMixamoAnimation.js` - Mixamo FBX retargeting for VRM humanoid bones
- `src/mixamoVRMRigMap.js` - Mixamo-to-VRM bone mapping
- `src/style.css` - simple page styling
- `package.json` - scripts and dependencies

## Build for production

```powershell
npm.cmd run build
```

The production files will be created in `dist/`.
