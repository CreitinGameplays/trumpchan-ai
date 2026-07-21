import './style.css';

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { loadMixamoAnimation } from './loadMixamoAnimation.js';
import { GestureController } from './gestureSystem.js';
import { SpatialController } from './spatialController.js';
import { BrowserController } from './browserController.js';
import { createBrowserWindow } from './browserWindow.js';
import {
  initPhysics,
  isPhysicsReady,
  syncBrowserCollider,
  setAvatarPosition,
  getPhysicsDebugInfo,
  spawnDynamicBox,
  stepPhysics,
} from './physicsWorld.js';
import {
  attachVrmBodyPhysics,
  detachVrmBodyPhysics,
  updateVrmBodyPhysics,
  activateRagdoll,
  getVrmBodyPartCount,
} from './vrmBodyPhysics.js';
import { configureVrmSpringGravity, clampSpringDelta } from './vrmSpringPhysics.js';
import defaultVrmUrl from '../files/Pati.vrm?url';
import defaultAnimationUrl from '../files/Standing-Idle.fbx?url';
import walkAnimationUrl from '../files/Walking.fbx?url';

const canvas = document.querySelector('#scene');
const status = document.querySelector('#status');

const DEFAULT_ALLOW_VERTICAL_MOTION = true;
// SpatialController owns world XZ; Mixamo floor root-motion must stay off.
const DEFAULT_ALLOW_FLOOR_MOTION = false;
const BLINK_INTERVAL_RANGE_SECONDS = [2.4, 5.8];
const DOUBLE_BLINK_INTERVAL_RANGE_SECONDS = [0.1, 0.28];
const DOUBLE_BLINK_CHANCE = 0.18;
const BLINK_CLOSE_DURATION_RANGE_SECONDS = [0.05, 0.085];
const BLINK_HOLD_DURATION_RANGE_SECONDS = [0.025, 0.05];
const BLINK_OPEN_DURATION_RANGE_SECONDS = [0.07, 0.12];
const BLINK_EYE_SCALE_RANGE = [0.92, 1];
const GAZE_DIRECT_HOLD_RANGE_SECONDS = [1.7, 4.2];
const GAZE_GLANCE_HOLD_RANGE_SECONDS = [0.45, 1.1];
const GAZE_DIRECT_YAW_RANGE_DEGREES = [-3.2, 3.2];
const GAZE_DIRECT_PITCH_RANGE_DEGREES = [-1.4, 2.1];
const GAZE_GLANCE_YAW_RANGE_DEGREES = [-7.5, 7.5];
const GAZE_GLANCE_PITCH_RANGE_DEGREES = [-3.5, 3.2];
const GAZE_GLANCE_CHANCE = 0.2;
const GAZE_MIN_SHIFT_DURATION_SECONDS = 0.12;
const GAZE_MAX_SHIFT_DURATION_SECONDS = 0.28;
const GAZE_CAMERA_FORWARD_OFFSET = 0.22;
const GAZE_MICRO_YAW_DEGREES = 0.42;
const GAZE_MICRO_PITCH_DEGREES = 0.28;
const HEAD_IDLE_SHIFT_INTERVAL_RANGE_SECONDS = [1.4, 3.6];
const HEAD_IDLE_SHIFT_DURATION_RANGE_SECONDS = [0.8, 1.6];
const HEAD_IDLE_YAW_RANGE_DEGREES = [-9.5, 9.5];
const HEAD_IDLE_PITCH_RANGE_DEGREES = [-5.2, 4];
const HEAD_IDLE_ROLL_RANGE_DEGREES = [-4.2, 4.2];
const HEAD_IDLE_MICRO_YAW_DEGREES = 1.8;
const HEAD_IDLE_MICRO_PITCH_DEGREES = 1.2;
const HEAD_IDLE_MICRO_ROLL_DEGREES = 0.9;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#d8e6ec');
scene.fog = new THREE.Fog('#d8e6ec', 12, 28);

const gazeTarget = new THREE.Object3D();
gazeTarget.name = 'NaturalGazeTarget';
scene.add(gazeTarget);

const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
camera.position.set(0, 1.4, 3.2);

const controls = new OrbitControls({ camera, domElement: canvas });
controls.target.set(0, 1.2, 0);
controls.enableDamping = true;
controls.minDistance = 1.5;
controls.maxDistance = 8;
controls.update();

// ---------------------------------------------------------------------------
// Avatar first-person vision (what Gemini Live sees)
// Spectator camera (above) stays for the human; AI sees from the avatar's head.
// ---------------------------------------------------------------------------
// FPV for Gemini. FOV near human (~55–65°). Wider (92°) made panels look distant;
// slightly tighter than 65° so a ~0.9m eye–panel stand fills most of the frame.
const VISION_WIDTH = 1920;
const VISION_HEIGHT = 1080;
const VISION_FPS = 1;
/** Higher JPEG quality so small UI text + coordinate rulers stay readable for flash-lite. */
const VISION_JPEG_QUALITY = 0.95;
/** Vertical FOV degrees. 58° + NEAR_BROWSER XZ ~1.35m ≈ readable panel when inspecting. */
const VISION_FOV = 58;
/**
 * FPV coordinate overlay (AI frames only). Primary targeting is x,y in 0–1
 * over the full image: (0,0)=top-left, (1,1)=bottom-right.
 * Optional legacy cell grid (A1–P12) still parses if the model sends cell=.
 */
const VISION_GRID_COLS = 16;
const VISION_GRID_ROWS = 12;
/** Major axis ticks every 0.1; minor every 0.05 */
const VISION_COORD_MAJOR = 0.1;
const VISION_COORD_MINOR = 0.05;
const VISION_GRID_ENABLED = true;
/** Verbose VisionFP/ViewClick logs. Off by default; set window.__VISION_DEBUG = true in console. */
const VISION_DEBUG =
  typeof window !== 'undefined' && window.__VISION_DEBUG === true;

const visionCamera = new THREE.PerspectiveCamera(
  VISION_FOV,
  VISION_WIDTH / VISION_HEIGHT,
  0.05,
  80,
);
visionCamera.name = 'AvatarVisionCamera';
// World-space FPV camera (not parented to head) — oriented via VRM LookAt each frame
visionCamera.layers.enableAll();
scene.add(visionCamera);

const visionRenderTarget = new THREE.WebGLRenderTarget(VISION_WIDTH, VISION_HEIGHT, {
  type: THREE.UnsignedByteType,
  format: THREE.RGBAFormat,
  colorSpace: THREE.SRGBColorSpace,
  depthBuffer: true,
  stencilBuffer: false,
  generateMipmaps: false,
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
});
visionRenderTarget.texture.generateMipmaps = false;
visionRenderTarget.texture.colorSpace = THREE.SRGBColorSpace;

const visionPixelBuffer = new Uint8Array(VISION_WIDTH * VISION_HEIGHT * 4);
const visionFlipCanvas = document.createElement('canvas');
visionFlipCanvas.width = VISION_WIDTH;
visionFlipCanvas.height = VISION_HEIGHT;
const visionFlipCtx = visionFlipCanvas.getContext('2d', { willReadFrequently: true });
const visionImageData = visionFlipCtx.createImageData(VISION_WIDTH, VISION_HEIGHT);

let visionLastSentAt = 0;
let visionSending = false;
let visionFrameCount = 0;
let visionHeadAttached = false;
/** When true, Gemini Live gets avatar POV (default). Spectator window is human-only. */
const AVATAR_FIRST_PERSON_VISION = true;

const hemiLight = new THREE.HemisphereLight('#ffffff', '#6f7d87', 1.8);
scene.add(hemiLight);

const dirLight = new THREE.DirectionalLight('#ffffff', 2.2);
dirLight.position.set(1.5, 3, 2);
scene.add(dirLight);

const fillLight = new THREE.DirectionalLight('#fff1dc', 1.2);
fillLight.position.set(-1.5, 2, -1);
scene.add(fillLight);

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(5, 64),
  new THREE.MeshStandardMaterial({
    color: '#b9cad2',
    roughness: 0.9,
    metalness: 0.05
  })
);
floor.name = 'RoomFloor';
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.01;
scene.add(floor);

const grid = new THREE.GridHelper(10, 20, '#718690', '#9bb0ba');
grid.position.y = 0;
scene.add(grid);

// Floating browser in the 3D scene.
// Electron: offscreen main-process browser → WebGL texture (no <webview>).
// Tab: iframe CSS3D fallback. Never throw — a browser failure must not blank the app.
let browserWindow = null;
try {
  // TV-style panel: lower (screen center ~1.0m), slightly larger, in front of
  // home facing the avatar (yaw 0 = +Z). Easy for FPV + inspect_browser.
  browserWindow = createBrowserWindow(scene, {
    url: 'https://example.com',
    position: new THREE.Vector3(0, 1.0, 1.85),
    rotation: new THREE.Euler(0, Math.PI, 0),
    scale: 0.0017,
  });
  console.log('[Main] Browser panel (TV) at (0, 1.0, 1.85) facing home, scale=0.0017');
  // Rapier collider for the panel (block walking through)
  initPhysics().then((ok) => {
    if (!ok) return;
    syncBrowserPanelPhysics();
    setAvatarPosition(0, 0);
    console.log('[Physics]', JSON.stringify(getPhysicsDebugInfo()));
  });
} catch (e) {
  console.error('[Main] createBrowserWindow failed:', e);
  browserWindow = {
    cssObject: null,
    render: () => {},
    setSize: () => {},
    setUrl: async () => ({ ok: false }),
    goBack: async () => {},
    goForward: async () => {},
    reload: async () => {},
    dispose: () => {},
    getCapabilities: () => ({ mode: 'none', canInput: false }),
    isGuestReady: () => false,
    waitForLoad: async () => false,
    getPageState: async () => ({ url: null, mode: 'none' }),
  };
}

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

let currentVrm = null;
let currentVrmUrl = null;
// Owns the AnimationMixer + persistent idle base + talking-gesture layer.
let gestureController = null;
// Avatar locomotion / look / walk in the 3D room (AI spatial tools).
let spatialController = null;
// AI control of the floating in-scene browser (navigate/click/type/...).
let browserController = null;
let currentAvatarRoot = null;
let currentMotionRoot = null;
let currentAnimationSource = null;


// Live speech signals feeding the gesture system:
//  - speechAmplitude: smoothed 0..1 loudness of the AI's outgoing audio.
//  - It drives both within-tier motion energy and (with emotion) tier choice.
let speechAmplitude = 0;
let blinkState = createBlinkState();
let gazeState = createNaturalGazeState();
let headIdleRig = null;
let headIdleState = createHeadIdleState();

// Native VRM emotion presets the AI can drive via function calls.
// These are blended smoothly each frame so the face eases between moods
// instead of snapping. Lip-sync (aa/ee/ih/oh/ou) and blink are handled
// separately, so emotion expressions never fight with mouth/eye animation.
const EMOTION_EXPRESSIONS = ['happy', 'angry', 'sad', 'relaxed', 'surprised', 'neutral'];
const EMOTION_BLEND_SPEED = 6; // higher = snappier transition
const emotionState = {
  // Target weight for each emotion expression (what the AI requested).
  target: { happy: 0, angry: 0, sad: 0, relaxed: 0, surprised: 0, neutral: 0 },
  // Current interpolated weight actually applied to the VRM each frame.
  current: { happy: 0, angry: 0, sad: 0, relaxed: 0, surprised: 0, neutral: 0 },
  // Seconds left before auto-reverting to neutral. <= 0 means hold forever.
  holdRemaining: 0
};

function setEmotion(emotion, intensity = 1.0, duration = 0) {
  const name = String(emotion || '').toLowerCase().trim();
  if (!EMOTION_EXPRESSIONS.includes(name)) {
    console.warn(`[Emotion] Ignoring unknown emotion "${emotion}"`);
    return;
  }

  const value = Math.max(0, Math.min(1, Number.isFinite(intensity) ? intensity : 1.0));

  // Only one emotion is active at a time: zero out the others as targets so
  // the current expression eases out while the new one eases in.
  for (const key of EMOTION_EXPRESSIONS) {
    emotionState.target[key] = 0;
  }

  // 'neutral' means "no emotional overlay" — leave every target at 0.
  if (name !== 'neutral') {
    emotionState.target[name] = value;
  }

  // Optional auto-revert timer. duration <= 0 (or neutral) holds indefinitely.
  const holdSeconds = Number.isFinite(duration) ? duration : 0;
  emotionState.holdRemaining = name !== 'neutral' && holdSeconds > 0 ? holdSeconds : 0;

  console.log(
    `[Emotion] Target set to "${name}" @ ${value}` +
    (emotionState.holdRemaining > 0 ? ` for ${emotionState.holdRemaining}s` : ' (held until changed)')
  );
}

// Clear all emotion weights instantly (used when (re)loading a model).
function resetEmotions() {
  for (const key of EMOTION_EXPRESSIONS) {
    emotionState.target[key] = 0;
    emotionState.current[key] = 0;
  }
  emotionState.holdRemaining = 0;
}

// Whether the loaded VRM actually has a given emotion expression preset.
function hasEmotionExpression(name) {
  return currentVrm?.expressionManager?.getExpression?.(name) != null;
}

// Smoothly move current emotion weights toward their targets and apply them.
function updateEmotions(delta) {
  const manager = currentVrm?.expressionManager;
  if (!manager) return;

  // Count down the hold timer; when it expires, ease back to neutral.
  if (emotionState.holdRemaining > 0) {
    emotionState.holdRemaining -= delta;
    if (emotionState.holdRemaining <= 0) {
      emotionState.holdRemaining = 0;
      for (const key of EMOTION_EXPRESSIONS) {
        emotionState.target[key] = 0;
      }

    }
  }

  const t = Math.min(1, EMOTION_BLEND_SPEED * delta);

  for (const name of EMOTION_EXPRESSIONS) {
    if (name === 'neutral') continue; // neutral is not a driven blendshape

    const cur = emotionState.current[name];
    const next = cur + (emotionState.target[name] - cur) * t;
    emotionState.current[name] = next;

    if (hasEmotionExpression(name)) {
      manager.setValue(name, next);
    }
  }
}

const gazeOrigin = new THREE.Vector3();
const gazeCameraForward = new THREE.Vector3();
const gazeCameraRight = new THREE.Vector3();
const gazeCameraUp = new THREE.Vector3();
const headIdleWorkingEuler = new THREE.Euler(0, 0, 0, 'XYZ');
const headIdleWorkingQuaternion = new THREE.Quaternion();
const headIdleOffsetQuaternion = new THREE.Quaternion();
const headIdleBaseQuaternion = new THREE.Quaternion();

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function smoothstep(value) {
  return value * value * (3 - 2 * value);
}

function degreesToRadians(value) {
  return THREE.MathUtils.degToRad(value);
}

function randomCentered(min, max) {
  const center = (min + max) * 0.5;
  const radius = (max - min) * 0.5;
  return center + (Math.random() * 2 - 1) * Math.random() * radius;
}

function createBlinkState() {
  return {
    elapsed: 0,
    nextBlinkAt: randomBetween(...BLINK_INTERVAL_RANGE_SECONDS),
    phase: 'idle',
    phaseElapsed: 0,
    closeDuration: randomBetween(...BLINK_CLOSE_DURATION_RANGE_SECONDS),
    holdDuration: randomBetween(...BLINK_HOLD_DURATION_RANGE_SECONDS),
    openDuration: randomBetween(...BLINK_OPEN_DURATION_RANGE_SECONDS),
    leftScale: 1,
    rightScale: 1,
    queueDoubleBlink: false
  };
}

function resetBlinkState() {
  blinkState = createBlinkState();
  applyBlinkWeight(0, 0);
}

function chooseNaturalGazeTarget(forceDirect = false) {
  const isGlance = !forceDirect && Math.random() < GAZE_GLANCE_CHANCE;
  const yawRange = isGlance ? GAZE_GLANCE_YAW_RANGE_DEGREES : GAZE_DIRECT_YAW_RANGE_DEGREES;
  const pitchRange = isGlance ? GAZE_GLANCE_PITCH_RANGE_DEGREES : GAZE_DIRECT_PITCH_RANGE_DEGREES;

  return {
    yaw: randomCentered(...yawRange),
    pitch: randomCentered(...pitchRange),
    isGlance
  };
}

function createNaturalGazeState() {
  const target = chooseNaturalGazeTarget(true);

  return {
    elapsed: 0,
    phaseElapsed: 0,
    isShifting: false,
    forceDirectNext: false,
    current: { yaw: 0, pitch: 0, isGlance: false },
    from: { yaw: 0, pitch: 0, isGlance: false },
    target,
    nextShiftAt: randomBetween(...GAZE_DIRECT_HOLD_RANGE_SECONDS),
    shiftDuration: GAZE_MIN_SHIFT_DURATION_SECONDS,
    microYawPhase: randomBetween(0, Math.PI * 2),
    microPitchPhase: randomBetween(0, Math.PI * 2)
  };
}

function resetNaturalGazeState() {
  gazeState = createNaturalGazeState();

  if (currentVrm?.lookAt) {
    currentVrm.lookAt.target = null;
    currentVrm.lookAt.reset();
  }
}

function createHeadIdleState() {
  return {
    elapsed: 0,
    phaseElapsed: 0,
    isShifting: false,
    current: { yaw: 0, pitch: 0, roll: 0 },
    from: { yaw: 0, pitch: 0, roll: 0 },
    target: { yaw: 0, pitch: 0, roll: 0 },
    nextShiftAt: randomBetween(...HEAD_IDLE_SHIFT_INTERVAL_RANGE_SECONDS),
    shiftDuration: randomBetween(...HEAD_IDLE_SHIFT_DURATION_RANGE_SECONDS),
    microYawPhase: randomBetween(0, Math.PI * 2),
    microPitchPhase: randomBetween(0, Math.PI * 2),
    microRollPhase: randomBetween(0, Math.PI * 2)
  };
}

function resetHeadIdleState() {
  headIdleState = createHeadIdleState();
}

function scheduleNextNaturalGazeShift() {
  const holdRange = gazeState.current.isGlance
    ? GAZE_GLANCE_HOLD_RANGE_SECONDS
    : GAZE_DIRECT_HOLD_RANGE_SECONDS;

  gazeState.nextShiftAt = gazeState.elapsed + randomBetween(...holdRange);
}

function beginNaturalGazeShift() {
  const target = chooseNaturalGazeTarget(gazeState.forceDirectNext);
  const shiftDistance = Math.hypot(
    target.yaw - gazeState.current.yaw,
    target.pitch - gazeState.current.pitch
  );

  gazeState.isShifting = true;
  gazeState.forceDirectNext = target.isGlance;
  gazeState.phaseElapsed = 0;
  gazeState.from = { ...gazeState.current };
  gazeState.target = target;
  gazeState.shiftDuration = THREE.MathUtils.clamp(
    0.1 + shiftDistance * 0.014 + randomBetween(0, 0.05),
    GAZE_MIN_SHIFT_DURATION_SECONDS,
    GAZE_MAX_SHIFT_DURATION_SECONDS
  );
}

function positionNaturalGazeTarget(yawDegrees, pitchDegrees) {
  const lookAt = currentVrm?.lookAt;

  if (!lookAt) {
    return;
  }

  camera.updateMatrixWorld(true);
  currentAvatarRoot?.updateMatrixWorld(true);

  lookAt.getLookAtWorldPosition(gazeOrigin);
  const distance = Math.max(1.2, gazeOrigin.distanceTo(camera.position));
  const horizontalOffset = Math.tan(degreesToRadians(yawDegrees)) * distance;
  const verticalOffset = Math.tan(degreesToRadians(pitchDegrees)) * distance;

  camera.getWorldDirection(gazeCameraForward);
  gazeCameraRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  gazeCameraUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();

  gazeTarget.position
    .copy(camera.position)
    .addScaledVector(gazeCameraForward, GAZE_CAMERA_FORWARD_OFFSET)
    .addScaledVector(gazeCameraRight, horizontalOffset)
    .addScaledVector(gazeCameraUp, verticalOffset);
  gazeTarget.updateMatrixWorld(true);
}

function updateNaturalGaze(delta) {
  if (!currentVrm?.lookAt) {
    return;
  }

  if (currentVrm.lookAt.target !== gazeTarget) {
    currentVrm.lookAt.target = gazeTarget;
    currentVrm.lookAt.autoUpdate = true;
  }

  gazeState.elapsed += delta;

  if (!gazeState.isShifting && gazeState.elapsed >= gazeState.nextShiftAt) {
    beginNaturalGazeShift();
  }

  if (gazeState.isShifting) {
    gazeState.phaseElapsed += delta;
    const progress = Math.min(1, gazeState.phaseElapsed / gazeState.shiftDuration);
    const eased = smoothstep(progress);

    gazeState.current = {
      yaw: THREE.MathUtils.lerp(gazeState.from.yaw, gazeState.target.yaw, eased),
      pitch: THREE.MathUtils.lerp(gazeState.from.pitch, gazeState.target.pitch, eased),
      isGlance: gazeState.target.isGlance
    };

    if (progress >= 1) {
      gazeState.phaseElapsed = 0;
      gazeState.isShifting = false;
      scheduleNextNaturalGazeShift();
    }
  }

  const microYaw =
    Math.sin(gazeState.elapsed * 0.78 + gazeState.microYawPhase) *
    GAZE_MICRO_YAW_DEGREES;
  const microPitch =
    Math.sin(gazeState.elapsed * 0.94 + gazeState.microPitchPhase) *
    GAZE_MICRO_PITCH_DEGREES;

  positionNaturalGazeTarget(
    gazeState.current.yaw + microYaw,
    gazeState.current.pitch + microPitch
  );
}

function scheduleNextHeadIdleShift() {
  headIdleState.nextShiftAt =
    headIdleState.elapsed + randomBetween(...HEAD_IDLE_SHIFT_INTERVAL_RANGE_SECONDS);
  headIdleState.shiftDuration = randomBetween(...HEAD_IDLE_SHIFT_DURATION_RANGE_SECONDS);
}

function beginHeadIdleShift() {
  headIdleState.isShifting = true;
  headIdleState.phaseElapsed = 0;
  headIdleState.from = { ...headIdleState.current };
  headIdleState.target = {
    yaw: degreesToRadians(randomBetween(...HEAD_IDLE_YAW_RANGE_DEGREES)),
    pitch: degreesToRadians(randomBetween(...HEAD_IDLE_PITCH_RANGE_DEGREES)),
    roll: degreesToRadians(randomBetween(...HEAD_IDLE_ROLL_RANGE_DEGREES))
  };
}

function setupHeadIdleRig(vrm) {
  const humanoid = vrm?.humanoid;

  if (!humanoid) {
    return null;
  }

  const upperChestBone =
    humanoid.getNormalizedBoneNode('upperChest') ??
    humanoid.getNormalizedBoneNode('chest') ??
    humanoid.getNormalizedBoneNode('spine');
  const neckBone = humanoid.getNormalizedBoneNode('neck');
  const headBone = humanoid.getNormalizedBoneNode('head');

  return {
    upperChestBone,
    neckBone,
    headBone
  };
}

function applyBoneIdleRotation(bone, baseQuaternion, pitch, yaw, roll) {
  if (!bone) {
    return;
  }

  headIdleWorkingEuler.set(pitch, yaw, roll);
  headIdleOffsetQuaternion.setFromEuler(headIdleWorkingEuler);
  baseQuaternion.copy(bone.quaternion);
  bone.quaternion.copy(baseQuaternion.multiply(headIdleOffsetQuaternion));
}

function updateHeadIdle(delta) {
  if (!headIdleRig) {
    return;
  }

  headIdleState.elapsed += delta;

  if (!headIdleState.isShifting && headIdleState.elapsed >= headIdleState.nextShiftAt) {
    beginHeadIdleShift();
  }

  if (headIdleState.isShifting) {
    headIdleState.phaseElapsed += delta;
    const progress = Math.min(1, headIdleState.phaseElapsed / headIdleState.shiftDuration);
    const eased = smoothstep(progress);

    headIdleState.current = {
      yaw: THREE.MathUtils.lerp(headIdleState.from.yaw, headIdleState.target.yaw, eased),
      pitch: THREE.MathUtils.lerp(headIdleState.from.pitch, headIdleState.target.pitch, eased),
      roll: THREE.MathUtils.lerp(headIdleState.from.roll, headIdleState.target.roll, eased)
    };

    if (progress >= 1) {
      headIdleState.phaseElapsed = 0;
      headIdleState.isShifting = false;
      scheduleNextHeadIdleShift();
    }
  }

  const elapsed = headIdleState.elapsed;
  const microYaw =
    Math.sin(elapsed * 0.65 + headIdleState.microYawPhase) *
    degreesToRadians(HEAD_IDLE_MICRO_YAW_DEGREES);
  const microPitch =
    Math.sin(elapsed * 0.92 + headIdleState.microPitchPhase) *
    degreesToRadians(HEAD_IDLE_MICRO_PITCH_DEGREES);
  const microRoll =
    Math.sin(elapsed * 0.51 + headIdleState.microRollPhase) *
    degreesToRadians(HEAD_IDLE_MICRO_ROLL_DEGREES);

  const yaw = headIdleState.current.yaw + microYaw;
  const pitch = headIdleState.current.pitch + microPitch;
  const roll = headIdleState.current.roll + microRoll;

  applyBoneIdleRotation(
    headIdleRig.upperChestBone,
    headIdleBaseQuaternion,
    pitch * 0.22,
    yaw * 0.16,
    roll * 0.24
  );
  applyBoneIdleRotation(
    headIdleRig.neckBone,
    headIdleWorkingQuaternion,
    pitch * 0.42,
    yaw * 0.39,
    roll * 0.4
  );
  applyBoneIdleRotation(
    headIdleRig.headBone,
    headIdleWorkingQuaternion,
    pitch * 0.5,
    yaw * 0.62,
    roll * 0.52
  );
}

function scheduleNextBlink(isDoubleBlink = false) {
  const waitTime = isDoubleBlink
    ? randomBetween(...DOUBLE_BLINK_INTERVAL_RANGE_SECONDS)
    : randomBetween(...BLINK_INTERVAL_RANGE_SECONDS);
  blinkState.nextBlinkAt = blinkState.elapsed + waitTime;
}

function beginBlinkCycle() {
  blinkState.phase = 'closing';
  blinkState.phaseElapsed = 0;
  blinkState.closeDuration = randomBetween(...BLINK_CLOSE_DURATION_RANGE_SECONDS);
  blinkState.holdDuration = randomBetween(...BLINK_HOLD_DURATION_RANGE_SECONDS);
  blinkState.openDuration = randomBetween(...BLINK_OPEN_DURATION_RANGE_SECONDS);
  blinkState.leftScale = randomBetween(...BLINK_EYE_SCALE_RANGE);
  blinkState.rightScale = randomBetween(...BLINK_EYE_SCALE_RANGE);
  blinkState.queueDoubleBlink = Math.random() < DOUBLE_BLINK_CHANCE;
}

function getBlinkCapabilities(vrm) {
  const manager = vrm?.expressionManager;

  if (!manager) {
    return { hasCombinedBlink: false, hasLeftBlink: false, hasRightBlink: false };
  }

  return {
    hasCombinedBlink: manager.getExpression('blink') != null,
    hasLeftBlink: manager.getExpression('blinkLeft') != null,
    hasRightBlink: manager.getExpression('blinkRight') != null
  };
}

function applyBlinkWeight(leftWeight, rightWeight) {
  const manager = currentVrm?.expressionManager;

  if (!manager) {
    return;
  }

  const { hasCombinedBlink, hasLeftBlink, hasRightBlink } = getBlinkCapabilities(currentVrm);

  if (hasLeftBlink || hasRightBlink) {
    if (hasCombinedBlink) {
      manager.setValue('blink', 0);
    }

    if (hasLeftBlink) {
      manager.setValue('blinkLeft', leftWeight);
    }

    if (hasRightBlink) {
      manager.setValue('blinkRight', rightWeight);
    }

    return;
  }

  if (hasCombinedBlink) {
    manager.setValue('blink', Math.max(leftWeight, rightWeight));
  }
}

function updateBlink(delta) {
  if (!currentVrm?.expressionManager) {
    return;
  }

  const { hasCombinedBlink, hasLeftBlink, hasRightBlink } = getBlinkCapabilities(currentVrm);

  if (!hasCombinedBlink && !hasLeftBlink && !hasRightBlink) {
    return;
  }

  blinkState.elapsed += delta;

  if (blinkState.phase === 'idle') {
    if (blinkState.elapsed >= blinkState.nextBlinkAt) {
      beginBlinkCycle();
    } else {
      applyBlinkWeight(0, 0);
      return;
    }
  }

  blinkState.phaseElapsed += delta;

  let normalizedWeight = 0;

  if (blinkState.phase === 'closing') {
    normalizedWeight = Math.min(1, blinkState.phaseElapsed / blinkState.closeDuration);

    if (blinkState.phaseElapsed >= blinkState.closeDuration) {
      blinkState.phase = 'holding';
      blinkState.phaseElapsed = 0;
      normalizedWeight = 1;
    }
  } else if (blinkState.phase === 'holding') {
    normalizedWeight = 1;

    if (blinkState.phaseElapsed >= blinkState.holdDuration) {
      blinkState.phase = 'opening';
      blinkState.phaseElapsed = 0;
    }
  } else if (blinkState.phase === 'opening') {
    normalizedWeight = 1 - Math.min(1, blinkState.phaseElapsed / blinkState.openDuration);

    if (blinkState.phaseElapsed >= blinkState.openDuration) {
      blinkState.phase = 'idle';
      blinkState.phaseElapsed = 0;
      normalizedWeight = 0;
      scheduleNextBlink(blinkState.queueDoubleBlink);
      blinkState.queueDoubleBlink = false;
    }
  }

  applyBlinkWeight(
    normalizedWeight * blinkState.leftScale,
    normalizedWeight * blinkState.rightScale
  );
}

function setStatus(message, isError = false) {
  status.textContent = message;
  status.dataset.error = String(isError);
}

function resizeRenderer() {
  const viewport = canvas.parentElement;
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;

  if (width === 0 || height === 0) {
    return;
  }

  if (canvas.width !== width || canvas.height !== height) {
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    browserWindow.setSize(width, height);
  }
}

function disposeCurrentModel() {
  if (gestureController) {
    gestureController.dispose();
    gestureController = null;
  }
  if (spatialController) {
    spatialController.dispose();
    spatialController = null;
  }
  detachVrmBodyPhysics();

  if (!currentVrm) {
    return;
  }

  // Keep visionCamera on the scene root (world-space FPV); just mark unattached
  visionHeadAttached = false;
  if (visionCamera.parent !== scene) {
    visionCamera.parent?.remove(visionCamera);
    scene.add(visionCamera);
  }
  if (currentAvatarRoot) {
    scene.remove(currentAvatarRoot);
    currentAvatarRoot = null;
  }

  currentMotionRoot = null;
  headIdleRig = null;
  resetHeadIdleState();
  resetNaturalGazeState();
  applyBlinkWeight(0, 0);
  resetBlinkState();
  VRMUtils.deepDispose(currentVrm.scene);
  currentVrm = null;

  if (currentVrmUrl?.startsWith('blob:')) {
    URL.revokeObjectURL(currentVrmUrl);
  }

  currentVrmUrl = null;
}

function disposeCurrentAnimation() {
  if (currentAnimationSource?.url?.startsWith('blob:')) {
    URL.revokeObjectURL(currentAnimationSource.url);
  }
}

function frameModel(root) {
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const height = Math.max(size.y, 1.4);

  controls.target.set(center.x, center.y + height * 0.1, center.z);
  camera.position.set(center.x, center.y + height * 0.45, center.z + Math.max(size.z, 1.2) + 2.1);
  controls.update();
}

function resetModelPosition() {
  if (!currentMotionRoot && !currentAvatarRoot) {
    return;
  }

  if (currentMotionRoot) currentMotionRoot.position.set(0, 0, 0);
  if (currentAvatarRoot) {
    currentAvatarRoot.position.set(0, 0, 0);
    currentAvatarRoot.rotation.y = 0;
  }
  if (spatialController) {
    spatialController.yaw = 0;
    spatialController.action = null;
    if (spatialController._worldPos) spatialController._worldPos.set(0, 0, 0);
  }
  if (isPhysicsReady()) setAvatarPosition(0, 0);

  gestureController?.resetBase();

  if (currentVrm) {
    frameModel(currentAvatarRoot ?? currentVrm.scene);
  }
}

function ensureSpatialController() {
  if (spatialController) return spatialController;
  spatialController = new SpatialController({
    getAvatarRoot: () => currentAvatarRoot,
    getMotionRoot: () => currentMotionRoot,
    getGesture: () => gestureController,
    getVrm: () => currentVrm,
    getCamera: () => camera,
    getBrowser: () => browserWindow?.cssObject ?? null,
    scene,
    idleUrl: defaultAnimationUrl,
    walkUrl: walkAnimationUrl,
    /** VisionPlanner / run_plan can include view_click steps */
    executeViewTool: async (name, args) => {
      if (name === 'view_click') return handleViewClick(args);
      if (name === 'view_look') return handleViewLook(args);
      if (name === 'view_go') return handleViewGo(args);
      return { ok: false, error: `unknown_view_tool:${name}` };
    },
    sendResult: (msg) => {
      if (globalWs && globalWs.readyState === 1) {
        globalWs.send(JSON.stringify(msg));
      }
    },
  });
  console.log('[Spatial] Controller ready.');
  return spatialController;
}

function ensureBrowserController() {
  if (browserController) return browserController;
  browserController = new BrowserController({
    getBrowserWindow: () => browserWindow,
    getGesture: () => gestureController,
    sendResult: (msg) => {
      if (globalWs && globalWs.readyState === 1) {
        globalWs.send(JSON.stringify(msg));
      } else {
        console.warn('[BrowserCtrl] WS not open; cannot send browserResult');
      }
    },
  });
  console.log('[BrowserCtrl] Controller ready.');
  return browserController;
}

// Scene pose is returned on every spatialResult (tool response). We do NOT
// stream sceneState as realtime text — that can make Live treat it as user
// input and start talking unprompted.

async function loadVrm(url, label = 'default VRM') {
  disposeCurrentModel();
  currentVrmUrl = url;
  resetHeadIdleState();
  resetBlinkState();
  setStatus(`Loading ${label}...`);

  try {
    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm;

    if (!vrm) {
      throw new Error('The selected file did not contain a VRM model.');
    }

    VRMUtils.rotateVRM0(vrm);
    currentVrm = vrm;
    resetEmotions();
    headIdleRig = setupHeadIdleRig(vrm);
    attachVisionCameraToHead(vrm);
    // Pull soft bones (esp. fox tail) downward with SpringBone gravity
    // Tail hangs; ears stiff; bust near-static; soft colliders reduce tail clip
    configureVrmSpringGravity(vrm, {
      tailGravity: 1.35,
      hairGravity: 0.55,
      earGravity: 0.12,
      bustGravity: 0.05,
    });

    currentAvatarRoot = new THREE.Group();
    currentAvatarRoot.name = 'VRMAvatarRoot';
    currentMotionRoot = new THREE.Group();
    currentMotionRoot.name = 'VRMMotionRoot';
    currentAvatarRoot.add(currentMotionRoot);
    currentMotionRoot.add(vrm.scene);
    scene.add(currentAvatarRoot);

    // Animated skinned meshes can get culled incorrectly once bones start moving.
    vrm.scene.traverse((object) => {
      object.frustumCulled = false;
    });

    frameModel(currentAvatarRoot);
    ensureSpatialController();
    // Fresh spawn: clear any prior world pose from a previous VRM session.
    if (spatialController) {
      spatialController.yaw = 0;
      spatialController.action = null;
      if (spatialController._worldPos) spatialController._worldPos.set(0, 0, 0);
      currentAvatarRoot.position.set(0, 0, 0);
      currentAvatarRoot.rotation.y = 0;
      currentMotionRoot.position.set(0, 0, 0);
    }
    if (isPhysicsReady()) {
      setAvatarPosition(0, 0);
      attachVrmBodyPhysics(vrm);
    } else {
      initPhysics().then((ok) => {
        if (ok && currentVrm === vrm) {
          setAvatarPosition(0, 0);
          attachVrmBodyPhysics(vrm);
        }
      });
    }

    if (currentAnimationSource) {
      await loadAnimation(currentAnimationSource.url, currentAnimationSource.name);
    } else {
      setStatus(`Loaded ${label}.`);
    }
  } catch (error) {
    disposeCurrentModel();
    setStatus(error instanceof Error ? error.message : 'Failed to load model.', true);
  }
}

async function loadAnimation(url, label = 'default animation') {
  currentAnimationSource = { url, name: label };

  if (!currentVrm) {
    setStatus(`Queued ${label} until the VRM finishes loading.`);
    return;
  }

  disposeCurrentAnimation();

  try {
    if (!gestureController) {
      // First animation for this VRM: stand up the gesture system. This loads
      // the idle base AND preloads the whole talking-gesture pool so speech
      // gestures can start instantly with zero mid-conversation load latency.
      gestureController = new GestureController({
        vrm: currentVrm,
        root: currentAvatarRoot ?? currentVrm.scene,
        motionRootName: currentMotionRoot?.name ?? null,
        getMood: getGestureMood,
      });
      await gestureController.load(url);
    } else {
      // Subsequent calls (API-driven walk/dance/etc.) swap the persistent base
      // layer with a cross-fade; the talking layer keeps working on top.
      await gestureController.setBaseAnimation(url, {
        allowVerticalMotion: DEFAULT_ALLOW_VERTICAL_MOTION,
        allowFloorMotion: DEFAULT_ALLOW_FLOOR_MOTION,
      });
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Failed to load animation.', true);
  }
}

// Map the avatar's current mood into gesture-selection inputs:
//  - tierBias: which energy tier of talking clips to prefer.
//  - amplitude: smoothed speech loudness (0..1) for within-tier liveliness.
// Emotion sets the baseline tier; loud speech can bump it up a notch.
function getGestureMood() {
  let tierBias = 'medium';

  // Strongest active emotion decides the baseline energy.
  let topEmotion = 'neutral';
  let topWeight = 0;
  for (const name of EMOTION_EXPRESSIONS) {
    if (name === 'neutral') continue;
    if (emotionState.current[name] > topWeight) {
      topWeight = emotionState.current[name];
      topEmotion = name;
    }
  }

  if (topWeight > 0.25) {
    if (topEmotion === 'angry' || topEmotion === 'surprised' || topEmotion === 'happy') {
      tierBias = 'high';
    } else if (topEmotion === 'sad' || topEmotion === 'relaxed') {
      tierBias = 'low';
    }
  }

  // Loud, emphatic speech nudges the tier up even on a neutral mood.
  if (speechAmplitude > 0.6 && tierBias === 'low') tierBias = 'medium';
  if (speechAmplitude > 0.75 && tierBias === 'medium') tierBias = 'high';

  return { tierBias, amplitude: speechAmplitude };
}

const clock = new THREE.Clock();

const _eyePos = new THREE.Vector3();
const _lookDir = new THREE.Vector3();
const _lookTarget = new THREE.Vector3();
const _upWorld = new THREE.Vector3(0, 1, 0);
const _headWorld = new THREE.Vector3();
const _headQuat = new THREE.Quaternion();

/**
 * Mark VRM as ready for FPV. Camera is world-space (not parented to head bone),
 * because head-local +Y=π was often wrong vs VRM faceFront / normalized bones.
 */
function attachVisionCameraToHead(vrm) {
  visionHeadAttached = false;
  // Ensure camera lives in scene root (world pose set every frame)
  if (visionCamera.parent !== scene) {
    visionCamera.parent?.remove(visionCamera);
    scene.add(visionCamera);
  }
  visionCamera.fov = VISION_FOV;
  visionCamera.aspect = VISION_WIDTH / VISION_HEIGHT;
  visionCamera.near = 0.05;
  visionCamera.far = 80;
  visionCamera.updateProjectionMatrix();
  visionCamera.layers.enableAll();

  const hasLookAt = typeof vrm?.lookAt?.getLookAtWorldDirection === 'function';
  const hasHead =
    !!vrm?.humanoid?.getNormalizedBoneNode?.('head') ||
    !!vrm?.humanoid?.getRawBoneNode?.('head') ||
    !!vrm?.humanoid?.getBoneNode?.('head');
  visionHeadAttached = hasLookAt || hasHead;
  console.log(
    `[VisionFP] FPV ready (world-space LookAt) lookAt=${hasLookAt} head=${hasHead} FOV=${VISION_FOV}° ${VISION_WIDTH}x${VISION_HEIGHT}`,
  );
}

/** Last FPV placement details (for verbose VisionFP position logs). */
const visionFpDebug = {
  eyeSource: 'none',
  rawEye: new THREE.Vector3(),
  headPos: new THREE.Vector3(),
  lookAtPos: new THREE.Vector3(),
  rootPos: new THREE.Vector3(),
  yaw: 0,
  bodyFwd: new THREE.Vector3(),
  eyeAfterNudge: new THREE.Vector3(),
  lookTarget: new THREE.Vector3(),
  aimedAtBrowser: false,
  eyeToBrowserDist: null,
  bodyAlign: null,
  yFloorClamped: false,
};

const _fpvCorner = new THREE.Vector3();
const _fpvNdc = new THREE.Vector3();

/**
 * Place visionCamera at the avatar eyes looking where the BODY faces.
 *
 * CRITICAL: Do NOT use VRMLookAt.getLookAtWorldDirection as the primary aim —
 * on many VRM0 models it returns rest/faceFront axes that are ~180° off from
 * avatarRoot yaw (spatialController). Logs showed facingBrowser=true while FPV
 * looked +Z away from the panel at z=-0.3.
 *
 * Body forward matches spatialController walk: (sin(yaw), 0, cos(yaw)).
 * Eye height from LookAt origin or head bone; optional small pitch toward browser.
 */
function updateVisionCameraFromAvatar() {
  if (!currentVrm && !currentAvatarRoot) return;

  currentAvatarRoot?.updateMatrixWorld(true);
  currentVrm?.scene?.updateMatrixWorld?.(true);

  // --- Body yaw forward (same convention as SpatialController) ---
  const yaw =
    spatialController && Number.isFinite(spatialController.yaw)
      ? spatialController.yaw
      : currentAvatarRoot?.rotation?.y ?? 0;
  // Horizontal aim
  _lookDir.set(Math.sin(yaw), 0, Math.cos(yaw)).normalize();
  visionFpDebug.yaw = yaw;
  visionFpDebug.bodyFwd.copy(_lookDir);
  if (currentAvatarRoot) {
    visionFpDebug.rootPos.copy(currentAvatarRoot.position);
  }

  // --- Eye position: LookAt origin / head / root ---
  let haveEye = false;
  let eyeSource = 'none';
  visionFpDebug.headPos.set(NaN, NaN, NaN);
  visionFpDebug.lookAtPos.set(NaN, NaN, NaN);

  const lookAt = currentVrm?.lookAt;
  if (lookAt && typeof lookAt.getLookAtWorldPosition === 'function') {
    try {
      lookAt.getLookAtWorldPosition(_eyePos);
      haveEye = Number.isFinite(_eyePos.x);
      if (haveEye) {
        eyeSource = 'lookAt';
        visionFpDebug.lookAtPos.copy(_eyePos);
      }
    } catch {
      /* fall through */
    }
  }

  const humanoid = currentVrm?.humanoid;
  const head =
    humanoid?.getNormalizedBoneNode?.('head') ||
    humanoid?.getRawBoneNode?.('head') ||
    humanoid?.getBoneNode?.('head') ||
    null;
  if (head) {
    head.getWorldPosition(_headWorld);
    visionFpDebug.headPos.copy(_headWorld);
    if (!haveEye) {
      _eyePos.copy(_headWorld);
      haveEye = true;
      eyeSource = 'headBone';
    }
  }
  if (!haveEye && currentAvatarRoot) {
    _eyePos.set(
      currentAvatarRoot.position.x,
      currentAvatarRoot.position.y + 1.48,
      currentAvatarRoot.position.z,
    );
    haveEye = true;
    eyeSource = 'rootFallback';
  }
  if (!haveEye) return;

  visionFpDebug.eyeSource = eyeSource;
  visionFpDebug.rawEye.copy(_eyePos);

  // Nudge slightly forward of the face (outside head mesh); keep small so distance to panel stays true
  _eyePos.addScaledVector(_lookDir, 0.06);
  // Slight upward bias from bone center toward eyes
  visionFpDebug.yFloorClamped = false;
  if (_eyePos.y < 1.1) {
    _eyePos.y = 1.35;
    visionFpDebug.yFloorClamped = true;
  }
  visionFpDebug.eyeAfterNudge.copy(_eyePos);

  // Prefer looking at the browser plane when it is roughly in front of the body
  // (same facing test as spatial: within ~40° of body forward).
  let aimedAtBrowser = false;
  visionFpDebug.bodyAlign = null;
  visionFpDebug.eyeToBrowserDist = null;
  if (typeof browserWindow?.getContentWorldCenter === 'function') {
    browserWindow.getContentWorldCenter(_povBrowserCenter);
    _povToBrowser.copy(_povBrowserCenter).sub(_eyePos);
    const dist = _povToBrowser.length();
    visionFpDebug.eyeToBrowserDist = dist;
    if (dist > 0.15 && dist < 8) {
      _povToBrowser.normalize();
      // Horizontal facing only for the gate
      const toH = new THREE.Vector3(_povToBrowser.x, 0, _povToBrowser.z);
      if (toH.lengthSq() > 1e-6) {
        toH.normalize();
        const bodyH = new THREE.Vector3(_lookDir.x, 0, _lookDir.z).normalize();
        const align = bodyH.dot(toH);
        visionFpDebug.bodyAlign = align;
        if (align > 0.35) {
          // Aim at browser center (includes pitch) — this is what the AI should see
          _lookTarget.copy(_povBrowserCenter);
          aimedAtBrowser = true;
        }
      }
    }
  }

  if (!aimedAtBrowser) {
    _lookTarget.copy(_eyePos).addScaledVector(_lookDir, 3.0);
    // Soft downward pitch so we see the room / mid-height panels
    _lookTarget.y -= 0.15;
  }

  visionFpDebug.aimedAtBrowser = aimedAtBrowser;
  visionFpDebug.lookTarget.copy(_lookTarget);

  visionCamera.position.copy(_eyePos);
  visionCamera.up.copy(_upWorld);
  visionCamera.lookAt(_lookTarget);
  visionCamera.updateMatrixWorld(true);
  visionHeadAttached = true;
}

/** Format a Vector3 for logs. */
function v3log(v, digits = 3) {
  if (!v || !Number.isFinite(v.x)) return 'n/a';
  return `${v.x.toFixed(digits)},${v.y.toFixed(digits)},${v.z.toFixed(digits)}`;
}

/**
 * Verbose FPV pose dump: eyes, root, head, browser plane, angular fill, spectator.
 * Called on throttled stream frames and every manual screenshot.
 */
function logVisionFpPositions(reason = 'diag') {
  visionCamera.getWorldPosition(_povCamWorld);
  visionCamera.getWorldDirection(_povFwd);
  visionCamera.getWorldQuaternion(_povQuat);

  const bodyYaw =
    spatialController && Number.isFinite(spatialController.yaw)
      ? spatialController.yaw
      : currentAvatarRoot?.rotation?.y ?? 0;

  const mesh = browserWindow?.contentMesh ?? null;
  let browserCenter = null;
  let browserDist = null;
  let rootToBrowser = null;
  let browserInFront = null;
  let browserNdc = null;
  let planeSize = null;
  let planeCornersNdc = null;
  let angularDeg = null;
  let screenFillApprox = null;

  if (typeof browserWindow?.getContentWorldCenter === 'function') {
    browserWindow.getContentWorldCenter(_povBrowserCenter);
    browserCenter = _povBrowserCenter.clone();
    browserDist = _povCamWorld.distanceTo(_povBrowserCenter);
    if (currentAvatarRoot) {
      rootToBrowser = currentAvatarRoot.position.distanceTo(_povBrowserCenter);
    }
    _povToBrowser.copy(_povBrowserCenter).sub(_povCamWorld);
    const toLen = _povToBrowser.length();
    if (toLen > 1e-6) {
      _povToBrowser.multiplyScalar(1 / toLen);
      browserInFront = _povFwd.dot(_povToBrowser) > 0.1;
    }
    _fpvNdc.copy(_povBrowserCenter).project(visionCamera);
    browserNdc = {
      x: +_fpvNdc.x.toFixed(3),
      y: +_fpvNdc.y.toFixed(3),
      z: +_fpvNdc.z.toFixed(3),
    };
  }

  if (mesh?.geometry) {
    mesh.geometry.computeBoundingBox?.();
    const bb = mesh.geometry.boundingBox;
    if (bb) {
      const size = new THREE.Vector3();
      bb.getSize(size);
      // PlaneGeometry is in local XY; world scale applied via mesh
      const sx = mesh.scale?.x ?? 1;
      const sy = mesh.scale?.y ?? 1;
      planeSize = {
        w: +(size.x * sx).toFixed(3),
        h: +(size.y * sy).toFixed(3),
      };
      if (browserDist != null && browserDist > 0.01 && planeSize.w > 0 && planeSize.h > 0) {
        const angW = (2 * Math.atan((planeSize.w / 2) / browserDist) * 180) / Math.PI;
        const angH = (2 * Math.atan((planeSize.h / 2) / browserDist) * 180) / Math.PI;
        angularDeg = { w: +angW.toFixed(1), h: +angH.toFixed(1) };
        // Vertical FOV fraction of frame height the panel would occupy if centered
        const fillH = angH / VISION_FOV;
        const hFov =
          (2 *
            Math.atan(Math.tan((VISION_FOV * Math.PI) / 360) * (VISION_WIDTH / VISION_HEIGHT)) *
            180) /
          Math.PI;
        const fillW = angW / hFov;
        screenFillApprox = {
          w: +Math.min(fillW, 9.99).toFixed(2),
          h: +Math.min(fillH, 9.99).toFixed(2),
          hFovDeg: +hFov.toFixed(1),
        };
      }

      // Project 4 plane corners (local) → NDC to see actual on-screen footprint
      const corners = [
        [bb.min.x, bb.min.y, 0],
        [bb.max.x, bb.min.y, 0],
        [bb.min.x, bb.max.y, 0],
        [bb.max.x, bb.max.y, 0],
      ];
      const ndcPts = [];
      for (const [lx, ly, lz] of corners) {
        _fpvCorner.set(lx, ly, lz);
        mesh.localToWorld(_fpvCorner);
        _fpvNdc.copy(_fpvCorner).project(visionCamera);
        ndcPts.push({
          x: +_fpvNdc.x.toFixed(2),
          y: +_fpvNdc.y.toFixed(2),
          z: +_fpvNdc.z.toFixed(2),
        });
      }
      planeCornersNdc = ndcPts;
    }
  }

  const spectator = {
    pos: v3log(camera.position),
    target: v3log(controls?.target),
    fov: camera.fov,
    distToBrowser:
      browserCenter != null ? +camera.position.distanceTo(browserCenter).toFixed(3) : null,
  };

  console.log(
    `[VisionFP] === positions (${reason}) ===\n` +
      `  eyeSource=${visionFpDebug.eyeSource} yFloorClamp=${visionFpDebug.yFloorClamped}\n` +
      `  rawEye=${v3log(visionFpDebug.rawEye)} head=${v3log(visionFpDebug.headPos)} lookAtOrigin=${v3log(visionFpDebug.lookAtPos)}\n` +
      `  eyeAfterNudge=${v3log(visionFpDebug.eyeAfterNudge)} camWorld=${v3log(_povCamWorld)}\n` +
      `  root=${v3log(visionFpDebug.rootPos)} bodyYawDeg=${THREE.MathUtils.radToDeg(bodyYaw).toFixed(1)} bodyFwd=${v3log(visionFpDebug.bodyFwd)}\n` +
      `  lookTarget=${v3log(visionFpDebug.lookTarget)} camFwd=${v3log(_povFwd)} aimedAtBrowser=${visionFpDebug.aimedAtBrowser}\n` +
      `  bodyAlign=${visionFpDebug.bodyAlign != null ? visionFpDebug.bodyAlign.toFixed(3) : 'n/a'} ` +
      `eyeToBrowser(preAim)=${visionFpDebug.eyeToBrowserDist != null ? visionFpDebug.eyeToBrowserDist.toFixed(3) : 'n/a'}\n` +
      `  browserCenter=${browserCenter ? v3log(browserCenter) : 'n/a'} ` +
      `camToBrowser=${browserDist != null ? browserDist.toFixed(3) : 'n/a'} ` +
      `rootToBrowser=${rootToBrowser != null ? rootToBrowser.toFixed(3) : 'n/a'}\n` +
      `  planeSize_m=${planeSize ? `${planeSize.w}x${planeSize.h}` : 'n/a'} ` +
      `angularDeg=${angularDeg ? JSON.stringify(angularDeg) : 'n/a'} ` +
      `screenFill≈${screenFillApprox ? JSON.stringify(screenFillApprox) : 'n/a'}\n` +
      `  browserNdc=${JSON.stringify(browserNdc)} inFront=${browserInFront} meshVis=${mesh?.visible}\n` +
      `  planeCornersNdc=${planeCornersNdc ? JSON.stringify(planeCornersNdc) : 'n/a'}\n` +
      `  fpvCam fov=${VISION_FOV} aspect=${(VISION_WIDTH / VISION_HEIGHT).toFixed(3)} ` +
      `near=${visionCamera.near} far=${visionCamera.far} ${VISION_WIDTH}x${VISION_HEIGHT}\n` +
      `  spectator pos=${spectator.pos} target=${spectator.target} fov=${spectator.fov} ` +
      `distToBrowser=${spectator.distToBrowser}`,
  );
}

/**
 * Render the 3D world from the avatar's eyes into visionFlipCanvas.
 * Same path the AI uses — hides the avatar mesh so we don't see inside the head.
 * @returns {{ ok: boolean, width: number, height: number, error?: string }}
 */
const _povBrowserCenter = new THREE.Vector3();
const _povCamWorld = new THREE.Vector3();
const _povFwd = new THREE.Vector3();
const _povToBrowser = new THREE.Vector3();
const _povQuat = new THREE.Quaternion();
const _povSavedViewport = new THREE.Vector4();
const _povSavedScissor = new THREE.Vector4();
let povDiagLogAt = 0;

function renderAvatarPovFrame() {
  if (!currentVrm && !currentAvatarRoot) {
    return { ok: false, width: VISION_WIDTH, height: VISION_HEIGHT, error: 'no_avatar' };
  }

  try {
    // Place eyes + face-front AFTER animation/VRM update (caller order in animate)
    updateVisionCameraFromAvatar();

    // Browser page is a WebGL CanvasTexture plane — force GPU upload before RT pass
    try {
      browserWindow?.prepareForVisionCapture?.();
      if (browserWindow?.contentMesh) {
        browserWindow.contentMesh.visible = true;
        browserWindow.contentMesh.frustumCulled = false;
        browserWindow.contentMesh.layers.enableAll();
      }
    } catch (e) {
      console.warn('[VisionFP] prepareForVisionCapture:', e?.message ?? e);
    }

    // Hide avatar for FPV (otherwise camera is inside the mesh)
    const avatarVisible = currentVrm?.scene?.visible;
    if (currentVrm?.scene) currentVrm.scene.visible = false;

    const prevTarget = renderer.getRenderTarget();
    const prevXr = renderer.xr?.enabled;
    renderer.getViewport(_povSavedViewport);
    renderer.getScissor(_povSavedScissor);
    const prevScissorTest = renderer.getScissorTest();
    if (renderer.xr) renderer.xr.enabled = false;

    // Spectator canvas size ≠ vision RT — force full RT viewport
    renderer.setRenderTarget(visionRenderTarget);
    renderer.setViewport(0, 0, VISION_WIDTH, VISION_HEIGHT);
    renderer.setScissor(0, 0, VISION_WIDTH, VISION_HEIGHT);
    renderer.setScissorTest(false);
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = true;
    // Match scene background clear
    if (scene.background && scene.background.isColor) {
      renderer.setClearColor(scene.background, 1);
    }
    renderer.clear(true, true, true);
    renderer.render(scene, visionCamera);
    renderer.autoClear = prevAutoClear;
    // CSS3D toolbar is DOM-only — not in this WebGL pass (by design).

    renderer.readRenderTargetPixels(
      visionRenderTarget,
      0,
      0,
      VISION_WIDTH,
      VISION_HEIGHT,
      visionPixelBuffer,
    );

    renderer.setRenderTarget(prevTarget);
    renderer.setViewport(_povSavedViewport);
    renderer.setScissor(_povSavedScissor);
    renderer.setScissorTest(prevScissorTest);
    if (renderer.xr && prevXr != null) renderer.xr.enabled = prevXr;
    if (currentVrm?.scene && avatarVisible !== undefined) {
      currentVrm.scene.visible = avatarVisible;
    } else if (currentVrm?.scene) {
      currentVrm.scene.visible = true;
    }

    // Flip Y (WebGL bottom-up → canvas top-down)
    const w = VISION_WIDTH;
    const h = VISION_HEIGHT;
    const dst = visionImageData.data;
    for (let y = 0; y < h; y++) {
      const srcRow = (h - 1 - y) * w * 4;
      const dstRow = y * w * 4;
      dst.set(visionPixelBuffer.subarray(srcRow, srcRow + w * 4), dstRow);
    }
    visionFlipCtx.putImageData(visionImageData, 0, 0);
    // Coordinate grid for AI grounding (view_click / view_look / view_go)
    if (VISION_GRID_ENABLED) {
      drawVisionGroundingGrid(visionFlipCtx, w, h);
    }

    // Optional verbose pose dump (off unless VISION_DEBUG / screenshot)
    if (VISION_DEBUG) {
      const now = performance.now();
      if (now - povDiagLogAt > 8000) {
        povDiagLogAt = now;
        logVisionFpPositions('stream');
      }
    }

    return { ok: true, width: w, height: h };
  } catch (e) {
    console.warn('[VisionFP] renderAvatarPovFrame failed:', e?.message ?? e);
    return {
      ok: false,
      width: VISION_WIDTH,
      height: VISION_HEIGHT,
      error: String(e?.message ?? e),
    };
  }
}

/** Column index 0..n → A, B, … Z, AA, AB… */
function visionColLabel(col) {
  let c = col;
  let s = '';
  do {
    s = String.fromCharCode(65 + (c % 26)) + s;
    c = Math.floor(c / 26) - 1;
  } while (c >= 0);
  return s;
}

/** Parse column letters A, B, … Z, AA → 0-based index. */
function visionColIndex(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    const ch = letters.charCodeAt(i);
    if (ch < 65 || ch > 90) return -1;
    n = n * 26 + (ch - 64);
  }
  return n - 1;
}

function visionCellLabel(col, row) {
  return `${visionColLabel(col)}${row + 1}`;
}

/**
 * Bake a numeric coordinate ruler into the AI FPV JPEG.
 * Primary: x,y in 0–1 over the full image (0,0)=top-left, (1,1)=bottom-right.
 * view_click({ x: 0.42, y: 0.61 }) aims at that point.
 */
function drawVisionGroundingGrid(ctx, w, h) {
  ctx.save();

  // Light checker every 0.1 so regions are easy to estimate
  const step = VISION_COORD_MAJOR;
  for (let iy = 0; iy < 1 / step; iy++) {
    for (let ix = 0; ix < 1 / step; ix++) {
      if ((ix + iy) % 2 === 0) {
        ctx.fillStyle = 'rgba(0, 35, 55, 0.06)';
        ctx.fillRect(ix * step * w, iy * step * h, step * w, step * h);
      }
    }
  }

  // Minor lines every 0.05
  for (let t = 0; t <= 1.0001; t += VISION_COORD_MINOR) {
    const major = Math.abs(t / VISION_COORD_MAJOR - Math.round(t / VISION_COORD_MAJOR)) < 1e-6;
    if (major) continue;
    const px = t * w;
    const py = t * h;
    ctx.lineWidth = 0.4;
    ctx.strokeStyle = 'rgba(0, 200, 255, 0.18)';
    ctx.beginPath();
    ctx.moveTo(Math.round(px) + 0.5, 0);
    ctx.lineTo(Math.round(px) + 0.5, h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, Math.round(py) + 0.5);
    ctx.lineTo(w, Math.round(py) + 0.5);
    ctx.stroke();
  }

  // Major lines every 0.1 + axis labels
  ctx.font = 'bold 11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  for (let t = 0; t <= 1.0001; t += VISION_COORD_MAJOR) {
    const v = Math.min(1, Math.round(t * 100) / 100);
    const px = v * w;
    const py = v * h;
    const isEdge = v === 0 || v === 1;
    ctx.lineWidth = isEdge ? 1.25 : 0.85;
    ctx.strokeStyle = isEdge ? 'rgba(0, 245, 255, 0.55)' : 'rgba(0, 220, 255, 0.38)';
    ctx.beginPath();
    ctx.moveTo(Math.round(px) + 0.5, 0);
    ctx.lineTo(Math.round(px) + 0.5, h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, Math.round(py) + 0.5);
    ctx.lineTo(w, Math.round(py) + 0.5);
    ctx.stroke();

    // X labels along top (and bottom for mid values)
    const label = v.toFixed(1);
    const lx = Math.min(w - 28, Math.max(2, px + 2));
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.fillStyle = 'rgba(255, 255, 90, 0.95)';
    ctx.strokeText(label, lx, 3);
    ctx.fillText(label, lx, 3);
    if (v > 0 && v < 1) {
      ctx.strokeText(label, lx, h - 32);
      ctx.fillText(label, lx, h - 32);
    }

    // Y labels along left
    const ly = Math.min(h - 28, Math.max(14, py + 2));
    ctx.strokeText(label, 3, ly);
    ctx.fillText(label, 3, ly);
  }

  // Corner anchors
  ctx.font = 'bold 12px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
  ctx.fillStyle = 'rgba(0, 255, 200, 0.98)';
  const corners = [
    { t: '(0,0)', x: 22, y: 18 },
    { t: '(1,0)', x: w - 48, y: 18 },
    { t: '(0,1)', x: 22, y: h - 40 },
    { t: '(1,1)', x: w - 48, y: h - 40 },
  ];
  for (const c of corners) {
    ctx.strokeText(c.t, c.x, c.y);
    ctx.fillText(c.t, c.x, c.y);
  }

  // Legend
  ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
  ctx.fillRect(4, h - 20, Math.min(w - 8, 560), 16);
  ctx.fillStyle = 'rgba(0, 255, 210, 0.98)';
  ctx.font = 'bold 11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'middle';
  ctx.fillText(
    `XY 0–1  (0,0)=TL (1,1)=BR  view_click({x:0.42,y:0.61})  ${w}×${h}`,
    10,
    h - 12,
  );
  ctx.restore();
}

/**
 * Numpad sub-cells inside one grid cell (screen y grows downward):
 *   7 8 9
 *   4 5 6
 *   1 2 3
 * Fractions are relative to the cell (0=left/top, 1=right/bottom).
 */
const VISION_SUBCELL_FRAC = {
  1: { fx: 0.2, fy: 0.8 },
  2: { fx: 0.5, fy: 0.8 },
  3: { fx: 0.8, fy: 0.8 },
  4: { fx: 0.2, fy: 0.5 },
  5: { fx: 0.5, fy: 0.5 },
  6: { fx: 0.8, fy: 0.5 },
  7: { fx: 0.2, fy: 0.2 },
  8: { fx: 0.5, fy: 0.2 },
  9: { fx: 0.8, fy: 0.2 },
};

const VISION_SUBCELL_DIR = {
  NW: 7,
  N: 8,
  NE: 9,
  W: 4,
  C: 5,
  CENTER: 5,
  E: 6,
  SW: 1,
  S: 2,
  SE: 3,
  TL: 7,
  TC: 8,
  TR: 9,
  ML: 4,
  M: 5,
  MR: 6,
  BL: 1,
  BC: 2,
  BR: 3,
};

/**
 * Parse cell → normalized view coords.
 * - "F3" / "H6" → cell center
 * - "F3.2" / "F3@9" / "F3,7" / "F3:1" → 3×3 sub-cell (numpad 1–9)
 * - "F3.NE" / "F3NW" → compass sub-cell
 * Optional dx/dy (-1..1) nudge within the cell after sub resolution.
 */
function parseVisionCell(cell, opts = {}) {
  const s = String(cell || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  // Base: letters + row, optional sub via . @ , : or glued letter dir
  const m =
    /^([A-Z]+)([1-9][0-9]*)(?:[.@,:#]([1-9]|NW|NE|SW|SE|N|S|E|W|C|CENTER|TL|TR|BL|BR|TC|BC|ML|MR|M))?$/.exec(
      s,
    ) || /^([A-Z]+)([1-9][0-9]*)(NW|NE|SW|SE|N|S|E|W)$/.exec(s);
  if (!m) return null;
  const col = visionColIndex(m[1]);
  const row = Number(m[2]) - 1;
  if (col < 0 || col >= VISION_GRID_COLS || row < 0 || row >= VISION_GRID_ROWS) {
    return null;
  }

  let sub = null;
  const subTok = m[3];
  if (subTok) {
    if (/^[1-9]$/.test(subTok)) sub = Number(subTok);
    else if (VISION_SUBCELL_DIR[subTok] != null) sub = VISION_SUBCELL_DIR[subTok];
  }
  // Explicit tool arg overrides suffix
  if (opts.sub != null && Number.isFinite(Number(opts.sub))) {
    const n = Math.round(Number(opts.sub));
    if (n >= 1 && n <= 9) sub = n;
  }

  let fx = 0.5;
  let fy = 0.5;
  if (sub != null && VISION_SUBCELL_FRAC[sub]) {
    fx = VISION_SUBCELL_FRAC[sub].fx;
    fy = VISION_SUBCELL_FRAC[sub].fy;
  }

  // Fine nudge within cell: dx/dy in -1..1 → shift toward edges (0.15..0.85)
  const dx = Number(opts.dx);
  const dy = Number(opts.dy);
  if (Number.isFinite(dx)) fx = Math.max(0.08, Math.min(0.92, fx + dx * 0.4));
  if (Number.isFinite(dy)) fy = Math.max(0.08, Math.min(0.92, fy + dy * 0.4));

  const x = (col + fx) / VISION_GRID_COLS;
  const y = (row + fy) / VISION_GRID_ROWS;
  const base = visionCellLabel(col, row);
  const label = sub != null ? `${base}.${sub}` : base;
  return { x, y, cell: label, baseCell: base, col, row, sub, fx, fy };
}

/**
 * Normalize view coord to 0–1.
 * Accepts 0–1 floats, or pixel values (e.g. 0–1920 / 0–1080) when > 1.5.
 */
function clamp01View(v, axis = 'x') {
  let n = Number(v);
  if (!Number.isFinite(n)) return null;
  // Pixel coords from models that count image pixels
  if (n > 1.5) {
    const den = axis === 'y' ? VISION_HEIGHT : VISION_WIDTH;
    n = n / den;
  }
  return Math.max(0, Math.min(1, n));
}

const _viewRaycaster = new THREE.Raycaster();
const _viewNdc = new THREE.Vector2();
const _viewHitWorld = new THREE.Vector3();
const _viewCorner = new THREE.Vector3();
const _viewNdcTmp = new THREE.Vector3();

/** Project content+toolbar plane corners to view 0–1 (top-left origin). */
function getBrowserViewBounds() {
  updateVisionCameraFromAvatar();
  const mesh = browserWindow?.contentMesh;
  const toolbar = browserWindow?.toolbarMesh;
  if (!mesh?.geometry) return null;

  mesh.updateMatrixWorld(true);
  toolbar?.updateMatrixWorld?.(true);

  const corners = [];
  const pushMeshCorners = (m) => {
    if (!m?.geometry) return;
    m.geometry.computeBoundingBox?.();
    const bb = m.geometry.boundingBox;
    if (!bb) return;
    const pts = [
      [bb.min.x, bb.min.y, 0],
      [bb.max.x, bb.min.y, 0],
      [bb.min.x, bb.max.y, 0],
      [bb.max.x, bb.max.y, 0],
    ];
    for (const [lx, ly, lz] of pts) {
      _viewCorner.set(lx, ly, lz);
      m.localToWorld(_viewCorner);
      _viewNdcTmp.copy(_viewCorner).project(visionCamera);
      if (_viewNdcTmp.z > 1 || _viewNdcTmp.z < -1) continue;
      const vx = (_viewNdcTmp.x + 1) / 2;
      const vy = (1 - _viewNdcTmp.y) / 2;
      if (Number.isFinite(vx) && Number.isFinite(vy)) corners.push({ x: vx, y: vy });
    }
  };
  pushMeshCorners(mesh);
  pushMeshCorners(toolbar);
  if (corners.length < 2) return null;

  let minX = 1;
  let maxX = 0;
  let minY = 1;
  let maxY = 0;
  for (const c of corners) {
    minX = Math.min(minX, c.x);
    maxX = Math.max(maxX, c.x);
    minY = Math.min(minY, c.y);
    maxY = Math.max(maxY, c.y);
  }
  // Clamp to image, keep a little padding inward so we hit content not empty edge
  const pad = 0.02;
  minX = Math.max(0, minX + pad);
  maxX = Math.min(1, maxX - pad);
  minY = Math.max(0, minY + pad);
  maxY = Math.min(1, maxY - pad);
  if (maxX <= minX || maxY <= minY) return null;

  // Sample points + center for the model (numeric coords primary)
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const samplePoints = [
    { x: +cx.toFixed(3), y: +cy.toFixed(3), note: 'center' },
    { x: +(minX + (maxX - minX) * 0.25).toFixed(3), y: +(minY + (maxY - minY) * 0.25).toFixed(3), note: 'upper-left-quarter' },
    { x: +(minX + (maxX - minX) * 0.75).toFixed(3), y: +(minY + (maxY - minY) * 0.25).toFixed(3), note: 'upper-right-quarter' },
    { x: +(minX + (maxX - minX) * 0.25).toFixed(3), y: +(minY + (maxY - minY) * 0.75).toFixed(3), note: 'lower-left-quarter' },
    { x: +(minX + (maxX - minX) * 0.75).toFixed(3), y: +(minY + (maxY - minY) * 0.75).toFixed(3), note: 'lower-right-quarter' },
  ];

  // Legacy cell list (optional; models may still use cell=)
  const cells = [];
  for (let r = 0; r < VISION_GRID_ROWS; r++) {
    for (let c = 0; c < VISION_GRID_COLS; c++) {
      const px = (c + 0.5) / VISION_GRID_COLS;
      const py = (r + 0.5) / VISION_GRID_ROWS;
      if (px >= minX && px <= maxX && py >= minY && py <= maxY) {
        cells.push(visionCellLabel(c, r));
      }
    }
  }

  return {
    minX: +minX.toFixed(3),
    maxX: +maxX.toFixed(3),
    minY: +minY.toFixed(3),
    maxY: +maxY.toFixed(3),
    center: { x: +cx.toFixed(3), y: +cy.toFixed(3) },
    samplePoints,
    cells,
    /* panel bounds for model */
  };
}

function cellLabelFromView(x, y) {
  const col = Math.min(VISION_GRID_COLS - 1, Math.max(0, Math.floor(x * VISION_GRID_COLS)));
  const row = Math.min(VISION_GRID_ROWS - 1, Math.max(0, Math.floor(y * VISION_GRID_ROWS)));
  return visionCellLabel(col, row);
}

/**
 * Resolve FPV view coords (or cell) → scene hit (browser page / toolbar / floor / other).
 * View space: x,y in 0–1, origin top-left of the vision image.
 * If the ray misses but the browser is on-screen, snap into the panel (snapToBrowser).
 */
function resolveViewRay(args = {}) {
  updateVisionCameraFromAvatar();
  visionCamera.updateMatrixWorld(true);

  // Prefer numeric x,y (primary). Legacy cell= still works if x/y omitted.
  let x = clamp01View(args.x, 'x');
  let y = clamp01View(args.y, 'y');
  let cell = args.cell != null ? String(args.cell) : null;
  let snapped = false;
  let snapFrom = null;
  let sub = args.sub != null ? Number(args.sub) : null;
  let baseCell = null;
  const hasXY = x != null && y != null;

  if (!hasXY && cell) {
    const parsed = parseVisionCell(cell, {
      sub: Number.isFinite(sub) ? sub : undefined,
      dx: args.dx,
      dy: args.dy,
    });
    if (!parsed) {
      return {
        ok: false,
        error: 'bad_coords',
      };
    }
    x = parsed.x;
    y = parsed.y;
    cell = parsed.cell;
    baseCell = parsed.baseCell;
    sub = parsed.sub;
  } else if (hasXY) {
    // Optional fine nudge in normalized image space (±0.05 max from dx/dy -1..1)
    const dx = Number(args.dx);
    const dy = Number(args.dy);
    if (Number.isFinite(dx)) x = Math.max(0, Math.min(1, x + dx * 0.05));
    if (Number.isFinite(dy)) y = Math.max(0, Math.min(1, y + dy * 0.05));
    cell = cellLabelFromView(x, y);
    baseCell = cell;
  }

  if (x == null || y == null) {
    return {
      ok: false,
      error: 'missing_coords',
    };
  }

  const browserBounds = getBrowserViewBounds();

  const castAt = (vx, vy) => {
    _viewNdc.set(vx * 2 - 1, -(vy * 2 - 1));
    _viewRaycaster.setFromCamera(_viewNdc, visionCamera);
    // Thin planes at distance need a bit more precision
    _viewRaycaster.near = 0.01;
    _viewRaycaster.far = 40;
    const targets = [];
    if (browserWindow?.contentMesh) {
      browserWindow.contentMesh.updateMatrixWorld(true);
      targets.push(browserWindow.contentMesh);
    }
    if (browserWindow?.toolbarMesh) {
      browserWindow.toolbarMesh.updateMatrixWorld(true);
      targets.push(browserWindow.toolbarMesh);
    }
    if (browserWindow?.panelRoot) {
      browserWindow.panelRoot.updateMatrixWorld(true);
      targets.push(browserWindow.panelRoot);
    }
    if (floor) {
      floor.updateMatrixWorld(true);
      targets.push(floor);
    }
    return _viewRaycaster.intersectObjects(targets, true);
  };

  let hits = castAt(x, y);

  // Miss or only empty space: snap into browser bounds (common model error: A-column while panel is C–H)
  if ((!hits.length || hits[0].object === floor) && browserBounds && args.allowSnap !== false) {
    const { minX, maxX, minY, maxY } = browserBounds;
    const outside = x < minX || x > maxX || y < minY || y > maxY;
    if (outside || !hits.length) {
      const sx = Math.min(maxX, Math.max(minX, x));
      const sy = Math.min(maxY, Math.max(minY, y));
      const snappedHits = castAt(sx, sy);
      if (snappedHits.length && snappedHits[0].object !== floor) {
        snapFrom = { x, y, cell };
        x = sx;
        y = sy;
        cell = cellLabelFromView(x, y);
        baseCell = cell;
        hits = snappedHits;
        snapped = true;
        if (VISION_DEBUG) {
          console.log(
            `[ViewClick] Snap ${snapFrom.cell || '?'}→${cell} ` +
              `(${snapFrom.x.toFixed(2)},${snapFrom.y.toFixed(2)})→(${x.toFixed(2)},${y.toFixed(2)})`,
          );
        }
      }
    }
  }

  if (!hits.length) {
    if (VISION_DEBUG) {
      console.log(
        `[ViewClick] Miss view=(${x.toFixed(3)},${y.toFixed(3)}) cell=${cell || '-'} ` +
          `browserCells=${browserBounds?.cells?.slice(0, 8)?.join(',') || 'n/a'}`,
      );
    }
    return {
      ok: true,
      hit: 'none',
      view: { x, y, cell },
      browserBounds,
      error: 'miss',
    };
  }

  // Prefer browser content over frame/floor when multiple hits
  let hit = hits[0];
  for (const h of hits) {
    const n = h.object?.name || '';
    if (n === 'FloatingBrowserContent' || h.object === browserWindow?.contentMesh) {
      hit = h;
      break;
    }
    if (n === 'FloatingBrowserToolbar' || h.object === browserWindow?.toolbarMesh) {
      hit = h;
      break;
    }
  }

  const name = hit.object?.name || '';
  let kind = 'other';
  if (name === 'FloatingBrowserContent' || hit.object === browserWindow?.contentMesh) kind = 'browser';
  else if (name === 'FloatingBrowserToolbar' || hit.object === browserWindow?.toolbarMesh) kind = 'toolbar';
  else if (
    name === 'FloatingBrowserChassis' ||
    name === 'FloatingBrowserLip' ||
    name === 'FloatingBrowserBezel' ||
    name === 'FloatingBrowserPhysical'
  ) {
    kind = 'browser_frame';
  } else if (
    hit.object === floor ||
    name === 'RoomFloor' ||
    name.includes('floor') ||
    hit.object?.geometry?.type === 'CircleGeometry'
  ) {
    kind = 'floor';
  }

  _viewHitWorld.copy(hit.point);
  let uv = hit.uv ? { u: hit.uv.x, v: hit.uv.y } : null;
  // If UV missing (some materials), estimate from local plane coords
  if (!uv && (kind === 'browser' || kind === 'toolbar') && hit.object) {
    const local = hit.object.worldToLocal(hit.point.clone());
    const geo = hit.object.geometry;
    geo.computeBoundingBox?.();
    const bb = geo.boundingBox;
    if (bb) {
      const u = (local.x - bb.min.x) / Math.max(1e-6, bb.max.x - bb.min.x);
      const v = (local.y - bb.min.y) / Math.max(1e-6, bb.max.y - bb.min.y);
      uv = { u: Math.max(0, Math.min(1, u)), v: Math.max(0, Math.min(1, v)) };
    }
  }

  let page = null;
  if (kind === 'browser' && uv) {
    page = {
      x: Number(uv.u.toFixed(4)),
      y: Number((1 - uv.v).toFixed(4)), // page content: top-left origin
    };
  }
  // Frame hit near content: treat as page edge click
  if (kind === 'browser_frame' && browserWindow?.contentMesh) {
    const contentHits = castAt(x, y).filter(
      (h) => h.object === browserWindow.contentMesh || h.object?.name === 'FloatingBrowserContent',
    );
    if (contentHits[0]?.uv) {
      kind = 'browser';
      hit = contentHits[0];
      uv = { u: hit.uv.x, v: hit.uv.y };
      page = { x: Number(uv.u.toFixed(4)), y: Number((1 - uv.v).toFixed(4)) };
      _viewHitWorld.copy(hit.point);
    }
  }

  let toolbarUv = null;
  if (kind === 'toolbar' && uv) {
    toolbarUv = { u: Number(uv.u.toFixed(4)), v: Number(uv.v.toFixed(4)) };
  }

  if (VISION_DEBUG) {
    console.log(
      `[ViewClick] hit=${kind} view=(${x.toFixed(3)},${y.toFixed(3)}) cell=${cell || '-'} ` +
        `snapped=${snapped} page=${page ? `${page.x},${page.y}` : '-'}`,
    );
  }

  return {
    ok: true,
    hit: kind,
    view: { x, y, cell, baseCell: baseCell || (cell && String(cell).split('.')[0]), sub },
    snapped,
    snapFrom,
    browserBounds,
    world: {
      x: Number(_viewHitWorld.x.toFixed(3)),
      y: Number(_viewHitWorld.y.toFixed(3)),
      z: Number(_viewHitWorld.z.toFixed(3)),
    },
    page,
    toolbarUv,
    distance: Number(hit.distance.toFixed(3)),
    objectName: name || null,
  };
}

/**
 * AI tool: click what is under a view coordinate / grid cell.
 */
async function handleViewClick(args = {}) {
  const resolved = resolveViewRay(args);
  if (!resolved.ok) return resolved;

  if (resolved.hit === 'none') {
    return {
      ...resolved,
      action: 'none',
      error: resolved.error || 'miss',
    };
  }

  // Browser page content → Playwright click
  if (resolved.hit === 'browser' && resolved.page) {
    const bw = browserWindow;
    if (!bw) return { ok: false, error: 'no_browser', ...resolved };
    const px = Math.max(0, Math.min(1, resolved.page.x));
    const py = Math.max(0, Math.min(1, resolved.page.y));
    try {
      ensureBrowserController();
      if (typeof bw.setCursorNormalized === 'function') {
        bw.setCursorNormalized(px, py, { phase: 'click', immediate: true });
      }
      let result;
      if (typeof bw.sendClickSmart === 'function') {
        result = await bw.sendClickSmart({
          x: px,
          y: py,
          button: args.button || 'left',
          clickCount: Number(args.clickCount) === 2 ? 2 : 1,
          force: true,
        });
      } else if (typeof bw.normalizedToContentPx === 'function') {
        const p = await bw.normalizedToContentPx(px, py);
        result = await bw.sendMouseClick(p.x, p.y, {
          button: args.button || 'left',
          clickCount: Number(args.clickCount) === 2 ? 2 : 1,
        });
      } else {
        result = { ok: false, error: 'no_click_api' };
      }
      if (VISION_DEBUG) console.log('[ViewClick] Browser page click', { x: px, y: py }, 'ok=', result?.ok);
      return {
        ok: result?.ok !== false,
        action: 'browser_click',
        ...resolved,
        page: { x: px, y: py },
        browserResult: {
          ok: result?.ok !== false,
          method: result?.method,
          error: result?.error,
        },
      };
    } catch (e) {
      console.warn('[ViewClick] browser click failed:', e?.message ?? e);
      return { ok: false, error: String(e?.message ?? e), action: 'browser_click', ...resolved };
    }
  }

  // Toolbar chrome (back / forward / reload / address)
  // paintToolbar: buttons at px 8–40, 46–78, 84–116 of contentW=1024
  if (resolved.hit === 'toolbar' && resolved.toolbarUv) {
    const u = resolved.toolbarUv.u;
    try {
      if (u < 40 / 1024) {
        await browserWindow?.goBack?.();
        return { ok: true, action: 'toolbar_back', ...resolved };
      }
      if (u < 78 / 1024) {
        await browserWindow?.goForward?.();
        return { ok: true, action: 'toolbar_forward', ...resolved };
      }
      if (u < 118 / 1024) {
        await browserWindow?.reload?.();
        return { ok: true, action: 'toolbar_reload', ...resolved };
      }
      return {
        ok: true,
        action: 'toolbar_address',
        ...resolved,
        error: 'address_bar',
      };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e), ...resolved };
    }
  }

  if (resolved.hit === 'browser_frame') {
    return {
      ok: true,
      action: 'browser_frame',
      ...resolved,
      error: 'browser_frame',
    };
  }

  if (resolved.hit === 'floor' && resolved.world) {
    // Walk toward floor point (XZ)
    ensureSpatialController();
    const target = { x: resolved.world.x, z: resolved.world.z };
    const sc = spatialController;
    if (sc && typeof sc.walkTowardWorldPoint === 'function') {
      await sc.walkTowardWorldPoint(target);
    } else if (sc) {
      // Inline short walk toward world XZ
      const pos = sc._avatarWorldPos?.() || { x: 0, z: 0 };
      const dx = target.x - pos.x;
      const dz = target.z - pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 0.15) {
        const yaw = Math.atan2(dx, dz);
        sc.yaw = yaw;
        sc._syncRoots?.();
        const travel = Math.min(dist, 2.5);
        const seconds = Math.max(0.6, travel / 0.72);
        await sc._setWalking?.(true);
        sc._beginAction?.({
          kind: 'walk',
          id: `view_go_${Date.now()}`,
          name: 'view_go',
          t: 0,
          duration: seconds,
          direction: 1,
        });
        // Wait roughly for walk
        await new Promise((r) => setTimeout(r, seconds * 1000 + 100));
        await sc._setWalking?.(false);
        sc.action = null;
      }
    }
    return {
      ok: true,
      action: 'walk_floor',
      ...resolved,
      ...spatialController?.getSceneState?.(),
    };
  }

  return {
    ok: true,
    action: 'look_only',
    hit: resolved.hit,
    ...resolved,
  };
}

async function handleViewLook(args = {}) {
  const resolved = resolveViewRay(args);
  if (!resolved.ok) return resolved;
  if (resolved.hit === 'none' || !resolved.world) {
    return { ...resolved, action: 'look_miss', error: 'miss' };
  }
  ensureSpatialController();
  const sc = spatialController;
  if (sc && typeof sc._setLookAt === 'function') {
    const pt = new THREE.Vector3(resolved.world.x, resolved.world.y, resolved.world.z);
    sc._setLookAt(pt, 5);
    // Face toward horizontal direction of hit
    const pos = sc._avatarWorldPos?.() || { x: 0, z: 0 };
    const yaw = Math.atan2(resolved.world.x - pos.x, resolved.world.z - pos.z);
    sc.yaw = yaw;
    sc._syncRoots?.();
  }
  if (VISION_DEBUG) console.log('[ViewClick] view_look', resolved.hit, resolved.view);
  return {
    ok: true,
    action: 'look',
    ...resolved,
    ...spatialController?.getSceneState?.(),
  };
}

async function handleViewGo(args = {}) {
  // Prefer floor hit; if browser, walk toward browser entity instead
  const resolved = resolveViewRay(args);
  if (!resolved.ok) return resolved;
  if (resolved.hit === 'browser' || resolved.hit === 'toolbar' || resolved.hit === 'browser_frame') {
    ensureSpatialController();
    // Reuse inspect approach
    return new Promise((resolve) => {
      const id = `view_go_browser_${Date.now()}`;
      const sc = spatialController;
      const prevFinish = sc._finish?.bind(sc);
      // Call inspect path
      sc.handleCommand({ id, name: 'inspect_browser', args: { seconds: 3 } });
      // Poll until not busy
      const t0 = performance.now();
      const tick = () => {
        if (!sc.busy && !sc.action) {
          resolve({
            ok: true,
            action: 'approach_browser',
            ...resolved,
            ...sc.getSceneState(),
          });
          return;
        }
        if (performance.now() - t0 > 8000) {
          resolve({ ok: true, action: 'approach_browser_timeout', ...resolved, ...sc.getSceneState() });
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }
  return handleViewClick({ ...args, _forceGo: true });
}

/** Wire view_* tools from spatialCommand. */
async function handleViewSpatialCommand(cmd) {
  const name = String(cmd.name || '');
  const args = cmd.args && typeof cmd.args === 'object' ? cmd.args : {};
  const id = String(cmd.id || '');
  let result;
  try {
    if (name === 'view_click') result = await handleViewClick(args);
    else if (name === 'view_look') result = await handleViewLook(args);
    else if (name === 'view_go') result = await handleViewGo(args);
    else result = { ok: false, error: `unknown_view_tool:${name}` };
  } catch (e) {
    result = { ok: false, error: String(e?.message ?? e) };
  }
  if (globalWs && globalWs.readyState === 1) {
    globalWs.send(
      JSON.stringify({
        type: 'spatialResult',
        id,
        name,
        result: {
          ok: result?.ok !== false,
          ...result,
        },
      }),
    );
  }
  if (VISION_DEBUG) console.log(`[ViewClick] Done ${name}`, result?.action || result?.error, result?.hit);
}

/**
 * Stream JPEG of avatar POV to Gemini Live (throttled ~1 FPS).
 * Always re-renders immediately before encode so the AI never gets a stale buffer.
 * Monotonic seq helps the AI server drop out-of-order frames.
 */
async function captureAndSendAvatarVision() {
  if (!AVATAR_FIRST_PERSON_VISION) return;
  if (visionSending) return;
  if (!globalWs || globalWs.readyState !== 1) return;
  if (!currentVrm && !currentAvatarRoot) return;

  const now = performance.now();
  if (now - visionLastSentAt < 1000 / VISION_FPS - 5) return;
  visionLastSentAt = now;
  visionSending = true;

  try {
    // Fresh POV every send (not a previously flipped canvas).
    const frame = renderAvatarPovFrame();
    if (!frame.ok) return;

    const dataUrl = visionFlipCanvas.toDataURL('image/jpeg', VISION_JPEG_QUALITY);
    const base64 = dataUrl.split(',')[1];
    if (!base64) return;

    visionFrameCount++;
    const ts = Date.now();
    globalWs.send(
      JSON.stringify({
        type: 'visionFrame',
        mimeType: 'image/jpeg',
        data: base64,
        width: frame.width,
        height: frame.height,
        ts,
        seq: visionFrameCount,
        source: 'avatar-first-person',
        grid: VISION_GRID_ENABLED
          ? {
              cols: VISION_GRID_COLS,
              rows: VISION_GRID_ROWS,
              origin: 'top-left',
              labels: `${visionCellLabel(0, 0)}-${visionCellLabel(VISION_GRID_COLS - 1, VISION_GRID_ROWS - 1)}`,
            }
          : null,
      }),
    );
    if (VISION_DEBUG && (visionFrameCount === 1 || visionFrameCount % 30 === 0)) {
      console.log(
        `[VisionFP] Sent avatar POV #${visionFrameCount} ${frame.width}x${frame.height} seq=${visionFrameCount}`,
      );
    }
  } catch (e) {
    console.warn('[VisionFP] capture failed:', e?.message ?? e);
  } finally {
    visionSending = false;
  }
}

/**
 * Save the exact AI first-person frame to a download (same camera/FOV/resolution).
 * JPEG matches Live stream quality; also keeps a PNG option via format.
 * @param {{ format?: 'jpeg'|'png' }} [opts]
 */
function saveAvatarPovScreenshot(opts = {}) {
  const format = opts.format === 'png' ? 'png' : 'jpeg';
  console.log(`[VisionFP] Manual POV screenshot requested format=${format}`);

  // Force a fresh diag log on manual capture (render path also dumps when throttle elapsed)
  povDiagLogAt = 0;
  const frame = renderAvatarPovFrame();
  if (!frame.ok) {
    console.warn('[VisionFP] POV screenshot failed:', frame.error);
    showPovScreenshotToast(`POV capture failed: ${frame.error || 'unknown'}`, true);
    return { ok: false, error: frame.error };
  }

  // Always dump full pose for this exact screenshot frame
  logVisionFpPositions('screenshot');

  let dataUrl;
  let ext;
  if (format === 'png') {
    dataUrl = visionFlipCanvas.toDataURL('image/png');
    ext = 'png';
  } else {
    // Same JPEG quality the AI stream uses
    dataUrl = visionFlipCanvas.toDataURL('image/jpeg', VISION_JPEG_QUALITY);
    ext = 'jpg';
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const filename = `avatar-pov_${stamp}_${frame.width}x${frame.height}.${ext}`;

  try {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    console.log(
      `[VisionFP] Saved POV screenshot ${filename} headAttached=${visionHeadAttached} fov=${VISION_FOV}`,
    );
    showPovScreenshotToast(`Saved ${filename}`);
    return { ok: true, filename, width: frame.width, height: frame.height };
  } catch (e) {
    console.warn('[VisionFP] download failed:', e?.message ?? e);
    showPovScreenshotToast(`Download failed: ${e?.message ?? e}`, true);
    return { ok: false, error: String(e?.message ?? e) };
  }
}

function showPovScreenshotToast(message, isError = false) {
  try {
    let el = document.getElementById('pov-shot-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pov-shot-toast';
      el.style.cssText = [
        'position:fixed',
        'bottom:24px',
        'left:50%',
        'transform:translateX(-50%)',
        'z-index:9999',
        'padding:10px 16px',
        'border-radius:10px',
        'font:13px/1.3 system-ui,sans-serif',
        'color:#fff',
        'pointer-events:none',
        'box-shadow:0 8px 24px rgba(0,0,0,0.35)',
        'transition:opacity 0.25s ease',
        'max-width:90vw',
      ].join(';');
      document.body.appendChild(el);
    }
    el.style.background = isError ? 'rgba(180,40,40,0.92)' : 'rgba(20,24,28,0.9)';
    el.textContent = message;
    el.style.opacity = '1';
    clearTimeout(showPovScreenshotToast._t);
    showPovScreenshotToast._t = setTimeout(() => {
      el.style.opacity = '0';
    }, 2800);
  } catch {
    /* ignore */
  }
}

/**
 * Keyboard: Ctrl/Cmd+Shift+V — save AI first-person vision frame.
 * Alt: Ctrl/Cmd+Shift+P — same (POV). Hold Shift+Alt for PNG.
 */
function isTypingTarget(el) {
  if (!el || el === document.body) return false;
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (el.isContentEditable) return true;
  return false;
}

function onPovScreenshotKeydown(e) {
  if (isTypingTarget(e.target)) return;
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || !e.shiftKey) return;
  const key = (e.key || '').toLowerCase();
  // Ctrl/Cmd+Shift+V or Ctrl/Cmd+Shift+P
  if (key !== 'v' && key !== 'p') return;
  e.preventDefault();
  e.stopPropagation();
  const format = e.altKey ? 'png' : 'jpeg';
  console.log(`[VisionFP] Hotkey POV screenshot key=${key} format=${format}`);
  saveAvatarPovScreenshot({ format });
}

window.addEventListener('keydown', onPovScreenshotKeydown, true);
console.log(
  '[VisionFP] POV screenshot: Ctrl/Cmd+Shift+V (or P). Hold Alt for PNG. Same frame as AI vision.',
);

/** Soft body physics burst — Ctrl/Cmd+Shift+R; drop a prop — Ctrl/Cmd+Shift+B */
function onPhysicsDebugKeydown(e) {
  if (isTypingTarget(e.target)) return;
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || !e.shiftKey) return;
  const key = (e.key || '').toLowerCase();
  if (key === 'r') {
    e.preventDefault();
    if (!currentVrm) return;
    activateRagdoll(currentVrm, 2200, {
      x: (Math.random() - 0.5) * 2,
      y: 2.2,
      z: (Math.random() - 0.5) * 2,
    });
    console.log('[VrmBody] Soft ragdoll', getVrmBodyPartCount(), 'parts');
  } else if (key === 'b') {
    e.preventDefault();
    const root = currentAvatarRoot?.position || { x: 0, z: 0 };
    spawnDynamicBox(root.x + 0.3, 1.6, root.z + 0.8, 0.1);
    console.log('[Physics] Spawned dynamic box near avatar');
  }
}
window.addEventListener('keydown', onPhysicsDebugKeydown, true);

function animate() {
  requestAnimationFrame(animate);
  resizeRenderer();

  const delta = clock.getDelta();
  controls.update();
  updateSpeechState();     // detect AI talking -> drive the gesture layer
  gestureController?.update(delta);
  spatialController?.update(delta);
  updateHeadIdle(delta);
  updateNaturalGaze(delta);
  updateBlink(delta);
  updateLipSync(); // Added AI lip sync driven by Web Audio Analyser RMS volume
  updateEmotions(delta); // AI-driven native VRM emotion blending (happy/angry/sad/etc.)
  // Clamp delta so SpringBone (hair/tail gravity) doesn't explode after tab freeze
  const vrmDelta = clampSpringDelta(delta);
  currentVrm?.update(vrmDelta);
  // Body colliders track bones; step world so kinematic targets + dynamics apply
  updateVrmBodyPhysics(currentVrm);
  if (isPhysicsReady()) stepPhysics();

  // Human spectator view (third person / orbit)
  renderer.render(scene, camera);
  // Physical WebGL panel cursor + raycast camera (no CSS3D overlay)
  browserWindow?.render?.(camera, { delta });

  // AI view: first-person from avatar head (throttled inside)
  captureAndSendAvatarVision();
}

async function initializeViewer() {
  currentAnimationSource = { url: defaultAnimationUrl, name: 'Standing-Idle.fbx' };
  await loadVrm(defaultVrmUrl, 'Pati.vrm');
}

// Bootstrapping moved to bottom to avoid TDZ for variables

// Audio context components
let audioCtx;
let analyser;
let audioStartTime = 0;
const lipSyncDataArray = new Uint8Array(128); // frequency bin count

function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.connect(audioCtx.destination);
  }
}

async function playAudioData(base64Pcm) {
  initAudio();
  const binaryString = atob(base64Pcm);
  const len = binaryString.length;
  // 16-bit PCM = 2 bytes per sample
  const floatArray = new Float32Array(len / 2);
  for (let i = 0; i < len / 2; i++) {
    // Little endian 16-bit to Float32
    let int16 = binaryString.charCodeAt(i * 2) + (binaryString.charCodeAt(i * 2 + 1) << 8);
    if (int16 > 32767) int16 -= 65536;
    floatArray[i] = int16 / 32768.0;
  }

  const audioBuffer = audioCtx.createBuffer(1, floatArray.length, 24000);
  audioBuffer.copyToChannel(floatArray, 0);

  const source = audioCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(analyser); // connect to analyser which connects to destination

  // Basic scheduling to avoid overlapping/gaps
  const currentTime = audioCtx.currentTime;
  if (audioStartTime < currentTime) audioStartTime = currentTime;
  source.start(audioStartTime);
  audioStartTime += audioBuffer.duration;
}

// Derive "is the AI currently talking?" from the audio schedule. `audioStartTime`
// is the end time of the last queued PCM chunk, so while currentTime hasn't
// caught up to it, speech is still playing. This is robust across the gaps
// between words (unlike raw amplitude, which dips mid-sentence). The gesture
// controller's own tail timer bridges the tiny gaps between streamed chunks.
function updateSpeechState() {
  if (!gestureController) return;
  const talking = !!audioCtx && audioStartTime > audioCtx.currentTime + 0.02;
  gestureController.setSpeaking(talking);
}

// Barge-in / interruption: stop scheduled audio and settle the body to idle so
// a half-finished gesture doesn't freeze mid-air when the user cuts in.
function stopSpeech() {
  if (audioCtx) audioStartTime = audioCtx.currentTime;
  speechAmplitude = 0;
  gestureController?.settleToIdle(true);
}

function getEnergy(dataArray, binStart, binEnd) {
  let sum = 0;
  for (let i = binStart; i < binEnd; i++) {
    sum += dataArray[i];
  }
  return sum / (binEnd - binStart);
}

function updateLipSync() {
  if (analyser && currentVrm && currentVrm.expressionManager) {
    analyser.getByteFrequencyData(lipSyncDataArray);

    // Overall volume
    let sum = 0;
    for (let i = 0; i < lipSyncDataArray.length; i++) { sum += lipSyncDataArray[i]; }
    const totalVol = sum / lipSyncDataArray.length;

    // Smoothed 0..1 loudness for the gesture system. ~40 is a loud passage on
    // this analyser scale; clamp and low-pass so gesture energy doesn't jitter.
    const instantAmp = Math.max(0, Math.min(1, totalVol / 40));
    speechAmplitude += (instantAmp - speechAmplitude) * 0.15;

    // Reset all facial blendshapes
    currentVrm.expressionManager.setValue('aa', 0);
    currentVrm.expressionManager.setValue('ee', 0);
    currentVrm.expressionManager.setValue('ih', 0);
    currentVrm.expressionManager.setValue('oh', 0);
    currentVrm.expressionManager.setValue('ou', 0);

    if (totalVol > 2) {
      // 24000 sample rate / 256 fftSize = 93.75 Hz per bin
      const ouEnergy = getEnergy(lipSyncDataArray, 2, 5);   // ~200-450 Hz
      const ohEnergy = getEnergy(lipSyncDataArray, 5, 8);   // ~450-750 Hz
      const aaEnergy = getEnergy(lipSyncDataArray, 8, 14);  // ~750-1300 Hz
      const eeEnergy = getEnergy(lipSyncDataArray, 16, 30); // ~1500-2800 Hz

      const m = 0.5;
      let aa = (aaEnergy / 255.0) * m;
      let ee = (eeEnergy / 255.0) * m * 0.8;
      let oh = (ohEnergy / 255.0) * m * 0.9;
      let ou = (ouEnergy / 255.0) * m * 0.6;

      currentVrm.expressionManager.setValue('aa', Math.min(1, aa));
      currentVrm.expressionManager.setValue('ee', Math.min(1, ee));
      currentVrm.expressionManager.setValue('oh', Math.min(1, oh));
      currentVrm.expressionManager.setValue('ou', Math.min(1, ou));
    }
  }
}

let globalWs = null;

// WebSocket API Client
function connectApiServer() {
  globalWs = new WebSocket('ws://localhost:3000');

  globalWs.onopen = () => {
    console.log('Connected to VRoid API Server');
    setStatus('Ready (API Connected)');
  };

  globalWs.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleApiCommand(data);
    } catch (e) {
      console.error('Failed to parse WS message', e);
    }
  };

  globalWs.onclose = () => {
    console.log('WS disconnected, retrying in 2s...');
    setTimeout(connectApiServer, 2000);
  };
}

// Chat UI Event Listeners
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');

function sendChatMessage() {
  const text = chatInput.value.trim();
  if (text) {
    if (globalWs && globalWs.readyState === 1) { // OPEN
      globalWs.send(JSON.stringify({ type: 'chatMessage', text }));
      chatInput.value = '';
      initAudio(); // Initialize audio context on explicit user gesture
    }
  }
}

if (chatSend && chatInput) {
  chatSend.addEventListener('click', sendChatMessage);
  chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendChatMessage();
  });
}

let apiGazeTarget = null;

function handleApiCommand(cmd) {
  switch (cmd.type) {
    case 'audio':
      if (cmd.data) playAudioData(cmd.data);
      break;
    case 'interrupted':
      // User barged in: drop queued audio and settle the body to idle fast.

      stopSpeech();
      break;
    case 'caption':
      if (cmd.text !== undefined) {
        const captionsEl = document.getElementById('captions');
        captionsEl.textContent = cmd.text;
        captionsEl.style.display = cmd.text.trim() === '' ? 'none' : 'block';
      }
      break;
    case 'expression':
      if (currentVrm && currentVrm.expressionManager) {
        currentVrm.expressionManager.setValue(cmd.expression, cmd.value);
      }
      break;
    case 'emotion':
      // AI-driven native VRM emotion (via Gemini function call). Smoothly
      // blended in updateEmotions() so it never snaps or fights lip-sync.

      setEmotion(cmd.emotion, cmd.intensity, cmd.duration);
      break;
    case 'lookAt':
      if (cmd.target && currentVrm && currentVrm.lookAt) {
        // Disable natural gaze shifts temporarily to focus on explicit target
        gazeState.nextShiftAt = gazeState.elapsed + 10;

        if (!apiGazeTarget) {
          apiGazeTarget = new THREE.Object3D();
          scene.add(apiGazeTarget);
        }
        apiGazeTarget.position.set(cmd.target.x, cmd.target.y, cmd.target.z);
        currentVrm.lookAt.target = apiGazeTarget;
      }
      break;
    case 'loadVrm':
      if (cmd.url) loadVrm(cmd.url, 'API Loaded VRM');
      break;
    case 'loadAnimation':
      if (cmd.url) loadAnimation(cmd.url, 'API Loaded Anim');
      break;
    case 'resetPosition':
      resetModelPosition();
      break;
    case 'spatialCommand': {
      const sn = String(cmd.name || '');
      if (sn === 'view_click' || sn === 'view_look' || sn === 'view_go') {
        handleViewSpatialCommand(cmd);
        break;
      }
      ensureSpatialController();
      spatialController?.handleCommand(cmd);
      break;
    }
    case 'browserCommand':
      ensureBrowserController();
      browserController?.handleCommand(cmd);
      break;
    case 'browserCancel':
      ensureBrowserController();
      if (cmd.all) {
        browserController?.cancel?.({ all: true, reason: cmd.reason || 'cancel' });
      } else if (cmd.id) {
        browserController?.cancel?.({ id: String(cmd.id), reason: cmd.reason || 'cancel' });
      }
      console.log('[BrowserCtrl] browserCancel', cmd.id || 'all', cmd.reason);
      break;
  }
}

/** Match physical browser chassis for Rapier static box. */
function syncBrowserPanelPhysics() {
  if (!isPhysicsReady() || !browserWindow) return;
  try {
    const pos =
      browserWindow.panelRoot?.position ||
      browserWindow.contentMesh?.position ||
      new THREE.Vector3(0, 1.0, 1.85);
    // Defaults match createBrowserWindow scale 0.0017 × 1024×720 + toolbar
    const scale = 0.0017;
    const planeW = 1024 * scale;
    const planeH = 720 * scale;
    const barH = 48 * scale;
    const depth = 0.05;
    syncBrowserCollider({
      x: pos.x,
      y: pos.y + barH / 2,
      z: pos.z,
      halfW: planeW / 2 + 0.03,
      halfH: (planeH + barH) / 2 + 0.03,
      halfD: depth / 2 + 0.02,
    });
  } catch (e) {
    console.warn('[Physics] syncBrowserPanelPhysics:', e?.message ?? e);
  }
}

connectApiServer();

// Bootstrap application
window.addEventListener('resize', resizeRenderer);
// Physics even if browser failed to create
initPhysics().then((ok) => {
  if (ok) {
    syncBrowserPanelPhysics();
    setAvatarPosition(0, 0);
  }
});
animate();
initializeViewer();

