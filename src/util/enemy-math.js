import * as THREE from 'three';

/**
 * Math + scratch for the clockwork-elf systems.
 *
 * Two ideas carry the whole look:
 *
 *  1. **Escapement easing.** Nothing lerps. A pose is held dead-still, then
 *     released in a snap that overshoots and rings down — a clock escapement.
 *     `tickEase(u, hold)` returns 0→1 across the first `hold` fraction of a
 *     tick and *exactly* 1 for the rest of it. The stillness is the point:
 *     70% of every tick is a freeze frame.
 *
 *  2. **Quantised phase.** Behaviour decisions, limb poses and rotations only
 *     change on tick boundaries. Between ticks nothing thinks. That is what
 *     separates stop-motion from smooth drift.
 *
 * Everything here is allocation-free; scratch objects live at module scope.
 */

// ── scratch ───────────────────────────────────────────────────────────────
export const SV = [];
for (let i = 0; i < 12; i++) SV.push(new THREE.Vector3());
export const SQ = [];
for (let i = 0; i < 6; i++) SQ.push(new THREE.Quaternion());
export const SM = [];
for (let i = 0; i < 4; i++) SM.push(new THREE.Matrix4());
export const SE = new THREE.Euler();
export const S2 = [];
for (let i = 0; i < 4; i++) S2.push(new THREE.Vector2());

export const UP = new THREE.Vector3(0, 1, 0);
export const RIGHT = new THREE.Vector3(1, 0, 0);
export const FWD = new THREE.Vector3(0, 0, 1);

// ── deterministic noise ───────────────────────────────────────────────────
export function hash11(n) {
  const s = Math.sin(n * 127.1) * 43758.5453123;
  return s - Math.floor(s);
}
export function hash21(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}
/** Signed, -1..1 */
export function shash(n) { return hash11(n) * 2 - 1; }

/** xorshift32 — cheap, seedable, no allocation after construction. */
export class Rng {
  constructor(seed = 1) { this.s = (seed >>> 0) || 0x9e3779b9; }
  reseed(seed) { this.s = (seed >>> 0) || 0x9e3779b9; return this; }
  next() {
    let x = this.s;
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    this.s = x;
    return x / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.next(); }
  int(n) { return Math.min(n - 1, (this.next() * n) | 0); }
  pick(arr) { return arr[this.int(arr.length)]; }
  sgn() { return this.next() < 0.5 ? -1 : 1; }
  /** Gaussian-ish via two samples; used for shoal scatter. */
  gauss() { return (this.next() + this.next() - 1); }
}

// ── escapement / stop-motion easing ───────────────────────────────────────

/**
 * Damped-spring snap. 0 at t=0, overshoots ~10-25%, settled by t=1.
 * `damp` lower = more ringing, `freq` higher = more bounces.
 */
export function escapement(t, damp = 4.0, freq = 5.0) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return 1 - Math.exp(-damp * t) * Math.cos(freq * t);
}

/**
 * The workhorse. `u` is the 0..1 position inside a tick.
 * Returns 0→1 during the first `hold` fraction (with overshoot), then a hard
 * flat 1 — the freeze frame.
 */
export function tickEase(u, hold = 0.3, damp = 4.0, freq = 5.0) {
  if (u >= hold) return 1;
  return escapement(u / hold, damp, freq);
}

/** Anticipation: dips *negative* before the snap. For wind-ups. */
export function anticipate(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  if (t < 0.42) { const k = t / 0.42; return -0.28 * Math.sin(k * Math.PI); }
  const k = (t - 0.42) / 0.58;
  return escapement(k, 3.4, 5.6);
}

/** Snap an angle to `steps` discrete positions around the circle. */
export function quantAngle(a, steps) {
  const q = (Math.PI * 2) / steps;
  return Math.round(a / q) * q;
}
export function quantize(v, step) { return Math.round(v / step) * step; }

/** Framerate-independent exponential smoothing. */
export function damp(current, target, lambda, dt) {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}
export function dampV(v, target, lambda, dt) {
  const k = 1 - Math.exp(-lambda * dt);
  v.x += (target.x - v.x) * k;
  v.y += (target.y - v.y) * k;
  v.z += (target.z - v.z) * k;
  return v;
}

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function saturate(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
export function smoothstep(a, b, x) {
  const t = saturate((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
export function mix(a, b, t) { return a + (b - a) * t; }
export function wrap01(v) { return v - Math.floor(v); }

/**
 * A ticking clock. Advances on scaled dt, reports whether a tick boundary was
 * crossed this frame and where we are inside the current tick.
 */
export class Escapement {
  constructor(rate = 8, phase = 0) {
    this.rate = rate;      // ticks per second
    this.phase = phase;    // 0..1 inside current tick
    this.count = 0;        // total ticks elapsed
    this.fired = false;    // crossed a boundary this frame
    this.jitter = 0;       // ±fraction of tick period, re-rolled per tick
  }
  reset(rate, phase = 0) {
    this.rate = rate; this.phase = phase; this.count = 0; this.fired = false;
    return this;
  }
  step(dt) {
    this.fired = false;
    const r = this.rate * (1 + this.jitter);
    this.phase += dt * r;
    while (this.phase >= 1) { this.phase -= 1; this.count++; this.fired = true; }
    if (this.phase < 0) this.phase = 0;
    return this.fired;
  }
  /** Eased 0..1 for this tick — flat 1 for the back of the tick. */
  ease(hold = 0.3, damp2 = 4.0, freq = 5.0) {
    return tickEase(this.phase, hold, damp2, freq);
  }
}

/**
 * Discrete pose channel: holds prev/next scalars and blends with the
 * escapement curve. Advance `next` on tick boundaries only.
 */
export class TickChan {
  constructor(v = 0) { this.prev = v; this.next = v; this.value = v; }
  set(v) { this.prev = this.value; this.next = v; }
  hard(v) { this.prev = this.next = this.value = v; }
  apply(s) { this.value = this.prev + (this.next - this.prev) * s; return this.value; }
}

/** Vec3 version of TickChan — the thing that makes elves lurch. */
export class TickVec {
  constructor() {
    this.prev = new THREE.Vector3();
    this.next = new THREE.Vector3();
    this.value = new THREE.Vector3();
  }
  set(v) { this.prev.copy(this.value); this.next.copy(v); }
  setXYZ(x, y, z) { this.prev.copy(this.value); this.next.set(x, y, z); }
  hard(v) { this.prev.copy(v); this.next.copy(v); this.value.copy(v); }
  apply(s) {
    this.value.copy(this.prev).lerp(this.next, s);
    return this.value;
  }
}

/** Shortest-arc look rotation without allocating. */
export function lookQuat(out, forward, up) {
  const m = SM[3];
  const f = SV[11].copy(forward);
  if (f.lengthSq() < 1e-8) f.set(0, 0, 1);
  f.normalize();
  const u = SV[10].copy(up || UP);
  if (Math.abs(f.dot(u)) > 0.999) u.set(f.z, f.x, f.y);
  const r = SV[9].crossVectors(u, f).normalize();
  const u2 = SV[8].crossVectors(f, r);
  m.set(
    r.x, u2.x, f.x, 0,
    r.y, u2.y, f.y, 0,
    r.z, u2.z, f.z, 0,
    0, 0, 0, 1
  );
  return out.setFromRotationMatrix(m);
}
