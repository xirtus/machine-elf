import * as THREE from 'three';
import Bus from '../core/Bus.js';
import CFG from '../core/Config.js';

const CFG_HALF_W = CFG.player.cageWidth * 0.5;
const CFG_HALF_H = CFG.player.cageHeight * 0.5;
import Palette from '../render/Palette.js';
import DIMENSIONS from '../util/fractal-dimensions.js';
import { sacredGeometry, voidMatte, fractalShell, clockworkBrass } from '../render/Materials.js';
import { lathe, jewel, gear, shardRing, cage, compose } from '../util/enemy-geometry.js';
import { makeHoopGeometry } from '../util/craft-geometry.js';
import { tickEase, hash11, Rng } from '../util/enemy-math.js';

/**
 * DIMENSIONS — owns descent.
 *
 *  1. The transition: goTo(i) drives a ~3.4 s melt. Every frame of it we emit
 *     `dimension:shift {from,to,progress}` and Palette / Fractal / PostFX all
 *     lerp off that one number. At the peak of the melt the structures are
 *     reseeded and the DE index swaps — hidden behind maximum warp.
 *
 *  2. The midground: between the raymarched far field and the dogfight sits
 *     a field of impossible machines — gyroscopes, toothed gates, spires and
 *     shard halos, instanced, seeded along the rail, ticking with escapement
 *     motion. They are what your brain uses for speed. Without them the
 *     fractal is a screensaver; with them it's a place you fly through.
 *
 *  3. Fog: exponential haze driven by the palette, so depth layers separate.
 */

const FIELD = [
  // density, min/max lateral offset, min/max scale, per dimension
  { count: 46, near: 26, far: 150, sMin: 5, sMax: 24 },
  { count: 54, near: 24, far: 170, sMin: 6, sMax: 32 },
  { count: 42, near: 28, far: 190, sMin: 8, sMax: 42 },
  { count: 58, near: 22, far: 160, sMin: 5, sMax: 28 },
  { count: 50, near: 26, far: 210, sMin: 9, sMax: 52 },
  { count: 60, near: 20, far: 220, sMin: 7, sMax: 60 },
];
const SPACING = 46;         // metres between structure slots
const AHEAD = 1150;         // spawn window
const BEHIND = 140;         // recycle window
const GATES_EVERY = 7;      // every Nth slot is a fly-through gate on the rail

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _off = new THREE.Vector3();

export class Dimensions {
  constructor() {
    this.name = 'dimensions';
    this.order = 11;

    this.current = 0;
    this.transitioning = false;
    this._from = 0;
    this._to = 0;
    this._t = 1;
    this._dur = 3.4;
    this._reseeded = true;

    this._slots = [];        // per-slot static data
    this._gateRing = 0;
    this._cursor = 0;        // next slot distance to evaluate
    this._fields = [];       // instanced meshes
    this._unsub = [];
  }

  async init(ctx) {
    this._ctx = ctx;
    const { scene } = ctx;

    scene.fog = new THREE.FogExp2(0x000000, 0.006);

    /* ── archetype geometry: nothing here is a three primitive ─────────── */
    // A. gyroscope — nested toothed rings + caged core
    const gyroGeo = compose([
      { geo: makeHoopGeometry({ R: 1.0, segs: 64, teeth: 20, toothAmp: 0.06 }), p: [0, 0, 0], e: [Math.PI / 2, 0, 0] },
      { geo: makeHoopGeometry({ R: 0.66, segs: 48, teeth: 14, toothAmp: 0.08 }), p: [0, 0, 0], e: [0.6, 0.4, 0] },
      { geo: jewel({ sides: 6, seed: 91, height: 0.9, radius: 0.3 }), p: [0, 0, 0], e: [0.2, 0.5, 0.1] },
    ]);
    // B. spire — a cathedral finial
    const spireGeo = compose([
      { geo: lathe({ sides: 7, seed: 61, jitter: 0.1, twist: 0.5, profile: [[0, -1.6], [0.5, -1.2], [0.28, -0.4], [0.42, 0.1], [0.16, 0.9], [0.22, 1.25], [0, 1.9]] }), p: [0, 0, 0] },
      { geo: shardRing({ count: 7, radius: 0.62, size: 0.16, seed: 77 }), p: [0, 0.55, 0] },
      { geo: gear({ teeth: 9, rOuter: 0.5, rInner: 0.36, thick: 0.07, seed: 23, gap: 1 }), p: [0, -0.6, 0] },
    ]);
    // C. gate — a toothed halo you thread
    const gateGeo = compose([
      { geo: makeHoopGeometry({ R: 1.0, segs: 96, teeth: 28, toothAmp: 0.035 }), p: [0, 0, 0] },
      { geo: shardRing({ count: 12, radius: 1.0, size: 0.06, seed: 55, wobble: 0.06 }), p: [0, 0, 0], e: [0, 0, Math.PI / 2] },
    ]);
    // D. reliquary — floating jewel cluster (the "elf reliquary")
    const reliGeo = compose([
      { geo: jewel({ sides: 5, seed: 7, height: 1.5, radius: 0.5, jitter: 0.24 }), p: [0, 0, 0], e: [0.2, 0, 0.15] },
      { geo: jewel({ sides: 4, seed: 12, height: 0.8, radius: 0.28, jitter: 0.3 }), p: [0.5, 0.4, 0.2], e: [0.7, 0.9, 0] },
      { geo: jewel({ sides: 4, seed: 19, height: 0.66, radius: 0.24, jitter: 0.3 }), p: [-0.44, -0.3, -0.18], e: [-0.5, 0.4, 0.9] },
      { geo: cage({ ribs: 5, height: 2.6, radius: 0.9, seed: 33 }), p: [0, 0, 0] },
    ]);

    const defs = [
      { geo: gyroGeo, mat: clockworkBrass({ scale: 0.5, glow: 0.5, anisotropy: 0.85 }), kind: 'spin' },
      { geo: spireGeo, mat: fractalShell({ scale: 0.5, space: 'local' }), kind: 'still' },
      { geo: gateGeo, mat: sacredGeometry({ freq: 5.0, rings: 0.6, spokes: 0.3, thickness: 1.2, intensity: 3.4 }), kind: 'spin' },
      { geo: reliGeo, mat: voidMatte({ rim: 1.7, scale: 0.8 }), kind: 'bob' },
    ];

    const maxCount = Math.max(...FIELD.map((f) => f.count));
    this._fields = defs.map((d) => {
      const mesh = new THREE.InstancedMesh(d.geo, d.mat, maxCount);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.count = 0;
      ctx.world.add(mesh);
      return { mesh, kind: d.kind, used: 0 };
    });

    // slot store
    for (let i = 0; i < 160; i++) {
      this._slots.push({
        live: false, dist: 0, field: 0, seed: 0,
        px: 0, py: 0, pz: 0,            // offset from rail point (frame space)
        rx: 0, ry: 0, rz: 0, scale: 1, spinRate: 0, tickStep: 0,
        passed: false,
      });
    }
    this._cursor = 120;
    this._seed = 1337;

    Bus.emit('dimension:enter', { index: 0, def: DIMENSIONS[0], initial: true });
  }

  /** Begin the melt toward dimension `i`. */
  goTo(i, dur = 3.4) {
    const to = ((i | 0) % Palette.count + Palette.count) % Palette.count;
    if (to === this.current || this.transitioning) return;
    this._from = this.current;
    this._to = to;
    this._t = 0;
    this._dur = dur;
    this.transitioning = true;
    this._reseeded = false;
    Bus.emit('dimension:shiftStart', { from: this._from, to, duration: dur });
  }

  /* ── structure field ─────────────────────────────────────────────────── */

  _spawnSlot(slot, dist, dimIdx) {
    const rng = new Rng((this._seed + Math.floor(dist) * 7919) >>> 0);
    const f = FIELD[dimIdx % FIELD.length];
    const rail = this._ctx.engine.get('rail');

    const isGate = (Math.floor(dist / SPACING) % GATES_EVERY) === 2;
    slot.live = true;
    slot.dist = dist;
    slot.seed = rng.next() * 1000;

    if (isGate) {
      slot.field = 2;                                   // gate archetype
      slot.px = rng.range(-3, 3);
      slot.py = rng.range(-1.5, 2);
      slot.scale = rng.range(11, 15);
    } else {
      // weighted pick: gyros & reliquaries common, spires rarer
      const r = rng.next();
      slot.field = r < 0.38 ? 0 : r < 0.55 ? 1 : r < 0.72 ? 2 : 3;
      const side = rng.next() < 0.5 ? -1 : 1;
      // near lane: 18% of machines whoosh past close — the speed read
      const nearLane = rng.next() < 0.18;
      const lat = nearLane
        ? rng.range(24, 38) * side
        : rng.range(f.near, f.far) * side;
      slot.px = lat;
      slot.py = nearLane
        ? rng.range(-7, 9)
        : rng.range(-f.far * 0.5, f.far * 0.65);
      slot.scale = nearLane ? rng.range(f.sMin * 0.45, f.sMax * 0.62) : rng.range(f.sMin, f.sMax);
    }
    slot.rx = rng.range(0, Math.PI * 2);
    slot.ry = rng.range(0, Math.PI * 2);
    slot.rz = rng.range(0, Math.PI * 2);
    slot.spinRate = rng.range(0.25, 1.1) * (rng.next() < 0.5 ? -1 : 1);
    slot.tickStep = [Math.PI / 6, Math.PI / 4, Math.PI / 12][Math.floor(rng.next() * 3)];
    // world position is resolved per-frame against the live rail frame
  }

  _writeInstance(slot, time) {
    const rail = this._ctx.engine.get('rail');
    const s = rail.sampleDistance(slot.dist);
    _off.set(slot.px, slot.py, slot.pz);
    _p.copy(s.position)
      .addScaledVector(s.binormal, _off.x)
      .addScaledVector(s.normal, _off.y);

    // escapement spin: angle advances in ticking quanta, never linearly
    const tt = time * slot.spinRate + slot.seed;
    const tick = Math.floor(tt);
    const frac = tt - tick;
    const spun = (tick + tickEase(frac, 0.42, 4.5, 4.0)) * slot.tickStep;

    _e.set(slot.rx + spun * 0.35, slot.ry + spun, slot.rz + spun * 0.13);
    _q.setFromEuler(_e);
    const bob = Math.sin(time * 0.4 + slot.seed * 3.1) * 1.2;
    _p.addScaledVector(s.normal, bob * 0.4);
    _s.setScalar(slot.scale);
    _m.compose(_p, _q, _s);
    return _m;
  }

  update(dt, ctx) {
    const { scene, camera } = ctx;
    const time = ctx.time.elapsed;

    /* fog follows the palette's live params */
    if (scene.fog) {
      scene.fog.color.copy(Palette.fog);
      scene.fog.density = Palette.params.fogDensity * 0.34;
    }

    /* ── transition sequencing ─────────────────────────────────────────── */
    if (this.transitioning) {
      this._t += dt / this._dur;
      const p = Math.min(1, this._t);
      Bus.emit('dimension:shift', { from: this._from, to: this._to, progress: p });

      const post = ctx.engine.get('postfx');
      const spike = Math.sin(p * Math.PI);
      post?.setPsych(Math.min(1, Palette.params.psych + spike * 0.55));

      // mid-melt: blinding flash covers the swap, then reseed
      if (!this._reseeded && p >= 0.48 && p < 0.56) {
        post?.flash(0.5);
      }
      if (!this._reseeded && p >= 0.5) {
        this._reseeded = true;
        this._seed = (this._seed * 1664525 + 1013904223) >>> 0;
        for (const s of this._slots) s.live = false;
        const rail = ctx.engine.get('rail');
        this._cursor = (rail?.distance ?? 0) + 100;
        Bus.emit('dimension:swapped', { from: this._from, to: this._to });
      }
      if (p >= 1) {
        this.transitioning = false;
        this.current = this._to;
        post?.setWarp(0);
        post?.setPsych(Palette.params.psych);
        Bus.emit('dimension:enter', { index: this.current, def: DIMENSIONS[this.current % DIMENSIONS.length] });
      }
    } else {
      const post = ctx.engine.get('postfx');
      post?.setPsych(Palette.params.psych);
    }

    /* ── structure field streaming ─────────────────────────────────────── */
    const rail = ctx.engine.get('rail');
    if (!rail || !rail.table?.count) return;
    const f = FIELD[this.current % FIELD.length];
    const dimIdx = this.current;

    // spawn ahead
    while (this._cursor < rail.distance + AHEAD && this._cursor < rail.length - 200) {
      let slot = null;
      for (const s of this._slots) if (!s.live) { slot = s; break; }
      if (!slot) break;
      this._spawnSlot(slot, this._cursor, dimIdx);
      this._cursor += SPACING * (0.7 + hash11(this._cursor * 0.37) * 0.7);
    }

    // write matrices, count live, recycle behind
    const counts = this._counts || (this._counts = [0, 0, 0, 0]);
    counts[0] = counts[1] = counts[2] = counts[3] = 0;
    for (const s of this._slots) {
      if (!s.live) continue;

      /* gate threading: the moment the player's rail position crosses the
         gate's plane, measure how close to centre they flew */
      if (s.field === 2 && !s.passed && rail.distance >= s.dist) {
        s.passed = true;
        const player = ctx.engine.get('player');
        if (player?.alive) {
          // lateral miss distance in metres
          const mx = player.cageOffset.x * CFG_HALF_W - s.px;
          const my = player.cageOffset.y * CFG_HALF_H - s.py;
          const miss = Math.sqrt(mx * mx + my * my);
          const inner = s.scale * 0.62;              // generous inner radius
          if (miss < inner) {
            Bus.emit('gate:pass', { dist: s.dist, precision: 1 - miss / inner });
            rail.boost(1.35, 1.1);
          }
        }
      }

      if (s.dist < rail.distance - BEHIND) { s.live = false; continue; }
      const field = this._fields[s.field];
      if (counts[s.field] >= f.count) continue;
      const mat4 = this._writeInstance(s, time);
      field.mesh.setMatrixAt(counts[s.field]++, mat4);
    }
    for (let i = 0; i < this._fields.length; i++) {
      const fm = this._fields[i].mesh;
      fm.count = counts[i];
      fm.instanceMatrix.needsUpdate = true;
    }
  }

  dispose() { for (const u of this._unsub) u(); }
}
export default Dimensions;
