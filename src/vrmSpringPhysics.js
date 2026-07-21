/**
 * Configure VRM SpringBone (hair / tail / ears / bust / soft secondary).
 * - Tail: gentle hang + body colliders to reduce clipping into the torso
 * - Ears: stay mostly stiff (not “wet noodle” realistic flop)
 * - Bust/breasts: very stiff, near-zero gravity (subtle only)
 * - Other soft: light gravity only
 */
import * as THREE from 'three';

const G_DOWN = new THREE.Vector3(0, -1, 0);

const TAIL_NAME_RE =
  /tail|j_tail|hips_tail|spine_tail|尻尾|しっぽ|しっぼ|けつ|fox.?tail|特大尻尾/i;
const EAR_NAME_RE =
  /ear|mimi|j_bip_c_head_ear|ear_0|ear\.|耳|みみ|animal.?ear|cat.?ear|fox.?ear/i;
/** Common VRM secondary-bone names for chest / bust physics */
const BUST_NAME_RE =
  /bust|breast|boob|mune|胸|おっぱい|oppai|pec|cleavage|j_sec_.*bust|sec_.*bust|breast_|_breast|tit/i;

/**
 * @param {import('@pixiv/three-vrm').VRM} vrm
 * @param {object} [opts]
 */
export function configureVrmSpringGravity(vrm, opts = {}) {
  const mgr = vrm?.springBoneManager;
  if (!mgr) {
    console.warn('[SpringPhys] No springBoneManager on VRM');
    return { ok: false, joints: 0 };
  }

  const joints = mgr.joints ? Array.from(mgr.joints) : [];
  if (joints.length === 0) {
    console.warn('[SpringPhys] 0 spring joints');
    return { ok: false, joints: 0 };
  }

  const tailG = Number.isFinite(opts.tailGravity) ? opts.tailGravity : 1.35;
  const softG = Number.isFinite(opts.hairGravity) ? opts.hairGravity : 0.55;
  const earG = Number.isFinite(opts.earGravity) ? opts.earGravity : 0.12;
  const bustG = Number.isFinite(opts.bustGravity) ? opts.bustGravity : 0.05;

  let tailJoints = 0;
  let earJoints = 0;
  let bustJoints = 0;
  let softJoints = 0;

  for (const joint of joints) {
    const s = joint.settings;
    if (!s) continue;

    const boneName = String(joint.bone?.name || '');
    const childName = String(joint.child?.name || '');
    const names = `${boneName} ${childName}`;
    const isTail = TAIL_NAME_RE.test(names);
    const isBust = !isTail && BUST_NAME_RE.test(names);
    const isEar = !isTail && !isBust && EAR_NAME_RE.test(names);

    // Always world-down
    if (s.gravityDir?.isVector3) s.gravityDir.copy(G_DOWN);
    else s.gravityDir = G_DOWN.clone();

    const prevG = Number(s.gravityPower) || 0;
    const prevStiff = Number(s.stiffness) || 1;
    const prevDrag = Number(s.dragForce) || 0.4;
    const prevHit = Number(s.hitRadius) || 0.02;

    if (isTail) {
      // Hang with weight, but not so soft it collapses into the hip/thigh
      s.gravityPower = Math.min(2.0, Math.max(prevG, tailG));
      s.stiffness = Math.max(0.35, prevStiff * 0.95);
      s.dragForce = Math.min(0.85, Math.max(0.35, prevDrag * 1.08));
      s.hitRadius = Math.max(prevHit, 0.035);
      tailJoints++;
    } else if (isBust) {
      // Near-static: high stiffness, almost no gravity, heavy damping
      s.gravityPower = Math.min(bustG, Math.max(0, prevG * 0.15));
      s.stiffness = Math.max(prevStiff * 2.2, 2.0);
      s.dragForce = Math.min(0.95, Math.max(0.7, prevDrag * 1.4));
      s.hitRadius = Math.max(0.01, prevHit);
      bustJoints++;
    } else if (isEar) {
      // Stiff “set piece” ears — subtle sway only
      s.gravityPower = Math.min(earG, Math.max(0.05, prevG * 0.35));
      s.stiffness = Math.max(prevStiff, 1.35);
      s.dragForce = Math.min(0.9, Math.max(0.45, prevDrag));
      s.hitRadius = Math.max(0.01, prevHit * 0.9);
      earJoints++;
    } else {
      // Hair / other soft — light hang, not dramatic
      s.gravityPower = Math.min(1.0, Math.max(prevG * 0.85, softG));
      if (prevG < 0.08) s.gravityPower = softG;
      s.stiffness = Math.max(0.25, prevStiff * 0.98);
      s.dragForce = Math.min(0.8, Math.max(0.25, prevDrag));
      softJoints++;
    }
  }

  // Grow torso/hips/head SpringBone colliders so the tail is pushed outside the mesh
  let collidersGrown = 0;
  try {
    const colliders = mgr.colliders ? Array.from(mgr.colliders) : [];
    for (const col of colliders) {
      const shape = col?.shape;
      if (!shape) continue;
      if (typeof shape.radius === 'number' && shape.radius > 0) {
        if (shape._origRadius == null) shape._origRadius = shape.radius;
        shape.radius = shape._origRadius * 1.12;
        collidersGrown++;
      }
    }
  } catch (e) {
    console.warn('[SpringPhys] collider grow failed:', e?.message ?? e);
  }

  try {
    mgr.setInitState?.();
    mgr.reset?.();
  } catch (e) {
    console.warn('[SpringPhys] reset after config:', e?.message ?? e);
  }

  console.log(
    `[SpringPhys] tuned joints=${joints.length} tail=${tailJoints} ear=${earJoints} ` +
      `bust=${bustJoints} soft=${softJoints} colliders+12%=${collidersGrown}`,
  );

  return {
    ok: true,
    joints: joints.length,
    tailJoints,
    earJoints,
    bustJoints,
    softJoints,
    collidersGrown,
  };
}

/** Safe delta for SpringBone (seconds). */
export function clampSpringDelta(delta) {
  if (!Number.isFinite(delta) || delta <= 0) return 1 / 60;
  return Math.min(delta, 1 / 30);
}
