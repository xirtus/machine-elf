import * as THREE from 'three';

/**
 * Zero-allocation math helpers for the lock-on / salvo systems.
 * Everything here works on plain numbers or caller-supplied output objects —
 * nothing in this file allocates once the module has loaded.
 */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const saturate = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Framerate-independent exponential approach. */
export const damp = (a, b, lambda, dt) => a + (b - a) * (1 - Math.exp(-lambda * dt));

/** Overshoot-and-settle. t in 0..1 → 0..>1..1 */
export function easeOutBack(t, s = 1.9) {
  const k = t - 1;
  return 1 + (s + 1) * k * k * k + s * k * k;
}
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeInCubic = (t) => t * t * t;
export const easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);

/** Deterministic 0..1 hash. */
export function hash1(n) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

// ── scratch -----------------------------------------------------------------
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/**
 * World position of an enemy handle. Enemies are contractually required to
 * expose `.position`, but may be Object3D-backed and parented into a group
 * that gets shifted during a dimension transition — handle both.
 */
export function worldPosOf(t, out) {
  if (!t) { out.set(0, 0, 0); return out; }
  if (t.isObject3D === true && t.parent) return t.getWorldPosition(out);
  const p = t.position;
  if (p) out.set(p.x, p.y, p.z); else out.set(0, 0, 0);
  return out;
}

/**
 * Project a world point into NDC.
 * @returns view-space z (negative == in front of the camera)
 */
export function toNdc(pos, camera, out) {
  out.copy(pos).applyMatrix4(camera.matrixWorldInverse);
  const vz = out.z;
  out.applyMatrix4(camera.projectionMatrix);
  return vz;
}

/**
 * Distance between two NDC points expressed as a fraction of SCREEN HEIGHT
 * (which is how `cfg.weapons.lockRadius` is specified).
 */
export function ndcDistFrac(ax, ay, bx, by, aspect) {
  const dx = (ax - bx) * aspect * 0.5;
  const dy = (ay - by) * 0.5;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Rotate unit vector (dx,dy,dz) toward unit vector (wx,wy,wz) by at most
 * `maxAngle` radians. Writes into `out` (a THREE.Vector3). Never NaNs.
 */
export function steerToward(dx, dy, dz, wx, wy, wz, maxAngle, out) {
  let c = dx * wx + dy * wy + dz * wz;
  if (c > 1) c = 1; else if (c < -1) c = -1;
  const ang = Math.acos(c);
  if (!(ang > 1e-5)) { out.set(wx, wy, wz); return out; }
  if (ang <= maxAngle) { out.set(wx, wy, wz); return out; }

  // component of w perpendicular to d
  let px = wx - dx * c, py = wy - dy * c, pz = wz - dz * c;
  let pl = Math.sqrt(px * px + py * py + pz * pz);
  if (pl < 1e-6) {
    // exactly anti-parallel — pick any perpendicular so we never stall
    _a.set(dx, dy, dz);
    _b.set(Math.abs(dx) > 0.9 ? 0 : 1, Math.abs(dx) > 0.9 ? 1 : 0, 0);
    _a.cross(_b);
    pl = _a.length() || 1;
    px = _a.x / pl; py = _a.y / pl; pz = _a.z / pl;
  } else {
    px /= pl; py /= pl; pz /= pl;
  }
  const cs = Math.cos(maxAngle), sn = Math.sin(maxAngle);
  out.set(dx * cs + px * sn, dy * cs + py * sn, dz * cs + pz * sn);
  const l = out.length();
  if (l > 1e-6) out.multiplyScalar(1 / l); else out.set(dx, dy, dz);
  return out;
}

/** Build an arbitrary unit vector perpendicular to (x,y,z). */
export function perpendicular(x, y, z, out) {
  if (Math.abs(y) < 0.9) out.set(-z, 0, x);
  else out.set(y, -x, 0);
  const l = out.length();
  if (l > 1e-6) out.multiplyScalar(1 / l); else out.set(1, 0, 0);
  return out;
}

/** Finite guard — returns `fallback` for NaN/Infinity. */
export const safe = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);
