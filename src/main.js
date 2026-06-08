import './style.css';

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { loadMixamoAnimation } from './loadMixamoAnimation.js';

const canvas = document.querySelector('#scene');
const fileInput = document.querySelector('#vrmInput');
const animationInput = document.querySelector('#animationInput');
const allowVerticalMotionInput = document.querySelector('#allowVerticalMotion');
const allowFloorMotionInput = document.querySelector('#allowFloorMotion');
const openViewerButton = document.querySelector('#openViewerButton');
const expandViewerButton = document.querySelector('#expandViewerButton');
const closeViewerButton = document.querySelector('#closeViewerButton');
const resetPositionButton = document.querySelector('#resetPositionButton');
const status = document.querySelector('#status');
const viewerModal = document.querySelector('#viewerModal');

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
let currentAnimationUrl = null;
let currentAnimationFile = null;
let currentMixer = null;
let currentAction = null;
let currentAvatarRoot = null;
let currentMotionRoot = null;
let debugFrameCounter = 0;

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

function setViewerOpen(isOpen) {
  viewerModal.setAttribute('aria-hidden', String(!isOpen));
  document.body.classList.toggle('viewer-open', isOpen);

  if (!isOpen) {
    viewerModal.classList.remove('viewer-modal--expanded');
    expandViewerButton?.setAttribute('aria-label', 'Expand VRM viewer');
    expandViewerButton?.setAttribute('title', 'Expand viewer');
  }

  if (isOpen) {
    resizeRenderer();
    controls.update();
  }
}

function toggleViewerExpanded() {
  const isExpanded = viewerModal.classList.toggle('viewer-modal--expanded');

  expandViewerButton.setAttribute('aria-label', isExpanded ? 'Shrink VRM viewer' : 'Expand VRM viewer');
  expandViewerButton.setAttribute('title', isExpanded ? 'Shrink viewer' : 'Expand viewer');

  resizeRenderer();
  controls.update();
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

  if (!currentVrm) return;

  if (currentAvatarRoot) {
    scene.remove(currentAvatarRoot);
    currentAvatarRoot = null;
  }

  currentMotionRoot = null;
  VRMUtils.deepDispose(currentVrm.scene);
  currentVrm = null;

  if (currentVrmUrl) {
    URL.revokeObjectURL(currentVrmUrl);
    currentVrmUrl = null;
  }
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

  if (currentAnimationUrl) {
    URL.revokeObjectURL(currentAnimationUrl);
    currentAnimationUrl = null;
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

async function loadVrm(file) {
  disposeCurrentModel();
  currentVrmUrl = URL.createObjectURL(file);
  setStatus(`Loading ${file.name}...`);

  try {
    const gltf = await loader.loadAsync(currentVrmUrl);
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

    if (currentAnimationFile) {
      await loadAnimation(currentAnimationFile, false);
    } else {
      setStatus(`Loaded ${file.name}`);
    }
  } catch (error) {
    disposeCurrentModel();
    setStatus(error instanceof Error ? error.message : 'Failed to load model.', true);
  }
}

async function loadAnimation(file, updateInput = true) {
  if (!currentVrm) {
    currentAnimationFile = file;
    setStatus('Animation queued. Load a VRM model to apply it.', false);
    return;
  }

  disposeCurrentAnimation();
  currentAnimationFile = file;
  currentAnimationUrl = URL.createObjectURL(file);
  setStatus(`Loading animation ${file.name}...`);

  try {
    const clip = await loadMixamoAnimation(currentAnimationUrl, currentVrm, {
      allowVerticalMotion: allowVerticalMotionInput.checked,
      allowFloorMotion: allowFloorMotionInput.checked,
      rootMotionNodeName: currentMotionRoot?.name ?? null
    });

    currentMixer = new THREE.AnimationMixer(currentAvatarRoot ?? currentVrm.scene);
    currentAction = currentMixer.clipAction(clip);
    currentAction.reset();
    currentAction.play();

    if (updateInput) {
      animationInput.value = '';
    }

    setStatus(`Loaded ${currentVrm.scene.name || 'VRM model'} with animation ${file.name}`);
  } catch (error) {
    disposeCurrentAnimation();
    setStatus(error instanceof Error ? error.message : 'Failed to load animation.', true);
  }
}

fileInput.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  if (!file.name.toLowerCase().endsWith('.vrm')) {
    setStatus('Please choose a .vrm file.', true);
    return;
  }

  await loadVrm(file);
});

animationInput.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  if (!file.name.toLowerCase().endsWith('.fbx')) {
    setStatus('Please choose a Mixamo .fbx animation file.', true);
    return;
  }

  await loadAnimation(file);
});

allowVerticalMotionInput.addEventListener('change', async () => {
  if (!currentAnimationFile || !currentVrm) {
    return;
  }

  await loadAnimation(currentAnimationFile, false);
});

allowFloorMotionInput.addEventListener('change', async () => {
  if (!currentMotionRoot) {
    return;
  }

  currentMotionRoot.position.set(0, 0, 0);

  if (!currentAnimationFile || !currentVrm) {
    return;
  }

  await loadAnimation(currentAnimationFile, false);
});

resetPositionButton.addEventListener('click', () => {
  resetModelPosition();
});

openViewerButton.addEventListener('click', () => {
  setViewerOpen(true);
});

expandViewerButton.addEventListener('click', () => {
  toggleViewerExpanded();
});

closeViewerButton.addEventListener('click', () => {
  setViewerOpen(false);
});

viewerModal.addEventListener('click', (event) => {
  const target = event.target;

  if (target instanceof HTMLElement && target.dataset.closeViewer === 'true') {
    setViewerOpen(false);
  }
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && viewerModal.getAttribute('aria-hidden') === 'false') {
    setViewerOpen(false);
  }
});

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  resizeRenderer();

  const delta = clock.getDelta();
  currentMixer?.update(delta);
  currentVrm?.update(delta);

  if (currentVrm && currentAction) {
    debugFrameCounter += 1;

    if (debugFrameCounter % 120 === 0) {
      const box = new THREE.Box3().setFromObject(currentAvatarRoot ?? currentVrm.scene);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());

      console.info('VRM scene debug:', {
        center: center.toArray(),
        size: size.toArray(),
        cameraPosition: camera.position.toArray(),
        controlTarget: controls.target.toArray(),
        rootPosition: currentMotionRoot?.position.toArray()
      });
    }
  }

  controls.update();
  renderer.render(scene, camera);
}

window.addEventListener('resize', resizeRenderer);
animate();
