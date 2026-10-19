/**
 * Shared TSL helpers for the fractal distance estimators.
 *
 * Conventions used by every DE in this folder:
 *
 *   de(p: vec3, A: vec4, B: vec4) -> vec4( distance, trap0, trap1, trap2 )
 *
 * `distance` is a *distance estimate* in fractal-local units (the marcher
 * scales it back to world units). The three trap channels are orbit-trap
 * values normalised to roughly 0..1 and are what drive all of the colouring —
 * without them a Mandelbulb is a grey lump.
 *
 * All helpers are deliberately branchless where possible; every `If` inside a
 * march loop costs us on wide SIMD.
 */
import {
  Fn, If, Loop, Break, vec2, vec3, vec4, float, mat3,
  abs, max, min, clamp, floor, dot, length, sin, cos, sqrt,
  mix, smoothstep, sign, exp, pow, oneMinus,
} from 'three/tsl';

/** GLSL-style mod (WGSL `%` is a truncated remainder and breaks on negatives). */
export const gmod = Fn(([x, y]) => x.sub(x.div(y).floor().mul(y)));

/** Polynomial smooth minimum — the dimension-morph "melt". */
export const smin = Fn(([a, b, k]) => {
  const h = clamp(float(0.5).add(b.sub(a).mul(float(0.5).div(k.max(1e-4)))), 0.0, 1.0).toVar();
  return mix(b, a, h).sub(k.mul(h).mul(oneMinus(h)));
});
smin.setLayout({
  name: 'fx_smin', type: 'float',
  inputs: [{ name: 'a', type: 'float' }, { name: 'b', type: 'float' }, { name: 'k', type: 'float' }],
});

/** Exact box SDF. */
export const sdBox = Fn(([p, b]) => {
  const q = p.abs().sub(b).toVar();
  return q.max(vec3(0)).length().add(q.x.max(q.y).max(q.z).min(0));
});
sdBox.setLayout({
  name: 'fx_sdBox', type: 'float',
  inputs: [{ name: 'p', type: 'vec3' }, { name: 'b', type: 'vec3' }],
});

/** Rotate a vec3 about Y. */
export const rotY = Fn(([p, a]) => {
  const c = cos(a).toVar(), s = sin(a).toVar();
  return vec3(p.x.mul(c).add(p.z.mul(s)), p.y, p.z.mul(c).sub(p.x.mul(s)));
});
rotY.setLayout({
  name: 'fx_rotY', type: 'vec3',
  inputs: [{ name: 'p', type: 'vec3' }, { name: 'a', type: 'float' }],
});

/** Rotate a vec3 about X. */
export const rotX = Fn(([p, a]) => {
  const c = cos(a).toVar(), s = sin(a).toVar();
  return vec3(p.x, p.y.mul(c).sub(p.z.mul(s)), p.y.mul(s).add(p.z.mul(c)));
});
rotX.setLayout({
  name: 'fx_rotX', type: 'vec3',
  inputs: [{ name: 'p', type: 'vec3' }, { name: 'a', type: 'float' }],
});

/** Rotate a vec3 about Z. */
export const rotZ = Fn(([p, a]) => {
  const c = cos(a).toVar(), s = sin(a).toVar();
  return vec3(p.x.mul(c).sub(p.y.mul(s)), p.x.mul(s).add(p.y.mul(c)), p.z);
});
rotZ.setLayout({
  name: 'fx_rotZ', type: 'vec3',
  inputs: [{ name: 'p', type: 'vec3' }, { name: 'a', type: 'float' }],
});

/**
 * Squash a raw orbit-trap distance into a readable 0..1 band.
 * The `log` keeps the huge dynamic range of `dot(z,z)` legible.
 */
export const trapCurve = Fn(([v, k]) => {
  return oneMinus(exp(v.mul(k).negate()));
});
trapCurve.setLayout({
  name: 'fx_trapCurve', type: 'float',
  inputs: [{ name: 'v', type: 'float' }, { name: 'k', type: 'float' }],
});

export default { gmod, smin, sdBox, rotX, rotY, rotZ, trapCurve };
