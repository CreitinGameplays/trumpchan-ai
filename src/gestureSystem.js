import * as THREE from 'three';
import { loadMixamoAnimation } from './loadMixamoAnimation.js';

// ---------------------------------------------------------------------------
// Co-speech gesture layer — KEYPOSE BLEND approach.
//
// Prior version only added tiny spring offsets, so it never formed a readable
// gesture (no arm raises, no hand shapes). This version follows the structure
// used by real co-speech systems (e.g. SentiAvatar's "plan-then-infill" and
// the `posers` procedural-VRM engine): a small LIBRARY OF TARGET KEYPOSES —
// actual poses like "forearm raised, palm open" or "point up" — that the avatar
// BLENDS TOWARD on speech beats, holds briefly, then releases back to idle.
//
// Layers, applied additively on top of the idle/walk base clip each frame:
//   1. POSE layer  — the big, readable gesture. One at a time (can be two-hand),
//                    eased in (attack, with slight overshoot), held, released.
//                    Rest gaps between gestures keep simple speech sparse.
//   2. ACCENT layer — small spring "beats" fired on loudness onsets, layered on
//                    top of the held pose so it stays lively mid-gesture.
//   3. SWAY layer  — tiny continuous idle-of-the-arms so a held pose breathes.
//
// Poses are authored ONCE for the right side in intuitive DOFs (armRaise,
// elbowBend, ...). Each DOF maps to a bone + local axis + per-side sign in the
// DOF_AXIS table, so left mirrors automatically and any wrong-axis guess is a
// one-line fix. Bones come from getNormalizedBoneNode, whose space is
// T-pose = identity, so these values are model-independent.
// ---------------------------------------------------------------------------

const CROSSFADE_SECONDS = 0.35;
const SPEECH_TAIL_SECONDS = 0.28;

// Gesture envelope timing (seconds). Attack reaches the pose, hold sustains it,
// release relaxes back to idle. Ranges are randomized per gesture.
const ATTACK_RANGE = [0.16, 0.26];
const HOLD_RANGE = [0.45, 1.3];
const RELEASE_RANGE = [0.32, 0.5];

// Rest gap between gestures, per energy tier. Low energy => long gaps => the
// avatar mostly rests during calm/simple speech (fixes "always gesturing").
const GAP_BY_TIER = {
  low: [1.4, 3.0],
  medium: [0.5, 1.4],
  high: [0.15, 0.6],
};

// Chance a gesture uses both hands, per tier.
const TWO_HAND_BY_TIER = { low: 0.1, medium: 0.3, high: 0.55 };

// Onset detection for accent beats (rising edge in loudness = emphasis).
const ONSET_DELTA_THRESHOLD = 0.05;
const ONSET_ABS_FLOOR = 0.09;
const ACCENT_MIN_INTERVAL = 0.22;

// Accent spring dynamics (small, quick).
const SPRING_STIFFNESS = 140;
const SPRING_DAMPING = 16;
const ACCENT_KICK = 3.2;

// Continuous sway.
const SWAY_AMOUNT = 0.06;

// Master weight easing (whole layer fades with speech).
const WEIGHT_RAMP_UP = 4.0;
const WEIGHT_RAMP_DOWN = 3.2;

const TIER_ORDER = ['low', 'medium', 'high'];

// --- DOF -> bone/axis/sign map --------------------------------------------
// The ONE place axis conventions live. If a joint bends the wrong way on your
// rig, flip its sign here. Guesses follow VRM-1.0 T-pose + the `posers` engine:
// right upperArm +Z lowers the arm to the side, so we lift/abduct with -Z, etc.
const DOF_AXIS = {
  armRaise: { bone: 'arm', axis: 'x', sign: { right: 1, left: 1 } }, // lift arm forward/up
  armOut: { bone: 'arm', axis: 'z', sign: { right: 1, left: -1 } },    // abduct away from torso
  armTwist: { bone: 'arm', axis: 'y', sign: { right: 1, left: -1 } },  // internal/external rotation
  elbowBend: { bone: 'elbow', axis: 'y', sign: { right: 1, left: -1 } }, // flex forearm forward/up (biggest read)
  elbowTwist: { bone: 'elbow', axis: 'z', sign: { right: -1, left: 1 } },
  wristPitch: { bone: 'wrist', axis: 'z', sign: { right: 1, left: -1 } },
  wristYaw: { bone: 'wrist', axis: 'x', sign: { right: 1, left: 1 } },
  shrug: { bone: 'shoulder', axis: 'z', sign: { right: -1, left: 1 } }, // raise shoulder
};

// --- Keypose library ------------------------------------------------------
// Authored for the RIGHT side (mirrored to left automatically). Values are
// radians. `fingers` selects a hand shape. `tier` is the energy level the pose
// suits; `twoHand` marks poses that read well mirrored on both arms.
const POSES = {
  // Calm, low-energy talking hand — forearm lifted, relaxed hand.
  relaxedTalk: {
    tier: 'low',
    dof: { armRaise: 0.18, armOut: 0.12, elbowBend: 1.05, wristPitch: 0.12 },
    fingers: 'relaxed',
  },
  // Open palm presented outward — "here's the thing".
  openPalmOut: {
    tier: 'medium',
    twoHand: true,
    dof: { armRaise: 0.3, armOut: 0.4, elbowBend: 0.95, wristPitch: -0.25, wristYaw: 0.15 },
    fingers: 'open',
  },
  // Hand to chest — sincerity / "I".
  toChest: {
    tier: 'low',
    dof: { armRaise: 0.34, armOut: -0.12, armTwist: 0.45, elbowBend: 1.4, wristPitch: 0.2 },
    fingers: 'relaxed',
  },
  // Raised forearm, hand up — general emphasis.
  raiseHand: {
    tier: 'medium',
    dof: { armRaise: 0.42, armOut: 0.18, elbowBend: 1.25, wristPitch: -0.1 },
    fingers: 'open',
  },
  // Index up — "point" / making a point.
  pointUp: {
    tier: 'high',
    dof: { armRaise: 0.6, armOut: 0.1, elbowBend: 1.35, wristPitch: -0.45 },
    fingers: 'point',
  },
  // Chop down — assertive beat.
  chopDown: {
    tier: 'high',
    dof: { armRaise: 0.5, armOut: 0.22, elbowBend: 0.72, wristPitch: 0.35 },
    fingers: 'open',
  },
  // Both palms up / shrug — "what can you do".
  shrug: {
    tier: 'medium',
    twoHand: true,
    dof: { shrug: 0.55, armOut: 0.3, armTwist: 0.5, elbowBend: 0.9, wristPitch: -0.35 },
    fingers: 'open',
  },
  // Big two-hand spread — high-energy exclamation.
  bigSpread: {
    tier: 'high',
    twoHand: true,
    dof: { armRaise: 0.45, armOut: 0.6, elbowBend: 0.8, wristPitch: -0.3, wristYaw: 0.2 },
    fingers: 'open',
  },
};

// Finger curl amounts per named hand shape. Applied to index/middle/ring/little
// proximal+intermediate+distal joints (thumb left alone to avoid odd twists).
const FINGER_SHAPES = {
  open: { Index: 0.05, Middle: 0.05, Ring: 0.08, Little: 0.1 },
  relaxed: { Index: 0.25, Middle: 0.28, Ring: 0.32, Little: 0.36 },
  point: { Index: 0.02, Middle: 1.15, Ring: 1.25, Little: 1.3 },
};

const FINGER_NAMES = ['Index', 'Middle', 'Ring', 'Little'];
const FINGER_SEGMENTS = ['Proximal', 'Intermediate', 'Distal'];
// Distribute a curl scalar across the three segments (proximal bends most).
const FINGER_SEGMENT_WEIGHT = { Proximal: 0.5, Intermediate: 0.32, Distal: 0.5 };
// Finger curl axis/sign (normalized VRM space); flip if fingers splay outward.
const FINGER_CURL_AXIS = 'z';
const FINGER_CURL_SIGN = { right: -1, left: 1 };

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

// Slight overshoot on the attack so a gesture "reaches" and settles naturally.
function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

// Small spring-damped scalar for accent beats (relaxes to 0).
class Spring {
  constructor() {
    this.x = 0;
    this.v = 0;
  }
  kick(a) {
    this.v += a;
  }
  update(delta) {
    const dt = Math.min(delta, 1 / 30);
    this.v += (-SPRING_STIFFNESS * this.x - SPRING_DAMPING * this.v) * dt;
    this.x += this.v * dt;
    return this.x;
  }
}

export class GestureController {
  constructor({ vrm, root, motionRootName = null, getMood = null }) {
    this.vrm = vrm;
    this.root = root;
    this.motionRootName = motionRootName;
    this.getMood = getMood ?? (() => ({ tierBias: 'medium', amplitude: 0 }));

    this.mixer = new THREE.AnimationMixer(root);
    this.baseEntry = null;
    this.baseFades = [];

    // Speech envelope.
    this.speaking = false;
    this.speechTail = 0;
    this.weight = 0;
    this.elapsed = 0;
    this.prevAmp = 0;

    // Active gesture (pose blend) state.
    this.gesture = null;         // { sides, poseKey, phase, t, attack, hold, release, weight }
    this.nextGestureAt = 0;
    this.lastPoseKey = null;
    this.lastDominant = 'right';

    // Accent + sway.
    this.accent = { left: new Spring(), right: new Spring() };
    this.lastAccentAt = -Infinity;
    this.swayPhase = randomBetween(0, Math.PI * 2);

    // Rig.
    this.rig = null;

    // Scratch.
    this._euler = new THREE.Euler(0, 0, 0, 'XYZ');
    this._offsetQ = new THREE.Quaternion();
    this._baseQ = new THREE.Quaternion();

    this.disposed = false;
    console.log('[Gesture] Keypose controller created.');
  }

  _buildRig() {
    const h = this.vrm?.humanoid;
    if (!h) {
      console.warn('[Gesture] VRM has no humanoid; gesture layer disabled.');
      return null;
    }
    const get = (n) => h.getNormalizedBoneNode(n) ?? null;
    const armFor = (side) => ({
      arm: get(`${side}UpperArm`),
      elbow: get(`${side}LowerArm`),
      wrist: get(`${side}Hand`),
      shoulder: get(`${side}Shoulder`),
    });
    // Finger bones: rig.fingers[side][FingerName][Segment] -> bone|null.
    const fingersFor = (side) => {
      const out = {};
      for (const f of FINGER_NAMES) {
        out[f] = {};
        for (const seg of FINGER_SEGMENTS) {
          out[f][seg] = get(`${side}${f}${seg}`);
        }
      }
      return out;
    };
    const rig = {
      left: armFor('left'),
      right: armFor('right'),
      fingers: { left: fingersFor('left'), right: fingersFor('right') },
      spine: get('spine') ?? get('chest'),
    };
    const present = [];
    for (const side of ['left', 'right']) {
      for (const k of ['arm', 'elbow', 'wrist', 'shoulder']) {
        if (rig[side][k]) present.push(`${side}.${k}`);
      }
    }
    let fingerCount = 0;
    for (const side of ['left', 'right']) {
      for (const f of FINGER_NAMES) {
        for (const seg of FINGER_SEGMENTS) if (rig.fingers[side][f][seg]) fingerCount++;
      }
    }
    console.log(`[Gesture] Rig: arms [${present.join(', ')}], ${fingerCount} finger bones, spine=${!!rig.spine}.`);
    return rig;
  }

  async load(baseClipUrl) {
    console.log('[Gesture] Loading base idle clip + building keypose rig...');
    const baseClip = await loadMixamoAnimation(baseClipUrl, this.vrm, {
      allowVerticalMotion: true,
      allowFloorMotion: false,
      rootMotionNodeName: this.motionRootName,
    });
    this.baseEntry = this._makeEntry(baseClip);
    this.baseEntry.action.play();
    this.baseEntry.action.setEffectiveWeight(1);
    this.rig = this._buildRig();
    console.log('[Gesture] Ready (keypose co-speech gestures).');
  }

  _makeEntry(clip) {
    const action = this.mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.enabled = true;
    return { action, clip };
  }

  setSpeaking(isSpeaking) {
    if (isSpeaking) {
      this.speechTail = SPEECH_TAIL_SECONDS;
      if (!this.speaking) {
        this.speaking = true;
        this.nextGestureAt = this.elapsed + randomBetween(0.05, 0.18);
        console.log('[Gesture] Speech started -> gesture layer engaging.');
      }
    } else if (this.speaking) {
      this.speechTail = Math.min(this.speechTail, SPEECH_TAIL_SECONDS);
    }
  }

  settleToIdle(fast = false) {
    this.speaking = false;
    this.speechTail = 0;
    if (this.gesture && this.gesture.phase !== 'release') {
      this.gesture.phase = 'release';
      this.gesture.t = 0;
      this.gesture.release = fast ? 0.18 : randomBetween(...RELEASE_RANGE);
    }
    if (fast) this.weight = Math.min(this.weight, 0.4);
  }

  async setBaseAnimation(url, { allowVerticalMotion = true, allowFloorMotion = true } = {}) {
    console.log('[Gesture] Swapping base animation...');
    const clip = await loadMixamoAnimation(url, this.vrm, {
      allowVerticalMotion,
      allowFloorMotion,
      rootMotionNodeName: this.motionRootName,
    });
    const oldEntry = this.baseEntry;
    const newEntry = this._makeEntry(clip);
    newEntry.action.play();
    newEntry.action.setEffectiveWeight(0);
    this.baseEntry = newEntry;
    this._fadeBase(newEntry.action, 1, CROSSFADE_SECONDS);
    if (oldEntry) {
      this._fadeBase(oldEntry.action, 0, CROSSFADE_SECONDS, () => {
        oldEntry.action.stop();
        this.mixer.uncacheAction(oldEntry.clip);
      });
    }
  }

  resetBase() {
    if (this.baseEntry) {
      this.baseEntry.action.reset();
      this.baseEntry.action.play();
    }
  }

  // --- Per-frame driver ----------------------------------------------------
  update(delta) {
    if (this.disposed) return;
    this.elapsed += delta;
    this._advanceBaseFades(delta);

    // 1) Base layer writes the arm/spine/finger quaternions.
    this.mixer.update(delta);

    const mood = this.getMood() || {};
    const amplitude = Math.max(0, Math.min(1, mood.amplitude ?? 0));
    const tier = TIER_ORDER.includes(mood.tierBias) ? mood.tierBias : 'medium';

    // 2) Speech tail -> stop speaking after the grace period.
    if (this.speaking) {
      this.speechTail -= delta;
      if (this.speechTail <= 0) {
        this.speaking = false;
        console.log('[Gesture] Speech ended -> relaxing to idle.');
        if (this.gesture && this.gesture.phase !== 'release') {
          this.gesture.phase = 'release';
          this.gesture.t = 0;
        }
      }
    }

    // 3) Gesture scheduling + envelope, accent beats.
    this._updateGesture(delta, amplitude, tier);
    this._updateAccents(delta, amplitude, tier);

    // 4) Master weight eases with speaking state.
    const target = this.speaking ? 1 : 0;
    const rate = target > this.weight ? WEIGHT_RAMP_UP : WEIGHT_RAMP_DOWN;
    this.weight += (target - this.weight) * Math.min(1, rate * delta);

    // 5) Compose all layers onto the bones.
    this._applyPose(delta, amplitude);

    this.prevAmp = amplitude;
  }

  // Start / advance / end the current keypose gesture.
  _updateGesture(delta, amplitude, tier) {
    if (this.gesture) {
      const g = this.gesture;
      g.t += delta;
      if (g.phase === 'attack') {
        const k = Math.min(1, g.t / g.attack);
        g.weight = Math.max(0, Math.min(1.05, easeOutBack(k)));
        if (k >= 1) { g.phase = 'hold'; g.t = 0; g.weight = 1; }
      } else if (g.phase === 'hold') {
        g.weight = 1;
        if (g.t >= g.hold) { g.phase = 'release'; g.t = 0; }
      } else { // release
        const k = Math.min(1, g.t / g.release);
        g.weight = 1 - smoothstep(k);
        if (k >= 1) {
          console.log(`[Gesture] Gesture "${g.poseKey}" done.`);
          this.gesture = null;
          const gap = randomBetween(...(GAP_BY_TIER[tier] ?? GAP_BY_TIER.medium));
          // Louder speech shortens the gap a touch (more animated).
          this.nextGestureAt = this.elapsed + gap * (1 - 0.4 * amplitude);
        }
      }
      return;
    }

    // No active gesture: start one if speaking, past the rest gap, and audible.
    if (this.speaking && this.elapsed >= this.nextGestureAt && amplitude > ONSET_ABS_FLOOR) {
      this._startGesture(tier);
    }
  }

  _startGesture(tier) {
    const poseKey = this._pickPose(tier);
    if (!poseKey) return;
    const pose = POSES[poseKey];

    // Sides: honour two-hand poses / tier chance, else alternate dominant hand.
    let sides;
    const twoHand = pose.twoHand && Math.random() < (TWO_HAND_BY_TIER[tier] ?? 0.3) + 0.2;
    if (twoHand) {
      sides = ['left', 'right'];
    } else {
      const dom = this.lastDominant === 'right' ? 'left' : 'right';
      this.lastDominant = dom;
      sides = [dom];
    }

    this.gesture = {
      poseKey,
      sides,
      phase: 'attack',
      t: 0,
      weight: 0,
      attack: randomBetween(...ATTACK_RANGE),
      hold: randomBetween(...HOLD_RANGE) * (tier === 'high' ? 0.7 : tier === 'low' ? 1.25 : 1),
      release: randomBetween(...RELEASE_RANGE),
    };
    this.lastPoseKey = poseKey;
    console.log(`[Gesture] Start "${poseKey}" tier=${tier} sides=${sides.join('+')}.`);
  }

  // Prefer poses matching the tier; avoid repeating the last pose.
  _pickPose(tier) {
    const keys = Object.keys(POSES);
    let pool = keys.filter((k) => POSES[k].tier === tier);
    // Fall back to neighbouring tiers if none / too few.
    if (pool.length < 2) {
      const idx = TIER_ORDER.indexOf(tier);
      pool = keys.filter((k) => Math.abs(TIER_ORDER.indexOf(POSES[k].tier) - idx) <= 1);
    }
    if (pool.length > 1 && this.lastPoseKey) {
      const noRepeat = pool.filter((k) => k !== this.lastPoseKey);
      if (noRepeat.length) pool = noRepeat;
    }
    return pool[Math.floor(Math.random() * pool.length)] ?? keys[0];
  }

  // Fire small accent springs on loudness onsets during a held gesture.
  _updateAccents(delta, amplitude, tier) {
    if (!this.speaking) return;
    const rising = amplitude - this.prevAmp;
    const since = this.elapsed - this.lastAccentAt;
    if (rising > ONSET_DELTA_THRESHOLD && amplitude > ONSET_ABS_FLOOR && since > ACCENT_MIN_INTERVAL) {
      const sides = this.gesture?.sides ?? [this.lastDominant];
      const k = ACCENT_KICK * (0.6 + 0.7 * amplitude);
      for (const s of sides) this.accent[s].kick(k);
      this.lastAccentAt = this.elapsed;
    }
  }

  // --- Compose pose + accent + sway onto the bones -------------------------
  _applyPose(delta, amplitude) {
    // Always integrate accent springs so they're settled when we fade in.
    const accentVal = {
      left: this.accent.left.update(delta),
      right: this.accent.right.update(delta),
    };
    if (!this.rig || this.weight <= 0.001) return;

    this.swayPhase += delta * 1.8;
    const g = this.gesture;
    const gw = g ? g.weight : 0;
    const pose = g ? POSES[g.poseKey] : null;
    const activeSides = g ? g.sides : [];

    for (const side of ['left', 'right']) {
      const bones = this.rig[side];
      const inGesture = activeSides.includes(side);

      // Accumulate per-bone euler contributions (radians) in normalized space.
      const acc = {
        arm: { x: 0, y: 0, z: 0 },
        elbow: { x: 0, y: 0, z: 0 },
        wrist: { x: 0, y: 0, z: 0 },
        shoulder: { x: 0, y: 0, z: 0 },
      };

      // Pose DOFs (the big readable gesture), scaled by envelope + master weight.
      if (inGesture && pose) {
        const w = gw * this.weight;
        for (const [dofName, value] of Object.entries(pose.dof)) {
          const map = DOF_AXIS[dofName];
          if (!map) continue;
          acc[map.bone][map.axis] += value * w * map.sign[side];
        }
      }

      // Accent beat: quick extra elbow flick + wrist, on top of the held pose.
      const a = accentVal[side] * this.weight;
      acc.elbow.y += a * 0.14 * DOF_AXIS.elbowBend.sign[side];
      acc.wrist.z += a * 0.1 * DOF_AXIS.wristPitch.sign[side];

      // Sway: gentle breathing so a held pose isn't frozen.
      const s = Math.sin(this.swayPhase + (side === 'left' ? 1.3 : 0)) * SWAY_AMOUNT * this.weight;
      acc.arm.z += s * 0.4 * DOF_AXIS.armOut.sign[side];
      acc.elbow.y += s * 0.6 * DOF_AXIS.elbowBend.sign[side];

      this._applyBoneEuler(bones.arm, acc.arm);
      this._applyBoneEuler(bones.elbow, acc.elbow);
      this._applyBoneEuler(bones.wrist, acc.wrist);
      this._applyBoneEuler(bones.shoulder, acc.shoulder);

      // Fingers follow the pose's hand shape.
      const shape = inGesture && pose ? FINGER_SHAPES[pose.fingers] : null;
      this._applyFingers(side, shape, gw * this.weight);
    }

    // Torso: subtle counter-lean toward the gesturing side.
    if (this.rig.spine && g && pose) {
      const lean = (activeSides.includes('right') ? -1 : 0) + (activeSides.includes('left') ? 1 : 0);
      this._euler.set(0, lean * 0.05 * gw * this.weight, 0);
      this._offsetQ.setFromEuler(this._euler);
      this._baseQ.copy(this.rig.spine.quaternion);
      this.rig.spine.quaternion.copy(this._baseQ.multiply(this._offsetQ));
    }
  }

  // Post-multiply an accumulated euler offset onto whatever the mixer wrote
  // (same technique as updateHeadIdle in main.js, so it composes cleanly).
  _applyBoneEuler(bone, e) {
    if (!bone || (e.x === 0 && e.y === 0 && e.z === 0)) return;
    this._euler.set(e.x, e.y, e.z);
    this._offsetQ.setFromEuler(this._euler);
    this._baseQ.copy(bone.quaternion);
    bone.quaternion.copy(this._baseQ.multiply(this._offsetQ));
  }

  // Curl fingers toward the target hand shape (weighted by gesture envelope).
  _applyFingers(side, shape, weight) {
    const hand = this.rig.fingers?.[side];
    if (!hand) return;
    const sign = FINGER_CURL_SIGN[side];
    for (const f of FINGER_NAMES) {
      const curl = (shape ? shape[f] : 0) * weight;
      if (curl === 0) continue;
      for (const seg of FINGER_SEGMENTS) {
        const bone = hand[f][seg];
        if (!bone) continue;
        const amt = curl * FINGER_SEGMENT_WEIGHT[seg] * sign;
        this._euler.set(
          FINGER_CURL_AXIS === 'x' ? amt : 0,
          FINGER_CURL_AXIS === 'y' ? amt : 0,
          FINGER_CURL_AXIS === 'z' ? amt : 0
        );
        this._offsetQ.setFromEuler(this._euler);
        this._baseQ.copy(bone.quaternion);
        bone.quaternion.copy(this._baseQ.multiply(this._offsetQ));
      }
    }
  }

  // --- Base-layer weight tweens --------------------------------------------
  _fadeBase(action, to, duration, onDone = null) {
    this.baseFades = this.baseFades.filter((f) => f.action !== action);
    this.baseFades.push({
      action,
      from: action.getEffectiveWeight(),
      to,
      elapsed: 0,
      duration: Math.max(0.0001, duration),
      onDone,
    });
  }

  _advanceBaseFades(delta) {
    if (this.baseFades.length === 0) return;
    const still = [];
    for (const f of this.baseFades) {
      f.elapsed += delta;
      const k = Math.min(1, f.elapsed / f.duration);
      f.action.setEffectiveWeight(f.from + (f.to - f.from) * smoothstep(k));
      if (k >= 1) { if (f.onDone) f.onDone(); } else { still.push(f); }
    }
    this.baseFades = still;
  }

  dispose() {
    this.disposed = true;
    try {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.root);
    } catch (e) {
      console.warn('[Gesture] Dispose warning:', e?.message ?? e);
    }
    this.baseEntry = null;
    this.baseFades = [];
    this.rig = null;
    this.gesture = null;
    console.log('[Gesture] Controller disposed.');
  }
}
