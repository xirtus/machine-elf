import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { makeRng, sampleKeys, lobe, clamp, TAU } from './craft-math.js';

/**
 * Procedural geometry for the player craft. Nothing here is a Three primitive:
 * every surface is a loft over authored cross-section keyframes, a swept
 * profile, or the convex hull of a jittered authored point set.
 *
 * Craft local space:  nose −Z, up +Y, starboard +X.
 *
 * Owned by the *player* agent (BRIEF §7).
 */

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();

/* ────────────────────────────────────────────────────────────────────────
 * loft — build a surface from a stack of equal-length rings.
 * rings: Array< Float32Array|number[] >  length N*3 each.
 * Normals are computed analytically from the grid so the U-seam stays smooth
 * (computeVertexNormals would split it and show a hard crease).
 * ──────────────────────────────────────────────────────────────────────── */
export function loft(rings, { closedU = true, autoOrient = true } = {}) {
  const M = rings.length;
  const N = rings[0].length / 3;
  const cols = closedU ? N + 1 : N;
  const vcount = M * cols;

  const pos = new Float32Array(vcount * 3);
  const nor = new Float32Array(vcount * 3);
  const uvs = new Float32Array(vcount * 2);

  const at = (i) => (((i % N) + N) % N) * 3;

  let cx = 0, cy = 0, cz = 0;
  for (let j = 0; j < M; j++) {
    const r = rings[j];
    for (let i = 0; i < cols; i++) {
      const o = (j * cols + i) * 3;
      const k = at(i);
      pos[o] = r[k]; pos[o + 1] = r[k + 1]; pos[o + 2] = r[k + 2];
      cx += r[k]; cy += r[k + 1]; cz += r[k + 2];
      const uo = (j * cols + i) * 2;
      uvs[uo] = i / (cols - 1);
      uvs[uo + 1] = j / (M - 1);
    }
  }
  cx /= vcount; cy /= vcount; cz /= vcount;

  // analytic normals from central differences on the (u, v) grid
  const getP = (j, i, v) => {
    const r = rings[clamp(j, 0, M - 1)];
    const k = at(i);
    return v.set(r[k], r[k + 1], r[k + 2]);
  };

  let orient = 0;
  for (let j = 0; j < M; j++) {
    for (let i = 0; i < cols; i++) {
      const iu0 = closedU ? i - 1 : clamp(i - 1, 0, N - 1);
      const iu1 = closedU ? i + 1 : clamp(i + 1, 0, N - 1);
      getP(j, iu1, _a).sub(getP(j, iu0, _b));      // dU
      getP(j + 1, i, _c).sub(getP(j - 1, i, _d));  // dV
      _a.cross(_c);
      if (_a.lengthSq() < 1e-14) {
        // degenerate (collapsed tip) — borrow the neighbouring row
        const jn = j === 0 ? 1 : j - 1;
        getP(jn, iu1, _a).sub(getP(jn, iu0, _b));
        getP(jn + 1, i, _c).sub(getP(jn - 1, i, _d));
        _a.cross(_c);
        if (_a.lengthSq() < 1e-14) _a.set(0, 0, 1);
      }
      _a.normalize();
      const o = (j * cols + i) * 3;
      nor[o] = _a.x; nor[o + 1] = _a.y; nor[o + 2] = _a.z;
      orient += _a.x * (pos[o] - cx) + _a.y * (pos[o + 1] - cy) + _a.z * (pos[o + 2] - cz);
    }
  }

  const flip = autoOrient && orient < 0;
  if (flip) for (let i = 0; i < nor.length; i++) nor[i] = -nor[i];

  const idx = [];
  for (let j = 0; j < M - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i, b = a + 1, c2 = a + cols, d2 = c2 + 1;
      if (flip) { idx.push(a, c2, b, b, c2, d2); }
      else { idx.push(a, b, c2, b, d2, c2); }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

/* ────────────────────────────────────────────────────────────────────────
 * HULL — authored cross-section keyframes.
 * cols: s, halfWidth, halfHeight, keel, dorsal, superEllipseN, yOffset, xOffset
 * ──────────────────────────────────────────────────────────────────────── */
const HULL_KEYS = [
  [0.000, 0.004, 0.004, 0.000, 0.000, 2.60,  0.030,  0.000],
  [0.045, 0.062, 0.048, 0.014, 0.006, 2.10,  0.026,  0.002],
  [0.120, 0.150, 0.108, 0.070, 0.024, 1.62,  0.014,  0.006],
  [0.215, 0.256, 0.170, 0.160, 0.048, 1.34,  0.000,  0.010],
  [0.330, 0.372, 0.222, 0.262, 0.082, 1.18, -0.014,  0.012],
  [0.450, 0.480, 0.262, 0.336, 0.118, 1.08, -0.026,  0.010],
  [0.560, 0.552, 0.288, 0.372, 0.150, 1.04, -0.032,  0.004],
  [0.660, 0.572, 0.296, 0.344, 0.168, 1.06, -0.028, -0.004],
  [0.755, 0.516, 0.278, 0.262, 0.152, 1.20, -0.014, -0.010],
  [0.845, 0.404, 0.244, 0.156, 0.110, 1.46,  0.006, -0.012],
  [0.920, 0.302, 0.212, 0.062, 0.062, 1.82,  0.022, -0.008],
  [0.968, 0.236, 0.186, 0.018, 0.030, 2.05,  0.030, -0.004],
  [1.000, 0.176, 0.150, 0.000, 0.014, 2.20,  0.032,  0.000],
];

const HULL_Z0 = -2.34;
const HULL_Z1 = 1.62;

/**
 * Build the fuselage. Returns { geometry, rings, N, M } — the ring data is
 * reused to derive the seam filaments so they sit exactly on the surface.
 */
export function makeHullGeometry({ M = 34, N = 34, scale = 1 } = {}) {
  const rings = [];
  const k = new Array(8);
  for (let j = 0; j < M; j++) {
    const s = j / (M - 1);
    sampleKeys(HULL_KEYS, s, k);
    const [w, h, keel, dorsal, nExp, yOff, xOff] = k;
    const z = THREE.MathUtils.lerp(HULL_Z0, HULL_Z1, s);
    // subtle spanwise twist — breaks the mirror read and adds torque
    const twist = 0.16 * Math.sin(s * 2.35) - 0.05 * s;
    const ring = new Float32Array(N * 3);
    const p = Math.max(0.35, 2 / Math.max(0.5, nExp));
    for (let i = 0; i < N; i++) {
      const th = (i / N) * TAU;
      const ct = Math.cos(th), st = Math.sin(th);
      let px = w * Math.sign(ct) * Math.pow(Math.abs(ct), p);
      let py = h * Math.sign(st) * Math.pow(Math.abs(st), p);

      // ventral keel blade + dorsal spine ridge
      py -= keel * lobe(th, -Math.PI / 2, 0.46);
      py += dorsal * lobe(th, Math.PI / 2, 0.30);
      // starboard chine — asymmetric, only on +X
      px += w * 0.20 * lobe(th, -0.42, 0.44);
      // port intake notch
      const notch = 0.16 * lobe(th, Math.PI - 0.66, 0.30) * Math.sin(Math.PI * s);
      px *= 1 - notch;
      py *= 1 - notch * 0.4;

      const cw = Math.cos(twist), sw = Math.sin(twist);
      const rx = px * cw - py * sw;
      const ry = px * sw + py * cw;

      ring[i * 3] = (rx + xOff) * scale;
      ring[i * 3 + 1] = (ry + yOff) * scale;
      ring[i * 3 + 2] = z * scale;
    }
    rings.push(ring);
  }
  const geometry = loft(rings, { closedU: true });
  return { geometry, rings, N, M };
}

/** Emissive filament seams traced along the hull grid. */
export function makeSeamGeometry(rings, N, M, { meridians = [0, 0.25, 0.5, 0.75], latitudes = [0.20, 0.37, 0.53, 0.70, 0.86], push = 1.008 } = {}) {
  const pts = [];
  const grab = (j, i, o) => {
    const r = rings[j];
    const k = ((i % N) + N) % N;
    o.set(r[k * 3], r[k * 3 + 1], r[k * 3 + 2]);
    // nudge outward from the ring centreline so lines never z-fight
    o.x *= push; o.y *= push;
    return o;
  };
  for (const mfrac of meridians) {
    const i = Math.round(mfrac * N);
    for (let j = 1; j < M - 2; j++) {
      grab(j, i, _a); grab(j + 1, i, _b);
      pts.push(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z);
    }
  }
  for (const lfrac of latitudes) {
    const j = clamp(Math.round(lfrac * (M - 1)), 1, M - 2);
    for (let i = 0; i < N; i++) {
      grab(j, i, _a); grab(j, i + 1, _b);
      pts.push(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z);
    }
  }
  const g = new THREE.BufferGeometry();
  const arr = new Float32Array(pts);
  g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  // a v-coordinate so the filaments can pulse along their length
  const uvs = new Float32Array((arr.length / 3) * 2);
  for (let i = 0; i < arr.length / 3; i++) {
    uvs[i * 2] = i / 40;
    uvs[i * 2 + 1] = (arr[i * 3 + 2] - HULL_Z0) / (HULL_Z1 - HULL_Z0);
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  return g;
}

/* ────────────────────────────────────────────────────────────────────────
 * WING VANE — thin swept blade lofted along +X, chord on Z, thickness on Y.
 * cols: s, chord, thickness, sweep(z), rise(y), twist
 * ──────────────────────────────────────────────────────────────────────── */
const VANE_KEYS = [
  [0.00, 0.30, 0.070, -0.02, 0.000,  0.00],
  [0.10, 0.42, 0.088,  0.03, 0.010, -0.04],
  [0.26, 0.50, 0.078,  0.14, 0.026, -0.10],
  [0.45, 0.48, 0.058,  0.32, 0.040, -0.17],
  [0.63, 0.40, 0.040,  0.55, 0.046, -0.24],
  [0.80, 0.28, 0.024,  0.82, 0.040, -0.31],
  [0.92, 0.15, 0.012,  1.04, 0.028, -0.36],
  [1.00, 0.02, 0.002,  1.19, 0.014, -0.39],
];

export function makeVaneGeometry({ M = 20, N = 12, length = 1.35 } = {}) {
  const rings = [];
  const k = new Array(6);
  for (let j = 0; j < M; j++) {
    const s = j / (M - 1);
    sampleKeys(VANE_KEYS, s, k);
    const [chord, thick, sweep, rise, twist] = k;
    const x = s * length;
    const ring = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const th = (i / N) * TAU;
      const ct = Math.cos(th), st = Math.sin(th);
      // sharpened lens section: pointed leading & trailing edge
      let pz = (chord * 0.5) * Math.sign(ct) * Math.pow(Math.abs(ct), 0.72);
      let py = (thick * 0.5) * Math.sign(st) * Math.pow(Math.abs(st), 1.55);
      // hollow the trailing edge into a scallop
      pz -= chord * 0.10 * lobe(th, Math.PI, 0.55);
      const cw = Math.cos(twist), sw = Math.sin(twist);
      const rz = pz * cw - py * sw;
      const ry = pz * sw + py * cw;
      ring[i * 3] = x;
      ring[i * 3 + 1] = ry + rise;
      ring[i * 3 + 2] = rz + sweep;
    }
    rings.push(ring);
  }
  return loft(rings, { closedU: true });
}

/* ────────────────────────────────────────────────────────────────────────
 * TOOTHED HOOP — a small profile swept around a circle with escapement teeth.
 * Doubles as the orrery gimbal rings and the internal hull ribs.
 * ──────────────────────────────────────────────────────────────────────── */
export function makeHoopGeometry({ R = 1, segs = 96, teeth = 24, toothAmp = 0.045, profile = null } = {}) {
  // profile: authored 2D section in (radial, axial) — an I-beam-ish bracket
  const P = profile || [
    [0.055, 0.000], [0.042, 0.038], [0.014, 0.052], [-0.014, 0.052],
    [-0.042, 0.038], [-0.055, 0.000], [-0.042, -0.038], [-0.014, -0.052],
    [0.014, -0.052], [0.042, -0.038],
  ];
  const N = P.length;
  const rings = [];
  for (let j = 0; j <= segs; j++) {
    const phi = (j / segs) * TAU;
    // square-ish tooth wave, softened
    const tw = Math.sin(phi * teeth);
    const tooth = toothAmp * (Math.sign(tw) * Math.pow(Math.abs(tw), 0.32));
    // one flattened arc breaks the rotational symmetry
    const flat = 1 - 0.10 * Math.exp(-Math.pow((((phi + Math.PI) % TAU) - Math.PI) / 0.5, 2));
    const cr = Math.cos(phi), sr = Math.sin(phi);
    const ring = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const rad = (R + P[i][0] + tooth) * flat;
      ring[i * 3] = cr * rad;
      ring[i * 3 + 1] = P[i][1];
      ring[i * 3 + 2] = sr * rad;
    }
    rings.push(ring);
  }
  const g = loft(rings, { closedU: true });
  return g;
}

/* ────────────────────────────────────────────────────────────────────────
 * CONVEX-HULL SOLIDS — authored point clouds, hulled into faceted gems.
 * ──────────────────────────────────────────────────────────────────────── */
function hullFromPoints(points) {
  const g = new ConvexGeometry(points);
  g.computeVertexNormals();   // flat facets (ConvexGeometry is non-indexed)
  return g;
}

/** The orrery core: a many-faceted jewel, slightly prolate, deliberately lumpy. */
export function makeCoreGeometry({ seed = 7, count = 42, radius = 0.30 } = {}) {
  const rng = makeRng(seed);
  const pts = [];
  for (let i = 0; i < count; i++) {
    // fibonacci sphere + radial jitter, then quantise a few points inward to
    // carve flat facets rather than a lumpy blob
    const t = (i + 0.5) / count;
    const y = 1 - 2 * t;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const ph = i * 2.399963;
    let rad = radius * (0.80 + 0.34 * rng());
    if (i % 5 === 0) rad *= 0.78;
    pts.push(new THREE.Vector3(
      Math.cos(ph) * r * rad * 1.02,
      y * rad * 1.34,
      Math.sin(ph) * r * rad * 0.94
    ));
  }
  return hullFromPoints(pts);
}

/** A sigil shard: sharp, few-faced, elongated along one axis. */
export function makeShardGeometry({ seed = 31, count = 9, radius = 1 } = {}) {
  const rng = makeRng(seed);
  const pts = [];
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    const y = 1 - 2 * t;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const ph = i * 2.399963 + rng() * 0.7;
    const rad = radius * (0.55 + 0.55 * rng());
    pts.push(new THREE.Vector3(
      Math.cos(ph) * r * rad * 0.55,
      y * rad * 1.55,
      Math.sin(ph) * r * rad * 0.42
    ));
  }
  pts.push(new THREE.Vector3(0, radius * 2.15, 0));
  pts.push(new THREE.Vector3(0, -radius * 1.35, 0.05));
  return hullFromPoints(pts);
}

/** Escapement pin — a tiny brass wedge/pallet. */
export function makePinGeometry() {
  const pts = [
    new THREE.Vector3(-0.030, 0, -0.030), new THREE.Vector3(0.030, 0, -0.030),
    new THREE.Vector3(0.030, 0, 0.030), new THREE.Vector3(-0.030, 0, 0.030),
    new THREE.Vector3(-0.016, 0.20, -0.010), new THREE.Vector3(0.016, 0.20, -0.010),
    new THREE.Vector3(0.014, 0.20, 0.014), new THREE.Vector3(-0.014, 0.20, 0.014),
    new THREE.Vector3(0.0, 0.255, -0.030),
  ];
  return hullFromPoints(pts);
}

/* ────────────────────────────────────────────────────────────────────────
 * NOZZLE + PLUME
 * ──────────────────────────────────────────────────────────────────────── */
const NOZZLE_KEYS = [
  [0.00, 0.150, 0.00],
  [0.18, 0.196, 0.06],
  [0.40, 0.152, 0.10],
  [0.62, 0.190, 0.14],
  [0.84, 0.268, 0.10],
  [1.00, 0.320, 0.02],
];

export function makeNozzleGeometry({ M = 16, N = 20, length = 0.62, flutes = 8 } = {}) {
  const rings = [];
  const k = new Array(3);
  for (let j = 0; j < M; j++) {
    const s = j / (M - 1);
    sampleKeys(NOZZLE_KEYS, s, k);
    const [rad, flute] = k;
    const ring = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const th = (i / N) * TAU;
      const r = rad * (1 - flute * (0.5 + 0.5 * Math.cos(th * flutes)));
      ring[i * 3] = Math.cos(th) * r;
      ring[i * 3 + 1] = Math.sin(th) * r * 0.86;
      ring[i * 3 + 2] = s * length;
    }
    rings.push(ring);
  }
  return loft(rings, { closedU: true });
}

/** Open cone, uv.y = 0 at the throat, 1 at the tail. Rendered additive. */
export function makePlumeGeometry({ M = 12, N = 16, length = 3.0, r0 = 0.20, r1 = 0.05 } = {}) {
  const rings = [];
  for (let j = 0; j < M; j++) {
    const s = j / (M - 1);
    const bulge = Math.sin(Math.PI * Math.pow(s, 0.55));
    const r = THREE.MathUtils.lerp(r0, r1, s) * (1 + bulge * 0.65);
    const ring = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const th = (i / N) * TAU;
      // lobed cross-section — three flame tongues, not a cone
      const rr = r * (1 + 0.22 * Math.cos(th * 3 + s * 2.2));
      ring[i * 3] = Math.cos(th) * rr;
      ring[i * 3 + 1] = Math.sin(th) * rr;
      ring[i * 3 + 2] = s * length;
    }
    rings.push(ring);
  }
  return loft(rings, { closedU: true });
}

/* ────────────────────────────────────────────────────────────────────────
 * SHATTER BAKING — cluster triangles into construction-seam chunks and store
 * per-vertex chunk centre + escape velocity so the death dissolve can be done
 * entirely in the vertex stage (zero CPU cost while alive).
 * ──────────────────────────────────────────────────────────────────────── */
export function bakeShatter(geometry, { cell = 0.40, seed = 5, speed = 1.0 } = {}) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = g.getAttribute('position');
  const tris = pos.count / 3;
  const rng = makeRng(seed);

  const centers = new Map();
  const keyOf = new Int32Array(tris);
  const keys = [];
  for (let t = 0; t < tris; t++) {
    let cx = 0, cy = 0, cz = 0;
    for (let v = 0; v < 3; v++) {
      cx += pos.getX(t * 3 + v); cy += pos.getY(t * 3 + v); cz += pos.getZ(t * 3 + v);
    }
    cx /= 3; cy /= 3; cz /= 3;
    const kx = Math.floor(cx / cell), ky = Math.floor(cy / cell), kz = Math.floor(cz / (cell * 1.5));
    const key = `${kx}|${ky}|${kz}`;
    let e = centers.get(key);
    if (!e) { e = { x: 0, y: 0, z: 0, n: 0, id: keys.length }; centers.set(key, e); keys.push(e); }
    e.x += cx; e.y += cy; e.z += cz; e.n++;
    keyOf[t] = e.id;
  }
  for (const e of keys) { e.x /= e.n; e.y /= e.n; e.z /= e.n; e.vx = 0; }
  for (const e of keys) {
    const L = Math.hypot(e.x, e.y, e.z * 0.35) || 1;
    e.vx = (e.x / L) * speed * (0.55 + rng() * 0.9) + (rng() - 0.5) * 0.4;
    e.vy = (e.y / L) * speed * (0.55 + rng() * 0.9) + (rng() - 0.5) * 0.4 + 0.18;
    e.vz = (e.z * 0.35 / L) * speed * 0.5 + (rng() - 0.5) * 0.6 + 0.35;
    e.sx = (rng() - 0.5) * 5.5; e.sy = (rng() - 0.5) * 5.5; e.sz = (rng() - 0.5) * 5.5;
    e.delay = rng();
  }

  const aCenter = new Float32Array(pos.count * 3);
  const aVel = new Float32Array(pos.count * 3);
  const aSpin = new Float32Array(pos.count * 4);   // xyz = spin axis*rate, w = delay
  for (let t = 0; t < tris; t++) {
    const e = keys[keyOf[t]];
    for (let v = 0; v < 3; v++) {
      const o = (t * 3 + v) * 3, o4 = (t * 3 + v) * 4;
      aCenter[o] = e.x; aCenter[o + 1] = e.y; aCenter[o + 2] = e.z;
      aVel[o] = e.vx; aVel[o + 1] = e.vy; aVel[o + 2] = e.vz;
      aSpin[o4] = e.sx; aSpin[o4 + 1] = e.sy; aSpin[o4 + 2] = e.sz; aSpin[o4 + 3] = e.delay;
    }
  }
  g.setAttribute('aCenter', new THREE.BufferAttribute(aCenter, 3));
  g.setAttribute('aVel', new THREE.BufferAttribute(aVel, 3));
  g.setAttribute('aSpin', new THREE.BufferAttribute(aSpin, 4));
  if (g !== geometry) geometry.dispose();
  return g;
}

export const HULL_BOUNDS = { z0: HULL_Z0, z1: HULL_Z1 };
