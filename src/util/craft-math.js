/**
 * Small numeric helpers for the player craft — seeded noise, keyframe curves
 * and second-order springs. Kept dependency-free and allocation-free so the
 * per-frame parts can run inside the update loop.
 *
 * Owned by the *player* agent (BRIEF §7). Prefix `craft-`.
 */

export const TAU = Math.PI * 2;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const saturate = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Frame-rate independent exponential approach. `rate` in 1/s. */
export const damp = (cur, target, rate, dt) =>
  cur + (target - cur) * (1 - Math.exp(-rate * dt));

export const smoothstep = (e0, e1, x) => {
  const t = saturate((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** back-out ease — overshoots then settles. The clockwork "tick". */
export function easeBackOut(t, s = 1.9) {
  const u = t - 1;
  return u * u * ((s + 1) * u + s) + 1;
}

/** Deterministic 32-bit PRNG so the craft is byte-identical every boot. */
export function makeRng(seed = 1337) {
  let s = seed >>> 0;
  return function rng() {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}

/** Cheap deterministic hash → 0..1 */
export function hash1(n) {
  const s = Math.sin(n * 127.1) * 43758.5453123;
  return s - Math.floor(s);
}

/** Catmull-Rom through a keyframe table `[[x, ...vals], ...]` sorted by x. */
export function sampleKeys(keys, x, out) {
  const n = keys.length;
  let i = 0;
  while (i < n - 2 && keys[i + 1][0] < x) i++;
  const k1 = keys[i], k2 = keys[i + 1];
  const k0 = keys[i - 1] || k1;
  const k3 = keys[i + 2] || k2;
  const span = k2[0] - k1[0];
  const t = span > 1e-6 ? saturate((x - k1[0]) / span) : 0;
  const t2 = t * t, t3 = t2 * t;
  const m = k1.length;
  for (let c = 1; c < m; c++) {
    const p0 = k0[c], p1 = k1[c], p2 = k2[c], p3 = k3[c];
    out[c - 1] = 0.5 * (
      2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3
    );
  }
  return out;
}

/** Shortest signed angular difference, radians. */
export function angDiff(a, b) {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Gaussian lobe used to sculpt fins/chines onto a cross-section. */
export function lobe(theta, center, width) {
  const d = angDiff(theta, center) / width;
  return Math.exp(-d * d);
}

/**
 * Second-order spring. Underdamped by default so it overshoots and settles —
 * the single most important thing separating "springy" from "lerp".
 *
 *   s.target = x; s.step(dt);  →  s.value
 */
export class Spring {
  constructor(omega = 10, zeta = 0.62, value = 0) {
    this.omega = omega;
    this.zeta = zeta;
    this.value = value;
    this.vel = 0;
    this.target = value;
    this.maxVel = Infinity;
  }
  set(v) { this.value = v; this.target = v; this.vel = 0; }
  kick(v) { this.vel += v; }
  step(dt) {
    // semi-implicit euler, substepped so big omega stays stable
    const steps = dt > 1 / 90 ? 2 : 1;
    const h = dt / steps;
    const k = this.omega * this.omega;
    const c = 2 * this.zeta * this.omega;
    for (let i = 0; i < steps; i++) {
      const a = (this.target - this.value) * k - this.vel * c;
      this.vel += a * h;
      if (this.vel > this.maxVel) this.vel = this.maxVel;
      else if (this.vel < -this.maxVel) this.vel = -this.maxVel;
      this.value += this.vel * h;
    }
    return this.value;
  }
}
