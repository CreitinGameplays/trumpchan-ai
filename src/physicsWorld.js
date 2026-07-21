/**
 * Rapier physics for the 3D room:
 * - Static floor + walls + browser panel box
 * - Avatar capsule via KinematicCharacterController (walk without clipping)
 *
 * Mixamo/gestures still own bones; physics owns root XZ collisions.
 */
import RAPIER from '@dimforge/rapier3d-compat';

const GRAVITY = { x: 0, y: -9.81, z: 0 };
const CAPSULE_RADIUS = 0.22;
const CAPSULE_HALF_HEIGHT = 0.55;
/** Center of capsule above floor (half-height + radius). */
const CAPSULE_CENTER_Y = CAPSULE_HALF_HEIGHT + CAPSULE_RADIUS;
const FLOOR_HALF = 5.0;
const FLOOR_THICKNESS = 0.15;

let ready = false;
let world = null;
let avatarBody = null;
let avatarCollider = null;
let characterController = null;
let browserBody = null;
let wallBodies = [];
let initPromise = null;

/** Collision group bitmasks (use with (membership << 16) | filter). */
export const PhysicsGroups = {
  AVATAR_LOCO: 0x0001,
  STATIC: 0x0002,
  DYNAMIC: 0x0004,
  AVATAR_BODY: 0x0008,
};

export function getPhysicsWorld() {
  return world;
}

/**
 * @returns {Promise<boolean>}
 */
export async function initPhysics() {
  if (ready && world) return true;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      await RAPIER.init();
      world = new RAPIER.World(GRAVITY);
      world.timestep = 1 / 60;

      const staticGroups =
        (PhysicsGroups.STATIC << 16) |
        (PhysicsGroups.AVATAR_LOCO | PhysicsGroups.AVATAR_BODY | PhysicsGroups.DYNAMIC);

      // Floor
      const floorBody = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(0, -FLOOR_THICKNESS, 0),
      );
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(FLOOR_HALF, FLOOR_THICKNESS, FLOOR_HALF)
          .setFriction(0.9)
          .setRestitution(0)
          .setCollisionGroups(staticGroups)
          .setSolverGroups(staticGroups),
        floorBody,
      );

      // Walls around walkable radius (~4.2)
      const wallR = 4.35;
      const wallH = 2.2;
      const wallT = 0.2;
      const walls = [
        { x: 0, z: wallR, hx: wallR + wallT, hz: wallT },
        { x: 0, z: -wallR, hx: wallR + wallT, hz: wallT },
        { x: wallR, z: 0, hx: wallT, hz: wallR + wallT },
        { x: -wallR, z: 0, hx: wallT, hz: wallR + wallT },
      ];
      wallBodies = [];
      for (const w of walls) {
        const body = world.createRigidBody(
          RAPIER.RigidBodyDesc.fixed().setTranslation(w.x, wallH / 2, w.z),
        );
        world.createCollider(
          RAPIER.ColliderDesc.cuboid(w.hx, wallH / 2, w.hz)
            .setFriction(0.4)
            .setCollisionGroups(staticGroups)
            .setSolverGroups(staticGroups),
          body,
        );
        wallBodies.push(body);
      }

      // Avatar kinematic capsule
      avatarBody = world.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicPositionBased()
          .setTranslation(0, CAPSULE_CENTER_Y, 0)
          .lockRotations()
          .setCanSleep(false),
      );
      // Locomotion capsule: collides with static (+ dynamics), not body segments
      const locoGroups = (PhysicsGroups.AVATAR_LOCO << 16) | (PhysicsGroups.STATIC | PhysicsGroups.DYNAMIC);
      avatarCollider = world.createCollider(
        RAPIER.ColliderDesc.capsule(CAPSULE_HALF_HEIGHT, CAPSULE_RADIUS)
          .setFriction(0.5)
          .setRestitution(0)
          .setCollisionGroups(locoGroups)
          .setSolverGroups(locoGroups),
        avatarBody,
      );

      // Character controller for sliding along walls/panel
      characterController = world.createCharacterController(0.01);
      characterController.setApplyImpulsesToDynamicBodies(false);
      characterController.setSlideEnabled(true);
      characterController.enableAutostep(0.15, 0.1, true);
      characterController.enableSnapToGround(0.2);
      characterController.setMaxSlopeClimbAngle((45 * Math.PI) / 180);
      characterController.setMinSlopeSlideAngle((30 * Math.PI) / 180);

      ready = true;
      console.log(
        `[Physics] Rapier ready — floor, ${wallBodies.length} walls, avatar capsule ` +
          `r=${CAPSULE_RADIUS} centerY=${CAPSULE_CENTER_Y.toFixed(2)}`,
      );
      return true;
    } catch (e) {
      console.error('[Physics] Init failed:', e);
      ready = false;
      world = null;
      characterController = null;
      return false;
    }
  })();

  return initPromise;
}

export function isPhysicsReady() {
  return ready && !!world && !!avatarBody && !!characterController;
}

/**
 * Sync browser panel as a fixed box collider.
 * @param {null | {
 *   x: number, y: number, z: number,
 *   halfW: number, halfH: number, halfD: number
 * }} panel
 */
export function syncBrowserCollider(panel) {
  if (!world || !ready) return;

  if (browserBody) {
    world.removeRigidBody(browserBody);
    browserBody = null;
  }
  if (!panel) return;

  const { x, y, z, halfW, halfH, halfD } = panel;
  const staticGroups =
    (PhysicsGroups.STATIC << 16) |
    (PhysicsGroups.AVATAR_LOCO | PhysicsGroups.AVATAR_BODY | PhysicsGroups.DYNAMIC);
  browserBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z));
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(
      Math.max(0.05, halfW),
      Math.max(0.05, halfH),
      Math.max(0.03, halfD),
    )
      .setFriction(0.5)
      .setCollisionGroups(staticGroups)
      .setSolverGroups(staticGroups),
    browserBody,
  );
}

/** Loco only collides with room statics / props — never own body bones. */
function locoFilterGroups() {
  return (PhysicsGroups.AVATAR_LOCO << 16) | (PhysicsGroups.STATIC | PhysicsGroups.DYNAMIC);
}

/**
 * Move avatar capsule with character controller collision.
 * @param {{ x: number, z: number }} desired desired root XZ
 * @returns {{ x: number, z: number, blocked: boolean }}
 */
export function moveAvatarCapsule(desired) {
  if (!isPhysicsReady()) {
    return { x: desired.x, z: desired.z, blocked: false };
  }

  const t = avatarBody.translation();
  const desiredDelta = {
    x: desired.x - t.x,
    y: CAPSULE_CENTER_Y - t.y, // keep on floor height
    z: desired.z - t.z,
  };

  // Character controller ignores collider groups unless filterGroups is set.
  // Without filters it hits every collider, including kinematic VRM body bones
  // that fully overlap this capsule → freezes walk at spawn (0,0).
  // EXCLUDE_KINEMATIC skips bone bodies; groups keep only static room + props.
  characterController.computeColliderMovement(
    avatarCollider,
    desiredDelta,
    RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC,
    locoFilterGroups(),
    (col) => {
      try {
        const parent = col.parent();
        if (parent && parent.handle === avatarBody.handle) return false;
      } catch {
        /* ignore */
      }
      return true;
    },
  );

  const corr = characterController.computedMovement();
  const next = {
    x: t.x + corr.x,
    y: CAPSULE_CENTER_Y,
    z: t.z + corr.z,
  };

  // Apply immediately so spatial root matches before world.step()
  avatarBody.setTranslation(next, true);
  avatarBody.setNextKinematicTranslation(next);

  const blocked =
    Math.hypot(desired.x - next.x, desired.z - next.z) > 0.02 &&
    Math.hypot(desiredDelta.x, desiredDelta.z) > 0.01;

  if (blocked) {
    console.log(
      `[Physics] walk blocked wanted=(${desired.x.toFixed(3)},${desired.z.toFixed(3)}) ` +
        `got=(${next.x.toFixed(3)},${next.z.toFixed(3)}) ` +
        `corr=(${corr.x.toFixed(3)},${corr.y.toFixed(3)},${corr.z.toFixed(3)})`,
    );
  }

  return { x: next.x, z: next.z, blocked };
}

/** Teleport capsule (reset / load). */
export function setAvatarPosition(x, z) {
  if (!isPhysicsReady()) return;
  const pos = { x, y: CAPSULE_CENTER_Y, z };
  avatarBody.setTranslation(pos, true);
  avatarBody.setNextKinematicTranslation(pos);
  world.step();
}

export function stepPhysics() {
  if (!isPhysicsReady()) return;
  world.step();
}

export function getPhysicsDebugInfo() {
  if (!isPhysicsReady()) return { ready: false };
  const t = avatarBody.translation();
  return {
    ready: true,
    avatar: { x: +t.x.toFixed(3), y: +t.y.toFixed(3), z: +t.z.toFixed(3) },
    hasBrowser: !!browserBody,
    walls: wallBodies.length,
  };
}

/** Dynamic prop for body-collision demos. */
export function spawnDynamicBox(x, y, z, half = 0.12) {
  if (!isPhysicsReady()) return null;
  const dyn =
    (PhysicsGroups.DYNAMIC << 16) |
    (PhysicsGroups.STATIC | PhysicsGroups.AVATAR_LOCO | PhysicsGroups.AVATAR_BODY | PhysicsGroups.DYNAMIC);
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z));
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(half, half, half)
      .setDensity(1.2)
      .setFriction(0.6)
      .setCollisionGroups(dyn)
      .setSolverGroups(dyn),
    body,
  );
  return body;
}

export const PhysicsConstants = {
  CAPSULE_RADIUS,
  CAPSULE_HALF_HEIGHT,
  CAPSULE_CENTER_Y,
};
