import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  Fn, attribute, vec3, vec4, float, uniform, color,
  positionLocal, positionWorld, normalWorld, cameraPosition,
  sin, cos, abs, fract, floor, pow, max, min, clamp, saturate, mix, step,
  smoothstep, dot, normalize, oneMinus, length, mod, time, reflect,
  mx_noise_float, mx_cell_noise_float,
} from 'three/tsl';

/**
 * Materials for the elves.
 *
 * The materials agent owns `render/Materials.js`; this file is the defensive
 * fallback + the adoption shim. Two rules make adoption possible:
 *
 *   - every elf geometry carries per-instance `aTint` (vec3) and
 *     `aState` (vec4: flash, telegraph, dissolve, seed)
 *   - a shared library material is only adopted if it is exposed as a
 *     *factory* that accepts `{ tintAttr, stateAttr }`, so it can wire those
 *     channels. Anything else and we keep our own — a silently-ignored hit
 *     flash is worse than a slightly different glass.
 *
 * The fallbacks are lighting-independent on purpose: at boot there may be no
 * lights in the scene at all, and the elves must still read. All shading is
 * baked into `emissiveNode` (which is also what PostFX's MRT bloom samples),
 * with `colorNode` kept dark so that when real lights land the bodies stay
 * silhouette-black rather than lighting up like plastic.
 */

const KEY = normalize(vec3(0.36, 0.86, 0.36));   // fake key, high and left
const FILL = normalize(vec3(-0.7, -0.15, 0.55)); // cold bounce from below

function common() {
  const st = attribute('aState', 'vec4');
  const tint = attribute('aTint', 'vec3');
  const N = normalWorld;
  const V = normalize(cameraPosition.sub(positionWorld));
  const ndv = saturate(dot(N, V));
  const fres = pow(oneMinus(ndv), 2.7);
  return { st, tint, N, V, ndv, fres };
}

/** Dissolve mask shared by every body material — drives the shatter death. */
function dissolveBits(st) {
  const nz = mx_noise_float(positionLocal.mul(6.5).add(vec3(st.w.mul(17.3)))).mul(0.5).add(0.5);
  const cell = mx_cell_noise_float(positionLocal.mul(4.1).add(vec3(st.w.mul(5.1))));
  const field = mix(nz, cell.mul(0.5).add(0.5), 0.55);
  const opacity = step(st.z, field);
  const edge = oneMinus(smoothstep(st.z, st.z.add(0.17), field)).mul(step(0.001, st.z));
  return { opacity, edge };
}

/**
 * Neon glass. Thin, cold, lit from inside. The interior "escapement" banding
 * is a cheap stand-in for the brass you can see through the body — it moves
 * in *quantised* steps with the instance seed so no two elves shimmer alike.
 */
export function makeNeonGlass(opts = {}) {
  const m = new MeshStandardNodeMaterial();
  m.name = 'elf.neonGlass';
  m.roughness = 0.12;
  m.metalness = 0.0;
  m.side = THREE.DoubleSide;

  const { st, tint, N, V, fres } = common();
  const { opacity, edge } = dissolveBits(st);

  m.colorNode = tint.mul(0.06);
  m.opacityNode = opacity;
  m.alphaTest = 0.5;

  m.emissiveNode = Fn(() => {
    // interior furnace: the whole body is lit from inside — this is neon
    // glass, and it must read at 300 metres against a black void
    const r = length(positionLocal);
    const core = oneMinus(smoothstep(float(0.05), float(1.0), r));
    // stacked lamellae — the escapement bands, stepped not smooth
    const band = floor(positionLocal.y.mul(9.0).add(st.w.mul(6.0))).mul(0.5);
    const lam = fract(band.mul(0.61803)).mul(0.55).add(0.65);
    const interior = tint.mul(core.mul(lam).mul(1.7));

    // neon rim: the contour light that separates the silhouette from the dark
    const rim = pow(fres, float(1.8)).mul(2.6).add(pow(fres, float(7.0)).mul(2.2));

    // facet separation even with zero scene lights
    const key = saturate(dot(N, KEY)).mul(0.30);
    const fill = saturate(dot(N, FILL)).mul(0.16);

    const base = interior.add(tint.mul(rim)).add(tint.mul(key)).add(tint.mul(fill)).add(tint.mul(0.16));

    // hit flash — white-hot, decays in JS
    const flash = vec3(1.0, 0.94, 0.99).mul(pow(st.x, float(1.6)).mul(3.2));
    // telegraph — the wind-up glow the player reads before an attack
    const tel = tint.mul(0.6).add(vec3(0.9, 0.25, 0.05)).mul(
      st.y.mul(saturate(sin(time.mul(26.0).add(st.w.mul(9.0))).mul(0.5).add(0.7))).mul(1.5)
    );
    // dissolve edge burns hot
    const burn = vec3(1.0, 0.62, 0.22).mul(edge.mul(3.4));

    return base.add(flash).add(tel).add(burn);
  })();

  return m;
}

/**
 * Clockwork brass. Metal, not neon: almost no ambient emissive, just a hard
 * anisotropic streak so it glints when a facet lines up. This is what keeps
 * the elves from being a uniform glow blob.
 */
export function makeClockworkBrass(opts = {}) {
  const m = new MeshStandardNodeMaterial();
  m.name = 'elf.clockworkBrass';
  m.roughness = 0.28;
  m.metalness = 1.0;

  const { st, tint, N, V, fres } = common();
  const { opacity, edge } = dissolveBits(st);

  m.colorNode = color(0xb98a3c);
  m.opacityNode = opacity;
  m.alphaTest = 0.5;

  m.emissiveNode = Fn(() => {
    const R = reflect(V.negate(), N);
    // stretched highlight: sharp across the grain, broad along it
    const spec = pow(saturate(dot(R, KEY)), float(34.0)).mul(1.35);
    const spec2 = pow(saturate(dot(R, FILL)), float(9.0)).mul(0.28);
    const gold = vec3(1.0, 0.72, 0.30);
    const cold = vec3(0.35, 0.55, 0.75);
    const rim = fres.mul(0.20);
    const flash = vec3(1.0).mul(pow(st.x, float(1.6)).mul(2.2));
    const tel = gold.mul(st.y.mul(0.8));
    const burn = vec3(1.0, 0.55, 0.18).mul(edge.mul(2.6));
    return gold.mul(spec).add(cold.mul(spec2)).add(tint.mul(rim)).add(flash).add(tel).add(burn);
  })();

  return m;
}

/**
 * Void matte. Near-black shell that carves the silhouette. Contributes almost
 * nothing to bloom — it exists to be a hole in the frame.
 */
export function makeVoidMatte(opts = {}) {
  const m = new MeshStandardNodeMaterial();
  m.name = 'elf.voidMatte';
  m.roughness = 0.85;
  m.metalness = 0.1;

  const { st, tint, N, fres } = common();
  const { opacity, edge } = dissolveBits(st);

  m.colorNode = vec3(0.012, 0.014, 0.02);
  m.opacityNode = opacity;
  m.alphaTest = 0.5;

  m.emissiveNode = Fn(() => {
    const rim = pow(fres, float(3.4)).mul(0.30);
    const key = saturate(dot(N, KEY)).mul(0.045);
    const flash = vec3(1.0).mul(pow(st.x, float(2.0)).mul(1.6));
    const tel = tint.mul(st.y.mul(0.35));
    const burn = vec3(1.0, 0.45, 0.14).mul(edge.mul(2.0));
    return tint.mul(rim).add(vec3(key)).add(flash).add(tel).add(burn);
  })();

  return m;
}

/**
 * Hostile energy — enemy ordnance. Ikaruga rules: one reserved hue, a core so
 * saturated it clips, and a hard dark boundary (supplied by the companion
 * outline material on an inverted hull) so it can never be lost in the
 * fractal. Scenery must never use this hue.
 */
export function makeHostileEnergy(opts = {}) {
  const m = new MeshStandardNodeMaterial();
  m.name = 'elf.hostileEnergy';
  m.roughness = 0.4;
  m.metalness = 0.0;

  const st = attribute('aState', 'vec4');
  const tint = attribute('aTint', 'vec3');
  const N = normalWorld;
  const V = normalize(cameraPosition.sub(positionWorld));
  const fres = pow(oneMinus(saturate(dot(N, V))), 2.0);

  m.colorNode = vec3(0.0);

  m.emissiveNode = Fn(() => {
    // READABILITY SPEC: a near-black core, a searing hostile rim, and a
    // white-hot pinpoint at the very centre. The dark body punches a hole
    // in whatever is behind it; the rim screams "that will kill you";
    // the pinpoint keeps it legible at 300 metres. Nothing else in the
    // game is allowed to look like this.
    const r = length(positionLocal.xz).mul(2.0);
    const pinpoint = oneMinus(smoothstep(float(0.02), float(0.16), r)).mul(3.2);
    const rimHot = pow(fres, float(1.3)).mul(2.8).add(pow(fres, float(5.0)).mul(2.0));
    const pulse = sin(time.mul(14.0).add(st.w.mul(21.0))).mul(0.22).add(1.0);
    const born = st.y;   // 0..1 spawn bloom, makes new bullets announce themselves
    return tint.mul(rimHot.mul(pulse))
      .add(vec3(1.0, 0.96, 0.98).mul(pinpoint))
      .mul(born.mul(1.6).add(0.55));
  })();

  return m;
}

/** The dark boundary for bullets/thorns — inverted hull, zero emissive. */
export function makeOutline(opts = {}) {
  const m = new MeshStandardNodeMaterial();
  m.name = 'elf.outline';
  m.roughness = 1.0;
  m.metalness = 0.0;
  m.side = THREE.BackSide;
  m.colorNode = vec3(0.0);
  m.emissiveNode = vec3(0.0);
  return m;
}

// ─────────────────────────────────────────────────────────────────────────

const FACTORIES = {
  neonGlass: makeNeonGlass,
  clockworkBrass: makeClockworkBrass,
  voidMatte: makeVoidMatte,
  hostileEnergy: makeHostileEnergy,
  outline: makeOutline,
};

/**
 * Build the elf material set, preferring the shared library when it exposes
 * factories that understand our instance channels.
 *
 * @param {object} ctx engine ctx
 * @returns {{neonGlass, clockworkBrass, voidMatte, hostileEnergy, outline, adopted:string[]}}
 */
export function resolveMaterials(ctx) {
  const lib = ctx?.engine?.get?.('materials');
  const req = { tintAttr: 'aTint', stateAttr: 'aState', instanced: true };
  const out = { adopted: [] };
  for (const key of Object.keys(FACTORIES)) {
    let mat = null;
    try {
      const fn = lib && (typeof lib[key] === 'function' ? lib[key].bind(lib) : null);
      if (fn) {
        const candidate = fn(req);
        // only adopt if it actually is a node material we can hand instances to
        if (candidate && candidate.isMaterial) { mat = candidate; out.adopted.push(key); }
      }
    } catch (e) {
      console.warn(`[enemies] materials.${key}() failed, using fallback`, e);
      mat = null;
    }
    out[key] = mat || FACTORIES[key]();
  }
  return out;
}

export default resolveMaterials;
