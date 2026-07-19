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
const ATTACK_RANGE = [0.34, 0.52];
const HOLD_RANGE = [0.6, 1.6];
const RELEASE_RANGE = [0.55, 0.85];

// Minimum rest between full keyposes (seconds), per energy tier. These are
// FLOORS only — gestures also require a prosodic onset (loudness rise), so the
// actual spacing is irregular and much sparser than a fixed timer. Research
// shows co-speech gesture density clusters around prosodic landmarks (phrase
// boundaries / amplitude peaks), not a metronome (Danner et al.; McNeill).
// Rough natural rates are ~8–15 full gestures/min even for animated speakers,
// with long quiet stretches in between.
const GAP_BY_TIER = {
  low: [3.5, 7.0],
  medium: [2.2, 5.0],
  high: [1.4, 3.2],
};
// After a gesture finishes, chance we skip the next eligible onset entirely
// (extra irregularity so it never feels like a beat clock).
const SKIP_ONSET_CHANCE = 0.35;
// How soon after speech starts the FIRST gesture may fire (still onset-gated).
const FIRST_GESTURE_DELAY = [0.25, 0.7];

// Chance a gesture uses both hands, per tier. Kept deliberately rare: natural
// co-speech is predominantly unimanual; bimanual (two-hand) gestures are for
// emphasis / global content only (Lausberg & Kita; McNeill). High random rates
// made "raise both arms" fire out of context.
const TWO_HAND_BY_TIER = { low: 0, medium: 0.04, high: 0.1 };
// Two-hand only when speech is loud enough (prosodic emphasis).
const TWO_HAND_MIN_AMPLITUDE = 0.5;
// Minimum seconds between two-hand gestures so they stay special, not habitual.
const TWO_HAND_COOLDOWN = 10;

// Onset detection (rising edge in loudness = prosodic emphasis). Used both for
// full keypose scheduling and for small accent flicks on a held pose.
const ONSET_DELTA_THRESHOLD = 0.06;
const ONSET_ABS_FLOOR = 0.14;
// Full keyposes need a clearer peak than tiny accent flicks.
const KEYPOSE_ONSET_DELTA = 0.09;
const KEYPOSE_ONSET_FLOOR = 0.2;
const ACCENT_MIN_INTERVAL = 0.35;

// Accent spring dynamics (softened: lower stiffness + more damping = a gentle,
// slower beat rather than a sharp flick).
const SPRING_STIFFNESS = 80;
const SPRING_DAMPING = 20;
const ACCENT_KICK = 1.8;

// Continuous sway.
const SWAY_AMOUNT = 0.045;

// --- Body-midline guard ----------------------------------------------------
// Instead of a fat torso capsule (which can't tell a resting arm from a hand
// crossing the chest), we keep each hand on its own side of the body: the
// lateral shoulder-to-shoulder axis is measured from the live rig, and if a
// wrist crosses past the allowed inner bound toward the far side, that arm is
// abducted outward until the hand comes back. Pose- and convention-independent.
const MIDLINE_ALLOWANCE_SCALE = 0.12; // how far past centre a hand may reach (× shoulder width)
const PUSH_OUT_GAIN = 16;          // integral rate: abduction added per metre crossed per second
const PUSH_OUT_MAX = 1.3;          // clamp so it can't fling the arm out
const PUSH_OUT_RELAX = 1.5;        // radians/sec the correction relaxes once clear
const DEBUG_COLLISION = true;      // log midline-crossing events (set false to quiet)

// Master weight easing (whole layer fades with speech). Lower = softer, slower
// fade in/out of the gesture layer as a whole.
const WEIGHT_RAMP_UP = 2.4;
const WEIGHT_RAMP_DOWN = 2.0;

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
  // Both palms up / shrug — "what can you do". Two-hand only.
  shrug: {
    tier: 'medium',
    twoHand: true,
    twoHandOnly: true,
    dof: { shrug: 0.55, armOut: 0.3, armTwist: 0.5, elbowBend: 0.9, wristPitch: -0.35 },
    fingers: 'open',
  },
  // Big two-hand spread — high-energy exclamation. Requires twoHand (never
  // played one-handed; looks odd without the pair) and the rare two-hand gate.
  bigSpread: {
    tier: 'high',
    twoHand: true,
    twoHandOnly: true,
    dof: { armRaise: 0.45, armOut: 0.6, elbowBend: 0.8, wristPitch: -0.3, wristYaw: 0.2 },
    fingers: 'open',
  },
};

// Finger curl amounts per named hand shape. Applied to index/middle/ring/little
// proximal+intermediate+distal joints (thumb left alone to avoid odd twists).
// Kept modest so even a slightly-wrong axis doesn't look extreme.
const FINGER_SHAPES = {
  open: { Index: 0.04, Middle: 0.04, Ring: 0.06, Little: 0.08 },
  relaxed: { Index: 0.18, Middle: 0.2, Ring: 0.24, Little: 0.28 },
  point: { Index: 0.02, Middle: 0.7, Ring: 0.8, Little: 0.85 },
};

const FINGER_NAMES = ['Index', 'Middle', 'Ring', 'Little'];
const FINGER_SEGMENTS = ['Proximal', 'Intermediate', 'Distal'];
// Distribute a curl scalar across the three segments (proximal bends most).
const FINGER_SEGMENT_WEIGHT = { Proximal: 0.55, Intermediate: 0.35, Distal: 0.4 };
// Finger curl axis/sign in normalized VRM space. Local axes vary across
// VRoid/VRM exports, so curls are gated by APPLY_FINGER_CURLS (off by default)
// until a correct mapping is verified for the model. When enabling, try
// flipping the two signs together if fingers bend the wrong way.
const APPLY_FINGER_CURLS = false;
const FINGER_CURL_AXIS = 'z';
const FINGER_CURL_SIGN = { right: -1, left: 1 };

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

// Gentle overshoot on the attack so a gesture "reaches" and settles naturally.
// Kept small (c1 low) so the motion glides into place instead of snapping.
function easeOutBack(t) {
  const c1 = 0.7;
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
    this.lastTwoHandAt = -Infinity;

    // Accent + sway.
    this.accent = { left: new Spring(), right: new Spring() };
    this.lastAccentAt = -Infinity;
    this.swayPhase = randomBetween(0, Math.PI * 2);

    // Rig.
    this.rig = null;
    // Rest (base) local rotation of every managed bone, captured once. Bones the
    // base clip does NOT animate (fingers, often shoulders) are reset to this
    // each frame so our additive offsets can't accumulate/drift.
    this._restQuat = new Map();      // bone -> THREE.Quaternion
    this._animatedBones = new Set(); // bones the current base clip drives
    this._managed = [];              // flat list of all managed bones

    // Scratch.
    this._euler = new THREE.Euler(0, 0, 0, 'XYZ');
    this._offsetQ = new THREE.Quaternion();
    this._baseQ = new THREE.Quaternion();
    // Scratch for torso self-collision (world space).
    this._capA = new THREE.Vector3();
    this._capB = new THREE.Vector3();
    this._wristW = new THREE.Vector3();
    this._shoulderW = new THREE.Vector3();
    this._nearest = new THREE.Vector3();
    this._pushOut = { left: 0, right: 0 }; // eased outward correction per side
    this._lastCollisionLog = 0;

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
      // Bones used to build the torso collision capsule (see _pushOutOfTorso).
      hips: get('hips'),
      chest: get('upperChest') ?? get('chest') ?? get('spine'),
      neck: get('neck') ?? get('head'),
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

    // Capture the rest local rotation of every bone we will offset, so we can
    // rebuild each frame from a known base instead of compounding in place.
    this._managed = [];
    this._restQuat.clear();
    const track = (bone) => {
      if (bone && !this._restQuat.has(bone)) {
        this._restQuat.set(bone, bone.quaternion.clone());
        this._managed.push(bone);
      }
    };
    for (const side of ['left', 'right']) {
      track(rig[side].arm); track(rig[side].elbow); track(rig[side].wrist); track(rig[side].shoulder);
      for (const f of FINGER_NAMES) for (const seg of FINGER_SEGMENTS) track(rig.fingers[side][f][seg]);
    }
    track(rig.spine);
    console.log(`[Gesture] Captured rest pose for ${this._managed.length} managed bones.`);
    return rig;
  }

  async load(baseClipUrl) {
    console.log('[Gesture] Loading base idle clip + building keypose rig...');
    const baseClip = await loadMixamoAnimation(baseClipUrl, this.vrm, {
      allowVerticalMotion: true,
      allowFloorMotion: false,
      rootMotionNodeName: null,
    });
    this.baseEntry = this._makeEntry(baseClip);
    this.baseEntry.action.play();
    this.baseEntry.action.setEffectiveWeight(1);
    this.rig = this._buildRig();
    this._computeAnimatedBones(baseClip);
    console.log('[Gesture] Ready (keypose co-speech gestures).');
  }

  _makeEntry(clip) {
    const action = this.mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.enabled = true;
    return { action, clip };
  }

  // Figure out which managed bones the base clip actually drives. Bones NOT in
  // this set are reset to their rest rotation each frame (so offsets on e.g.
  // fingers, which the idle never touches, can't accumulate and stay stuck).
  _computeAnimatedBones(clip) {
    this._animatedBones = new Set();
    if (!clip || !this.rig) return;
    const names = new Set();
    for (const track of clip.tracks) {
      const dot = track.name.lastIndexOf('.');
      names.add(dot >= 0 ? track.name.slice(0, dot) : track.name);
    }
    for (const bone of this._managed) {
      if (bone && names.has(bone.name)) this._animatedBones.add(bone);
    }
    const total = this._managed.length;
    const driven = this._animatedBones.size;
    console.log(`[Gesture] Base clip drives ${driven}/${total} managed bones; ${total - driven} reset-to-rest each frame.`);
  }

  setSpeaking(isSpeaking) {
    if (isSpeaking) {
      this.speechTail = SPEECH_TAIL_SECONDS;
      if (!this.speaking) {
        this.speaking = true;
        // Don't fire immediately — wait a beat, then only on a prosodic onset.
        this.nextGestureAt = this.elapsed + randomBetween(...FIRST_GESTURE_DELAY);
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

  async setBaseAnimation(url, { allowVerticalMotion = true, allowFloorMotion = false } = {}) {
    console.log(`[Gesture] Swapping base animation (floorMotion=${allowFloorMotion})...`);
    const clip = await loadMixamoAnimation(url, this.vrm, {
      allowVerticalMotion,
      allowFloorMotion,
      // Only bind root-motion tracks when explicitly allowed.
      rootMotionNodeName: allowFloorMotion ? this.motionRootName : null,
    });
    const oldEntry = this.baseEntry;
    const newEntry = this._makeEntry(clip);
    newEntry.action.play();
    newEntry.action.setEffectiveWeight(0);
    this.baseEntry = newEntry;
    this._computeAnimatedBones(clip);
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
          // Floor gap only — the next fire still needs a prosodic onset, so the
          // actual interval is longer and irregular.
          const gap = randomBetween(...(GAP_BY_TIER[tier] ?? GAP_BY_TIER.medium));
          this.nextGestureAt = this.elapsed + gap;
        }
      }
      return;
    }

    // No active gesture: only fire on a clear prosodic onset (loudness rise),
    // past the rest floor, while speaking. This replaces a metronome timer with
    // speech-driven, irregular density — matching how real co-speech gestures
    // cluster around emphasis rather than ticking at fixed intervals.
    if (!this.speaking || this.elapsed < this.nextGestureAt) return;
    if (amplitude < KEYPOSE_ONSET_FLOOR) return;
    const rising = amplitude - this.prevAmp;
    if (rising < KEYPOSE_ONSET_DELTA) return;
    // Extra irregularity: sometimes skip an otherwise-valid onset entirely.
    if (Math.random() < SKIP_ONSET_CHANCE) {
      this.nextGestureAt = this.elapsed + randomBetween(0.4, 1.2);
      return;
    }
    this._startGesture(tier, amplitude);
  }

  // Whether a two-hand gesture is allowed right now. Research on co-speech
  // gesture shows bimanual gestures are rare and reserved for emphasis / global
  // content — not random decoration. Require high energy, loud speech, and a
  // long cooldown so "both arms up" stays special and context-appropriate.
  _allowTwoHand(tier, amplitude) {
    if (tier === 'low') return false;
    if (amplitude < TWO_HAND_MIN_AMPLITUDE) return false;
    if (this.elapsed - this.lastTwoHandAt < TWO_HAND_COOLDOWN) return false;
    return Math.random() < (TWO_HAND_BY_TIER[tier] ?? 0);
  }

  _startGesture(tier, amplitude = 0) {
    const allowTwoHand = this._allowTwoHand(tier, amplitude);
    const poseKey = this._pickPose(tier, allowTwoHand);
    if (!poseKey) return;
    const pose = POSES[poseKey];

    // Two-hand only when (a) the gate allows it and (b) the pose supports it.
    // twoHandOnly poses (e.g. bigSpread) are never played one-handed.
    let sides;
    const twoHand = allowTwoHand && pose.twoHand;
    if (twoHand) {
      sides = ['left', 'right'];
      this.lastTwoHandAt = this.elapsed;
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

  // Prefer poses matching the tier; avoid repeating the last pose. Exclude
  // twoHandOnly poses when two-hand is not currently allowed.
  _pickPose(tier, allowTwoHand = false) {
    const keys = Object.keys(POSES);
    const eligible = (k) => {
      const p = POSES[k];
      if (p.twoHandOnly && !allowTwoHand) return false;
      return true;
    };
    let pool = keys.filter((k) => POSES[k].tier === tier && eligible(k));
    // Fall back to neighbouring tiers if none / too few.
    if (pool.length < 2) {
      const idx = TIER_ORDER.indexOf(tier);
      pool = keys.filter(
        (k) => Math.abs(TIER_ORDER.indexOf(POSES[k].tier) - idx) <= 1 && eligible(k)
      );
    }
    if (pool.length > 1 && this.lastPoseKey) {
      const noRepeat = pool.filter((k) => k !== this.lastPoseKey);
      if (noRepeat.length) pool = noRepeat;
    }
    return pool[Math.floor(Math.random() * pool.length)] ?? keys.find(eligible) ?? keys[0];
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
    if (!this.rig) return;

    // Reset every bone the base clip does NOT animate back to its rest rotation.
    // The mixer already refreshed the animated bones; these it never touches, so
    // without this our additive offsets would compound every frame and stick
    // (this was the cause of fingers bending backward and never relaxing).
    for (const bone of this._managed) {
      if (!this._animatedBones.has(bone)) {
        bone.quaternion.copy(this._restQuat.get(bone));
      }
    }

    // Fully idle: bones are at rest (animated ones from mixer, others reset
    // above). Keep the collision correction decaying and skip offset work.
    if (this.weight <= 0.001) {
      this._pushOut.left = 0;
      this._pushOut.right = 0;
      return;
    }

    this.swayPhase += delta * 1.15;
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

      // Torso self-collision guard: abduct outward by the eased correction
      // measured last frame, so the wrist never crosses through the body.
      acc.arm.z += this._pushOut[side] * DOF_AXIS.armOut.sign[side];

      this._applyBoneEuler(bones.arm, acc.arm);
      this._applyBoneEuler(bones.elbow, acc.elbow);
      this._applyBoneEuler(bones.wrist, acc.wrist);
      this._applyBoneEuler(bones.shoulder, acc.shoulder);

      // Measure penetration with the rotations now applied and drive it to zero
      // with an integral controller: while the wrist is inside the torso, keep
      // adding outward abduction; once clear, relax the correction back down.
      // (A proportional/eased target settles at nonzero penetration, which is
      // why arms still passed through before.)
      const penetration = this._torsoPenetration(side, bones);
      if (penetration > 0) {
        this._pushOut[side] = Math.min(
          PUSH_OUT_MAX,
          this._pushOut[side] + penetration * PUSH_OUT_GAIN * delta
        );
      } else {
        // Clear: relax slowly so the arm doesn't snap back into the body.
        this._pushOut[side] = Math.max(0, this._pushOut[side] - PUSH_OUT_RELAX * delta);
      }

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

  // Body-midline guard. Returns how far (metres) this side's wrist has crossed
  // past its allowed inner bound toward/through the far side of the body, i.e.
  // the amount of outward abduction needed to keep the hand from passing
  // through the torso. 0 if the hand is on its own side.
  //
  // Robust + convention-free: the lateral ("shoulder-to-shoulder") axis is
  // derived from the live world positions of the two shoulders, so we don't
  // guess which local axis points sideways. The right hand must stay on the
  // right of the body centre; the left on the left. A small inward allowance
  // lets hand-to-chest gestures reach the midline without triggering. Runs
  // after the arm rotations are applied, so it sees the real resulting pose.
  _torsoPenetration(side, bones) {
    const wrist = bones.wrist;
    const centreBone = this.rig.chest ?? this.rig.spine ?? this.rig.neck;
    const lShoulder = this.rig.left.shoulder ?? this.rig.left.arm;
    const rShoulder = this.rig.right.shoulder ?? this.rig.right.arm;
    if (!wrist || !centreBone || !lShoulder || !rShoulder) return 0;

    wrist.updateWorldMatrix(true, false);
    centreBone.updateWorldMatrix(true, false);
    lShoulder.updateWorldMatrix(true, false);
    rShoulder.updateWorldMatrix(true, false);

    this._wristW.setFromMatrixPosition(wrist.matrixWorld);
    this._shoulderW.setFromMatrixPosition(rShoulder.matrixWorld);   // right
    this._capA.setFromMatrixPosition(lShoulder.matrixWorld);        // left
    this._capB.setFromMatrixPosition(centreBone.matrixWorld);       // body centre

    // Lateral axis: from left shoulder toward right shoulder (world space).
    this._nearest.copy(this._shoulderW).sub(this._capA);
    const shoulderWidth = this._nearest.length();
    if (shoulderWidth < 1e-4) return 0;
    this._nearest.multiplyScalar(1 / shoulderWidth);               // unit lateral axis (points right)

    // Signed lateral offset of the wrist from the body centre. Positive = toward
    // the right shoulder side, negative = toward the left. (_shoulderW is free
    // to reuse as scratch now.)
    const lateral = this._shoulderW.copy(this._wristW).sub(this._capB).dot(this._nearest);

    // Inner bound: the hand may reach this far toward centre but no further.
    // Small negative allowance lets a hand touch the chest centre/opposite a
    // touch without flagging. Beyond it, the hand is crossing the body.
    const innerBound = -shoulderWidth * MIDLINE_ALLOWANCE_SCALE;
    // Right side must stay >= innerBound; left side <= -innerBound (mirror).
    const crossed = side === 'right'
      ? innerBound - lateral       // >0 when right wrist went too far left
      : lateral - (-innerBound);   // >0 when left wrist went too far right

    if (DEBUG_COLLISION && crossed > 0 && this.elapsed - this._lastCollisionLog > 0.5) {
      this._lastCollisionLog = this.elapsed;
      console.log(
        `[Gesture] ${side} wrist crossed midline: over=${crossed.toFixed(3)}m ` +
        `lateral=${lateral.toFixed(3)}m bound=${innerBound.toFixed(3)}m ` +
        `shoulderW=${shoulderWidth.toFixed(3)}m push=${this._pushOut[side].toFixed(3)}rad`
      );
    }
    return crossed > 0 ? crossed : 0;
  }

  // Curl fingers toward the target hand shape (weighted by gesture envelope).
  // Disabled by default: finger local-axis conventions vary across VRoid/VRM
  // exports, and a wrong curl axis/sign produces the "bent completely backward"
  // look. With APPLY_FINGER_CURLS off, fingers stay at the VRM rest pose (and
  // the rest-rebuild + Mixamo finger-track exclusion already keep them there).
  // Flip FINGER_CURL_SIGN / FINGER_CURL_AXIS and set APPLY_FINGER_CURLS true
  // once a correct mapping is verified for the model.
  _applyFingers(side, shape, weight) {
    if (!APPLY_FINGER_CURLS) return;
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
