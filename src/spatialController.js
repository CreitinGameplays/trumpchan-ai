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
 * rotating parent (that + floor-clamp on local coords caused wrong directions
 * and edge teleports when combined with Mixamo floor root-motion).
 *
 * Commands are serialized (queue) so concurrent tool calls from Gemini do not
 * race (e.g. turn + look_at finishing out of order).
 */

const FLOOR_RADIUS = 4.2;
const WALK_SPEED = 0.72; // m/s world forward (slower = more controllable)
const TURN_SPEED = 2.4; // rad/s
const LOOK_HOLD_DEFAULT = 5;
const NEAR_BROWSER = 1.35;
const NEAR_HOME = 0.35;
const NEAR_USER = 1.8;
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
    console.log(`[Spatial] Queued ${cmd.name} (queue=${this.queue.length})`, cmd.id);
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
      this._worldPos.x += Math.sin(this.yaw) * step;
      this._worldPos.z += Math.cos(this.yaw) * step;
      this._clampToFloor(this._worldPos);
      this._syncRoots();

      if (a.kind === 'walk_toward' && a.nearRadius != null && a.faceTarget) {
        const dist = this._avatarWorldPos().distanceTo(a.faceTarget);
        if (dist <= a.nearRadius) {
          console.log(
            `[Spatial] Arrived near ${a.targetName || 'target'} dist=${dist.toFixed(2)}`,
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
    const distBrowser = browser ? pos.distanceTo(browser) : null;
    const distUser = user ? pos.distanceTo(user) : null;
    const facingUser = user
      ? Math.abs(shortestAngleDelta(this.yaw, this._yawTowardWorldPoint(user))) < 0.5
      : false;
    const facingBrowser = browser
      ? Math.abs(shortestAngleDelta(this.yaw, this._yawTowardWorldPoint(browser))) < 0.55
      : false;

    return {
      ok: true,
      x: Number(pos.x.toFixed(2)),
      z: Number(pos.z.toFixed(2)),
      yawDeg: Number(THREE.MathUtils.radToDeg(normalizeYaw(this.yaw)).toFixed(1)),
      walking: this.walking,
      distanceToBrowser: distBrowser != null ? Number(distBrowser.toFixed(2)) : null,
      distanceToUser: distUser != null ? Number(distUser.toFixed(2)) : null,
      facingUser,
      facingBrowser,
      floorRadius: FLOOR_RADIUS,
      hint: facingBrowser
        ? 'You are facing the floating browser — describe what you see on the page.'
        : facingUser
          ? 'You are facing the user.'
          : 'You may need to look_at or turn toward browser/user.',
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
    console.log(`[Spatial] Run ${name}`, id, args);

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
      console.log(`[Spatial] Plan step ${i + 1}/${steps.length} ${stepName} done`, result?.ok !== false);
    }

    const last = stepResults[stepResults.length - 1]?.result || {};
    this._finish(id, originalName, {
      ok: true,
      planner,
      reasoning,
      stepsRun: stepResults.map((s) => s.name),
      ...this.getSceneState(),
      instruction:
        originalName === 'inspect_browser' ||
        steps.some((s) => s?.name === 'inspect_browser' || s?.name === 'look_at')
          ? 'Describe what you actually see on the floating browser / in the room now using your vision.'
          : last.instruction,
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

      timer = setTimeout(() => {
        settleOnce({ ok: false, error: 'step_timeout', name });
      }, 15000);

      this._executeImmediate(stepId, name, args).catch((e) => {
        settleOnce({ ok: false, error: String(e?.message ?? e) });
      });
    });
  }

  async _executeImmediate(id, name, args) {
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

    // Face target (rotation only — no translation).
    this.yaw = this._yawTowardWorldPoint(point);
    this._syncRoots();
    this._setLookAt(point, LOOK_HOLD_DEFAULT + 3);

    const pos = this._avatarWorldPos();
    const dist = pos.distanceTo(point);
    console.log(
      `[Spatial] walk_toward ${target} dist=${dist.toFixed(2)} near=${near} ` +
        `yaw=${THREE.MathUtils.radToDeg(this.yaw).toFixed(1)}°`,
    );

    if (dist <= near) {
      await this._setWalking(false);
      this._finish(id, 'walk_toward', { arrived: true, alreadyClose: true, ...this.getSceneState() });
      return;
    }

    // Duration from remaining distance; model seconds only extends, never shortens.
    const travel = Math.max(0, dist - near * 0.85);
    let seconds = travel / WALK_SPEED + 0.25;
    const argSec = Number(args.seconds);
    if (Number.isFinite(argSec)) seconds = Math.max(seconds, argSec);
    seconds = clamp(seconds, MIN_WALK_SECONDS, MAX_WALK_SECONDS);

    console.log(`[Spatial] walk_toward duration=${seconds.toFixed(2)}s travel≈${travel.toFixed(2)}m`);

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
    const dist = pos.distanceTo(point);
    console.log(`[Spatial] inspect_browser dist=${dist.toFixed(2)} near=${NEAR_BROWSER}`);

    if (dist <= NEAR_BROWSER) {
      await this._setWalking(false);
      await this._delay(200);
      this._finish(id, 'inspect_browser', {
        arrived: true,
        alreadyClose: true,
        ...this.getSceneState(),
        instruction: 'Look at the floating browser page in your vision and describe what you see.',
      });
      return;
    }

    const travel = Math.max(0, dist - NEAR_BROWSER * 0.85);
    let seconds = travel / WALK_SPEED + 0.25;
    const argSec = Number(args.seconds);
    if (Number.isFinite(argSec)) seconds = Math.max(seconds, argSec);
    seconds = clamp(seconds, 1.5, MAX_WALK_SECONDS);

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
      targetName: 'browser',
      inspect: true,
    });
  }

  async _cmdResetPose(id) {
    this.action = null;
    await this._setWalking(false);
    this._worldPos.set(0, 0, 0);
    this.yaw = 0;
    this._syncRoots();
    const userPt = this._resolveTargetPoint('user');
    if (userPt) this._setLookAt(userPt, LOOK_HOLD_DEFAULT);
    this._finish(id, 'reset_pose', this.getSceneState());
  }

  // --- Action lifecycle ----------------------------------------------------

  _beginAction(action) {
    this.action = action;
    console.log(`[Spatial] Action start ${action.kind} id=${action.id}`);
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
    if (a.inspect || a.name === 'inspect_browser') {
      result.instruction =
        'You moved to inspect the browser. Describe what you actually see on the floating browser page now.';
    }
    this._finish(a.id, a.name, result);
  }

  _finish(id, name, result) {
    const payload = { ok: result.ok !== false, ...result };
    console.log(`[Spatial] Done ${name}`, payload);
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
