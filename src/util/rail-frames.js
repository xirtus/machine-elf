import * as THREE from 'three';

/**
 * Arc-length frame table built with PARALLEL TRANSPORT.
 *
 * Frenet frames are computed from the second derivative, so they spin 180°
 * at every inflection point and are undefined on straights — a camera bolted
 * to a Frenet frame rolls violently for no reason. Instead we transport an
 * up-vector along the curve with the minimal rotation that carries each
 * tangent onto the next, then re-orthogonalize. The frame then only rotates
 * as much as the curve forces it to, and is continuous everywhere.
 *
 * On top of that we bake a *bank* angle — the frame rolls into curvature like
 * an aircraft in a coordinated turn — stored separately so it can be scaled
 * at sample time without touching the transported frame.
 *
 * Frame convention (three.js standard): forward = -Z, up = +Y, right = +X.
 *   tangent  = -zAxis(q)     normal = yAxis(q)     binormal = xAxis(q)
 */

const _p = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _t = new THREE.Vector3();
const _n = new THREE.Vector3();
const _b = new THREE.Vector3();
const _u = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const G = 9.81;

export class FrameTable {
  constructor(spacing = 4) {
    this.spacing = spacing;
    this.count = 0;
    this.length = 0;
    this.pos = null;      // 3N
    this.quat = null;     // 4N  (transported, unbanked)
    this.curv = null;     // N   |dT/ds|
    this.curvLat = null;  // N   signed, positive = turning right
    this.curvVert = null; // N   signed, positive = pitching up
    this.bank = null;     // N   radians of roll baked from curvature
    this.pace = null;     // N   authored speed multiplier
    this.brake = null;    // N   max curvature within the look-ahead window
    this.seedQuat = new THREE.Quaternion();
    this.endPos = new THREE.Vector3();
    this.endDir = new THREE.Vector3(0, 0, -1);
    this.endUp = new THREE.Vector3(0, 1, 0);
  }

  /**
   * @param {THREE.CatmullRomCurve3} curve
   * @param {object} o  { seedNormal, uprightRate, bankScale, bankMax,
   *                      nominalSpeed, motifs, pathLength, lookAhead }
   */
  build(curve, o = {}) {
    const spacing = this.spacing;
    curve.arcLengthDivisions = Math.max(600, Math.min(8000, curve.points.length * 24));
    curve.updateArcLengths();
    const L = curve.getLength();
    const N = Math.max(4, Math.floor(L / spacing) + 1);

    this.length = (N - 1) * spacing;
    this.count = N;
    const pos = this.pos = new Float32Array(N * 3);
    const quat = this.quat = new Float32Array(N * 4);
    const curv = this.curv = new Float32Array(N);
    const curvLat = this.curvLat = new Float32Array(N);
    const curvVert = this.curvVert = new Float32Array(N);
    const bank = this.bank = new Float32Array(N);
    const pace = this.pace = new Float32Array(N);
    const brake = this.brake = new Float32Array(N);
    const tan = new Float32Array(N * 3);

    // ── positions, uniformly spaced in arc length ────────────────────────
    for (let i = 0; i < N; i++) {
      const u = Math.min(1, (i * spacing) / L);
      curve.getPointAt(u, _p);
      pos[i * 3] = _p.x; pos[i * 3 + 1] = _p.y; pos[i * 3 + 2] = _p.z;
    }

    // ── tangents by central difference (stabler than curve.getTangentAt) ──
    for (let i = 0; i < N; i++) {
      const a = Math.max(0, i - 1), b = Math.min(N - 1, i + 1);
      _t.set(pos[b * 3] - pos[a * 3], pos[b * 3 + 1] - pos[a * 3 + 1], pos[b * 3 + 2] - pos[a * 3 + 2]);
      if (_t.lengthSq() < 1e-12) _t.set(0, 0, -1);
      _t.normalize();
      tan[i * 3] = _t.x; tan[i * 3 + 1] = _t.y; tan[i * 3 + 2] = _t.z;
    }

    // ── parallel transport ───────────────────────────────────────────────
    const upright = o.uprightRate ?? 0;
    _t.set(tan[0], tan[1], tan[2]);
    if (o.seedNormal) _n.copy(o.seedNormal);
    else _n.copy(WORLD_UP);
    // project the seed normal perpendicular to the first tangent
    _n.addScaledVector(_t, -_n.dot(_t));
    if (_n.lengthSq() < 1e-8) { _n.set(1, 0, 0).addScaledVector(_t, -_t.x); }
    _n.normalize();

    const prevT = new THREE.Vector3().copy(_t);
    const normal = new THREE.Vector3().copy(_n);

    for (let i = 0; i < N; i++) {
      _t.set(tan[i * 3], tan[i * 3 + 1], tan[i * 3 + 2]);

      if (i > 0) {
        // minimal rotation carrying the previous tangent onto this one
        const d = THREE.MathUtils.clamp(prevT.dot(_t), -1, 1);
        if (d < 0.999999) {
          _q.setFromUnitVectors(prevT, _t);
          normal.applyQuaternion(_q);
        }
        // re-orthogonalize: numerical drift accumulates over thousands of steps
        normal.addScaledVector(_t, -normal.dot(_t));
        const l2 = normal.lengthSq();
        if (l2 < 1e-10) {
          normal.set(0, 1, 0).addScaledVector(_t, -_t.y);
          if (normal.lengthSq() < 1e-10) normal.set(1, 0, 0).addScaledVector(_t, -_t.x);
        }
        normal.normalize();

        // gentle up-righting so a long level doesn't accumulate arbitrary
        // roll. Fades out when flying near-vertical (where "up" is meaningless)
        // and is zero in dimensions that have no up at all.
        if (upright > 0) {
          const vert = Math.abs(_t.y);
          const w = (1 - Math.min(1, vert * 1.35)) * (1 - Math.exp(-upright * spacing));
          if (w > 1e-5) {
            _u.copy(WORLD_UP).addScaledVector(_t, -WORLD_UP.dot(_t));
            if (_u.lengthSq() > 1e-8) {
              _u.normalize();
              if (_u.dot(normal) > -0.9) {   // never flip through the antipode
                normal.lerp(_u, w).addScaledVector(_t, -normal.dot(_t));
                normal.normalize();
              }
            }
          }
        }
        prevT.copy(_t);
      }

      // quaternion from basis (x=right, y=up, z=back)
      _b.copy(_t).cross(normal).normalize();     // right = forward x up
      _n.copy(_b).cross(_t).normalize();         // re-derived up (exactly orthonormal)
      _p2.copy(_t).negate();                     // back
      _m.makeBasis(_b, _n, _p2);
      _q.setFromRotationMatrix(_m);
      // keep the quaternion track in one hemisphere so slerp always takes the
      // short way and any lerp-ish blend behaves
      if (i > 0 && (_q.x * quat[(i - 1) * 4] + _q.y * quat[(i - 1) * 4 + 1] +
                    _q.z * quat[(i - 1) * 4 + 2] + _q.w * quat[(i - 1) * 4 + 3]) < 0) {
        _q.set(-_q.x, -_q.y, -_q.z, -_q.w);
      }
      quat[i * 4] = _q.x; quat[i * 4 + 1] = _q.y; quat[i * 4 + 2] = _q.z; quat[i * 4 + 3] = _q.w;
      normal.copy(_n);
    }

    this.seedQuat.set(quat[0], quat[1], quat[2], quat[3]);
    this.endPos.set(pos[(N - 1) * 3], pos[(N - 1) * 3 + 1], pos[(N - 1) * 3 + 2]);
    this.endDir.set(tan[(N - 1) * 3], tan[(N - 1) * 3 + 1], tan[(N - 1) * 3 + 2]);
    this.getAxes(N - 1, null, this.endUp, null);

    // ── curvature (signed in the transported frame) ──────────────────────
    for (let i = 0; i < N; i++) {
      const a = Math.max(0, i - 1), b = Math.min(N - 1, i + 1);
      const ds = (b - a) * spacing;
      _t.set(tan[b * 3] - tan[a * 3], tan[b * 3 + 1] - tan[a * 3 + 1], tan[b * 3 + 2] - tan[a * 3 + 2])
        .divideScalar(ds || 1);
      curv[i] = _t.length();
      this.getAxes(i, _b, _n, null);
      curvLat[i] = _t.dot(_b);
      curvVert[i] = _t.dot(_n);
    }
    smoothArray(curv, 3);
    smoothArray(curvLat, 3);
    smoothArray(curvVert, 3);

    // ── bank: roll into the turn, proportional to curvature x speed² ─────
    const v = o.nominalSpeed ?? 80;
    const bankScale = o.bankScale ?? 1;
    const bankMax = o.bankMax ?? 1.15;
    for (let i = 0; i < N; i++) {
      const a = Math.atan2(v * v * curvLat[i], G) * bankScale;
      bank[i] = THREE.MathUtils.clamp(a, -bankMax, bankMax);
    }
    // blur the bank so it anticipates the turn and settles out of it
    smoothArray(bank, Math.max(2, Math.round(28 / spacing)), 3);

    // ── authored pace + braking look-ahead ───────────────────────────────
    const motifs = o.motifs;
    const pathLen = o.pathLength || L;
    const k = L / (pathLen || L);
    for (let i = 0; i < N; i++) pace[i] = 1;
    if (motifs) {
      for (let mi = 0; mi < motifs.length; mi++) {
        const m = motifs[mi];
        const i0 = Math.max(0, Math.floor((m.start * k) / spacing));
        const i1 = Math.min(N - 1, Math.ceil((m.end * k) / spacing));
        for (let i = i0; i <= i1; i++) pace[i] = m.pace;
        m.tableStart = i0 * spacing;
        m.tableEnd = i1 * spacing;
      }
      smoothArray(pace, Math.max(2, Math.round(60 / spacing)), 2);
    }

    const win = Math.max(1, Math.round((o.lookAhead ?? 150) / spacing));
    for (let i = 0; i < N; i++) {
      let mx = 0;
      const e = Math.min(N - 1, i + win);
      for (let j = i; j <= e; j++) if (curv[j] > mx) mx = curv[j];
      brake[i] = mx;
    }
    smoothArray(brake, 4);

    return this;
  }

  /** Read the basis axes of table entry i without allocating. */
  getAxes(i, right, up, forward) {
    const o = i * 4;
    const x = this.quat[o], y = this.quat[o + 1], z = this.quat[o + 2], w = this.quat[o + 3];
    quatAxes(x, y, z, w, right, up, forward);
  }

  /**
   * Sample at arc-length distance `d`.
   * @param {number} d
   * @param {object} out  {position, tangent, normal, binormal, quaternion, ...}
   * @param {number} bankMul  scales the baked bank (1 = as authored)
   */
  sampleDistance(d, out, bankMul = 1) {
    const N = this.count;
    const sp = this.spacing;
    let f = d / sp;
    if (!(f >= 0)) f = 0;
    let i = Math.floor(f);
    if (i > N - 2) { i = N - 2; }
    if (i < 0) i = 0;
    let a = f - i;
    // clamp (never extrapolate the table — callers get the endpoint frame)
    if (a < 0) a = 0; else if (a > 1) a = 1;
    const j = i + 1;

    // ── Hermite position: the stored tangents are exact derivatives wrt
    //    arc length, so this reproduces the curve to well under a millimetre
    const o3a = i * 3, o3b = j * 3;
    // quatAxes' third output is +Z (backward); forward is -Z, hence the minus
    quatAxes(this.quat[i * 4], this.quat[i * 4 + 1], this.quat[i * 4 + 2], this.quat[i * 4 + 3], null, null, _t);
    const m0x = -_t.x * sp, m0y = -_t.y * sp, m0z = -_t.z * sp;
    quatAxes(this.quat[j * 4], this.quat[j * 4 + 1], this.quat[j * 4 + 2], this.quat[j * 4 + 3], null, null, _t);
    const m1x = -_t.x * sp, m1y = -_t.y * sp, m1z = -_t.z * sp;

    const a2 = a * a, a3 = a2 * a;
    const h00 = 2 * a3 - 3 * a2 + 1, h10 = a3 - 2 * a2 + a;
    const h01 = -2 * a3 + 3 * a2, h11 = a3 - a2;

    out.position.set(
      h00 * this.pos[o3a] + h10 * m0x + h01 * this.pos[o3b] + h11 * m1x,
      h00 * this.pos[o3a + 1] + h10 * m0y + h01 * this.pos[o3b + 1] + h11 * m1y,
      h00 * this.pos[o3a + 2] + h10 * m0z + h01 * this.pos[o3b + 2] + h11 * m1z
    );

    // ── orientation: slerp the transported quaternions, then roll ────────
    _q.set(this.quat[i * 4], this.quat[i * 4 + 1], this.quat[i * 4 + 2], this.quat[i * 4 + 3]);
    _q2.set(this.quat[j * 4], this.quat[j * 4 + 1], this.quat[j * 4 + 2], this.quat[j * 4 + 3]);
    _q.slerp(_q2, a);

    const bank = (this.bank[i] + (this.bank[j] - this.bank[i]) * a) * bankMul;
    if (bank !== 0) {
      const h = bank * 0.5;
      _q2.set(0, 0, -Math.sin(h), Math.cos(h));   // roll about local forward (-Z)
      _q.multiply(_q2);
    }
    out.quaternion.copy(_q);
    quatAxes(_q.x, _q.y, _q.z, _q.w, out.binormal, out.normal, out.tangent);
    out.tangent.negate();   // quatAxes gives +Z (back); forward is -Z

    out.distance = d;
    out.bank = bank;
    out.curvature = this.curv[i] + (this.curv[j] - this.curv[i]) * a;
    out.curvatureLat = this.curvLat[i] + (this.curvLat[j] - this.curvLat[i]) * a;
    out.curvatureVert = this.curvVert[i] + (this.curvVert[j] - this.curvVert[i]) * a;
    out.pace = this.pace[i] + (this.pace[j] - this.pace[i]) * a;
    out.brake = this.brake[i] + (this.brake[j] - this.brake[i]) * a;
    return out;
  }

  scalarAt(arr, d) {
    const N = this.count;
    let f = d / this.spacing;
    if (!(f >= 0)) f = 0;
    let i = Math.floor(f);
    if (i > N - 2) i = N - 2;
    if (i < 0) i = 0;
    const a = Math.min(1, Math.max(0, f - i));
    return arr[i] + (arr[i + 1] - arr[i]) * a;
  }
}

/** Extract basis axes from a quaternion straight into vectors — no matrices. */
export function quatAxes(x, y, z, w, right, up, back) {
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  if (right) right.set(1 - (yy + zz), xy + wz, xz - wy);
  if (up) up.set(xy - wz, 1 - (xx + zz), yz + wx);
  if (back) back.set(xz + wy, yz - wx, 1 - (xx + yy));
}

/** In-place box blur, `passes` times, radius r. */
function smoothArray(arr, r, passes = 1) {
  const n = arr.length;
  if (n < 3 || r < 1) return;
  const tmp = new Float32Array(n);
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      const a = Math.max(0, i - r), b = Math.min(n - 1, i + r);
      for (let j = a; j <= b; j++) { s += arr[j]; c++; }
      tmp[i] = s / c;
    }
    arr.set(tmp);
  }
}

/** Allocate a sample result object. */
export function makeSample() {
  return {
    position: new THREE.Vector3(),
    tangent: new THREE.Vector3(0, 0, -1),
    normal: new THREE.Vector3(0, 1, 0),
    binormal: new THREE.Vector3(1, 0, 0),
    quaternion: new THREE.Quaternion(),
    distance: 0, curvature: 0, curvatureLat: 0, curvatureVert: 0,
    bank: 0, pace: 1, brake: 0,
  };
}
