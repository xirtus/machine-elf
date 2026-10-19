import * as THREE from 'three';
import { LineBasicNodeMaterial, MeshBasicNodeMaterial } from 'three/webgpu';
import { attribute, color, vec3, vec4, uv, mix, float } from 'three/tsl';
import Bus from '../core/Bus.js';
import CFG from '../core/Config.js';
import { buildSegment, extendSegment, presetFor, makeRng } from '../util/rail-path.js';
import { FrameTable, makeSample } from '../util/rail-frames.js';

/**
 * THE RAIL — the flight path and the moving frame of reference the whole game
 * is built on top of.
 *
 * Coordinate space: everything the rail reports is in `ctx.world` space.
 * The camera rig transforms to scene space; content parented under `world`
 * can use rail coordinates directly.
 *
 * ── Public API ────────────────────────────────────────────────────────────
 *  sample(t, out?)              → {position,tangent,normal,binormal,quaternion,
 *                                  curvature,curvatureLat,bank,pace,distance}
 *                                 t is 0..1 over the whole generated path.
 *                                 Returned object is pooled (8 deep) — copy
 *                                 what you need if you hold it across frames.
 *  sampleDistance(m, out?)      → same, addressed by metres along the path
 *  sampleAhead(metres, out?)    → same, relative to the craft's position
 *  frameAt(t, outQuat?)         → THREE.Quaternion (forward = -Z, up = +Y)
 *  matrixAt(t, outMat4?)        → THREE.Matrix4 of the moving cage
 *  curvatureAt(t)               → 1/metres (unsigned)
 *  curvatureLatAt(t)            → signed, + = turning right
 *  bankAt(t)                    → baked roll in radians
 *  tAt(distance)                → normalized parameter for a distance
 *  cageToWorld(x,y,ahead,out)   → world point for a cage offset in -1..1
 *
 *  .distance      metres travelled along the current path
 *  .odometer      metres travelled since boot (never resets)
 *  .speed         current forward speed, m/s
 *  .speedScale    external multiplier — boost, boss hover, director beats
 *  .length        total metres of the current path
 *  .t             normalized position, 0..1
 *  .progress      0..1 through the current segment
 *  .current       live sample at the craft position (stable object reference)
 *  .node          THREE.Object3D at the current frame, parented to world
 *  .segment       {index, dimension, name, startDist, endDist}
 *  .motif         {kind, start, end, intensity, pace} — current manoeuvre
 *  .preset        dimension character used to author the path
 *
 *  regenerate({dimension, seed, length, continuous})  swap path character
 *  extend(metres)                                     append more path
 *  setDebug(bool)                                     frame ribbon + rungs
 *  verifyFrames(n)                                    numeric stability report
 *
 * ── Events ────────────────────────────────────────────────────────────────
 *  emits  rail:generated {dimension, length, segment}
 *         rail:extended  {length}
 *         rail:motif     {kind, index, intensity, length, dimension}
 *         rail:segment   {index, dimension}
 *         rail:end       {remaining}   (fires once, near the end of the path)
 *  listens dimension:enter, player:boost
 */

const TUNE = {
  spacing: 4,             // frame table resolution, metres
  segmentLength: 5400,
  extendBy: 2800,
  extendWhenWithin: 1800,
  maxLength: 16000,
  baseSpeed: 82,
  minSpeed: 30,
  maxSpeed: 165,
  accel: 15,              // m/s² — slow enough that straights *feel* like acceleration
  decel: 46,              // braking into a corner is decisive
  brakeGain: 30,          // how hard curvature slows the flight
  brakeFloor: 0.44,
  bankMax: 1.18,
  lookAheadBrake: 170,
};

// ── module-scope scratch: zero allocation in update ───────────────────────
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _scratch = makeSample();

export class Rail {
  constructor() {
    this.name = 'rail';
    this.order = 20;

    this.table = new FrameTable(TUNE.spacing);
    this.curve = null;
    this.seg = null;                 // authoring state from rail-path
    this.length = 0;
    this.distance = 0;
    this.odometer = 0;
    this.speed = TUNE.baseSpeed;
    this.speedScale = 1;
    this.bankMul = 1;
    this.dimension = 0;
    this.seed = (Math.random() * 0xffffffff) >>> 0;
    this.paused = false;

    this.segment = { index: -1, dimension: 0, name: '', startDist: 0, endDist: 0 };
    this.motif = null;
    this.preset = presetFor(0);

    this.current = makeSample();
    this.node = new THREE.Object3D();
    this.node.name = 'railNode';
    this.node.matrixAutoUpdate = false;

    // pooled sample results — 8 live samples per frame before aliasing
    this._pool = [];
    for (let i = 0; i < 8; i++) this._pool.push(makeSample());
    this._poolIdx = 0;

    this._boostMul = 1;
    this._boostTimer = 0;
    this._endFired = false;
    this._debug = null;
    this._debugOn = false;
    this._unsub = [];
  }

  // ───────────────────────────────────────────────────────────── lifecycle
  async init(ctx) {
    this._ctx = ctx;
    ctx.world.add(this.node);

    const q = typeof location !== 'undefined' ? location.search : '';
    const wantDebug = /(^|[?&])raildebug/.test(q) || !!ctx.cfg?.debug?.rail;

    this.generate({ dimension: 0, seed: this.seed, continuous: false });

    this._unsub.push(Bus.on('dimension:enter', (d) => {
      if (d && typeof d.index === 'number' && d.index !== this.dimension) {
        this.regenerate({ dimension: d.index });
      }
    }));
    this._unsub.push(Bus.on('player:boost', (d) => {
      this._boostMul = d?.on ? (ctx.cfg.player.boostMul ?? 1.6) : 1;
    }));

    if (wantDebug) this.setDebug(true);
    if (typeof window !== 'undefined') window.__rail = this;
  }

  dispose() {
    for (const u of this._unsub) u();
    this._unsub.length = 0;
    this.setDebug(false);
    this.node.parent?.remove(this.node);
  }

  // ──────────────────────────────────────────────────────────── generation
  /**
   * Build a fresh path. `continuous` starts it from the current frame so a
   * dimension swap doesn't teleport the craft.
   */
  generate(o = {}) {
    const dimension = o.dimension ?? this.dimension;
    const seed = o.seed ?? ((this.seed + 0x9e3779b9 * (dimension + 1)) >>> 0);
    const targetLength = o.length ?? TUNE.segmentLength;

    let start = null;
    let seedNormal = null;
    if (o.continuous !== false && this.table.count > 0) {
      const s = this.sampleDistance(this.distance, _scratch);
      start = { pos: s.position.clone(), dir: s.tangent.clone(), up: s.normal.clone() };
      seedNormal = s.normal.clone();
    }

    this.seg = buildSegment({ seed, dimension, targetLength, start });
    this.preset = this.seg.preset;
    this.dimension = dimension;
    this._rebuild(seedNormal);

    this.distance = 0;
    this._endFired = false;
    this.segment = {
      index: this.segment.index + 1,
      dimension,
      name: this.preset.name,
      startDist: 0,
      endDist: this.length,
    };
    this.motif = this.seg.motifs[0] || null;
    this._motifIndex = -1;

    this.sampleDistance(0, this.current);
    this._syncNode();

    if (this._debugOn) this._buildDebug();
    Bus.emit('rail:generated', {
      dimension, length: this.length, segment: this.segment.index, name: this.preset.name,
    });
    Bus.emit('rail:segment', { index: this.segment.index, dimension });
    return this;
  }

  /** Swap the path character for a new dimension, continuing from here. */
  regenerate(o = {}) {
    return this.generate({ continuous: true, ...o });
  }

  /** Append more path. Called automatically as the craft nears the end. */
  extend(metres = TUNE.extendBy) {
    if (!this.seg) return false;
    if (this.length >= TUNE.maxLength) return false;
    extendSegment(this.seg, { targetLength: metres });
    this._rebuild(null);
    this.segment.endDist = this.length;
    if (this._debugOn) this._buildDebug();
    Bus.emit('rail:extended', { length: this.length });
    return true;
  }

  _rebuild(seedNormal) {
    const pts = this.seg.points;
    this.curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
    this.table.build(this.curve, {
      // Extending re-runs the transport from the same seed over identical
      // geometry, so already-flown frames come out bit-identical.
      seedNormal: seedNormal || this._seedNormal || null,
      uprightRate: this.preset.uprightRate,
      bankScale: this.preset.bankScale,
      bankMax: TUNE.bankMax,
      nominalSpeed: TUNE.baseSpeed * this.preset.speed,
      motifs: this.seg.motifs,
      pathLength: this.seg.pathLength,
      lookAhead: TUNE.lookAheadBrake,
    });
    if (seedNormal) this._seedNormal = seedNormal.clone();
    else if (!this._seedNormal) {
      this._seedNormal = new THREE.Vector3();
      this.table.getAxes(0, null, this._seedNormal, null);
    }
    this.length = this.table.length;
  }

  // ──────────────────────────────────────────────────────────────── sampling
  _out(out) {
    if (out) return out;
    const o = this._pool[this._poolIdx];
    this._poolIdx = (this._poolIdx + 1) & 7;
    return o;
  }

  /** t in 0..1 over the whole generated path. */
  sample(t, out) {
    return this.table.sampleDistance(t * this.length, this._out(out), this.bankMul);
  }

  sampleDistance(d, out) {
    return this.table.sampleDistance(d, this._out(out), this.bankMul);
  }

  /** Relative to where the craft is right now — the one you usually want. */
  sampleAhead(metres, out) {
    return this.table.sampleDistance(this.distance + metres, this._out(out), this.bankMul);
  }

  tAt(distance) { return this.length > 0 ? distance / this.length : 0; }
  get t() { return this.tAt(this.distance); }

  /** 0..1 through the current segment. */
  get progress() {
    const span = this.segment.endDist - this.segment.startDist;
    return span > 0 ? THREE.MathUtils.clamp((this.distance - this.segment.startDist) / span, 0, 1) : 0;
  }

  /** 0..1 through the current manoeuvre — for beat-synced spawning. */
  get motifProgress() {
    const m = this.motif;
    if (!m || m.tableEnd == null) return 0;
    const span = m.tableEnd - m.tableStart;
    return span > 0 ? THREE.MathUtils.clamp((this.distance - m.tableStart) / span, 0, 1) : 0;
  }

  curvatureAt(t) { return this.table.scalarAt(this.table.curv, t * this.length); }
  curvatureLatAt(t) { return this.table.scalarAt(this.table.curvLat, t * this.length); }
  bankAt(t) { return this.table.scalarAt(this.table.bank, t * this.length) * this.bankMul; }

  /** Orientation of the moving cage at t. forward = -Z, up = +Y. */
  frameAt(t, outQuat) {
    const s = this.table.sampleDistance(t * this.length, _scratch, this.bankMul);
    return (outQuat || new THREE.Quaternion()).copy(s.quaternion);
  }

  matrixAt(t, outMat) {
    const s = this.table.sampleDistance(t * this.length, _scratch, this.bankMul);
    return (outMat || new THREE.Matrix4()).compose(s.position, s.quaternion, ONE);
  }

  /**
   * Map a cage offset (-1..1 in each axis) to a world point `ahead` metres
   * along the rail. This is the movement cage the player flies inside.
   */
  cageToWorld(x, y, ahead = 0, out) {
    const s = this.table.sampleDistance(this.distance + ahead, _scratch, this.bankMul);
    const o = out || new THREE.Vector3();
    o.copy(s.position)
      .addScaledVector(s.binormal, x * CFG.player.cageWidth * 0.5)
      .addScaledVector(s.normal, y * CFG.player.cageHeight * 0.5);
    return o;
  }

  // ──────────────────────────────────────────────────────────────── update
  update(dt, ctx) {
    if (!this.table.count || this.paused) return;

    if (this._boostTimer > 0) {
      this._boostTimer -= dt;
      if (this._boostTimer <= 0) this._boostMul = 1;
    }

    // Target speed: authored pace x curvature braking x external scale.
    // `brake` is the worst curvature in the next ~170m, so the flight eases
    // *before* the corner rather than lurching inside it.
    const s = this.table.sampleDistance(this.distance, _scratch, this.bankMul);
    const brake = 1 / (1 + s.brake * TUNE.brakeGain);
    const curveFactor = Math.max(TUNE.brakeFloor, brake);
    const target = THREE.MathUtils.clamp(
      TUNE.baseSpeed * this.preset.speed * s.pace * curveFactor * this.speedScale * this._boostMul,
      TUNE.minSpeed, TUNE.maxSpeed
    );

    const rate = target > this.speed ? TUNE.accel : TUNE.decel;
    const d = target - this.speed;
    const step = rate * dt;
    this.speed += Math.abs(d) < step ? d : Math.sign(d) * step;

    const adv = this.speed * dt;
    this.distance += adv;
    this.odometer += adv;

    // end of path handling
    const remaining = this.length - this.distance;
    if (remaining < TUNE.extendWhenWithin) {
      if (this.length < TUNE.maxLength) this.extend();
      else if (!this._endFired) {
        this._endFired = true;
        Bus.emit('rail:end', { remaining });
      }
    }
    if (this.distance > this.length - 8) {
      this.distance = this.length - 8;   // park at the end rather than run off
      this.speed *= 0.9;
    }

    this.table.sampleDistance(this.distance, this.current, this.bankMul);
    this._syncNode();
    this._trackMotif();
  }

  _syncNode() {
    const c = this.current;
    this.node.position.copy(c.position);
    this.node.quaternion.copy(c.quaternion);
    this.node.matrix.compose(c.position, c.quaternion, ONE);
    this.node.matrixWorldNeedsUpdate = true;
  }

  _trackMotif() {
    const ms = this.seg?.motifs;
    if (!ms) return;
    // motifs are ordered; walk forward from the cached index
    let i = this._motifIndex;
    while (i + 1 < ms.length && this.distance >= (ms[i + 1].tableStart ?? Infinity)) i++;
    if (i !== this._motifIndex) {
      this._motifIndex = i;
      this.motif = ms[Math.max(0, i)];
      if (this.motif) {
        Bus.emit('rail:motif', {
          kind: this.motif.kind, index: this.motif.index,
          intensity: this.motif.intensity, length: this.motif.length,
          still: this.motif.still, dimension: this.dimension,
        });
      }
    }
  }

  /** Temporary speed multiplier (boost pickups, director beats). */
  boost(mul = 1.5, duration = 1.2) {
    this._boostMul = mul;
    this._boostTimer = duration;
  }

  // ───────────────────────────────────────────────────────────── verification
  /**
   * Numeric proof that the frame never flips. Walks the whole path and checks
   * orthonormality, continuity of the up-vector, and roll rate.
   */
  verifyFrames(samples = 3000) {
    const a = makeSample(), b = makeSample();
    let minDot = 1, maxOrtho = 0, maxRoll = 0, flips = 0, worstAt = 0;
    const step = this.length / samples;
    this.table.sampleDistance(0, a, this.bankMul);
    for (let i = 1; i <= samples; i++) {
      const d = i * step;
      this.table.sampleDistance(d, b, this.bankMul);
      const dot = a.normal.dot(b.normal);
      if (dot < minDot) { minDot = dot; worstAt = d; }
      if (dot < 0) flips++;
      const o = Math.abs(a.normal.dot(a.tangent));
      if (o > maxOrtho) maxOrtho = o;
      const roll = Math.acos(THREE.MathUtils.clamp(dot, -1, 1)) / step;
      if (roll > maxRoll) maxRoll = roll;
      a.normal.copy(b.normal); a.tangent.copy(b.tangent);
    }
    const report = {
      ok: flips === 0 && minDot > 0.9 && maxOrtho < 1e-3,
      samples, length: +this.length.toFixed(1), stepMetres: +step.toFixed(2),
      flips, minConsecutiveDot: +minDot.toFixed(6), worstAtMetres: +worstAt.toFixed(1),
      maxOrthogonalityError: +maxOrtho.toExponential(2),
      maxRollRadPerMetre: +maxRoll.toFixed(5),
      motifs: this.seg ? this.seg.motifs.map((m) => m.kind).join(',') : '',
    };
    return report;
  }

  // ──────────────────────────────────────────────────────────────── debug viz
  /** Frame ribbon + up/right rungs. Off by default; `?raildebug` turns it on. */
  setDebug(on) {
    this._debugOn = !!on;
    if (!on) { this._clearDebug(); return; }
    this._buildDebug();
  }

  _clearDebug() {
    if (!this._debug) return;
    this._debug.traverse((o) => {
      o.geometry?.dispose?.();
      o.material?.dispose?.();
    });
    this._debug.parent?.remove(this._debug);
    this._debug = null;
  }

  _buildDebug() {
    this._clearDebug();
    const ctx = this._ctx;
    if (!ctx) return;
    const g = new THREE.Group();
    g.name = 'railDebug';

    const N = this.table.count;
    const stride = Math.max(1, Math.round(3 / TUNE.spacing));
    const s = makeSample();

    // centreline
    const line = new Float32Array(Math.ceil(N / stride) * 3);
    let li = 0;
    // rungs: right (red) and up (green), every ~24 m
    const rungEvery = Math.max(1, Math.round(24 / TUNE.spacing));
    const rungCount = Math.ceil(N / rungEvery);
    const rUp = new Float32Array(rungCount * 6);
    const rRight = new Float32Array(rungCount * 6);
    // ribbon: a band swept along the binormal — banking reads instantly
    const ribbon = new Float32Array(Math.ceil(N / stride) * 6);
    const ribbonUV = new Float32Array(Math.ceil(N / stride) * 4);
    let ri = 0, ui = 0, ki = 0;

    for (let i = 0; i < N; i += stride) {
      this.table.sampleDistance(i * TUNE.spacing, s, this.bankMul);
      line[li++] = s.position.x; line[li++] = s.position.y; line[li++] = s.position.z;

      const w = 5.0;
      ribbon[ri++] = s.position.x - s.binormal.x * w;
      ribbon[ri++] = s.position.y - s.binormal.y * w;
      ribbon[ri++] = s.position.z - s.binormal.z * w;
      ribbon[ri++] = s.position.x + s.binormal.x * w;
      ribbon[ri++] = s.position.y + s.binormal.y * w;
      ribbon[ri++] = s.position.z + s.binormal.z * w;
      const u = i / N;
      ribbonUV[ui++] = u; ribbonUV[ui++] = 0;
      ribbonUV[ui++] = u; ribbonUV[ui++] = 1;

      if (i % rungEvery === 0 && ki < rungCount * 6) {
        rUp[ki] = s.position.x; rUp[ki + 1] = s.position.y; rUp[ki + 2] = s.position.z;
        rUp[ki + 3] = s.position.x + s.normal.x * 7;
        rUp[ki + 4] = s.position.y + s.normal.y * 7;
        rUp[ki + 5] = s.position.z + s.normal.z * 7;
        rRight[ki] = s.position.x; rRight[ki + 1] = s.position.y; rRight[ki + 2] = s.position.z;
        rRight[ki + 3] = s.position.x + s.binormal.x * 7;
        rRight[ki + 4] = s.position.y + s.binormal.y * 7;
        rRight[ki + 5] = s.position.z + s.binormal.z * 7;
        ki += 6;
      }
    }

    const mkLines = (arr, hex, LineType = THREE.LineSegments) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      const mat = new LineBasicNodeMaterial();
      mat.colorNode = color(hex);
      mat.transparent = true;
      mat.opacity = 0.9;
      return new LineType(geo, mat);
    };

    g.add(mkLines(line.subarray(0, li), 0x00e5ff, THREE.Line));
    g.add(mkLines(rUp.subarray(0, ki), 0x66ff99));
    g.add(mkLines(rRight.subarray(0, ki), 0xff3388));

    // ribbon strip
    const rgeo = new THREE.BufferGeometry();
    rgeo.setAttribute('position', new THREE.BufferAttribute(ribbon.subarray(0, ri), 3));
    rgeo.setAttribute('uv', new THREE.BufferAttribute(ribbonUV.subarray(0, ui), 2));
    const quads = ri / 6 - 1;
    const idx = new Uint32Array(quads * 6);
    for (let q = 0; q < quads; q++) {
      const a = q * 2;
      idx[q * 6] = a; idx[q * 6 + 1] = a + 1; idx[q * 6 + 2] = a + 2;
      idx[q * 6 + 3] = a + 1; idx[q * 6 + 4] = a + 3; idx[q * 6 + 5] = a + 2;
    }
    rgeo.setIndex(new THREE.BufferAttribute(idx, 1));
    const rmat = new MeshBasicNodeMaterial();
    rmat.colorNode = mix(vec3(0.0, 0.10, 0.22), vec3(0.35, 0.02, 0.28), uv().y);
    rmat.side = THREE.DoubleSide;
    rmat.transparent = true;
    rmat.opacity = 0.42;
    rmat.depthWrite = false;
    g.add(new THREE.Mesh(rgeo, rmat));

    ctx.world.add(g);
    this._debug = g;
  }
}

const ONE = new THREE.Vector3(1, 1, 1);

export default Rail;
