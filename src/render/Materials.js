/**
 * Materials.js — the authored material library for MACHINE ELF.
 *
 * OWNER: materials agent.  Everyone else's elves, bosses, craft and terrain are
 * built out of these. Import the factories, don't roll your own NodeMaterial:
 *
 *   import { neonGlass, clockworkBrass, dissolve } from '../render/Materials.js';
 *   const body = neonGlass({ tint: 'key', core: 'accent' });
 *   const mesh = new THREE.InstancedMesh(geo, body, 64);
 *
 * ── Contracts every material in here honours ────────────────────────────────
 *
 *  1. PALETTE-DRIVEN.  Colours are named *slots* ('key' | 'accent' | 'rim' |
 *     'hostile' | 'fog' | 'void' | 'glow' | 'ink'), resolved to live TSL
 *     uniforms. A dimension shift retints every material in the world by
 *     writing `.value` — no shader recompiles, no frame hitch.
 *
 *  2. EMISSIVE IS DELIBERATE.  PostFX reads the emissive MRT for its two-tier
 *     bloom. A bright `colorNode` does NOT bloom. Every material writes a
 *     considered `emissiveNode` clamped to 0–4 (`voidMatte` writes a whisper on
 *     purpose). Overshoot that ceiling and you get the bloom soup the brief bans.
 *
 *  3. INSTANCING-SAFE.  Nothing reads a per-object JS uniform. Per-instance
 *     variation comes from `instanced: true` (a hashed instance seed resolved in
 *     the vertex stage) or from an InstancedBufferAttribute you name yourself.
 *
 *  4. CACHED.  Identical options return the identical material instance, so the
 *     40 call sites across the game compile ~a dozen programs, not 40. If you
 *     intend to mutate a material after creation, pass `{ cache: false }`.
 *
 * ── The cost table (measure before you scale) ───────────────────────────────
 *     neonGlass       heavy   — transmission forces an opaque-framebuffer copy +
 *                               mip chain. Hero material. Budget < ~40 on screen.
 *     fractalShell    medium  — 3 octaves x 3 triplanar taps.
 *     clockworkBrass  medium  — anisotropic BRDF + 2 noise fields.
 *     sacredGeometry  light   — no lighting model, pure line work.
 *     voidMatte       light
 *     hostileEnergy   trivial — deliberately so; hundreds on screen.
 */

import * as THREE from 'three';
import {
  MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, MeshBasicNodeMaterial,
  SpriteNodeMaterial,
} from 'three/webgpu';
import {
  Fn, vec2, vec3, vec4, float, int, color, uniform, mix, min, max, clamp, saturate,
  smoothstep, step, pow, abs, sin, cos, fract, floor, sqrt, length, dot, normalize,
  oneMinus, negate, exp, atan, time, uv, positionLocal, positionWorld, positionView,
  normalLocal, normalView, normalWorld, cameraPosition, luminance, Discard, select,
  attribute, varying, fwidth,
} from 'three/tsl';

import Palette from './Palette.js';
import {
  facing, grazing, fresnel, viewDepth01, detailPos, instanceSeed,
  fbm, fbmS, cells, triBlend, triplanar, aaGrid, aaRings, aaSpokes, aaBand,
  breathe, travel, clampEmissive, dissolveField, hueShift,
} from '../util/mat-nodes.js';

/** Flip to true to build the material showcase grid instead of playing. */
const SHOWCASE = false;

/* ══════════════════════════════════════════════════════════════════════════ */
/* colour resolution                                                          */
/* ══════════════════════════════════════════════════════════════════════════ */

const _slots = ['key', 'accent', 'rim', 'hostile', 'fog', 'void', 'glow', 'ink'];

/**
 * Resolve a colour spec to a TSL vec3 node.
 *   'key'                  → the live palette uniform (retints on dimension shift)
 *   ['key','accent',0.35]  → a live perceptual-ish blend of two slots
 *   0x00ffd5 | THREE.Color → a frozen constant (escape hatch; does NOT retint)
 *   <any TSL node>         → passed straight through
 */
export function slotColor(spec, fallback = 'key') {
  if (spec == null) return Palette.u[fallback];
  if (typeof spec === 'string') return Palette.u[spec] ?? Palette.u[fallback];
  if (Array.isArray(spec)) {
    return mix(slotColor(spec[0], fallback), slotColor(spec[1], fallback), float(spec[2] ?? 0.5));
  }
  if (spec.isNode === true) return spec;
  const c = spec.isColor ? spec.clone() : new THREE.Color().setHex(spec, THREE.SRGBColorSpace);
  return color(c);
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* cache                                                                      */
/* ══════════════════════════════════════════════════════════════════════════ */

const _cache = new Map();
let _built = 0;

function stableKey(name, o) {
  const keys = Object.keys(o).sort();
  let s = name;
  for (const k of keys) {
    const v = o[k];
    if (v === undefined) continue;
    s += `|${k}=${v && v.isColor ? v.getHexString() : v && v.isNode ? 'node' + (v.uuid || '') : v}`;
  }
  return s;
}

function cached(name, o, build) {
  if (o.cache === false) { _built++; return tag(build(), name); }
  const k = stableKey(name, o);
  let m = _cache.get(k);
  if (!m) { m = tag(build(), name); _built++; _cache.set(k, m); }
  return m;
}

function tag(m, name) {
  m.name = m.name || name;
  m.userData.matKind = name;
  return m;
}

/** Diagnostics: how many distinct programs this library has asked for. */
export function materialStats() {
  const kinds = {};
  for (const m of _cache.values()) kinds[m.userData.matKind] = (kinds[m.userData.matKind] || 0) + 1;
  return { cached: _cache.size, built: _built, kinds };
}

export function clearMaterialCache() {
  for (const m of _cache.values()) m.dispose?.();
  _cache.clear();
}

const G = () => Palette.u.gain;

/* ══════════════════════════════════════════════════════════════════════════ */
/* 1. neonGlass — the hero material                                           */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * Jewelled automaton bodies. Real transmission + dispersion + iridescence, with
 * an interior emissive core that swells through the body and is brightest at
 * grazing angles — so the read is "lit from inside", not "shiny surface".
 *
 * The three things doing the heavy lifting, in order of importance:
 *   · attenuationColor over a short attenuationDistance — light that crosses the
 *     volume picks up the tint, so thick parts go deep and thin parts go pale.
 *     This is what separates glass from a transparent plastic shell.
 *   · dispersion — the refracted background splits into RGB. Needs contrasty
 *     stuff *behind* the glass to be visible at all; against flat black it does
 *     nothing, which is why the showcase puts a lattice behind everything.
 *   · a grazing-weighted emissive core, not a uniform glow. Uniform emissive on
 *     glass reads as a lightbulb; path-length-weighted emissive reads as volume.
 *
 * @param {object} opts
 * @param {string|number} [opts.tint='key']       body/volume hue (palette slot)
 * @param {string|number} [opts.core='accent']    interior core hue
 * @param {string|number} [opts.rimColor='rim']   fresnel rim hue
 * @param {number} [opts.ior=1.5]
 * @param {number} [opts.thickness=0.85]          volume depth in metres
 * @param {number} [opts.dispersion=4.5]          0 = none, ~10 = prismatic
 * @param {number} [opts.iridescence=0.55]
 * @param {number} [opts.transmission=1]          drop to ~0.6 for milkier glass
 * @param {number} [opts.roughness=0.055]
 * @param {number} [opts.coreGain=1.15]           interior glow strength
 * @param {number} [opts.rimGain=0.95]
 * @param {number} [opts.detail=1.8]              interior structure frequency
 * @param {number} [opts.attenuation=0.85]        metres to full tint
 * @param {boolean}[opts.instanced=false]         per-instance core phase/hue jitter
 * @param {boolean}[opts.doubleSided=false]
 */
export function neonGlass(opts = {}) {
  const o = {
    tint: 'key', core: 'accent', rimColor: 'rim',
    ior: 1.5, thickness: 0.85, dispersion: 4.5, iridescence: 0.55,
    transmission: 1.0, roughness: 0.055,
    coreGain: 1.15, rimGain: 0.95, detail: 1.8, attenuation: 0.85,
    instanced: false, doubleSided: false, cache: true, ...opts,
  };

  return cached('neonGlass', o, () => {
    const m = new MeshPhysicalNodeMaterial();
    m.transparent = true;
    m.side = o.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
    m.metalness = 0.0;
    m.envMapIntensity = 1.25;

    const tintC = slotColor(o.tint, 'key');
    const coreC = slotColor(o.core, 'accent');
    const rimC = slotColor(o.rimColor, 'rim');
    const glowC = Palette.u.glow;

    const seed = o.instanced ? instanceSeed() : float(0.37);
    const p = detailPos('local', o.detail);

    /* interior structure — an escapement-ish banded field drifting slowly
       upward through the body, NOT a uniform glow. */
    const drift = vec3(0.0, time.mul(0.11).add(seed.mul(6.0)), time.mul(0.04));
    const inner = fbm(p.add(drift), 3);
    const filament = smoothstep(float(0.50), float(0.80), inner);
    const pulse = breathe(0.21);

    /* fresnel terms */
    const path = grazing.pow(float(1.7));      // approximate optical path length
    const edge = grazing.pow(float(5.5));      // thin bright contour
    const hot = grazing.pow(float(14.0));      // the last pixel of the silhouette

    /* ── colour / volume ────────────────────────────────────────────────── */
    // Under transmission, diffuseColor is the transmittance tint. Keep it light
    // or the body goes to soot; the saturation lives in attenuationColor.
    m.colorNode = mix(tintC, vec3(1.0), float(0.42));

    m.transmissionNode = float(o.transmission);
    m.iorNode = float(o.ior);
    m.attenuationColorNode = tintC.mul(0.9);
    m.attenuationDistanceNode = float(o.attenuation);

    // Varying thickness is what makes dispersion vary across the surface — a
    // constant thickness reads as a uniform colour fringe, i.e. as a filter.
    m.thicknessNode = float(o.thickness).mul(inner.mul(0.85).add(0.55));
    m.dispersionNode = float(o.dispersion);

    m.iridescenceNode = float(o.iridescence).mul(grazing.mul(0.75).add(0.35));
    m.iridescenceIORNode = float(1.32);
    // oil-film thickness in nm, drifting — the surface never sits still
    m.iridescenceThicknessNode = mix(
      float(180.0), float(680.0),
      fbm(p.mul(0.55).add(vec3(0.0, 0.0, time.mul(0.05))), 2)
    );

    // never a perfect mirror: micro-variation breaks the CG-chrome tell
    m.roughnessNode = float(o.roughness).add(cells(p.mul(2.3), 1.0).mul(0.055));

    /* ── the interior light ─────────────────────────────────────────────── */
    m.emissiveNode = Fn(() => {
      const bodyGlow = coreC.mul(
        path.mul(float(o.coreGain)).mul(pulse.mul(0.55).add(0.62))
      );
      const veins = coreC.mul(filament.mul(path).mul(0.75));
      const rimLight = rimC.mul(edge.mul(float(o.rimGain)));
      const contour = glowC.mul(hot.mul(0.42));
      return clampEmissive(
        bodyGlow.add(veins).add(rimLight).add(contour).mul(G()), 3.4
      );
    })();

    return m;
  });
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* 2. clockworkBrass                                                          */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * Aged metal for the escapements visible inside the elves. Anisotropic
 * highlights along machined turning marks, procedural patina/wear from a
 * triplanar noise stack that breaks up the specular, and a faint emissive
 * bleed in the recesses so it never reads as a dead chrome ball.
 *
 * @param {object} opts
 * @param {string|number} [opts.tint='accent']    the metal hue
 * @param {string|number} [opts.patinaColor='rim']oxidised hue in the recesses
 * @param {string|number} [opts.glowColor='key']  recess emissive
 * @param {number} [opts.roughness=0.32]          base polish
 * @param {number} [opts.wear=0.62]               0 = factory-new, 1 = ruined
 * @param {number} [opts.anisotropy=0.72]
 * @param {number} [opts.scale=2.6]               detail frequency
 * @param {number} [opts.glow=0.28]               recess emissive strength
 */
export function clockworkBrass(opts = {}) {
  const o = {
    tint: 'accent', patinaColor: 'rim', glowColor: 'key',
    roughness: 0.32, wear: 0.62, anisotropy: 0.72, scale: 2.6, glow: 0.28,
    instanced: false, cache: true, ...opts,
  };

  return cached('clockworkBrass', o, () => {
    const m = new MeshPhysicalNodeMaterial();
    m.metalness = 1.0;
    m.envMapIntensity = 1.0;

    const metalC = slotColor(o.tint, 'accent');
    const patinaC = slotColor(o.patinaColor, 'rim');
    const glowC = slotColor(o.glowColor, 'key');

    const seed = o.instanced ? instanceSeed() : float(0.11);
    const p = detailPos('local', o.scale).add(seed.mul(11.0));
    const b = triBlend(4.0);

    /* wear stack: broad tarnish, fine machining grain, cellular pitting */
    const tarnish = fbm(p.mul(0.45), 3);
    const grain = triplanar((q) => fbm(vec3(q.x.mul(24.0), q.y.mul(1.6), 0.0), 2), p, b);
    const pits = cells(p.mul(3.4), 1.0).pow(float(2.0));
    const wear = clamp(
      tarnish.mul(0.62).add(pits.mul(0.30)).add(grain.mul(0.16)).mul(float(o.wear * 1.55)),
      float(0.0), float(1.0)
    );

    /* Recesses: where the pitting is deepest. Metal loses its metalness there
       (oxide is a dielectric) — that single detail is most of "aged". */
    const recess = smoothstep(float(0.55), float(0.95), pits.add(tarnish.mul(0.25)));

    const base = mix(metalC, patinaC, wear.mul(0.55));
    // pull a little chroma out of the worn areas rather than just darkening
    const desat = mix(base, vec3(luminance(base)), wear.mul(0.35));
    m.colorNode = desat.mul(wear.mul(-0.38).add(1.0));

    m.metalnessNode = float(1.0).sub(recess.mul(0.55)).sub(wear.mul(0.12));
    m.roughnessNode = clamp(
      float(o.roughness).add(wear.mul(0.42)).add(grain.mul(0.10)).sub(float(0.06)),
      float(0.045), float(0.95)
    );

    /* Anisotropy: mostly aligned turning marks with a noise wobble, weakened
       where the surface is corroded. vec2 = direction * strength. */
    const th = fbmS(p.mul(1.15), 2).mul(0.55);
    m.anisotropyNode = vec2(cos(th), sin(th)).mul(
      float(o.anisotropy).mul(wear.mul(-0.55).add(1.0))
    );

    m.clearcoatNode = recess.oneMinus().mul(0.18);
    m.clearcoatRoughnessNode = float(0.25).add(wear.mul(0.4));

    m.emissiveNode = Fn(() => {
      // light trapped in the machined recesses + a faint edge catch
      const inRecess = recess.mul(float(o.glow)).mul(breathe(0.29).mul(0.5).add(0.75));
      const catchLight = grazing.pow(float(6.0)).mul(0.22);
      return clampEmissive(glowC.mul(inRecess).add(metalC.mul(catchLight)).mul(G()), 1.6);
    })();

    return m;
  });
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* 3. sacredGeometry                                                          */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * Emissive line-work for impossible machines: etched grids, concentric rings and
 * radial spokes projected triplanar onto whatever surface you give it, with
 * energy travelling along the lines.
 *
 * All masks are `fwidth`-derived and measured in PIXELS, so the lines hold a
 * constant screen weight at every distance instead of aliasing into moiré. Hard
 * `step()` line work is the single most obvious "procedural shader" tell.
 *
 * Uses no lighting model (basic + fresnel body), so it is cheap enough to put on
 * a lot of geometry.
 *
 * @param {object} opts
 * @param {string|number} [opts.lineColor='key']
 * @param {string|number} [opts.altColor='accent']  rings/spokes hue
 * @param {string|number} [opts.bodyColor='ink']    the unlit substrate
 * @param {number} [opts.scale=1.0]     world units per pattern cell
 * @param {number} [opts.freq=6.0]      grid cells per unit
 * @param {number} [opts.thickness=1.1] line half-width in PIXELS
 * @param {number} [opts.rings=0.7]     0..1 mix of concentric rings
 * @param {number} [opts.spokes=0.45]   0..1 mix of radial spokes
 * @param {number} [opts.spokeCount=12]
 * @param {number} [opts.pulseSpeed=0.35]
 * @param {number} [opts.intensity=1.8] peak emissive
 * @param {boolean}[opts.transparentBody=false] discard the substrate → pure wire
 */
export function sacredGeometry(opts = {}) {
  const o = {
    lineColor: 'key', altColor: 'accent', bodyColor: 'ink',
    scale: 1.0, freq: 6.0, thickness: 1.1,
    rings: 0.7, spokes: 0.45, spokeCount: 12,
    pulseSpeed: 0.35, intensity: 1.8,
    transparentBody: false, instanced: false, cache: true, ...opts,
  };

  return cached('sacredGeometry', o, () => {
    const m = new MeshBasicNodeMaterial();
    if (o.transparentBody) { m.transparent = true; m.depthWrite = false; }

    const lineC = slotColor(o.lineColor, 'key');
    const altC = slotColor(o.altColor, 'accent');
    const bodyC = slotColor(o.bodyColor, 'ink');
    const rimC = Palette.u.rim;

    const seed = o.instanced ? instanceSeed() : float(0.0);
    const p = detailPos('local', 1.0 / Math.max(1e-3, o.scale));
    const b = triBlend(5.0);
    const t = float(o.thickness);

    // Three separate single-value shader functions — one per mask family.
    // (A multi-output Fn returning a JS object breaks const-node resolution
    // in r185's compiler; single-value Fns are the supported path.)
    const patternGrid = Fn(() =>
      triplanar((q) => aaGrid(q.mul(float(o.freq)), t), p, b)
    );
    const patternRing = Fn(() =>
      aaRings(p.xz, float(o.freq * 0.5), t)
        .mul(b.y)
        .add(aaRings(p.xy, float(o.freq * 0.5), t).mul(b.z))
        .mul(float(o.rings))
        .saturate()
    );
    const patternSpoke = Fn(() =>
      aaSpokes(p.xz, float(o.spokeCount), t.mul(1.15))
        .mul(b.y).mul(float(o.spokes))
        .saturate()
    );

    m.colorNode = o.transparentBody ? vec3(0.0) : bodyC.mul(0.75);

    m.emissiveNode = Fn(() => {
      const gridM = patternGrid();
      const ringM = patternRing();
      const spokeM = patternSpoke();
      const lines = max(gridM, max(ringM, spokeM)).saturate();

      // energy running along the structure — two fronts at different speeds so
      // the motion never resolves into a loop
      const runA = travel(p.y.mul(0.16).add(seed), float(o.pulseSpeed), float(0.22), float(2.4));
      const runB = travel(p.x.mul(0.11).sub(seed), float(o.pulseSpeed * 0.61), float(0.34), float(1.6));
      const surge = runA.mul(2.1).add(runB.mul(1.1)).add(breathe(0.19).mul(0.35));

      const hue = mix(lineC, altC, max(ringM, spokeM).mul(0.85));
      const lineGlow = hue.mul(lines).mul(float(o.intensity).mul(surge.mul(0.55).add(0.55)));

      // the substrate still needs a form read, or it's a flat dark blob
      const rimLight = rimC.mul(grazing.pow(float(3.2)).mul(0.55));
      return clampEmissive(lineGlow.add(rimLight).mul(G()), 3.6);
    })();

    if (o.transparentBody) {
      m.opacityNode = Fn(() => {
        const gridM = patternGrid();
        const ringM = patternRing();
        const spokeM = patternSpoke();
        return max(gridM, max(ringM, spokeM)).saturate().mul(1.4).min(float(1.0));
      })();
    }

    return m;
  });
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* 4. fractalShell                                                            */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * Skin for Mandelbulb cathedrals / Mandelbox corridors — anything raymarched or
 * extruded out of an SDF. Deep triplanar detail at three scales (so it holds up
 * from 200 m and from 2 m), a depth-based hue shift that separates the layers
 * without needing a fog pass, and an iridescent sheen that only shows at grazing
 * angles so the silhouette edge lights up as you bank past it.
 *
 * @param {object} opts
 * @param {string|number} [opts.baseColor='void']
 * @param {string|number} [opts.midColor='rim']
 * @param {string|number} [opts.creviceColor='key'] emissive in the deep folds
 * @param {number} [opts.scale=0.35]      detail frequency (world units)
 * @param {number} [opts.roughness=0.55]
 * @param {number} [opts.metalness=0.25]
 * @param {number} [opts.hueShiftAmount=0.55] radians of hue drift over `far`
 * @param {number} [opts.far=420]         distance the hue shift completes over
 * @param {number} [opts.sheen=0.75]      iridescent grazing sheen
 * @param {number} [opts.glow=0.55]       crevice emissive
 * @param {string} [opts.space='world']   'world' keeps detail fixed in space
 */
export function fractalShell(opts = {}) {
  const o = {
    baseColor: 'void', midColor: 'rim', creviceColor: 'key',
    scale: 0.35, roughness: 0.55, metalness: 0.25,
    hueShiftAmount: 0.55, far: 420, sheen: 0.75, glow: 0.55,
    space: 'world', cache: true, ...opts,
  };

  return cached('fractalShell', o, () => {
    const m = new MeshPhysicalNodeMaterial();
    m.envMapIntensity = 0.85;

    const baseC = slotColor(o.baseColor, 'void');
    const midC = slotColor(o.midColor, 'rim');
    const crevC = slotColor(o.creviceColor, 'key');
    const fogC = Palette.u.fog;

    const p = detailPos(o.space, o.scale);
    const b = triBlend(3.5, o.space);

    // three octaves at decade-separated scales: silhouette-level, panel-level,
    // and pore-level. Self-similarity is the whole point of the world.
    const big = fbm(p.mul(0.5), 3);
    const mid = fbm(p.mul(2.7), 3);
    const fine = triplanar((q) => fbm(vec3(q.x, q.y, 0.0).mul(9.0), 2), p, b);

    const crevice = smoothstep(float(0.62), float(0.24), big.mul(0.55).add(mid.mul(0.45)));
    const strata = big.mul(0.6).add(mid.mul(0.3)).add(fine.mul(0.1));

    const depth = viewDepth01(o.far);

    m.colorNode = Fn(() => {
      const surf = mix(baseC, midC, strata.pow(float(1.4)));
      const shifted = hueShift(surf, depth.mul(float(o.hueShiftAmount)));
      // aerial perspective baked into the material so layers separate even
      // before the fog pass touches them
      return mix(shifted, fogC.mul(1.15), depth.pow(float(1.6)).mul(0.7));
    })();

    m.roughnessNode = clamp(
      float(o.roughness).add(fine.mul(0.35)).sub(mid.mul(0.18)),
      float(0.12), float(1.0)
    );
    m.metalnessNode = float(o.metalness).mul(strata.mul(0.6).add(0.4));

    m.iridescenceNode = float(o.sheen).mul(grazing.pow(float(2.4)));
    m.iridescenceIORNode = float(1.4);
    m.iridescenceThicknessNode = mix(float(220.0), float(560.0), mid);

    m.emissiveNode = Fn(() => {
      // light comes out of the folds, not off the faces
      const inFold = crevice.mul(float(o.glow)).mul(breathe(0.13).mul(0.45).add(0.7));
      const rimSheen = mix(midC, crevC, float(0.5)).mul(grazing.pow(float(4.5)).mul(0.45));
      const far = depth.oneMinus().pow(float(0.8));   // don't bloom the horizon
      return clampEmissive(crevC.mul(inFold).mul(far).add(rimSheen).mul(G()), 2.2);
    })();

    return m;
  });
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* 5. hostileEnergy                                                           */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * Enemy bullets and beams. READABILITY BEATS BEAUTY — this is the material the
 * player's survival depends on, so it is built to a spec, not to taste:
 *
 *   · a near-white hot core (so it reads at 3 px against any background)
 *   · a saturated `hostile` mantle (the hue no scenery is ever allowed to use)
 *   · a hard DARK outline at the silhouette — emissive is driven to zero at the
 *     rim so the bullet punches a black hole in whatever is behind it. Without
 *     this, bullets vanish over bright scenery. Nothing else in the game has a
 *     dark edge, so the shape is identifiable even at peripheral vision.
 *   · a separate soft additive halo (`{ halo: true }`) — put it on a slightly
 *     larger shell or a sprite BEHIND the core, never in the same draw, because
 *     additive blending cannot produce the dark outline.
 *
 * Standard usage is two meshes per bullet, or one InstancedMesh per layer:
 *   const core = hostileEnergy();
 *   const halo = hostileEnergy({ halo: true, sprite: true });
 *
 * @param {object} opts
 * @param {string|number} [opts.tint='hostile'] pass 'key' for friendly fire
 * @param {boolean}[opts.halo=false]   additive outer glow instead of the core
 * @param {boolean}[opts.sprite=false] SpriteNodeMaterial + radial uv (billboards)
 * @param {number} [opts.intensity=1]  master multiplier
 * @param {number} [opts.flicker=0.35] 0 = steady, 1 = unstable
 * @param {number} [opts.outline=0.16] width of the dark rim (0..0.4)
 */
export function hostileEnergy(opts = {}) {
  const o = {
    tint: 'hostile', halo: false, sprite: false,
    intensity: 1.0, flicker: 0.35, outline: 0.16,
    cache: true, ...opts,
  };

  return cached('hostileEnergy', o, () => {
    const hotC = slotColor(o.tint, 'hostile');
    const glowC = Palette.u.glow;

    // radial coordinate: 1 at the centre of the shape, 0 at its silhouette
    const radial = o.sprite
      ? uv().sub(vec2(0.5)).length().mul(2.0).saturate().oneMinus()
      : facing;

    // fast, irregular instability — a steady sine reads as decorative, this
    // reads as something barely contained
    const jitter = sin(time.mul(37.0)).mul(0.6)
      .add(sin(time.mul(23.3).add(1.7)).mul(0.4))
      .mul(float(o.flicker)).mul(0.5).add(1.0);

    if (o.halo) {
      const m = o.sprite ? new SpriteNodeMaterial() : new MeshBasicNodeMaterial();
      m.transparent = true;
      m.depthWrite = false;
      m.blending = THREE.AdditiveBlending;
      m.side = THREE.DoubleSide;
      m.toneMapped = false;

      const fall = radial.pow(float(2.6));
      m.colorNode = hotC.mul(fall.mul(0.5));
      m.opacityNode = fall.mul(0.85);
      m.emissiveNode = clampEmissive(
        hotC.mul(fall.mul(float(o.intensity) * 1.5).mul(jitter)).mul(G()), 2.4
      );
      return m;
    }

    const m = o.sprite ? new SpriteNodeMaterial() : new MeshBasicNodeMaterial();
    m.toneMapped = false;
    if (o.sprite) { m.transparent = true; m.depthWrite = false; }

    const core = smoothstep(float(0.58), float(0.93), radial);
    const mantle = smoothstep(float(0.10), float(0.62), radial);
    // hard cut to black at the very edge — the outline
    const rimGate = smoothstep(float(0.0), float(o.outline), radial);

    m.colorNode = mix(vec3(0.004, 0.002, 0.006), hotC.mul(0.28), mantle.mul(rimGate));

    m.emissiveNode = clampEmissive(
      hotC.mul(mantle.sub(core.mul(0.55)).max(float(0.0)).mul(2.4))
        .add(glowC.mul(core.mul(3.0)))
        .mul(rimGate).mul(jitter).mul(float(o.intensity)).mul(G()),
      3.9
    );

    if (o.sprite) m.opacityNode = smoothstep(float(0.0), float(0.06), radial);

    return m;
  });
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* 6. voidMatte                                                               */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * The near-black for silhouette masses — boss hulls, occluders, the inside of
 * architecture. The whole point of the art direction is that most of the frame
 * is dark, and this is the material that makes "dark" not mean "a hole".
 *
 * It is never pure black: a chromatic `ink` base, a broad low-contrast triplanar
 * break-up so large surfaces don't read as vinyl, and a fresnel rim tuned to the
 * minimum that lets the form separate from the background.
 *
 * @param {object} opts
 * @param {string|number} [opts.baseColor='ink']
 * @param {string|number} [opts.rimColor='rim']
 * @param {number} [opts.rim=0.55]       rim strength (this is the only knob you
 *                                       usually need — push to 1.2 for a hero
 *                                       silhouette, drop to 0.2 for background)
 * @param {number} [opts.rimPower=4.5]
 * @param {number} [opts.roughness=0.78]
 * @param {number} [opts.scale=0.6]      break-up frequency
 * @param {number} [opts.variation=0.35] how much the break-up lightens
 */
export function voidMatte(opts = {}) {
  const o = {
    baseColor: 'ink', rimColor: 'rim',
    rim: 0.55, rimPower: 4.5, roughness: 0.78, scale: 0.6, variation: 0.35,
    space: 'local', cache: true, ...opts,
  };

  return cached('voidMatte', o, () => {
    const m = new MeshStandardNodeMaterial();
    m.metalness = 0.12;
    m.envMapIntensity = 0.5;

    const baseC = slotColor(o.baseColor, 'ink');
    const rimC = slotColor(o.rimColor, 'rim');

    const p = detailPos(o.space, o.scale);
    const n = fbm(p, 3);

    m.colorNode = baseC.mul(n.mul(float(o.variation)).add(0.85));
    m.roughnessNode = clamp(float(o.roughness).add(n.mul(0.18)).sub(0.09), float(0.2), float(1.0));

    m.emissiveNode = Fn(() => {
      const broad = rimC.mul(grazing.pow(float(o.rimPower)).mul(float(o.rim)));
      const contour = rimC.mul(grazing.pow(float(16.0)).mul(float(o.rim * 0.6)));
      // face-on fill: a silhouette must never collapse to a rendering-error
      // black hole — there is always *some* light in hyperspace
      const fill = rimC.mul(0.055).add(baseC.mul(0.10)).mul(n.mul(0.6).add(0.5));
      return clampEmissive(broad.add(contour).add(fill).mul(G()), 1.2);
    })();

    return m;
  });
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* dissolve decorator                                                         */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * Wrap any material from this library (or any NodeMaterial) in a procedural
 * dissolve/materialise with a glowing erosion edge. Spawns, deaths, boss phase
 * transitions, dimension bleed-through.
 *
 * Returns a NEW material (the library caches and shares instances, so mutating
 * the original would dissolve everything using it). The returned material
 * carries:
 *     mat.uDissolve      TSL uniform, 1 = fully present, 0 = fully gone
 *     mat.setDissolve(v) convenience setter
 *
 * PER-INSTANCE: pass `{ attribute: 'aDissolve' }` and add a matching
 * InstancedBufferAttribute (float, 1 per instance) to the geometry. Each
 * instance then dissolves independently with no extra draw calls — this is what
 * you want for a wave of elves materialising.
 *
 * @param {THREE.Material} material
 * @param {object} opts
 * @param {string|number} [opts.edgeColor='glow'] erosion edge hue
 * @param {number} [opts.width=0.09]     edge band width
 * @param {number} [opts.intensity=3.0]  edge emissive peak
 * @param {number} [opts.scale=1.6]      erosion noise frequency
 * @param {string} [opts.axis='y']       'y' | 'radial' | 'inward' | 'none'
 * @param {number} [opts.axisScale=0.35] how directional the sweep is
 * @param {number} [opts.extent=2.0]     object half-height/radius in local units
 * @param {string} [opts.attribute]      per-instance attribute name
 * @param {boolean}[opts.clone=true]
 */
export function dissolve(material, opts = {}) {
  const o = {
    edgeColor: 'glow', width: 0.09, intensity: 3.0,
    scale: 1.6, axis: 'y', axisScale: 0.35, extent: 2.0,
    space: 'local', attribute: null, clone: true, ...opts,
  };

  const m = o.clone === false ? material : material.clone();
  const prevEmissive = m.emissiveNode;
  const prevOpacity = m.opacityNode;

  const u = uniform(1);
  const amount = o.attribute ? attribute(o.attribute, 'float') : u;

  const field = dissolveField(o);
  // 1 → cut below the field minimum (nothing eroded); 0 → cut above the maximum
  const cut = mix(float(1.18), float(-0.06), amount.saturate());
  const w = float(o.width);
  const edgeC = slotColor(o.edgeColor, 'glow');

  m.transparent = m.transparent || false;

  // Discard lives in opacityNode: it is always evaluated, and evaluated early.
  m.opacityNode = Fn(() => {
    Discard(field.lessThan(cut));
    return prevOpacity ? float(prevOpacity) : float(1.0);
  })();

  m.emissiveNode = Fn(() => {
    const edge = oneMinus(smoothstep(cut, cut.add(w), field)).saturate();
    // squared so the band is tight and hot rather than a soft wash
    const band = edge.mul(edge).mul(float(o.intensity));
    // fade the edge out entirely at the endpoints so a settled object is clean
    const gate = smoothstep(float(0.0), float(0.06), amount).mul(
      oneMinus(smoothstep(float(0.94), float(1.0), amount))
    );
    const glow = edgeC.mul(band.mul(gate));
    const base = prevEmissive ? vec3(prevEmissive) : vec3(0.0);
    return clampEmissive(base.add(glow.mul(G())), 4.0);
  })();

  m.uDissolve = u;
  m.setDissolve = (v) => { u.value = v; };
  m.userData.matKind = `${material.userData?.matKind || 'material'}+dissolve`;
  return m;
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* procedural environment — what the glass and brass actually reflect          */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * A palette-driven equirectangular "studio", painted on a canvas (no assets) and
 * handed to three, which PMREMs it automatically. Physical materials with
 * nothing to reflect look like plastic no matter how good the BRDF is — this is
 * the cheapest thing in the whole file and one of the largest wins.
 *
 * Repainted on every palette change, so the reflections retint with the world.
 */
export function buildEnvironmentCanvas(size = 256) {
  const c = document.createElement('canvas');
  c.width = size * 2; c.height = size;
  return c;
}

export function paintEnvironment(canvas) {
  const g = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  const voidC = Palette.css('void');
  const rimC = Palette.css('rim');
  const keyC = Palette.css('key');
  const accentC = Palette.css('accent');
  const fogC = Palette.css('fog');

  // vertical ground→sky ramp
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0.00, rimC);
  sky.addColorStop(0.38, fogC);
  sky.addColorStop(0.52, voidC);
  sky.addColorStop(1.00, '#000000');
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);

  // two cathedral "windows" — the key highlights that shape the glass
  const blob = (x, y, r, col, a) => {
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, col);
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalAlpha = a; g.fillStyle = rg;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 1;
  };

  blob(W * 0.22, H * 0.28, H * 0.40, keyC, 0.95);
  blob(W * 0.70, H * 0.34, H * 0.30, accentC, 0.75);
  blob(W * 0.47, H * 0.10, H * 0.26, '#ffffff', 0.28);
  blob(W * 0.88, H * 0.62, H * 0.22, rimC, 0.55);

  // a few hard vertical bars — glass needs a straight edge to bend, otherwise
  // the refraction has no structure to distort and reads as a tint
  g.globalAlpha = 0.5;
  g.fillStyle = keyC;
  for (let i = 0; i < 7; i++) {
    const x = (i / 7) * W + W * 0.03;
    g.fillRect(x, H * 0.18, Math.max(2, W * 0.006), H * 0.34);
  }
  g.globalAlpha = 1;

  return canvas;
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* module                                                                     */
/* ══════════════════════════════════════════════════════════════════════════ */

export class Materials {
  constructor() {
    this.name = 'materials';
    this.order = 2;               // before every consumer
    this.env = null;
    this._envCanvas = null;
    this._ownsEnvironment = false;
  }

  async init(ctx) {
    const { scene } = ctx;

    Palette.bindBus();
    Palette.audit();

    // procedural IBL
    try {
      this._envCanvas = paintEnvironment(buildEnvironmentCanvas(256));
      const tex = new THREE.CanvasTexture(this._envCanvas);
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      this.env = tex;
      if (!scene.environment) {
        scene.environment = tex;
        scene.environmentIntensity = Palette.params.envIntensity;
        this._ownsEnvironment = true;
      }
    } catch (e) {
      console.warn('[materials] environment build failed, physical materials will be flat', e);
    }

    this._unsub = Palette.onChange(() => {
      if (!this._envCanvas || !this.env) return;
      paintEnvironment(this._envCanvas);
      this.env.needsUpdate = true;
      this.env.needsPMREMUpdate = true;
      if (this._ownsEnvironment) scene.environmentIntensity = Palette.params.envIntensity;
    });

    // debug handles
    if (typeof window !== 'undefined') {
      window.__palette = Palette;
      window.__materials = MaterialLib;
    }

    if (SHOWCASE) {
      const { buildShowcase } = await import('../util/mat-preview.js');
      this._showcase = buildShowcase(ctx);
    }
  }

  update(dt, ctx) {
    if (this._showcase) this._showcase.update(dt, ctx);
  }

  dispose() {
    this._unsub?.();
    this._showcase?.dispose?.();
    this.env?.dispose();
    clearMaterialCache();
  }
}

/** Everything a consumer needs, in one bag. */
export const MaterialLib = {
  neonGlass, clockworkBrass, sacredGeometry, fractalShell, hostileEnergy, voidMatte,
  dissolve, slotColor, materialStats, clearMaterialCache, Palette,
};

export default Materials;
