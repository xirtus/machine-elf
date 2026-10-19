import * as THREE from 'three';

/**
 * Procedural rail path authoring.
 *
 * The path is *flown*, not drawn: a cursor (position, forward, up) integrates
 * yaw/pitch/roll rates along arc length, exactly like a craft being piloted.
 * That guarantees C1-smooth control points and lets motifs be written as
 * manoeuvres ("pull 2g while rolling twice") instead of as point soup.
 *
 * A segment is composed of *beats*. The composer enforces pacing — tension
 * rises, then a long stillness where the world opens up and you just look.
 * A uniformly curvy rail is as boring as a straight one.
 */

// ── deterministic rng ─────────────────────────────────────────────────────
export function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function rng() {
    a += 0x6d2b79f5; a |= 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rr = (rng, a, b) => a + (b - a) * rng();
const pick = (rng, arr) => arr[Math.min(arr.length - 1, (rng() * arr.length) | 0)];
const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** window that eases a manoeuvre in and out — anticipation + settle */
const ENV_MEAN = 0.82;
const env = (k) => smoothstep(0, 0.18, k) * smoothstep(1, 0.82, k);

// ── scratch ───────────────────────────────────────────────────────────────
const _right = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _tmp = new THREE.Vector3();
const _m = new THREE.Matrix4();
const RATE = { yaw: 0, pitch: 0, roll: 0 };

// ──────────────────────────────────────────────────────────────────────────
// dimension character
// ──────────────────────────────────────────────────────────────────────────
/**
 * Each dimension descends further from euclidean sanity.
 *  uprightRate — how strongly the transported frame is nudged back toward
 *                world-up per metre. dim 1 keeps a horizon; dim 5 has none.
 */
export const DIMENSION_PRESETS = [
  {
    name: 'gate', speed: 1.00, bankScale: 1.00, uprightRate: 0.0055,
    radius: 1.30, verticality: 0.45, stillness: 1.20,
    weights: { sweep: 4.0, straight: 2.2, dive: 1.4, climb: 1.1, weave: 1.0, corkscrew: 0.5, spiral: 0.4 },
  },
  {
    name: 'lattice', speed: 1.05, bankScale: 1.10, uprightRate: 0.0042,
    radius: 1.05, verticality: 0.65, stillness: 1.00,
    weights: { sweep: 3.4, straight: 1.6, dive: 1.6, climb: 1.3, weave: 2.0, corkscrew: 1.0, spiral: 0.7 },
  },
  {
    name: 'gasket', speed: 1.10, bankScale: 1.20, uprightRate: 0.0028,
    radius: 0.88, verticality: 0.85, stillness: 0.85,
    weights: { sweep: 2.8, straight: 1.3, dive: 1.9, climb: 1.5, weave: 2.6, corkscrew: 1.6, spiral: 1.1 },
  },
  {
    name: 'bulb', speed: 1.14, bankScale: 1.30, uprightRate: 0.0016,
    radius: 0.76, verticality: 1.05, stillness: 0.75,
    weights: { sweep: 2.4, straight: 1.1, dive: 2.1, climb: 1.7, weave: 2.8, corkscrew: 2.2, spiral: 1.5, loop: 0.8 },
  },
  {
    name: 'fold', speed: 1.18, bankScale: 1.42, uprightRate: 0.0006,
    radius: 0.68, verticality: 1.25, stillness: 0.65,
    weights: { sweep: 2.0, straight: 1.0, dive: 2.2, climb: 1.9, weave: 3.0, corkscrew: 2.6, spiral: 1.8, loop: 1.6 },
  },
  {
    // no up, no outside, the path passes through itself
    name: 'noplace', speed: 1.22, bankScale: 1.55, uprightRate: 0.0,
    radius: 0.60, verticality: 1.6, stillness: 0.55,
    weights: { sweep: 1.6, straight: 0.9, dive: 2.0, climb: 1.8, weave: 2.6, corkscrew: 3.0, spiral: 2.0, loop: 2.6, knot: 3.0 },
  },
];

export function presetFor(dimension) {
  const i = Math.max(0, Math.min(DIMENSION_PRESETS.length - 1, dimension | 0));
  return DIMENSION_PRESETS[i];
}

// ──────────────────────────────────────────────────────────────────────────
// the flying cursor
// ──────────────────────────────────────────────────────────────────────────
export function makeCursor(pos, dir, up) {
  const c = {
    pos: (pos || new THREE.Vector3()).clone(),
    dir: (dir || new THREE.Vector3(0, 0, -1)).clone().normalize(),
    up: (up || new THREE.Vector3(0, 1, 0)).clone(),
  };
  orthonormalize(c);
  return c;
}

function orthonormalize(c) {
  c.dir.normalize();
  _tmp.copy(c.dir).multiplyScalar(c.up.dot(c.dir));
  c.up.sub(_tmp);
  if (c.up.lengthSq() < 1e-8) {
    c.up.set(0, 1, 0);
    _tmp.copy(c.dir).multiplyScalar(c.up.dot(c.dir));
    c.up.sub(_tmp);
    if (c.up.lengthSq() < 1e-8) c.up.set(1, 0, 0);
  }
  c.up.normalize();
}

/**
 * Integrate a manoeuvre. `rateFn(k, s, RATE)` fills radians-per-metre.
 * Pushes control points into `out` roughly every `spacing` metres.
 */
function fly(state, len, spacing, rateFn) {
  const c = state.cursor;
  const step = 2.0;
  let s = 0;
  let since = state.since || 0;
  while (s < len - 1e-6) {
    const ds = Math.min(step, len - s);
    RATE.yaw = 0; RATE.pitch = 0; RATE.roll = 0;
    rateFn(s / len, s, RATE);

    if (RATE.pitch !== 0) {
      _right.copy(c.dir).cross(c.up).normalize();
      _q.setFromAxisAngle(_right, RATE.pitch * ds);
      c.dir.applyQuaternion(_q); c.up.applyQuaternion(_q);
    }
    if (RATE.yaw !== 0) {
      _q.setFromAxisAngle(c.up, -RATE.yaw * ds);   // +yaw = turn right
      c.dir.applyQuaternion(_q);
    }
    if (RATE.roll !== 0) {
      _q.setFromAxisAngle(c.dir, -RATE.roll * ds); // +roll = right wing down
      c.up.applyQuaternion(_q);
    }
    orthonormalize(c);

    c.pos.addScaledVector(c.dir, ds);
    s += ds; since += ds;
    if (since >= spacing) { state.push(c.pos); since = 0; }
  }
  state.since = since;
  return len;
}

// ──────────────────────────────────────────────────────────────────────────
// motifs — each returns the arc length it consumed
// ──────────────────────────────────────────────────────────────────────────
const MOTIFS = {
  /** stillness. the world opens up and you just look. */
  straight(state, rng, p) {
    const len = p.len;
    const drift = p.drift ?? 0;
    return fly(state, len, 110, (k, s, R) => {
      if (drift) {
        R.yaw = Math.sin(k * Math.PI * 2) * drift;
        R.pitch = Math.cos(k * Math.PI * 1.3) * drift * 0.5;
      }
    });
  },

  /** long sweeping arc — the bread and butter */
  sweep(state, rng, p) {
    const len = p.len, turn = p.turn, rise = p.rise ?? 0;
    return fly(state, len, Math.max(34, p.radius * 0.34), (k, s, R) => {
      const e = env(k) / ENV_MEAN;
      R.yaw = (turn / len) * e;
      R.pitch = (rise / len) * e;
    });
  },

  /** sudden dive — sharp ease-in, long recovery */
  dive(state, rng, p) {
    const len = p.len, drop = p.drop, yaw = p.yaw ?? 0;
    return fly(state, len, 42, (k, s, R) => {
      // fast onset, slow settle: pitch down hard then flare out
      const e = (smoothstep(0, 0.10, k) * (1 - smoothstep(0.30, 1.0, k)) * 1.55 +
                 smoothstep(0.55, 1.0, k) * -0.55);
      R.pitch = (drop / len) * e * 2.1;
      R.yaw = (yaw / len) * env(k) / ENV_MEAN;
      R.roll = R.yaw * 0.8;
    });
  },

  climb(state, rng, p) {
    return MOTIFS.dive(state, rng, { len: p.len, drop: -p.rise, yaw: p.yaw ?? 0 });
  },

  /**
   * Barrel roll. A coordinated roll is a constant pull with a constant roll
   * rate — the trajectory is a helix and the frame corkscrews around it.
   */
  corkscrew(state, rng, p) {
    const len = p.len, turns = p.turns, radius = p.radius;
    const w = (Math.PI * 2 * turns) / len;   // roll rate, rad/m
    const kappa = radius * w * w;            // helix curvature
    const sgn = p.dir ?? 1;
    return fly(state, len, 30, (k, s, R) => {
      const e = env(k) / ENV_MEAN;
      R.pitch = kappa * e;
      R.roll = w * sgn * e;
    });
  },

  /** tight canyon weave — hard alternating S-bends, counter-rolled */
  weave(state, rng, p) {
    const len = p.len, amp = p.amp, cycles = p.cycles, phase = p.phase ?? 0;
    return fly(state, len, 26, (k, s, R) => {
      const e = env(k) / ENV_MEAN;
      const a = Math.sin(k * Math.PI * 2 * cycles + phase);
      R.yaw = amp * a * e;
      R.pitch = Math.sin(k * Math.PI * 2 * cycles * 0.5 + 1.1) * amp * 0.22 * e;
      R.roll = amp * a * e * 0.55;
    });
  },

  /** loop-the-loop. the frame flips completely and comes back — PTF proof. */
  loop(state, rng, p) {
    const radius = p.radius;
    const len = Math.PI * 2 * radius;
    const twist = p.twist ?? 0;
    return fly(state, len, Math.max(22, radius * 0.28), (k, s, R) => {
      R.pitch = 1 / radius;
      R.roll = (twist * Math.PI * 2) / len;
    });
  },

  /** descending helix around a vertical-ish axis — falling down a well */
  spiral(state, rng, p) {
    const len = p.len, turns = p.turns, radius = p.radius, drop = p.drop;
    const w = (Math.PI * 2 * turns) / len;
    return fly(state, len, Math.max(26, radius * 0.3), (k, s, R) => {
      const e = env(k) / ENV_MEAN;
      R.yaw = w * e * (p.dir ?? 1);
      R.pitch = (drop / len) * e - (radius * w * w) * 0.0;
      R.roll = w * e * 0.45 * (p.dir ?? 1);
    });
  },

  /**
   * A trefoil knot spliced into the path — it literally passes through
   * itself. Only sane in dimension 5, where nothing else is either.
   */
  knot(state, rng, p) {
    const S = p.scale;
    const steps = p.steps ?? 160;
    const c = state.cursor;

    // trefoil tangent at theta=0 is (5,0,-3); build a rotation taking that to
    // the cursor's forward, with the knot's +Y roughly on the cursor's up.
    const t0 = _tmp.set(5, 0, -3).normalize();
    const q0 = new THREE.Quaternion().setFromUnitVectors(t0, c.dir);
    const kUp = new THREE.Vector3(0, 1, 0).applyQuaternion(q0);
    const proj = kUp.clone().addScaledVector(c.dir, -kUp.dot(c.dir)).normalize();
    const want = c.up.clone().addScaledVector(c.dir, -c.up.dot(c.dir)).normalize();
    const q1 = new THREE.Quaternion().setFromUnitVectors(proj, want);
    const rot = q1.multiply(q0);

    const p0 = new THREE.Vector3(0, -1, 0).multiplyScalar(S).applyQuaternion(rot);
    const origin = c.pos.clone().sub(p0);
    const pt = new THREE.Vector3();
    let len = 0;
    const prev = new THREE.Vector3().copy(c.pos);

    for (let i = 1; i <= steps; i++) {
      const th = (i / steps) * Math.PI * 2;
      pt.set(
        Math.sin(th) + 2 * Math.sin(2 * th),
        Math.cos(th) - 2 * Math.cos(2 * th),
        -Math.sin(3 * th)
      ).multiplyScalar(S).applyQuaternion(rot).add(origin);
      len += pt.distanceTo(prev);
      prev.copy(pt);
      if (i % 3 === 0 || i === steps) state.push(pt);
    }
    c.pos.copy(prev);
    state.since = 0;
    return len;
  },
};

// ──────────────────────────────────────────────────────────────────────────
// beat composer — pacing is the whole game
// ──────────────────────────────────────────────────────────────────────────
const INTENSITY = {
  straight: 0.05, sweep: 0.30, dive: 0.72, climb: 0.60,
  corkscrew: 0.85, weave: 0.80, loop: 0.95, spiral: 0.65, knot: 1.0,
};
const PACE = {
  straight: 1.16, sweep: 1.02, dive: 1.10, climb: 0.94,
  corkscrew: 0.92, weave: 0.80, loop: 0.86, spiral: 0.88, knot: 0.78,
};

function weightedPick(rng, weights, banned) {
  let total = 0;
  for (const k in weights) { if (banned && banned.has(k)) continue; total += weights[k]; }
  if (total <= 0) return 'sweep';
  let r = rng() * total;
  for (const k in weights) {
    if (banned && banned.has(k)) continue;
    r -= weights[k];
    if (r <= 0) return k;
  }
  return 'sweep';
}

function paramsFor(kind, rng, pre) {
  const R = pre.radius;
  switch (kind) {
    case 'straight':
      return { len: rr(rng, 260, 420), drift: rr(rng, 0, 0.00035) };
    case 'sweep': {
      const radius = rr(rng, 260, 620) * R;
      const turn = rr(rng, 0.7, 2.0) * (rng() < 0.5 ? -1 : 1);
      const len = Math.abs(turn) * radius;
      return { len, turn, radius, rise: rr(rng, -0.35, 0.35) * pre.verticality };
    }
    case 'dive':
      return { len: rr(rng, 300, 520), drop: -rr(rng, 0.55, 1.05) * pre.verticality,
               yaw: rr(rng, -0.5, 0.5) };
    case 'climb':
      return { len: rr(rng, 320, 540), rise: rr(rng, 0.45, 0.95) * pre.verticality,
               yaw: rr(rng, -0.5, 0.5) };
    case 'corkscrew': {
      const turns = pick(rng, [1, 1.5, 2, 2, 3]);
      return { len: rr(rng, 420, 760), turns, radius: rr(rng, 26, 58) * R,
               dir: rng() < 0.5 ? -1 : 1 };
    }
    case 'weave': {
      const cycles = pick(rng, [1.5, 2, 2.5, 3]);
      return { len: rr(rng, 380, 660), amp: rr(rng, 0.009, 0.017) / R,
               cycles, phase: rng() * Math.PI * 2 };
    }
    case 'loop':
      return { radius: rr(rng, 90, 150) * R, twist: pick(rng, [0, 0, 1, -1]) };
    case 'spiral':
      return { len: rr(rng, 520, 900), turns: rr(rng, 1.0, 2.2),
               radius: rr(rng, 90, 190) * R, drop: -rr(rng, 0.4, 1.1) * pre.verticality,
               dir: rng() < 0.5 ? -1 : 1 };
    case 'knot':
      return { scale: rr(rng, 34, 60) };
    default:
      return { len: 300 };
  }
}

/**
 * Build control points for one segment of rail.
 *
 * @param {object} o
 *  seed, dimension, targetLength, start:{pos,dir,up}|null
 * @returns {{points:THREE.Vector3[], motifs:Array, cursor:object, preset:object,
 *            pathLength:number, rng:function}}
 */
export function buildSegment(o = {}) {
  const rng = o.rng || makeRng(o.seed ?? 1);
  const pre = presetFor(o.dimension ?? 0);
  const target = o.targetLength ?? 5200;

  const cursor = o.start
    ? makeCursor(o.start.pos, o.start.dir, o.start.up)
    : makeCursor(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0.06, -1), new THREE.Vector3(0, 1, 0));

  const points = [];
  const motifs = [];
  const state = {
    cursor, since: 1e9,
    push: (p) => { points.push(p.clone()); },
  };

  // back-extrapolated ghost so the curve's start tangent is exact
  points.push(cursor.pos.clone().addScaledVector(cursor.dir, -140));
  points.push(cursor.pos.clone().addScaledVector(cursor.dir, -70));
  points.push(cursor.pos.clone());

  let dist = 0;
  const beats = composeBeats(rng, pre, target);
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i];
    const used = MOTIFS[b.kind](state, rng, b.params);
    motifs.push({
      kind: b.kind, index: motifs.length,
      start: dist, end: dist + used, length: used,
      intensity: INTENSITY[b.kind] ?? 0.4,
      pace: b.pace ?? (PACE[b.kind] ?? 1),
      still: !!b.still,
    });
    dist += used;
  }
  state.push(cursor.pos);
  points.push(cursor.pos.clone().addScaledVector(cursor.dir, 80));

  return { points, motifs, cursor, preset: pre, pathLength: dist, rng };
}

/** Append more beats onto an existing segment's cursor. */
export function extendSegment(seg, o = {}) {
  const rng = seg.rng;
  const pre = seg.preset;
  const target = o.targetLength ?? 2600;
  const points = seg.points;
  // drop the trailing ghost point before continuing
  points.pop();

  const state = { cursor: seg.cursor, since: 0, push: (p) => points.push(p.clone()) };
  let dist = seg.pathLength;
  const beats = composeBeats(rng, pre, target, seg.motifs.length);
  for (const b of beats) {
    const used = MOTIFS[b.kind](state, rng, b.params);
    seg.motifs.push({
      kind: b.kind, index: seg.motifs.length,
      start: dist, end: dist + used, length: used,
      intensity: INTENSITY[b.kind] ?? 0.4,
      pace: b.pace ?? (PACE[b.kind] ?? 1),
      still: !!b.still,
    });
    dist += used;
  }
  state.push(seg.cursor.pos);
  points.push(seg.cursor.pos.clone().addScaledVector(seg.cursor.dir, 80));
  seg.pathLength = dist;
  return seg;
}

/**
 * Tension curve. Rise, spike, then *stop* — the stillness is what makes the
 * violence read. Guarantees at least one corkscrew and one long open straight
 * per segment, and never stacks two maximum-intensity beats.
 */
function composeBeats(rng, pre, targetLength, beatOffset = 0) {
  const beats = [];
  let len = 0;
  let tension = 0;
  let prev = null;
  let hadRoll = false, hadStill = false;
  const banned = new Set();

  // settle in
  if (beatOffset === 0) {
    beats.push({ kind: 'straight', params: { len: rr(rng, 300, 420), drift: 0 }, pace: 1.0 });
    len += 360;
  }

  let guard = 0;
  while (len < targetLength && guard++ < 200) {
    const remain = targetLength - len;
    banned.clear();
    if (prev) banned.add(prev);                       // never repeat back to back
    if (tension > 0.9) { banned.add('corkscrew'); banned.add('weave'); banned.add('loop'); banned.add('knot'); banned.add('dive'); }
    if (remain < 700) { banned.add('loop'); banned.add('knot'); banned.add('spiral'); }

    let kind;
    // a long stillness after a hard run — the world opens up
    if (tension > 1.5 && remain > 900 && rng() < 0.75) {
      const len2 = rr(rng, 680, 1080) * pre.stillness;
      beats.push({ kind: 'straight', params: { len: len2, drift: rr(rng, 0, 0.0002) }, pace: 1.18, still: true });
      len += len2; tension = 0; prev = 'straight'; hadStill = true;
      continue;
    }
    // forced beats so every segment has a signature moment
    if (!hadRoll && len > targetLength * 0.45 && remain > 800) kind = 'corkscrew';
    else if (!hadStill && len > targetLength * 0.72 && remain > 900) kind = 'straight';
    else kind = weightedPick(rng, pre.weights, banned);

    const params = paramsFor(kind, rng, pre);
    const est = kind === 'loop' ? Math.PI * 2 * params.radius
              : kind === 'knot' ? params.scale * 16
              : params.len;
    if (est > remain * 1.6) { kind = 'sweep'; }

    const p2 = kind === (beats.length ? beats[beats.length - 1].kind : null) ? paramsFor(kind, rng, pre) : params;
    const used = kind === 'loop' ? Math.PI * 2 * p2.radius
               : kind === 'knot' ? p2.scale * 16
               : p2.len;

    beats.push({ kind, params: p2 });
    len += used;
    if (kind === 'corkscrew' || kind === 'loop' || kind === 'knot') hadRoll = true;
    if (kind === 'straight' && used > 600) hadStill = true;

    const inten = INTENSITY[kind] ?? 0.4;
    tension = kind === 'straight' ? Math.max(0, tension - 1.2) : tension + inten;
    prev = kind;

    // breather after anything violent
    if (inten > 0.7 && remain > 500 && rng() < 0.7) {
      const bl = rr(rng, 200, 380);
      beats.push({ kind: 'sweep', params: { len: bl, turn: rr(rng, -0.35, 0.35), radius: 500, rise: 0 }, pace: 1.08 });
      len += bl; prev = 'sweep';
    }
  }
  return beats;
}

export { MOTIFS };
