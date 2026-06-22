import './style.css';

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { loadMixamoAnimation } from './loadMixamoAnimation.js';
import defaultVrmUrl from '../files/Pati.vrm?url';
import defaultAnimationUrl from '../files/Standing-Idle.fbx?url';

const canvas = document.querySelector('#scene');
const status = document.querySelector('#status');

const DEFAULT_ALLOW_VERTICAL_MOTION = true;
const DEFAULT_ALLOW_FLOOR_MOTION = true;
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

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 1.2, 0);
controls.enableDamping = true;
controls.minDistance = 1.5;
controls.maxDistance = 8;
controls.update();

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
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.01;
scene.add(floor);

const grid = new THREE.GridHelper(10, 20, '#718690', '#9bb0ba');
grid.position.y = 0;
scene.add(grid);

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

let currentVrm = null;
let currentVrmUrl = null;
let currentMixer = null;
let currentAction = null;
let currentAvatarRoot = null;
let currentMotionRoot = null;
let currentAnimationSource = null;
let blinkState = createBlinkState();
let gazeState = createNaturalGazeState();
let headIdleRig = null;
let headIdleState = createHeadIdleState();
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
  }
}

function disposeCurrentModel() {
  if (currentAction) {
    currentAction.stop();
    currentAction = null;
  }

  if (currentMixer) {
    currentMixer.stopAllAction();
    currentMixer = null;
  }

  if (!currentVrm) {
    return;
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
  if (currentAction) {
    currentAction.stop();
    currentAction = null;
  }

  if (currentMixer) {
    currentMixer.stopAllAction();
    currentMixer = null;
  }

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
  if (!currentMotionRoot) {
    return;
  }

  currentMotionRoot.position.set(0, 0, 0);

  if (currentAction) {
    currentAction.reset();
    currentAction.play();
  }

  if (currentVrm) {
    frameModel(currentAvatarRoot ?? currentVrm.scene);
  }
}

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
    headIdleRig = setupHeadIdleRig(vrm);
    resetNaturalGazeState();
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
  // setStatus(`Loading animation ${label}...`);

  try {
    const clip = await loadMixamoAnimation(url, currentVrm, {
      allowVerticalMotion: DEFAULT_ALLOW_VERTICAL_MOTION,
      allowFloorMotion: DEFAULT_ALLOW_FLOOR_MOTION,
      rootMotionNodeName: currentMotionRoot?.name ?? null
    });

    currentMixer = new THREE.AnimationMixer(currentAvatarRoot ?? currentVrm.scene);
    currentAction = currentMixer.clipAction(clip);
    currentAction.reset();
    currentAction.play();


  } catch (error) {
    disposeCurrentAnimation();
    setStatus(error instanceof Error ? error.message : 'Failed to load animation.', true);
  }
}

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  resizeRenderer();

  const delta = clock.getDelta();
  controls.update();
  currentMixer?.update(delta);
  updateHeadIdle(delta);
  updateNaturalGaze(delta);
  updateBlink(delta);
  updateLipSync(); // Added AI lip sync driven by Web Audio Analyser RMS volume
  currentVrm?.update(delta);

  renderer.render(scene, camera);
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
  }
}

connectApiServer();

// Bootstrap application
window.addEventListener('resize', resizeRenderer);
animate();
initializeViewer();

