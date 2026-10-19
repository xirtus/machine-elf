import * as THREE from 'three';

/**
 * Spring-damper primitives for the camera rig, plus the noise it shakes with.
 *
 * Lerp-toward-target is an exponential decay: it has no momentum, so it can
 * never lag into a turn or overshoot out of one — everything feels like mush.
 * A second-order spring has both. `zeta` is the damping ratio:
 *   1.0  critically damped — fastest approach with no overshoot
 *   0.6  loose, overshoots and settles — use it laterally, it reads as weight
 *
 * Everything here is allocation-free after construction and substeps
 * internally so a stiff spring can never explode on a long frame.
 */

const _e = new THREE.Vector3();
const _a = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _ax = new THREE.Vector3();

const MAX_STEP = 0.30;   // omega * dt ceiling per substep

/** Scalar spring. `s` = {x, v}. */
export function springScalar(s, target, omega, zeta, dt) {
  if (dt <= 0) return s.x;
  const n = Math.min(8, Math.max(1, Math.ceil((omega * dt) / MAX_STEP)));
  const h = dt / n;
  const k = omega * omega;
  const c = 2 * zeta * omega;
  for (let i = 0; i < n; i++) {
    s.v += (-k * (s.x - target) - c * s.v) * h;
    s.x += s.v * h;
  }
  return s.x;
}

/** Exponential smoothing, frame-rate independent. For things without weight. */
export function expSmooth(cur, target, rate, dt) {
  return cur + (target - cur) * (1 - Math.exp(-rate * dt));
}

/**
 * Vector spring whose stiffness is expressed in a moving basis — tighter
 * vertically than laterally, near-rigid longitudinally. `omega`/`zeta` are
 * Vector3s of (right, up, forward) gains.
 *
 * The caller is expected to feed-forward the target's own motion before
 * calling (pos += targetDelta), so this only ever fights *acceleration*.
 * That is what makes the camera lag in turns but never trail on straights.
 */
export function springBasis3(pos, vel, target, right, up, fwd, omega, zeta, dt, maxErr = 0) {
  if (dt <= 0) return;
  const n = Math.min(8, Math.max(1, Math.ceil((Math.max(omega.x, omega.y, omega.z) * dt) / MAX_STEP)));
  const h = dt / n;
  for (let s = 0; s < n; s++) {
    _e.copy(pos).sub(target);
    const ex = _e.dot(right), ey = _e.dot(up), ez = _e.dot(fwd);
    const vx = vel.dot(right), vy = vel.dot(up), vz = vel.dot(fwd);
    const ax = -omega.x * omega.x * ex - 2 * zeta.x * omega.x * vx;
    const ay = -omega.y * omega.y * ey - 2 * zeta.y * omega.y * vy;
    const az = -omega.z * omega.z * ez - 2 * zeta.z * omega.z * vz;
    _a.copy(right).multiplyScalar(ax).addScaledVector(up, ay).addScaledVector(fwd, az);
    vel.addScaledVector(_a, h);
    pos.addScaledVector(vel, h);
  }
  if (maxErr > 0) {
    _e.copy(pos).sub(target);
    const l = _e.length();
    if (l > maxErr) {
      pos.copy(target).addScaledVector(_e, maxErr / l);
      // bleed the velocity that drove us out of bounds
      vel.multiplyScalar(0.6);
    }
  }
}

/**
 * Quaternion spring with real angular velocity. Slerping toward a target is
 * first-order and mushy; this carries momentum so the view whips and settles.
 * `w` is angular velocity in world space (rad/s).
 */
export function springQuat(q, w, target, omega, zeta, dt, maxRate = 12) {
  if (dt <= 0) return q;
  const n = Math.min(8, Math.max(1, Math.ceil((omega * dt) / MAX_STEP)));
  const h = dt / n;
  const k = omega * omega;
  const c = 2 * zeta * omega;
  for (let i = 0; i < n; i++) {
    _qi.copy(q).invert();
    _q.copy(target).multiply(_qi);           // world-space error rotation
    if (_q.w < 0) { _q.x = -_q.x; _q.y = -_q.y; _q.z = -_q.z; _q.w = -_q.w; }
    const s = Math.sqrt(Math.max(0, 1 - _q.w * _q.w));
    let angle = 2 * Math.acos(Math.min(1, Math.max(-1, _q.w)));
    if (angle > Math.PI) angle -= Math.PI * 2;
    if (s > 1e-6) _ax.set(_q.x / s, _q.y / s, _q.z / s);
    else _ax.set(0, 0, 0);

    // acceleration = k * error - c * velocity
    _ax.multiplyScalar(k * angle).addScaledVector(w, -c);
    w.addScaledVector(_ax, h);
    let wl = w.length();
    if (wl > maxRate) { w.multiplyScalar(maxRate / wl); wl = maxRate; }
    if (wl > 1e-7) {
      _q.setFromAxisAngle(_ax.copy(w).divideScalar(wl), wl * h);
      q.premultiply(_q).normalize();
    }
  }
  return q;
}

// ── noise ─────────────────────────────────────────────────────────────────
function hash1(n) {
  const s = Math.sin(n) * 43758.5453123;
  return s - Math.floor(s);
}

/** Smooth 1D value noise in -1..1. */
export function noise1(x, seed = 0) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash1(i * 127.1 + seed * 311.7);
  const b = hash1((i + 1) * 127.1 + seed * 311.7);
  return (a + (b - a) * u) * 2 - 1;
}

/** Two-octave fbm — enough texture that shake never reads as a sine wave. */
export function fbm1(x, seed = 0) {
  return noise1(x, seed) * 0.68 + noise1(x * 2.17 + 13.7, seed + 5.3) * 0.32;
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const smoothstep01 = (x) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};
