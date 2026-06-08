import './style.css';

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { loadMixamoAnimation } from './loadMixamoAnimation.js';
import defaultVrmUrl from '../files/trumpchan.vrm?url';
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

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#d8e6ec');
scene.fog = new THREE.Fog('#d8e6ec', 12, 28);

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

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
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
  setStatus(`Loading animation ${label}...`);

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

    setStatus(`Loaded ${currentVrm.scene.name || 'VRM model'} with ${label}. Press R to reset position.`);
  } catch (error) {
    disposeCurrentAnimation();
    setStatus(error instanceof Error ? error.message : 'Failed to load animation.', true);
  }
}

window.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() === 'r') {
    resetModelPosition();
  }
});

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  resizeRenderer();

  const delta = clock.getDelta();
  currentMixer?.update(delta);
  updateBlink(delta);
  currentVrm?.update(delta);

  controls.update();
  renderer.render(scene, camera);
}

async function initializeViewer() {
  currentAnimationSource = { url: defaultAnimationUrl, name: 'Standing-Idle.fbx' };
  await loadVrm(defaultVrmUrl, 'trumpchan.vrm');
}

window.addEventListener('resize', resizeRenderer);
animate();
initializeViewer();
