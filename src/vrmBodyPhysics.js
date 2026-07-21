/**
 * VRM body physics (Rapier): animation-driven kinematic colliders on major
 * humanoid bones. Mixamo/gestures still drive the skeleton; each frame we
 * copy bone world poses onto kinematic bodies so props / the room can collide
 * with the actual body shape (not only the walk capsule).
 *
 * Optional soft ragdoll mode: limbs become dynamic for a short fall, then
 * snap back to animation.
 */
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  isPhysicsReady,
  getPhysicsWorld,
  PhysicsGroups,
} from './physicsWorld.js';

/** @typedef {{ bone: string, endBone?: string, shape: 'sphere'|'capsule', radius: number, halfHeight?: number }} BodyPartDef */

/** Major body segments — tuned for typical ~1.5–1.7m VRM female proportion. */
const BODY_PARTS = /** @type {BodyPartDef[]} */ ([
  { bone: 'hips', shape: 'sphere', radius: 0.13 },
  { bone: 'spine', endBone: 'chest', shape: 'capsule', radius: 0.12, halfHeight: 0.06 },
  { bone: 'chest', endBone: 'upperChest', shape: 'capsule', radius: 0.14, halfHeight: 0.05 },
  { bone: 'upperChest', endBone: 'neck', shape: 'capsule', radius: 0.13, halfHeight: 0.04 },
  { bone: 'neck', endBone: 'head', shape: 'capsule', radius: 0.05, halfHeight: 0.03 },
  { bone: 'head', shape: 'sphere', radius: 0.11 },
  { bone: 'leftUpperArm', endBone: 'leftLowerArm', shape: 'capsule', radius: 0.05, halfHeight: 0.08 },
  { bone: 'leftLowerArm', endBone: 'leftHand', shape: 'capsule', radius: 0.04, halfHeight: 0.08 },
  { bone: 'rightUpperArm', endBone: 'rightLowerArm', shape: 'capsule', radius: 0.05, halfHeight: 0.08 },
  { bone: 'rightLowerArm', endBone: 'rightHand', shape: 'capsule', radius: 0.04, halfHeight: 0.08 },
  { bone: 'leftUpperLeg', endBone: 'leftLowerLeg', shape: 'capsule', radius: 0.07, halfHeight: 0.12 },
  { bone: 'leftLowerLeg', endBone: 'leftFoot', shape: 'capsule', radius: 0.055, halfHeight: 0.12 },
  { bone: 'rightUpperLeg', endBone: 'rightLowerLeg', shape: 'capsule', radius: 0.07, halfHeight: 0.12 },
  { bone: 'rightLowerLeg', endBone: 'rightFoot', shape: 'capsule', radius: 0.055, halfHeight: 0.12 },
]);

const _pos = new THREE.Vector3();
const _posEnd = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _yAxis = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
/** @type {Array<{
 *   def: BodyPartDef,
 *   bone: THREE.Object3D,
 *   endBone: THREE.Object3D | null,
 *   body: import('@dimforge/rapier3d-compat').RigidBody,
 *   collider: import('@dimforge/rapier3d-compat').Collider,
 *   boneName: string,
 * }>} */
let parts = [];
let attachedVrm = null;
let ragdollActive = false;
let ragdollUntil = 0;

function getBone(vrm, name) {
  const h = vrm?.humanoid;
  if (!h) return null;
  return (
    h.getNormalizedBoneNode?.(name) ||
    h.getRawBoneNode?.(name) ||
    h.getBoneNode?.(name) ||
    null
  );
}

function membership(groups, filter) {
  return (groups << 16) | filter;
}

/**
 * Build / rebuild kinematic colliders for a loaded VRM.
 * Call after humanoid is ready (post-load).
 */
export function attachVrmBodyPhysics(vrm) {
  detachVrmBodyPhysics();
  if (!vrm || !isPhysicsReady()) {
    console.warn('[VrmBody] attach skipped — no VRM or physics not ready');
    return false;
  }

  const world = getPhysicsWorld();
  if (!world) return false;

  attachedVrm = vrm;
  ragdollActive = false;
  let count = 0;

  for (const def of BODY_PARTS) {
    const bone = getBone(vrm, def.bone);
    if (!bone) continue;
    const endBone = def.endBone ? getBone(vrm, def.endBone) : null;

    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setCanSleep(false)
        .lockRotations(false),
    );

    let colliderDesc;
    if (def.shape === 'sphere') {
      colliderDesc = RAPIER.ColliderDesc.ball(def.radius);
    } else {
      const hh = def.halfHeight ?? 0.08;
      colliderDesc = RAPIER.ColliderDesc.capsule(hh, def.radius);
    }

    // Body collides with static world + dynamics, not with locomotion capsule
    colliderDesc
      .setFriction(0.4)
      .setRestitution(0.05)
      .setCollisionGroups(
        membership(
          PhysicsGroups.AVATAR_BODY,
          PhysicsGroups.STATIC | PhysicsGroups.DYNAMIC,
        ),
      )
      .setSolverGroups(
        membership(
          PhysicsGroups.AVATAR_BODY,
          PhysicsGroups.STATIC | PhysicsGroups.DYNAMIC,
        ),
      );

    const collider = world.createCollider(colliderDesc, body);
    parts.push({
      def,
      bone,
      endBone,
      body,
      collider,
      boneName: def.bone,
    });
    count++;
  }

  // Immediate pose sync
  updateVrmBodyPhysics(vrm);
  console.log(`[VrmBody] Attached ${count} kinematic colliders to VRM humanoid`);
  return count > 0;
}

export function detachVrmBodyPhysics() {
  const world = getPhysicsWorld();
  if (world && parts.length) {
    for (const p of parts) {
      try {
        world.removeRigidBody(p.body);
      } catch {
        /* ignore */
      }
    }
  }
  parts = [];
  attachedVrm = null;
  ragdollActive = false;
}

/**
 * After Mixamo/gesture/VRM update — push bone world pose into kinematic bodies.
 * @param {import('@pixiv/three-vrm').VRM | null} vrm
 */
export function updateVrmBodyPhysics(vrm) {
  if (!isPhysicsReady() || !parts.length) return;
  if (ragdollActive) {
    if (performance.now() > ragdollUntil) {
      deactivateRagdoll(vrm);
    }
    // While dynamic, leave bodies to Rapier (no kinematic write)
    return;
  }

  const v = vrm || attachedVrm;
  if (!v) return;
  for (const p of parts) {
    _applyBoneToBody(p);
  }
}

function _applyBoneToBody(p) {
  const { bone, endBone, def, body } = p;
  bone.updateWorldMatrix(true, false);
  bone.getWorldPosition(_pos);

  if (def.shape === 'sphere' || !endBone) {
    body.setNextKinematicTranslation({ x: _pos.x, y: _pos.y, z: _pos.z });
    bone.getWorldQuaternion(_quat);
    body.setNextKinematicRotation({
      x: _quat.x,
      y: _quat.y,
      z: _quat.z,
      w: _quat.w,
    });
    return;
  }

  endBone.updateWorldMatrix(true, false);
  endBone.getWorldPosition(_posEnd);
  _mid.addVectors(_pos, _posEnd).multiplyScalar(0.5);
  _dir.subVectors(_posEnd, _pos);
  const len = _dir.length();
  if (len < 1e-4) {
    body.setNextKinematicTranslation({ x: _pos.x, y: _pos.y, z: _pos.z });
    return;
  }
  _dir.multiplyScalar(1 / len);
  // Capsule default axis is +Y — rotate Y to bone direction
  _quat.setFromUnitVectors(_yAxis, _dir);
  body.setNextKinematicTranslation({ x: _mid.x, y: _mid.y, z: _mid.z });
  body.setNextKinematicRotation({
    x: _quat.x,
    y: _quat.y,
    z: _quat.z,
    w: _quat.w,
  });
}

/**
 * Soft "ragdoll" burst: body colliders go dynamic briefly so they can be
 * hit by props / fall. Skeleton still follows animation unless caller freezes
 * gestures — this is mainly for physical volume + fun impulses.
 */
export function activateRagdoll(_vrm, durationMs = 2000, impulse = null) {
  if (!isPhysicsReady() || !parts.length) return false;

  ragdollActive = true;
  ragdollUntil = performance.now() + durationMs;

  for (const p of parts) {
    try {
      p.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      p.body.wakeUp();
      if (impulse && typeof impulse === 'object') {
        p.body.applyImpulse(
          {
            x: Number(impulse.x) || 0,
            y: Number(impulse.y) || 1.5,
            z: Number(impulse.z) || 0,
          },
          true,
        );
      }
    } catch (e) {
      console.warn('[VrmBody] ragdoll convert failed', p.boneName, e?.message ?? e);
    }
  }
  console.log(`[VrmBody] Soft ragdoll ON for ${durationMs}ms (${parts.length} parts)`);
  return true;
}

export function deactivateRagdoll(vrm) {
  if (!ragdollActive) return;
  ragdollActive = false;
  for (const p of parts) {
    try {
      p.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
      p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      p.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    } catch {
      /* ignore */
    }
  }
  updateVrmBodyPhysics(vrm || attachedVrm);
  console.log('[VrmBody] Soft ragdoll OFF — kinematic body colliders');
}

export function isRagdollActive() {
  return ragdollActive;
}

export function getVrmBodyPartCount() {
  return parts.length;
}

// re-export RAPIER types used above — ensure RigidBodyType exists on import
// (attached at module load from compat package via physics init)
