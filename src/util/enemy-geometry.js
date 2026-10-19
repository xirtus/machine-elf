import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hash21, Rng } from './enemy-math.js';

/**
 * Procedural geometry kit for the clockwork elves. No primitives survive
 * untouched: every builder here revolves an authored profile, jitters its
 * angular divisions so nothing is radially symmetric, and emits faceted
 * (non-indexed) triangles so the glass catches light per-facet.
 *
 * Builders return raw BufferGeometry in a canonical orientation (+Y up,
 * +Z forward) around the origin; `compose()` bolts them together into a
 * single geometry so one elf part = one draw call slot.
 */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _e = new THREE.Euler();

// ─────────────────────────────────────────────────────────────────────────
// core: jittered lathe

/**
 * Revolve a 2D profile. `profile` is [[radius, y], ...] bottom→top.
 * Rings with radius 0 become poles. Angular divisions are *unevenly spaced*
 * and each vertex gets a seeded radial jitter, so the silhouette never reads
 * as a lathe.
 */
export function lathe(opts = {}) {
  const {
    profile = [[0, -1], [0.6, -0.55], [0.95, 0], [0.6, 0.6], [0, 1]],
    sides = 7,
    seed = 1,
    jitter = 0.14,
    twist = 0.0,
    angleWobble = 0.35,
    scale = [1, 1, 1],
    flat = true,
  } = opts;

  const rng = new Rng((seed * 2654435761) >>> 0);
  // uneven angular steps that still close the loop
  const raw = new Float32Array(sides);
  let sum = 0;
  for (let i = 0; i < sides; i++) { raw[i] = 1 + rng.range(-angleWobble, angleWobble); sum += raw[i]; }
  const ang = new Float32Array(sides + 1);
  let acc = 0;
  for (let i = 0; i < sides; i++) { ang[i] = (acc / sum) * Math.PI * 2; acc += raw[i]; }
  ang[sides] = Math.PI * 2;

  const rings = profile.length;
  const pos = [];

  const rj = (ri, si) => 1 + (hash21(ri * 13.1 + seed, si * 7.7) - 0.5) * 2 * jitter;

  const px = (ri, si) => {
    const [r, y] = profile[ri];
    const a = ang[si % sides] + twist * (y);
    const rr = r * (r > 0 ? rj(ri, si % sides) : 1);
    return [Math.cos(a) * rr * scale[0], y * scale[1], Math.sin(a) * rr * scale[2]];
  };

  for (let ri = 0; ri < rings - 1; ri++) {
    const r0 = profile[ri][0], r1 = profile[ri + 1][0];
    for (let si = 0; si < sides; si++) {
      const a = px(ri, si), b = px(ri, si + 1);
      const c = px(ri + 1, si), d = px(ri + 1, si + 1);
      if (r0 <= 1e-6) {
        pos.push(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]);
      } else if (r1 <= 1e-6) {
        pos.push(a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2]);
      } else {
        pos.push(a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2]);
        pos.push(b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2]);
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (flat) g.computeVertexNormals();
  else { g.computeVertexNormals(); smoothNormals(g); }
  return g;
}

/** A faceted jewel: two stacked lathes with a hard equatorial break. */
export function jewel(opts = {}) {
  const {
    sides = 6, seed = 3, height = 1, radius = 0.55,
    topSharp = 1.25, botSharp = 0.85, belt = 0.12, jitter = 0.18,
  } = opts;
  return lathe({
    sides, seed, jitter, angleWobble: 0.4,
    profile: [
      [0, -height * botSharp],
      [radius * 0.62, -height * 0.34],
      [radius, -belt * height],
      [radius * 0.96, belt * height],
      [radius * 0.5, height * 0.46],
      [0, height * topSharp],
    ],
  });
}

/** Tapered polygonal strut. Runs along +Y from 0 to `len`. */
export function strut(opts = {}) {
  const { len = 1, r0 = 0.06, r1 = 0.03, sides = 3, seed = 5, twist = 0.6, bend = 0 } = opts;
  const rng = new Rng((seed * 40503) >>> 0);
  const off = rng.range(0, Math.PI * 2);
  const pos = [];
  const ring = (t) => {
    const r = r0 + (r1 - r0) * t;
    const y = len * t;
    const bx = bend * t * t * len;
    const a0 = off + twist * t;
    const out = [];
    for (let i = 0; i < sides; i++) {
      const a = a0 + (i / sides) * Math.PI * 2;
      out.push([Math.cos(a) * r + bx, y, Math.sin(a) * r]);
    }
    return out;
  };
  const segs = 3;
  for (let s = 0; s < segs; s++) {
    const A = ring(s / segs), B = ring((s + 1) / segs);
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      pos.push(...A[i], ...B[i], ...A[j]);
      pos.push(...A[j], ...B[i], ...B[j]);
    }
  }
  // caps
  const A = ring(0), B = ring(1);
  for (let i = 1; i < sides - 1; i++) {
    pos.push(...A[0], ...A[i + 1], ...A[i]);
    pos.push(...B[0], ...B[i], ...B[i + 1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/**
 * A swept vane / wing blade. Grows along +X, curls in Z, tapers to a point.
 * Cross-section is a flattened quad so it reads as glass plate, not a box.
 */
export function blade(opts = {}) {
  const {
    len = 1, width = 0.3, thick = 0.05, curve = 0.35, sweep = 0.25,
    segs = 6, seed = 9, notch = 0.0,
  } = opts;
  const rng = new Rng((seed * 22695477) >>> 0);
  const wob = rng.range(0.8, 1.2);
  const pos = [];
  const section = (t) => {
    const x = len * t;
    const w = width * (1 - t * t * 0.92) * (1 + notch * Math.sin(t * 9.1) * 0.4);
    const th = thick * (1 - t * 0.8);
    const y = curve * t * t * len * wob;
    const z = sweep * Math.sin(t * 2.1) * len * 0.25;
    return [
      [x, y + w * 0.5, z + th * 0.5],
      [x, y + w * 0.5, z - th * 0.5],
      [x, y - w * 0.5, z - th * 0.5],
      [x, y - w * 0.5, z + th * 0.5],
    ];
  };
  for (let s = 0; s < segs; s++) {
    const A = section(s / segs), B = section((s + 1) / segs);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      pos.push(...A[i], ...B[i], ...A[j]);
      pos.push(...A[j], ...B[i], ...B[j]);
    }
  }
  const A = section(0);
  pos.push(...A[0], ...A[2], ...A[1]);
  pos.push(...A[0], ...A[3], ...A[2]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/**
 * Escapement gear — the brass that shows through the glass. Teeth are
 * unevenly cut (a real escapement has an anchor gap) so it never reads as a
 * cylinder. Lies in the XZ plane, thickness along Y.
 */
export function gear(opts = {}) {
  const {
    teeth = 11, rOuter = 0.5, rInner = 0.34, rHub = 0.14,
    thick = 0.05, seed = 11, gap = 2,
  } = opts;
  const rng = new Rng((seed * 69069) >>> 0);
  const n = teeth;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 0.42) / n) * Math.PI * 2;
    const a2 = ((i + 0.58) / n) * Math.PI * 2;
    const a3 = ((i + 1) / n) * Math.PI * 2;
    const missing = (i % (n) ) < gap && rng.next() < 0.9 && i < gap;
    const rt = missing ? rInner : rOuter * rng.range(0.94, 1.04);
    pts.push([a0, rInner], [a1, rt], [a2, rt], [a3, rInner]);
  }
  const pos = [];
  const hub = [];
  for (let i = 0; i < pts.length; i++) {
    const [a, r] = pts[i];
    const [a2, r2] = pts[(i + 1) % pts.length];
    const p0 = [Math.cos(a) * r, 0, Math.sin(a) * r];
    const p1 = [Math.cos(a2) * r2, 0, Math.sin(a2) * r2];
    const h0 = [Math.cos(a) * rHub, 0, Math.sin(a) * rHub];
    const h1 = [Math.cos(a2) * rHub, 0, Math.sin(a2) * rHub];
    hub.push([p0, p1, h0, h1]);
    const t = thick * 0.5;
    // rim faces
    pos.push(p0[0], t, p0[2], p1[0], t, p1[2], p0[0], -t, p0[2]);
    pos.push(p1[0], t, p1[2], p1[0], -t, p1[2], p0[0], -t, p0[2]);
    // top/bottom webs
    pos.push(p0[0], t, p0[2], h0[0], t, h0[2], p1[0], t, p1[2]);
    pos.push(p1[0], t, p1[2], h0[0], t, h0[2], h1[0], t, h1[2]);
    pos.push(p1[0], -t, p1[2], h0[0], -t, h0[2], p0[0], -t, p0[2]);
    pos.push(h1[0], -t, h1[2], h0[0], -t, h0[2], p1[0], -t, p1[2]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** A faceted, jittered ring — the orbiting shards' track / halo. */
export function shardRing(opts = {}) {
  const { count = 9, radius = 0.7, size = 0.09, seed = 17, wobble = 0.22, tilt = 0.4 } = opts;
  const rng = new Rng((seed * 2246822519) >>> 0);
  const parts = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rng.range(-0.18, 0.18);
    const r = radius * (1 + rng.range(-wobble, wobble));
    const s = size * rng.range(0.55, 1.5);
    parts.push({
      geo: jewel({ sides: 4, seed: seed + i, height: 1.6, radius: 0.5, jitter: 0.3 }),
      p: [Math.cos(a) * r, rng.range(-1, 1) * radius * 0.22, Math.sin(a) * r],
      e: [rng.range(-Math.PI, Math.PI), a, tilt * rng.range(-1, 1)],
      s: [s * 0.6, s, s * 0.6],
    });
  }
  return compose(parts);
}

/** Hollow strut cage — the phase elf's skeleton. */
export function cage(opts = {}) {
  const { ribs = 5, height = 1.4, radius = 0.6, r0 = 0.045, seed = 23 } = opts;
  const rng = new Rng((seed * 3266489917) >>> 0);
  const parts = [];
  for (let i = 0; i < ribs; i++) {
    const a = (i / ribs) * Math.PI * 2 + rng.range(-0.25, 0.25);
    const bend = rng.range(-0.5, -0.15);
    parts.push({
      geo: strut({ len: height, r0, r1: r0 * 0.5, sides: 3, seed: seed + i, bend }),
      p: [Math.cos(a) * radius, -height * 0.5, Math.sin(a) * radius],
      e: [0, -a, Math.cos(a) * 0.34],
      s: [1, 1, 1],
    });
  }
  return compose(parts);
}

/** Dart — enemy bullet. Elongated bipyramid with a flared tail, never a sphere. */
export function dart(opts = {}) {
  const { seed = 31, len = 1, r = 0.34 } = opts;
  return lathe({
    sides: 5, seed, jitter: 0.06, angleWobble: 0.2,
    profile: [
      [0, -len * 0.9],
      [r * 0.5, -len * 0.4],
      [r, 0],
      [r * 0.34, len * 0.55],
      [r * 0.5, len * 0.72],
      [0, len * 0.95],
    ],
  });
}

/** Thorn — the weaver's dropped hostile geometry. */
export function thorn(opts = {}) {
  const { seed = 41 } = opts;
  return compose([
    { geo: jewel({ sides: 5, seed, height: 1.0, radius: 0.42, jitter: 0.26, topSharp: 1.5 }), p: [0, 0, 0], e: [0, 0, 0], s: [1, 1, 1] },
    { geo: jewel({ sides: 4, seed: seed + 5, height: 0.7, radius: 0.3, jitter: 0.3 }), p: [0.24, 0.1, 0.06], e: [0.6, 0.9, 1.3], s: [0.7, 0.9, 0.7] },
    { geo: jewel({ sides: 4, seed: seed + 9, height: 0.62, radius: 0.26, jitter: 0.3 }), p: [-0.2, -0.14, -0.1], e: [-0.8, 0.2, -1.1], s: [0.7, 0.8, 0.7] },
  ]);
}

// ─────────────────────────────────────────────────────────────────────────
// composition

/**
 * Bolt geometries together into one. Each piece: {geo, p:[x,y,z],
 * e:[x,y,z] euler, q:[x,y,z,w], s:[x,y,z]|number}.
 * Source geometries are disposed unless `keep` is set.
 */
export function compose(pieces, keep = false) {
  const list = [];
  for (const pc of pieces) {
    const g = pc.geo.clone();
    const s = pc.s == null ? 1 : pc.s;
    _v.set(...(Array.isArray(s) ? s : [s, s, s]));
    if (pc.q) _q.set(pc.q[0], pc.q[1], pc.q[2], pc.q[3]);
    else { _e.set(...(pc.e || [0, 0, 0])); _q.setFromEuler(_e); }
    _m.compose(new THREE.Vector3(...(pc.p || [0, 0, 0])), _q, _v);
    g.applyMatrix4(_m);
    if (!g.attributes.normal) g.computeVertexNormals();
    // strip everything but position/normal so merge never mismatches
    for (const k of Object.keys(g.attributes)) {
      if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    }
    if (g.index) { const ng = g.toNonIndexed(); g.dispose(); list.push(ng); }
    else list.push(g);
    if (!keep) pc.geo.dispose?.();
  }
  const merged = mergeGeometries(list, false);
  for (const g of list) g.dispose();
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  return merged;
}

/** Average normals across coincident verts (softens glass without indexing). */
export function smoothNormals(geo, eps = 1e-3) {
  const p = geo.attributes.position.array;
  const n = geo.attributes.normal.array;
  const map = new Map();
  const key = (i) => `${Math.round(p[i] / eps)},${Math.round(p[i + 1] / eps)},${Math.round(p[i + 2] / eps)}`;
  for (let i = 0; i < p.length; i += 3) {
    const k = key(i);
    let e = map.get(k);
    if (!e) map.set(k, (e = [0, 0, 0, []]));
    e[0] += n[i]; e[1] += n[i + 1]; e[2] += n[i + 2]; e[3].push(i);
  }
  for (const e of map.values()) {
    const l = Math.hypot(e[0], e[1], e[2]) || 1;
    for (const i of e[3]) { n[i] = e[0] / l; n[i + 1] = e[1] / l; n[i + 2] = e[2] / l; }
  }
  geo.attributes.normal.needsUpdate = true;
  return geo;
}

/** Rough triangle count for budgeting. */
export function triCount(geo) {
  return (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
}
