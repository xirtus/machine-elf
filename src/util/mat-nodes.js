/**
 * mat-nodes.js — shared, cached TSL sub-graphs for the material library.
 *
 * OWNER: materials agent.  Consumed by src/render/Materials.js.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every material in the game wants fresnel, fbm noise, triplanar projection and
 * anti-aliased line masks. Rebuilding those graphs per material produces dozens
 * of near-identical WGSL programs and a visible compile hitch on the first frame
 * each one is drawn. TSL nodes are immutable graph descriptions, so a single node
 * instance can safely be referenced by any number of materials — every builder in
 * here memoises on its parameters and hands back the *same* node object.
 *
 * Everything is instancing-safe: nothing reads a per-object JS uniform, and
 * per-instance variation goes through `instanceSeed()` which is resolved in the
 * vertex stage (WGSL `instance_index` is not readable from a fragment shader).
 */

import {
  Fn, If, vec2, vec3, vec4, float, int, uniform, varying, attribute,
  positionLocal, positionWorld, positionView, normalLocal, normalView, normalWorld,
  positionViewDirection, cameraPosition, modelWorldMatrix,
  uv, time, instanceIndex, hash,
  sin, cos, abs, floor, fract, sign, min, max, clamp, saturate, mix, step, smoothstep,
  sqrt, pow, exp, log2, mod, length, dot, cross, normalize, oneMinus, negate, atan,
  fwidth, dFdx, dFdy, select, Discard, luminance, remapClamp,
  mx_noise_float, mx_fractal_noise_float, mx_fractal_noise_vec3, mx_worley_noise_float,
} from 'three/tsl';

/* ────────────────────────────────────────────────────────────────────────── */
/* memo helper                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

const _memo = new Map();
/** Memoise a node builder on a string key. Returns the identical node object. */
export function memo(key, build) {
  let n = _memo.get(key);
  if (n === undefined) { n = build(); _memo.set(key, n); }
  return n;
}
export function clearNodeCache() { _memo.clear(); }
export function nodeCacheSize() { return _memo.size; }

const K = (...a) => a.join('|');

/* ────────────────────────────────────────────────────────────────────────── */
/* view geometry — fresnel / facing                                           */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * 1 when the surface faces the camera dead-on, 0 at a perfect grazing angle.
 * Uses `normalView` (always valid inside colorNode; `transformedNormalView` is
 * not yet assigned when colorNode is built).
 */
export const facing = /*@__PURE__*/ memo('facing', () =>
  normalView.dot(positionViewDirection).abs().saturate()
);

/** 0 head-on → 1 at grazing. The raw fresnel ramp. */
export const grazing = /*@__PURE__*/ memo('grazing', () => facing.oneMinus());

/** Schlick-ish fresnel with an exponent. Cached per exponent. */
export function fresnel(power = 3.0, bias = 0.0, scale = 1.0) {
  return memo(K('fres', power, bias, scale), () =>
    grazing.pow(float(power)).mul(scale).add(bias).saturate()
  );
}

/** Signed depth of the fragment in view space, 0 near → 1 at `far`. */
export function viewDepth01(far = 300) {
  return memo(K('vd', far), () => positionView.z.negate().div(float(far)).saturate());
}

/* ────────────────────────────────────────────────────────────────────────── */
/* position spaces for surface detail                                         */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The position a procedural pattern should be evaluated in.
 *  - 'local'  : object space. Detail sticks to the mesh, correct for
 *               InstancedMesh (every instance gets the identical pattern —
 *               add `instanceSeed()` to break it up).
 *  - 'world'  : world space. Detail stays fixed in space and the object swims
 *               through it. Right for terrain, wrong for moving enemies.
 */
export function detailPos(space = 'local', scale = 1) {
  return memo(K('dp', space, scale), () =>
    (space === 'world' ? positionWorld : positionLocal).mul(float(scale))
  );
}

/**
 * A stable pseudo-random 0..1 per InstancedMesh instance, resolved in the vertex
 * stage and interpolated (all vertices of an instance share the value, so the
 * interpolation is a no-op). Returns hash(0) for non-instanced draws.
 */
export const instanceSeed = () => memo('iseed', () =>
  varying(hash(instanceIndex), 'vMatSeed')
);

/** Per-instance float supplied by the caller as an InstancedBufferAttribute. */
export function instanceAttr(name, type = 'float') {
  return memo(K('iattr', name, type), () => attribute(name, type));
}

/* ────────────────────────────────────────────────────────────────────────── */
/* noise                                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

/** Fractal perlin, remapped to 0..1. */
export function fbm(p, octaves = 4, lac = 2.0, gain = 0.5) {
  return mx_fractal_noise_float(p, int(octaves), float(lac), float(gain)).mul(0.5).add(0.5);
}

/** Fractal perlin, signed -1..1. */
export function fbmS(p, octaves = 4, lac = 2.0, gain = 0.5) {
  return mx_fractal_noise_float(p, int(octaves), float(lac), float(gain));
}

/** Ridged fractal — good for metal wear and fractal rock. 0..1, sharp creases. */
export const ridged = /*@__PURE__*/ Fn(([p, oct]) => {
  const v = mx_fractal_noise_float(p, int(4), float(2.07), float(0.5));
  void oct;
  return v.abs().oneMinus().pow(float(2.2));
});

/** Cellular pitting/patina mask, 0..1 (1 = deep in a cell). */
export function cells(p, jitter = 1.0) {
  return mx_worley_noise_float(p, float(jitter)).saturate();
}

/* ────────────────────────────────────────────────────────────────────────── */
/* triplanar                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

/** Normalised triplanar blend weights from the object-space normal. */
export function triBlend(sharpness = 5.0, space = 'local') {
  return memo(K('tb', sharpness, space), () => {
    const n = (space === 'world' ? normalWorld : normalLocal).abs().pow(float(sharpness));
    return n.div(n.x.add(n.y).add(n.z).max(float(1e-4)));
  });
}

/**
 * Project a 2D pattern function onto a surface from three axes.
 * @param {(uv2:Node)=>Node} fn2 — takes a vec2, returns a float (or vec3).
 */
export function triplanar(fn2, p, blend) {
  return fn2(p.zy).mul(blend.x)
    .add(fn2(p.xz).mul(blend.y))
    .add(fn2(p.xy).mul(blend.z));
}

/** Triplanar fbm — a genuinely 3D field, so it needs no blend; kept for symmetry. */
export function triFbm(p, octaves = 4) { return fbm(p, octaves); }

/* ────────────────────────────────────────────────────────────────────────── */
/* anti-aliased line work                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Screen-space-correct band mask. `x` is any scalar field; returns 1 where
 * |x| < halfWidth with a ~1px feather either side. This is the difference
 * between "etched glowing line" and "crawling aliased mess".
 */
export const aaBand = /*@__PURE__*/ Fn(([x, halfWidth]) => {
  const w = fwidth(x).max(float(1e-5));
  return smoothstep(halfWidth.add(w), halfWidth.sub(w), x.abs()).saturate();
});

/**
 * Anti-aliased grid line mask from a 2D coordinate.
 * `thicknessPx` is measured in pixels, so lines hold their weight at any
 * distance instead of dissolving — that's what makes procedural line work read
 * as authored rather than as moiré.
 */
export const aaGrid = /*@__PURE__*/ Fn(([q, thicknessPx]) => {
  const d = fract(q.sub(vec2(0.5))).sub(vec2(0.5)).abs();
  const px = fwidth(q).max(vec2(1e-5));
  const du = d.div(px);
  const m = min(du.x, du.y);
  return oneMinus(smoothstep(thicknessPx.sub(float(0.6)), thicknessPx.add(float(0.6)), m)).saturate();
});

/** Anti-aliased concentric rings around the origin of a 2D coordinate. */
export const aaRings = /*@__PURE__*/ Fn(([q, freq, thicknessPx]) => {
  const r = q.length().mul(freq);
  const d = fract(r.sub(float(0.5))).sub(float(0.5)).abs();
  const px = fwidth(r).max(float(1e-5));
  return oneMinus(smoothstep(thicknessPx.sub(float(0.6)), thicknessPx.add(float(0.6)), d.div(px))).saturate();
});

/** Anti-aliased radial spokes. */
export const aaSpokes = /*@__PURE__*/ Fn(([q, count, thicknessPx]) => {
  const a = atan(q.y, q.x).mul(count.mul(float(0.1591549))); // /(2pi)
  const d = fract(a.sub(float(0.5))).sub(float(0.5)).abs();
  const px = fwidth(a).max(float(1e-5));
  const fade = smoothstep(float(0.02), float(0.25), q.length());
  return oneMinus(smoothstep(thicknessPx.sub(float(0.6)), thicknessPx.add(float(0.6)), d.div(px))).mul(fade).saturate();
});

/* ────────────────────────────────────────────────────────────────────────── */
/* motion shaping — clockwork never moves linearly                            */
/* ────────────────────────────────────────────────────────────────────────── */

/** Non-linear pulse: slow swell, fast decay. 0..1. */
export function breathe(rate = 0.35, phase = 0) {
  return memo(K('br', rate, phase), () => {
    const t = time.mul(float(rate)).add(float(phase)).fract();
    return t.pow(float(0.55)).mul(t.oneMinus().pow(float(1.8))).mul(float(2.6)).saturate();
  });
}

/** Quantised (stop-motion) time. `steps` ticks per second. */
export function staccato(steps = 8) {
  return memo(K('st', steps), () => time.mul(float(steps)).floor().div(float(steps)));
}

/** A travelling wavefront along a scalar axis — energy running down a line. */
export const travel = /*@__PURE__*/ Fn(([axis, speed, width, sharp]) => {
  const t = axis.sub(time.mul(speed)).fract();
  return smoothstep(width, float(0.0), t).pow(sharp);
});

/* ────────────────────────────────────────────────────────────────────────── */
/* emissive discipline                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * PostFX reads the emissive MRT and runs a two-tier bloom off it. Values above
 * ~4 turn the two-tier bloom into a white wash — the "bloom soup" the brief
 * bans. Every material funnels its emissive through here.
 */
export function clampEmissive(v, ceiling = 4.0) {
  return v.max(vec3(0.0)).min(vec3(float(ceiling)));
}

/* ────────────────────────────────────────────────────────────────────────── */
/* dissolve field                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Build the scalar field a dissolve erodes through.
 * @returns {Node<float>} 0..~1.2
 */
export function dissolveField({ space = 'local', scale = 1.6, axis = 'y', axisScale = 0.35, extent = 2.0 }) {
  const p = detailPos(space, scale);
  const n = fbm(p, 3).mul(0.72);
  let grad;
  if (axis === 'y') grad = positionLocal.y.div(float(extent)).mul(0.5).add(0.5);
  else if (axis === 'radial') grad = positionLocal.length().div(float(extent)).saturate();
  else if (axis === 'inward') grad = positionLocal.length().div(float(extent)).saturate().oneMinus();
  else grad = float(0.5);
  return n.add(grad.mul(float(axisScale))).div(float(0.72 + axisScale));
}

/* ────────────────────────────────────────────────────────────────────────── */
/* misc                                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

/** Soft-min blend of two scalars (metaball-ish), for pattern union. */
export const smin = /*@__PURE__*/ Fn(([a, b, k]) => {
  const h = clamp(b.sub(a).div(k).mul(0.5).add(0.5), float(0), float(1));
  return mix(b, a, h).sub(k.mul(h).mul(h.oneMinus()));
});

/** Cheap hue rotation in YIQ, for depth-based hue shift. */
export const hueShift = /*@__PURE__*/ Fn(([col, ang]) => {
  const cs = cos(ang), sn = sin(ang);
  const y = dot(col, vec3(0.299, 0.587, 0.114));
  const i = dot(col, vec3(0.596, -0.274, -0.322));
  const q = dot(col, vec3(0.211, -0.523, 0.312));
  const i2 = i.mul(cs).sub(q.mul(sn));
  const q2 = i.mul(sn).add(q.mul(cs));
  return vec3(
    y.add(i2.mul(0.956)).add(q2.mul(0.621)),
    y.sub(i2.mul(0.272)).sub(q2.mul(0.647)),
    y.sub(i2.mul(1.106)).add(q2.mul(1.703))
  ).max(vec3(0.0));
});

export default {
  memo, clearNodeCache, nodeCacheSize,
  facing, grazing, fresnel, viewDepth01,
  detailPos, instanceSeed, instanceAttr,
  fbm, fbmS, ridged, cells,
  triBlend, triplanar, triFbm,
  aaBand, aaGrid, aaRings, aaSpokes,
  breathe, staccato, travel,
  clampEmissive, dissolveField, smin, hueShift,
};
