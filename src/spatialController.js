import * as THREE from 'three';

/**
 * SpatialController — avatar locomotion + gaze in the 3D room.
 *
 * Hierarchy:
 *   avatarRoot (world XZ + yaw) → motionRoot (always 0; no root-motion) → VRM
 *
 * Translation is ALWAYS world-space on avatarRoot.position.
 * Yaw is ALWAYS avatarRoot.rotation.y (normalized to (-π, π]).
 * Walk uses world forward from current yaw each frame — never local Z under a
 * rotating parent. When Rapier physics is ready, walk XZ is resolved through
 * a kinematic capsule (walls / browser panel) via moveAvatarCapsule.
 *
 * Commands are serialized (queue) so concurrent tool calls from Gemini do not
 * race (e.g. turn + look_at finishing out of order).
 */

import { isPhysicsReady, moveAvatarCapsule, setAvatarPosition } from './physicsWorld.js';

const FLOOR_RADIUS = 4.2;
const WALK_SPEED = 0.72; // m/s world forward (slower = more controllable)
const TURN_SPEED = 2.4; // rad/s
const LOOK_HOLD_DEFAULT = 5;
// Floor (XZ) stop distance for browser — NEVER 3D distance (panel y≈1, root y=0).
// ~1.35m XZ → eye≈1.4m to panel center ≈1.45m → panel fills ~75–80% of 58° FPV
// (0.75m was face-in-the-screen: angular size ~78° > FOV, corners clipped).
const NEAR_BROWSER = 1.35;
const NEAR_HOME = 0.35;
const NEAR_USER = 1.8;

/** Horizontal (floor) distance — locomotion only moves on XZ. */
function horizontalDist(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
const DEFAULT_WALK_SECONDS = 2.5;
const MAX_WALK_SECONDS = 8;
const MIN_WALK_SECONDS = 0.4;

const NAMED = new Set(['user', 'browser', 'home', 'left', 'right', 'forward', 'back']);

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function normalizeYaw(yaw) {
  let y = yaw;
  while (y > Math.PI) y -= Math.PI * 2;
  while (y < -Math.PI) y += Math.PI * 2;
  return y;
}

function shortestAngleDelta(from, to) {
  return normalizeYaw(to - from);
}

export class SpatialController {
  /**
   * @param {object} opts
   * @param {() => THREE.Object3D|null} opts.getAvatarRoot
   * @param {() => THREE.Object3D|null} opts.getMotionRoot
   * @param {() => import('./gestureSystem.js').GestureController|null} opts.getGesture
   * @param {() => any} opts.getVrm
   * @param {() => THREE.Camera} opts.getCamera
   * @param {() => { position: THREE.Vector3 }|null} opts.getBrowser
   * @param {THREE.Scene} opts.scene
   * @param {(msg: object) => void} opts.sendResult
   * @param {string} opts.idleUrl
   * @param {string} opts.walkUrl
   */
  constructor(opts) {
    this.opts = opts;
    /** Body yaw on avatarRoot. 0 = face +Z (toward default camera / user). */
    this.yaw = 0;
    this.lookHoldUntil = 0;
    this.apiGazeTarget = null;

    /** @type {null | object} */
    this.action = null;
    this.walking = false;
    this.elapsed = 0;

    /** @type {Array<{id:string,name:string,args:object}>} */
    this.queue = [];
    this.busy = false;

    this._tmp = new THREE.Vector3();
    this._worldPos = new THREE.Vector3(0, 0, 0);

    console.log('[Spatial] Controller created (world-space walk, no floor root-motion).');
  }

  /**
   * Enqueue a spatialCommand. Runs one at a time.
   * @param {{ id: string, name: string, args?: object }} cmd
   */
  handleCommand(cmd) {
    this.queue.push({
      id: String(cmd.id),
      name: String(cmd.name),
      args: cmd.args && typeof cmd.args === 'object' ? cmd.args : {},
    });
    // quiet: queue
    this._pumpQueue();
  }

  update(delta) {
    this.elapsed += delta;
    this._syncRoots();

    if (!this.action) {
      this._maybeReleaseLook();
      return;
    }

    const a = this.action;
    a.t += delta;

    if (a.kind === 'turn') {
      const step = TURN_SPEED * delta;
      const d = shortestAngleDelta(this.yaw, a.targetYaw);
      if (Math.abs(d) <= step || a.t >= a.duration) {
        this.yaw = normalizeYaw(a.targetYaw);
        this._syncRoots();
        this._completeAction({});
      } else {
        this.yaw = normalizeYaw(this.yaw + Math.sign(d) * step);
        this._syncRoots();
      }
      return;
    }

    if (a.kind === 'walk' || a.kind === 'walk_toward') {
      // Optional: gently face target while approaching (does not translate).
      if (a.kind === 'walk_toward' && a.faceTarget) {
        const faceYaw = this._yawTowardWorldPoint(a.faceTarget);
        const d = shortestAngleDelta(this.yaw, faceYaw);
        this.yaw = normalizeYaw(
          this.yaw + clamp(d, -TURN_SPEED * delta, TURN_SPEED * delta),
        );
      }

      const step = WALK_SPEED * a.direction * delta;
      // World forward from current yaw: +Z at yaw=0 → (sin(yaw), cos(yaw)).
      const desired = {
        x: this._worldPos.x + Math.sin(this.yaw) * step,
        z: this._worldPos.z + Math.cos(this.yaw) * step,
      };
      this._applyWalkDesired(desired);
      this._syncRoots();

      if (a.kind === 'walk_toward' && a.nearRadius != null && a.faceTarget) {
        // Browser/home targets have elevated Y — use XZ so nearRadius is reachable.
        const useXz = a.nearUseXz === true || a.targetName === 'browser' || a.targetName === 'home';
        const pos = this._avatarWorldPos();
        const dist = useXz
          ? horizontalDist(pos, a.faceTarget)
          : pos.distanceTo(a.faceTarget);
        if (dist <= a.nearRadius) {
          console.log(
            `[Spatial] Arrived near ${a.targetName || 'target'} ` +
              `dist=${dist.toFixed(2)} (${useXz ? 'xz' : '3d'}) near=${a.nearRadius}`,
          );
          this._completeAction({ arrived: true });
          return;
        }
      }

      if (a.t >= a.duration) {
        this._completeAction({ arrived: false });
      }
    }
  }

  getSceneState() {
    const pos = this._avatarWorldPos();
    const browser = this._browserWorldPos();
    const user = this._userWorldPos();
    const distBrowser3d = browser ? pos.distanceTo(browser) : null;
    const distBrowserXz = browser ? horizontalDist(pos, browser) : null;
    const distUser = user ? horizontalDist(pos, user) : null;
    const facingUser = user
      ? Math.abs(shortestAngleDelta(this.yaw, this._yawTowardWorldPoint(user))) < 0.5
      : false;
    const facingBrowser = browser
      ? Math.abs(shortestAngleDelta(this.yaw, this._yawTowardWorldPoint(browser))) < 0.55
      : false;
    const nearBrowser = distBrowserXz != null && distBrowserXz <= NEAR_BROWSER;
    const yawDeg = Number(THREE.MathUtils.radToDeg(normalizeYaw(this.yaw)).toFixed(1));

    // Extensible named-entity registry for hybrid vision grounding (future props plug in here).
    const entities = [
      {
        id: 'avatar',
        kind: 'self',
        x: Number(pos.x.toFixed(2)),
        y: 0,
        z: Number(pos.z.toFixed(2)),
        yawDeg,
        eyeY: 1.4,
      },
      {
        id: 'home',
        kind: 'spawn',
        x: 0,
        y: 0,
        z: 0,
        distanceXz: Number(horizontalDist(pos, { x: 0, z: 0 }).toFixed(2)),
      },
    ];
    if (browser) {
      entities.push({
        id: 'browser',
        kind: 'browser_panel',
        x: Number(browser.x.toFixed(2)),
        y: Number((browser.y || 1).toFixed(2)),
        z: Number(browser.z.toFixed(2)),
        distanceXz: distBrowserXz != null ? Number(distBrowserXz.toFixed(2)) : null,
        distance3d: distBrowser3d != null ? Number(distBrowser3d.toFixed(2)) : null,
        facing: facingBrowser,
        near: nearBrowser,
        interactable: true,
      });
    }
    if (user) {
      entities.push({
        id: 'user',
        kind: 'spectator',
        x: Number(user.x.toFixed(2)),
        y: 0,
        z: Number(user.z.toFixed(2)),
        distanceXz: distUser != null ? Number(distUser.toFixed(2)) : null,
        facing: facingUser,
      });
    }

    let primaryView = 'room';
    if (facingBrowser && nearBrowser) primaryView = 'browser_close';
    else if (facingBrowser) primaryView = 'browser_far';
    else if (facingUser) primaryView = 'user';

    // Factual scene graph only — no coaching / tool-policy text (stripped again on AI server).
    const grounding = {
      schema: 'trumpchan.scene.v1',
      ts: Date.now(),
      avatar: {
        x: Number(pos.x.toFixed(2)),
        z: Number(pos.z.toFixed(2)),
        yawDeg,
        walking: this.walking,
        eyeY: 1.4,
      },
      primaryView,
      entities,
      visionCoords: {
        system: 'xy_0_1',
        origin: 'top-left',
      },
    };

    return {
      ok: true,
      x: Number(pos.x.toFixed(2)),
      z: Number(pos.z.toFixed(2)),
      yawDeg,
      walking: this.walking,
      distanceToBrowser: distBrowserXz != null ? Number(distBrowserXz.toFixed(2)) : null,
      distanceToBrowser3d: distBrowser3d != null ? Number(distBrowser3d.toFixed(2)) : null,
      distanceToUser: distUser != null ? Number(distUser.toFixed(2)) : null,
      nearBrowser,
      nearBrowserRadius: NEAR_BROWSER,
      facingUser,
      facingBrowser,
      primaryView,
      floorRadius: FLOOR_RADIUS,
      entities,
      grounding,
      physics: isPhysicsReady(),
    };
  }

  dispose() {
    this.action = null;
    this.queue = [];
    this.busy = false;
    this._setWalking(false);
    if (this.apiGazeTarget) {
      this.opts.scene?.remove(this.apiGazeTarget);
      this.apiGazeTarget = null;
    }
    console.log('[Spatial] Disposed.');
  }

  // --- Queue ---------------------------------------------------------------

  _pumpQueue() {
    if (this.busy || this.queue.length === 0) return;
    if (this.action) return;
    const next = this.queue.shift();
    this.busy = true;
    this._runCommand(next).catch((e) => {
      console.error('[Spatial] Command error:', e);
      this._finish(next.id, next.name, { ok: false, error: String(e?.message ?? e) });
    });
  }

  async _runCommand(cmd) {
    const { id, name, args } = cmd;


    // Top-level view_* (fallback path when not wrapped in run_plan)
    if (name === 'view_click' || name === 'view_look' || name === 'view_go') {
      await this._executeImmediate(id, name, args);
      return;
    }

    switch (name) {
      case 'run_plan':
        await this._cmdRunPlan(id, args);
        break;
      case 'look_at':
        await this._cmdLookAt(id, args);
        break;
      case 'turn':
        await this._cmdTurn(id, args);
        break;
      case 'walk':
        await this._cmdWalk(id, args);
        break;
      case 'walk_toward':
        await this._cmdWalkToward(id, args);
        break;
      case 'stop_moving':
        await this._cmdStop(id);
        break;
      case 'inspect_browser':
        await this._cmdInspectBrowser(id, args);
        break;
      case 'reset_pose':
        await this._cmdResetPose(id);
        break;
      default:
        this._finish(id, name, { ok: false, error: `unknown_command:${name}` });
    }
  }

  async _cmdRunPlan(id, args) {
    const steps = Array.isArray(args.steps) ? args.steps : [];
    const originalName = String(args.originalName || 'run_plan');
    const planner = String(args.planner || 'unknown');
    const reasoning = args.reasoning ? String(args.reasoning) : '';

    console.log(
      `[Spatial] run_plan planner=${planner} steps=${steps.map((s) => s?.name).join('→') || '(empty)'} ` +
        `reason=${reasoning}`,
    );

    if (steps.length === 0) {
      this._finish(id, originalName, {
        ok: false,
        error: 'empty_plan',
        planner,
        ...this.getSceneState(),
      });
      return;
    }

    const stepResults = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepName = String(step?.name || '');
      const stepArgs = step?.args && typeof step.args === 'object' ? step.args : {};
      if (!stepName) continue;

      const stepId = `${id}__step${i}`;
      const result = await this._runStepAndWait(stepId, stepName, stepArgs);
      stepResults.push({ name: stepName, result });

    }

    const last = stepResults[stepResults.length - 1]?.result || {};
    const hadViewClick = stepResults.some((s) => s.name === 'view_click');
    const lastView = [...stepResults].reverse().find((s) => String(s.name).startsWith('view_'));
    this._finish(id, originalName, {
      ok: true,
      planner,
      reasoning,
      stepsRun: stepResults.map((s) => s.name),
      stepResults: stepResults.map((s) => ({
        name: s.name,
        ok: s.result?.ok !== false,
        hit: s.result?.hit,
        cell: s.result?.view?.cell || s.result?.cell,
        page: s.result?.page,
        action: s.result?.action,
        error: s.result?.error,
      })),
      ...(lastView?.result && typeof lastView.result === 'object' ? lastView.result : {}),
      ...this.getSceneState(),
    });
  }

  _runStepAndWait(stepId, name, args) {
    return new Promise((resolve) => {
      const prevSend = this.opts.sendResult;
      let settled = false;
      let timer = null;

      const settleOnce = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.opts.sendResult = prevSend;
        resolve(result || { ok: true });
      };

      this.opts.sendResult = (msg) => {
        if (msg?.type === 'spatialResult' && String(msg.id) === stepId) {
          settleOnce(msg.result);
          return;
        }
        prevSend?.(msg);
      };

      // view_click may wait on Playwright; allow longer than pure locomotion
      const timeoutMs =
        name === 'view_click' || name === 'view_go' || name === 'view_look' ? 25000 : 15000;
      timer = setTimeout(() => {
        settleOnce({ ok: false, error: 'step_timeout', name });
      }, timeoutMs);

      this._executeImmediate(stepId, name, args).catch((e) => {
        settleOnce({ ok: false, error: String(e?.message ?? e) });
      });
    });
  }

  async _executeImmediate(id, name, args) {
    // FPV view tools — run via optional executor (wired from main.js)
    if (name === 'view_click' || name === 'view_look' || name === 'view_go') {
      if (typeof this.opts.executeViewTool === 'function') {
        try {
          const result = await this.opts.executeViewTool(name, args || {});
          this._finish(id, name, {
            ok: result?.ok !== false,
            ...(result && typeof result === 'object' ? result : {}),

          });
        } catch (e) {
          this._finish(id, name, { ok: false, error: String(e?.message ?? e) });
        }
        return;
      }
      this._finish(id, name, {
        ok: false,
        error: 'view_executor_missing',
      });
      return;
    }

    switch (name) {
      case 'look_at':
        await this._cmdLookAt(id, args);
        break;
      case 'turn':
        await this._cmdTurn(id, args);
        break;
      case 'walk':
        await this._cmdWalk(id, args);
        break;
      case 'walk_toward':
        await this._cmdWalkToward(id, args);
        break;
      case 'stop_moving':
        await this._cmdStop(id);
        break;
      case 'inspect_browser':
        await this._cmdInspectBrowser(id, args);
        break;
      case 'reset_pose':
        await this._cmdResetPose(id);
        break;
      default:
        this._finish(id, name, { ok: false, error: `unknown_step:${name}` });
    }
  }

  // --- Commands ------------------------------------------------------------

  async _cmdLookAt(id, args) {
    const target = String(args.target || 'user');
    const duration = clamp(Number(args.duration) || LOOK_HOLD_DEFAULT, 1, 20);
    const point = this._resolveTargetPoint(target);
    if (!point) {
      this._finish(id, 'look_at', { ok: false, error: 'bad_target', target });
      return;
    }
    this._setLookAt(point, duration);
    await this._delay(150);
    this._finish(id, 'look_at', { target, ...this.getSceneState() });
  }

  async _cmdTurn(id, args) {
    const mode = String(args.mode || 'face_target');
    let targetYaw = this.yaw;

    if (mode === 'face_target' || args.target) {
      const target = String(args.target || 'user');
      const point = this._resolveTargetPoint(target);
      if (!point) {
        this._finish(id, 'turn', { ok: false, error: 'bad_target', target });
        return;
      }
      targetYaw = this._yawTowardWorldPoint(point);
      this._setLookAt(point, LOOK_HOLD_DEFAULT);
    } else {
      let deg = Number(args.degrees);
      if (!Number.isFinite(deg)) deg = 0;
      deg = clamp(deg, -180, 180);
      targetYaw = normalizeYaw(this.yaw + THREE.MathUtils.degToRad(deg));
    }

    targetYaw = normalizeYaw(targetYaw);
    const delta = Math.abs(shortestAngleDelta(this.yaw, targetYaw));
    if (delta < 0.05) {
      this.yaw = targetYaw;
      this._syncRoots();
      this._finish(id, 'turn', this.getSceneState());
      return;
    }

    const duration = Math.max(0.25, delta / TURN_SPEED + 0.08);
    console.log(
      `[Spatial] turn yaw ${THREE.MathUtils.radToDeg(this.yaw).toFixed(1)}° → ` +
        `${THREE.MathUtils.radToDeg(targetYaw).toFixed(1)}° (pos stays x=${this._worldPos.x.toFixed(2)} z=${this._worldPos.z.toFixed(2)})`,
    );
    this._beginAction({
      kind: 'turn',
      id,
      name: 'turn',
      t: 0,
      duration,
      targetYaw,
    });
  }

  async _cmdWalk(id, args) {
    const direction = String(args.direction || 'forward') === 'back' ? -1 : 1;
    let seconds = Number(args.seconds);
    if (!Number.isFinite(seconds)) seconds = DEFAULT_WALK_SECONDS;
    seconds = clamp(seconds, MIN_WALK_SECONDS, MAX_WALK_SECONDS);

    console.log(
      `[Spatial] walk dir=${direction > 0 ? 'fwd' : 'back'} ${seconds}s speed=${WALK_SPEED} ` +
        `from (${this._worldPos.x.toFixed(2)}, ${this._worldPos.z.toFixed(2)}) yaw=${THREE.MathUtils.radToDeg(this.yaw).toFixed(1)}°`,
    );

    await this._setWalking(true);
    this._beginAction({
      kind: 'walk',
      id,
      name: 'walk',
      t: 0,
      duration: seconds,
      direction,
    });
  }

  async _cmdWalkToward(id, args) {
    const target = String(args.target || 'browser');
    const point = this._resolveTargetPoint(target);
    if (!point) {
      this._finish(id, 'walk_toward', { ok: false, error: 'bad_target', target });
      return;
    }

    const near =
      target === 'browser' ? NEAR_BROWSER :
      target === 'home' ? NEAR_HOME :
      NEAR_USER;
    // Elevated targets (browser y≈1, home y≈1.45): measure stop distance on the floor plane.
    const nearUseXz = target === 'browser' || target === 'home';

    // Face target (rotation only — no translation).
    this.yaw = this._yawTowardWorldPoint(point);
    this._syncRoots();
    this._setLookAt(point, LOOK_HOLD_DEFAULT + 3);

    const pos = this._avatarWorldPos();
    const dist3d = pos.distanceTo(point);
    const dist = nearUseXz ? horizontalDist(pos, point) : dist3d;
    console.log(
      `[Spatial] walk_toward ${target} dist=${dist.toFixed(2)} (${nearUseXz ? 'xz' : '3d'}) ` +
        `dist3d=${dist3d.toFixed(2)} near=${near} ` +
        `yaw=${THREE.MathUtils.radToDeg(this.yaw).toFixed(1)}° ` +
        `root=(${pos.x.toFixed(2)},${pos.z.toFixed(2)}) target=(${point.x.toFixed(2)},${point.y.toFixed(2)},${point.z.toFixed(2)})`,
    );

    if (dist <= near) {
      await this._setWalking(false);
      this._finish(id, 'walk_toward', {
        arrived: true,
        alreadyClose: true,
        nearMetric: nearUseXz ? 'xz' : '3d',
        ...this.getSceneState(),
      });
      return;
    }

    // Duration from remaining floor distance; model seconds only extends, never shortens.
    const travel = Math.max(0, dist - near * 0.85);
    let seconds = travel / WALK_SPEED + 0.25;
    const argSec = Number(args.seconds);
    if (Number.isFinite(argSec)) seconds = Math.max(seconds, argSec);
    seconds = clamp(seconds, MIN_WALK_SECONDS, MAX_WALK_SECONDS);

    console.log(
      `[Spatial] walk_toward duration=${seconds.toFixed(2)}s travel≈${travel.toFixed(2)}m ` +
        `(${nearUseXz ? 'xz' : '3d'})`,
    );

    await this._setWalking(true);
    this._beginAction({
      kind: 'walk_toward',
      id,
      name: 'walk_toward',
      t: 0,
      duration: seconds,
      direction: 1,
      faceTarget: point.clone(),
      nearRadius: near,
      nearUseXz,
      targetName: target,
    });
  }

  async _cmdStop(id) {
    this.action = null;
    await this._setWalking(false);
    this._finish(id, 'stop_moving', this.getSceneState());
  }

  async _cmdInspectBrowser(id, args) {
    const point = this._resolveTargetPoint('browser');
    if (!point) {
      this._finish(id, 'inspect_browser', { ok: false, error: 'no_browser' });
      return;
    }

    this.yaw = this._yawTowardWorldPoint(point);
    this._syncRoots();
    this._setLookAt(point, LOOK_HOLD_DEFAULT + 4);

    const pos = this._avatarWorldPos();
    // XZ only — 3D dist includes ~1m height and could never fall below NEAR_BROWSER.
    const distXz = horizontalDist(pos, point);
    const dist3d = pos.distanceTo(point);
    console.log(
      `[Spatial] inspect_browser distXz=${distXz.toFixed(2)} dist3d=${dist3d.toFixed(2)} ` +
        `near=${NEAR_BROWSER} (xz) root=(${pos.x.toFixed(2)},${pos.z.toFixed(2)}) ` +
        `browser=(${point.x.toFixed(2)},${point.y.toFixed(2)},${point.z.toFixed(2)})`,
    );

    if (distXz <= NEAR_BROWSER) {
      await this._setWalking(false);
      await this._delay(200);
      this._finish(id, 'inspect_browser', {
        arrived: true,
        alreadyClose: true,
        nearMetric: 'xz',
        distanceXz: Number(distXz.toFixed(2)),
        ...this.getSceneState(),
      });
      return;
    }

    const travel = Math.max(0, distXz - NEAR_BROWSER * 0.85);
    let seconds = travel / WALK_SPEED + 0.25;
    const argSec = Number(args.seconds);
    if (Number.isFinite(argSec)) seconds = Math.max(seconds, argSec);
    seconds = clamp(seconds, 1.5, MAX_WALK_SECONDS);

    console.log(
      `[Spatial] inspect_browser walking travel≈${travel.toFixed(2)}m xz duration=${seconds.toFixed(2)}s`,
    );

    await this._setWalking(true);
    this._beginAction({
      kind: 'walk_toward',
      id,
      name: 'inspect_browser',
      t: 0,
      duration: seconds,
      direction: 1,
      faceTarget: point.clone(),
      nearRadius: NEAR_BROWSER,
      nearUseXz: true,
      targetName: 'browser',
      inspect: true,
    });
  }

  async _cmdResetPose(id) {
    this.action = null;
    await this._setWalking(false);
    this._worldPos.set(0, 0, 0);
    this.yaw = 0;
    if (isPhysicsReady()) setAvatarPosition(0, 0);
    this._syncRoots();
    const userPt = this._resolveTargetPoint('user');
    if (userPt) this._setLookAt(userPt, LOOK_HOLD_DEFAULT);
    this._finish(id, 'reset_pose', this.getSceneState());
  }

  /**
   * Apply desired walk XZ: Rapier capsule when ready, else soft floor clamp.
   * @param {{ x: number, z: number }} desired
   */
  _applyWalkDesired(desired) {
    if (isPhysicsReady()) {
      const resolved = moveAvatarCapsule(desired);
      this._worldPos.x = resolved.x;
      this._worldPos.z = resolved.z;
      this._worldPos.y = 0;
      if (resolved.blocked) {
        // Soft log only occasionally
        if (!this._lastBlockedLog || this.elapsed - this._lastBlockedLog > 1.5) {
          this._lastBlockedLog = this.elapsed;
          console.log(
            `[Spatial] Physics blocked walk near (${resolved.x.toFixed(2)}, ${resolved.z.toFixed(2)})`,
          );
        }
      }
      return;
    }
    this._worldPos.x = desired.x;
    this._worldPos.z = desired.z;
    this._clampToFloor(this._worldPos);
  }

  // --- Action lifecycle ----------------------------------------------------

  _beginAction(action) {
    this.action = action;

  }

  async _completeAction(extra = {}) {
    const a = this.action;
    if (!a) {
      this.busy = false;
      this._pumpQueue();
      return;
    }
    this.action = null;
    await this._setWalking(false);

    const result = {
      ...this.getSceneState(),
      ...extra,
    };
    this._finish(a.id, a.name, result);
  }

  _finish(id, name, result) {
    const payload = { ok: result.ok !== false, ...result };

    this.opts.sendResult?.({
      type: 'spatialResult',
      id,
      name,
      result: payload,
    });
    if (String(id).includes('__step')) {
      return;
    }
    this.busy = false;
    this._pumpQueue();
  }

  async _setWalking(on) {
    if (this.walking === on) return;
    this.walking = on;
    const gesture = this.opts.getGesture?.();
    if (!gesture) return;
    try {
      // Never allow Mixamo floor root-motion — controller owns translation.
      if (on) {
        await gesture.setBaseAnimation(this.opts.walkUrl, {
          allowVerticalMotion: true,
          allowFloorMotion: false,
        });
      } else {
        await gesture.setBaseAnimation(this.opts.idleUrl, {
          allowVerticalMotion: true,
          allowFloorMotion: false,
        });
      }
      // Zero any residual motionRoot translation from older clips.
      const motion = this.opts.getMotionRoot?.();
      if (motion) motion.position.set(0, 0, 0);
    } catch (e) {
      console.error('[Spatial] Walk/idle swap failed:', e);
    }
  }

  _setLookAt(worldPoint, holdSeconds) {
    const vrm = this.opts.getVrm?.();
    const scene = this.opts.scene;
    if (!vrm?.lookAt || !scene) return;

    if (!this.apiGazeTarget) {
      this.apiGazeTarget = new THREE.Object3D();
      this.apiGazeTarget.name = 'SpatialGazeTarget';
      scene.add(this.apiGazeTarget);
    }
    this.apiGazeTarget.position.copy(worldPoint);
    vrm.lookAt.target = this.apiGazeTarget;
    vrm.lookAt.autoUpdate = true;
    this.lookHoldUntil = this.elapsed + holdSeconds;
  }

  _maybeReleaseLook() {
    if (this.lookHoldUntil <= 0 || this.elapsed < this.lookHoldUntil) return;
    this.lookHoldUntil = 0;
    const vrm = this.opts.getVrm?.();
    if (vrm?.lookAt) vrm.lookAt.target = null;
  }

  /**
   * Push controller state onto the Three hierarchy.
   * motionRoot must stay at origin so walk clips cannot drag the body.
   */
  _syncRoots() {
    this.yaw = normalizeYaw(this.yaw);
    const root = this.opts.getAvatarRoot?.();
    if (root) {
      root.rotation.order = 'YXZ';
      root.rotation.y = this.yaw;
      root.position.x = this._worldPos.x;
      root.position.y = 0;
      root.position.z = this._worldPos.z;
    }
    const motion = this.opts.getMotionRoot?.();
    if (motion) {
      // If a clip still writes motionRoot.position, kill it every frame.
      if (motion.position.x !== 0 || motion.position.z !== 0 || motion.position.y !== 0) {
        console.log(
          `[Spatial] Clearing motionRoot drift ` +
            `(${motion.position.x.toFixed(3)}, ${motion.position.y.toFixed(3)}, ${motion.position.z.toFixed(3)})`,
        );
        motion.position.set(0, 0, 0);
      }
    }
  }

  _avatarWorldPos() {
    return new THREE.Vector3(this._worldPos.x, 0, this._worldPos.z);
  }

  _browserWorldPos() {
    const b = this.opts.getBrowser?.();
    if (!b) return null;
    if (b.getWorldPosition) {
      const p = new THREE.Vector3();
      b.getWorldPosition(p);
      return p;
    }
    if (b.position) return b.position.clone();
    return null;
  }

  _userWorldPos() {
    const cam = this.opts.getCamera?.();
    if (!cam) return new THREE.Vector3(0, 0, 3.2);
    return new THREE.Vector3(cam.position.x, 0, cam.position.z);
  }

  _clampToFloor(pos) {
    const r = Math.hypot(pos.x, pos.z);
    if (r > FLOOR_RADIUS) {
      const s = FLOOR_RADIUS / r;
      pos.x *= s;
      pos.z *= s;
      console.log(`[Spatial] Floor clamp → (${pos.x.toFixed(2)}, ${pos.z.toFixed(2)})`);
    }
  }

  _yawTowardWorldPoint(point) {
    const pos = this._avatarWorldPos();
    const dx = point.x - pos.x;
    const dz = point.z - pos.z;
    if (Math.abs(dx) < 1e-5 && Math.abs(dz) < 1e-5) return this.yaw;
    return normalizeYaw(Math.atan2(dx, dz));
  }

  _resolveTargetPoint(name) {
    if (!NAMED.has(name)) return null;
    const pos = this._avatarWorldPos();
    const eyeY = 1.45;

    if (name === 'user') {
      const u = this._userWorldPos();
      return new THREE.Vector3(u.x, eyeY, u.z);
    }
    if (name === 'browser') {
      const b = this._browserWorldPos();
      if (!b) return null;
      return new THREE.Vector3(b.x, b.y || eyeY, b.z);
    }
    if (name === 'home') {
      return new THREE.Vector3(0, eyeY, 0);
    }
    const dist = 2.5;
    let yaw = this.yaw;
    if (name === 'left') yaw = normalizeYaw(yaw + Math.PI / 2);
    else if (name === 'right') yaw = normalizeYaw(yaw - Math.PI / 2);
    else if (name === 'back') yaw = normalizeYaw(yaw + Math.PI);
    return new THREE.Vector3(
      pos.x + Math.sin(yaw) * dist,
      eyeY,
      pos.z + Math.cos(yaw) * dist,
    );
  }

  _delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
