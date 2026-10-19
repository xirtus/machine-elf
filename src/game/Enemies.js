import * as THREE from 'three';
import Bus from '../core/Bus.js';
import CFG from '../core/Config.js';
import Palette from '../render/Palette.js';
import { resolveMaterials } from '../util/enemy-materials.js';
import {
  lathe, jewel, strut, blade, gear, shardRing, cage, dart, thorn, compose,
} from '../util/enemy-geometry.js';
import {
  SV, SQ, Rng, hash11, shash, tickEase, escapement, anticipate, quantAngle,
  damp, dampV, clamp, saturate, lookQuat,
} from '../util/enemy-math.js';
import { ndcDistFrac } from '../util/weap-math.js';

/**
 * THE CLOCKWORK ELVES.
 *
 * Jewelled automata made of neon glass with brass escapements inside. The
 * two rules from enemy-math.js govern everything they do:
 *
 *   1. ESCAPEMENT EASING — poses snap with overshoot, then hold DEAD STILL.
 *   2. QUANTISED PHASE — decisions and rotations only change on tick edges.
 *
 * Between ticks an elf is a statue. That stillness, against the fluid rail
 * flight, is the entire DMT-automaton read.
 *
 * Rendering: per type, one InstancedMesh for glass parts + one for brass,
 * with per-instance aTint / aState (flash, telegraph, dissolve, seed).
 * Bullets: one instanced pool of hostile darts + an inverted-hull outline,
 * in the reserved hostile hue. Ikaruga readability rules, always.
 */

/* ── type table ─────────────────────────────────────────────────────────── */
const TYPES = {
  wisp: {
    cap: 26, hp: 1, radius: 1.0, score: 100, scale: [2.2, 3.1],
    fire: { range: 380, period: 2.2, telegraph: 0.45, pattern: 'aimed', speed: 72 },
    build() {
      const glass = compose([
        { geo: jewel({ sides: 6, seed: 11, height: 0.75, radius: 0.42 }), p: [0, 0, 0] },
        { geo: shardRing({ count: 5, radius: 0.5, size: 0.1, seed: 21 }), p: [0, -0.1, 0] },
      ]);
      const brass = compose([
        { geo: gear({ teeth: 8, rOuter: 0.3, rInner: 0.2, thick: 0.05, seed: 5, gap: 1 }), p: [0, -0.32, 0] },
      ]);
      return { glass, brass };
    },
  },
  weaver: {
    cap: 18, hp: 3, radius: 1.35, score: 250, scale: [3.2, 4.4],
    fire: { range: 400, period: 2.9, telegraph: 0.55, pattern: 'burst3', speed: 88 },
    build() {
      const glass = compose([
        { geo: lathe({ sides: 6, seed: 31, jitter: 0.12, twist: 0.8, profile: [[0, -1.1], [0.3, -0.6], [0.42, 0], [0.26, 0.7], [0, 1.25]] }), p: [0, 0, 0], e: [Math.PI / 2, 0, 0] },
        { geo: blade({ seed: 7 }), p: [0.34, 0, 0.1], e: [0, 0, -0.5] },
        { geo: blade({ seed: 9 }), p: [-0.36, 0, -0.06], e: [0, 0, 2.6] },
      ]);
      const brass = compose([
        { geo: strut({ len: 1.3, r0: 0.05, r1: 0.02, sides: 3, seed: 13 }), p: [0, 0.15, 0.3], e: [0.9, 0, 0] },
        { geo: gear({ teeth: 7, rOuter: 0.22, rInner: 0.14, thick: 0.05, seed: 17, gap: 0 }), p: [0, 0, -0.5] },
      ]);
      return { glass, brass };
    },
  },
  lancer: {
    cap: 10, hp: 8, radius: 2.0, score: 500, scale: [5.5, 7.5],
    fire: { range: 420, period: 3.8, telegraph: 0.85, pattern: 'spread5', speed: 78 },
    build() {
      const glass = compose([
        { geo: lathe({ sides: 8, seed: 41, jitter: 0.1, profile: [[0, -1.3], [0.55, -0.9], [0.75, -0.2], [0.6, 0.5], [0.3, 1.0], [0, 1.35]] }), p: [0, 0, 0], e: [Math.PI / 2, 0, 0] },
        { geo: shardRing({ count: 8, radius: 0.85, size: 0.14, seed: 51, tilt: 0.2 }), p: [0, 0, 0.2], e: [Math.PI / 2, 0, 0] },
      ]);
      const brass = compose([
        { geo: gear({ teeth: 11, rOuter: 0.5, rInner: 0.34, thick: 0.09, seed: 23, gap: 2 }), p: [0.75, 0.1, 0], e: [0, 0, Math.PI / 2] },
        { geo: gear({ teeth: 9, rOuter: 0.4, rInner: 0.26, thick: 0.08, seed: 29, gap: 1 }), p: [-0.72, -0.05, 0.1], e: [0, 0, Math.PI / 2] },
        { geo: cage({ ribs: 4, height: 1.4, radius: 0.5, seed: 37 }), p: [0, 0, 0.6], e: [Math.PI / 2, 0, 0] },
      ]);
      return { glass, brass };
    },
  },
  gyre: {
    cap: 8, hp: 6, radius: 2.6, score: 650, scale: [6.5, 9.0],
    fire: { range: 340, period: 3.4, telegraph: 0.7, pattern: 'ring', speed: 54 },
    build() {
      const glass = compose([
        { geo: shardRing({ count: 9, radius: 1.0, size: 0.22, seed: 61, wobble: 0.3, tilt: 0.5 }), p: [0, 0, 0] },
        { geo: jewel({ sides: 7, seed: 67, height: 0.9, radius: 0.4, jitter: 0.22 }), p: [0, 0, 0] },
      ]);
      const brass = compose([
        { geo: gear({ teeth: 13, rOuter: 0.62, rInner: 0.45, thick: 0.07, seed: 71, gap: 2 }), p: [0, 0, 0] },
      ]);
      return { glass, brass };
    },
  },
};

const BULLET_CAP = 512;
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _ndc = new THREE.Vector3();
const _col = new THREE.Color();

export class Enemies {
  constructor() {
    this.name = 'enemies';
    this.order = 40;

    this.active = [];            // live handles (incl. external boss cores)
    this.bullets = [];
    this._types = new Map();
    this._unsub = [];
    this._time = 0;
    this._bossMode = false;
  }

  async init(ctx) {
    this._ctx = ctx;
    const mats = resolveMaterials(ctx);
    this._mats = mats;

    for (const [id, def] of Object.entries(TYPES)) {
      const { glass, brass } = def.build();
      const mk = (geo, mat) => {
        const tint = new THREE.InstancedBufferAttribute(new Float32Array(def.cap * 3), 3);
        const state = new THREE.InstancedBufferAttribute(new Float32Array(def.cap * 4), 4);
        tint.setUsage(THREE.DynamicDrawUsage);
        state.setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute('aTint', tint);
        geo.setAttribute('aState', state);
        const mesh = new THREE.InstancedMesh(geo, mat, def.cap);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.frustumCulled = false;
        mesh.count = 0;
        ctx.world.add(mesh);
        return { mesh, tint, state };
      };
      this._types.set(id, {
        def,
        glass: mk(glass, mats.neonGlass),
        brass: mk(brass, mats.clockworkBrass),
        free: Array.from({ length: def.cap }, (_, i) => def.cap - 1 - i),
        used: [],
      });
    }

    /* ── bullet pool: hostile darts + dark outline hulls ───────────────── */
    const bGeo = dart({ seed: 101, len: 1.6, r: 0.42 });
    const btint = new THREE.InstancedBufferAttribute(new Float32Array(BULLET_CAP * 3), 3);
    const bstate = new THREE.InstancedBufferAttribute(new Float32Array(BULLET_CAP * 4), 4);
    btint.setUsage(THREE.DynamicDrawUsage);
    bstate.setUsage(THREE.DynamicDrawUsage);
    bGeo.setAttribute('aTint', btint);
    bGeo.setAttribute('aState', bstate);
    this._bTint = btint; this._bState = bstate;
    this._bMesh = new THREE.InstancedMesh(bGeo, mats.hostileEnergy, BULLET_CAP);
    this._bMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._bMesh.frustumCulled = false;
    this._bMesh.count = 0;
    ctx.fx.add(this._bMesh);

    const oGeo = dart({ seed: 103, len: 0.9, r: 0.22 });
    this._oMesh = new THREE.InstancedMesh(oGeo, mats.outline, BULLET_CAP);
    this._oMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._oMesh.frustumCulled = false;
    this._oMesh.count = 0;
    ctx.fx.add(this._oMesh);

    for (let i = 0; i < BULLET_CAP; i++) {
      this.bullets.push({
        alive: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        age: 0, life: 6, r: 0.42, grazed: false, seed: 0,
      });
    }

    // tint bullets once per palette change (reserved hue, but retint anyway)
    const tintBullets = () => {
      const c = Palette.hostile;
      for (let i = 0; i < BULLET_CAP; i++) {
        btint.array[i * 3] = c.r; btint.array[i * 3 + 1] = c.g; btint.array[i * 3 + 2] = c.b;
      }
      btint.needsUpdate = true;
    };
    tintBullets();
    this._unsub.push(Palette.onChange(tintBullets));
    this._unsub.push(Bus.on('boss:spawn', () => { this._bossMode = true; }));
    this._unsub.push(Bus.on('boss:dead', () => { this._bossMode = false; }));

    window.__enemies = this;
  }

  /* ── spawning ────────────────────────────────────────────────────────── */
  /**
   * spawn('wisp', {ahead: 260, ox: -0.4, oy: 0.3}) — placed in the rail frame
   * `ahead` metres in front of the player, offset in cage-normalised units.
   * Or pass {position: Vector3} for a raw world point. Returns the handle.
   */
  spawn(typeId, opts = {}) {
    const T = this._types.get(typeId);
    if (!T || T.free.length === 0) return null;
    const rail = this._ctx.engine.get('rail');
    const slot = T.free.pop();
    const def = T.def;
    const seed = hash11((this._time + slot * 13.7) * 7.31) * 100;

    const e = {
      id: `${typeId}:${slot}`, type: typeId, def, slot,
      alive: true, external: false,
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      anchor: new THREE.Vector3(),
      anchorBinormal: new THREE.Vector3(1, 0, 0),
      anchorNormal: new THREE.Vector3(0, 1, 0),
      radius: def.radius * (opts.scale ?? 1) * 0.55,
      hp: def.hp * (opts.hpMul ?? 1), maxHp: def.hp,
      lockable: true, onScreen: false,
      seed, age: 0, railDist: 0,
      scale: (def.scale[0] + hash11(seed) * (def.scale[1] - def.scale[0])) * (opts.scale ?? 1),
      flash: 0, telegraph: 0, dissolve: 1, dying: 0, materialize: 0,
      fireClock: (def.fire?.period ?? 3) * (0.4 + hash11(seed * 3.1) * 0.9),
      tickPhase: hash11(seed * 7.7) * 10,
      aggro: opts.aggro ?? 0.5,
      yaw: 0, yawPrev: 0, yawTarget: 0,
      hopFrom: new THREE.Vector3(), hopTo: new THREE.Vector3(), hopT: 1, hopDur: 0.5,
      value: def.score,
      takeDamage: (n, hitPoint, o) => this._damage(e, n, hitPoint, o),
    };

    if (opts.position) {
      e.position.copy(opts.position);
      e.anchor.copy(opts.position);
      e.railDist = rail ? rail.distance : 0;
    } else if (rail) {
      const ahead = opts.ahead ?? 280;
      const s = rail.sampleAhead(ahead);
      e.railDist = rail.distance + ahead;
      e.anchorBinormal.copy(s.binormal);
      e.anchorNormal.copy(s.normal);
      e.anchor.copy(s.position)
        .addScaledVector(s.binormal, (opts.ox ?? shash(seed)) * CFG.player.cageWidth * 1.4)
        .addScaledVector(s.normal, (opts.oy ?? shash(seed * 2.3) * 0.8) * CFG.player.cageHeight * 1.6);
      e.position.copy(e.anchor);
    }
    e.hopFrom.copy(e.position);
    e.hopTo.copy(e.position);

    // per-instance identity
    const tint = this._tintFor(e);
    T.glass.tint.array.set([tint.r, tint.g, tint.b], slot * 3);
    T.brass.tint.array.set([tint.r * 0.9, tint.g * 0.9, tint.b * 0.95], slot * 3);
    T.glass.tint.needsUpdate = true;
    T.brass.tint.needsUpdate = true;
    this._setState(T, slot, 0, 0, 1, seed);   // born dissolved — burns in

    T.used.push(e);
    this.active.push(e);
    Bus.emit('enemy:spawn', { enemy: e });
    return e;
  }

  _tintFor(e) {
    // glass bodies: key→accent range per instance, NEVER hostile
    const t = hash11(e.seed * 1.71);
    _col.copy(Palette.key).lerp(Palette.accent, t * 0.65);
    return _col;
  }

  _setState(T, slot, flash, tel, dis, seed) {
    for (const part of [T.glass, T.brass]) {
      const a = part.state.array;
      a[slot * 4] = flash; a[slot * 4 + 1] = tel; a[slot * 4 + 2] = dis; a[slot * 4 + 3] = seed;
      part.state.needsUpdate = true;
    }
  }

  /** Boss cores etc. register here so lock-on finds them. */
  addExternal(handle) { this.active.push(handle); }
  removeExternal(handle) {
    const i = this.active.indexOf(handle);
    if (i >= 0) this.active.splice(i, 1);
  }

  /* ── damage / death ──────────────────────────────────────────────────── */
  _damage(e, n, hitPoint, opts = {}) {
    if (!e.alive || e.dying) return false;
    e.hp -= n;
    e.flash = 1;
    if (e.hp <= 0) {
      e.dying = 1e-4;
      e.lockable = false;
      Bus.emit('enemy:killed', { enemy: e, position: e.position, value: e.value, bomb: !!opts.bomb });
      return true;
    }
    Bus.emit('enemy:damaged', { enemy: e, position: hitPoint || e.position });
    return false;
  }

  _free(e) {
    const T = this._types.get(e.type);
    if (T) {
      const ui = T.used.indexOf(e);
      if (ui >= 0) T.used.splice(ui, 1);
      T.free.push(e.slot);
      // park the instance far below the world
      _m.makeTranslation(0, -10000, 0);
      T.glass.mesh.setMatrixAt(e.slot, _m);
      T.brass.mesh.setMatrixAt(e.slot, _m);
      T.glass.mesh.instanceMatrix.needsUpdate = true;
      T.brass.mesh.instanceMatrix.needsUpdate = true;
    }
    const ai = this.active.indexOf(e);
    if (ai >= 0) this.active.splice(ai, 1);
    e.alive = false;
  }

  /* ── bullets ─────────────────────────────────────────────────────────── */
  fireBullet(pos, vel, opts = {}) {
    let b = null;
    for (const c of this.bullets) if (!c.alive) { b = c; break; }
    if (!b) return null;
    b.alive = true;
    b.pos.copy(pos);
    b.vel.copy(vel);
    b.age = 0;
    b.life = opts.life ?? 7;
    b.r = opts.r ?? 0.42;
    b.grazed = false;
    b.seed = hash11(pos.x * 3.1 + pos.y * 7.7 + this._time) * 10;
    this._bState.array[bIndex(this, b) * 4 + 1] = 0;   // born bloom starts closed
    return b;
  }

  clearBullets() {
    for (const b of this.bullets) b.alive = false;
  }

  _firePattern(e) {
    const player = this._ctx.engine.get('player');
    if (!player?.alive) return;
    const F = e.def.fire;
    const speed = F.speed * (1 + e.aggro * 0.5);
    _v.copy(player.position).sub(e.position).normalize();

    switch (F.pattern) {
      case 'aimed': {
        // lead the shot slightly
        _v2.copy(player.position).addScaledVector(player.velocity, 0).sub(e.position).normalize();
        this.fireBullet(e.position, _v2.multiplyScalar(speed));
        Bus.emit('enemy:fire', { enemy: e, pattern: 'aimed' });
        break;
      }
      case 'burst3': {
        for (let i = 0; i < 3; i++) {
          _v2.copy(player.position).sub(e.position).normalize();
          // slight fan around the aim direction
          _v3.crossVectors(_v, e.anchorNormal).normalize();
          _v2.addScaledVector(_v3, (i - 1) * 0.09).normalize();
          this.fireBullet(e.position, _v2.multiplyScalar(speed + i * 6));
        }
        Bus.emit('enemy:fire', { enemy: e, pattern: 'burst3' });
        break;
      }
      case 'spread5': {
        _v3.crossVectors(_v, e.anchorNormal).normalize();
        const up2 = SV[4].crossVectors(_v3, _v).normalize();
        for (let i = 0; i < 5; i++) {
          const a = (i - 2) * 0.16;
          _v2.copy(_v).addScaledVector(_v3, Math.sin(a)).addScaledVector(up2, Math.sin(a * 0.4)).normalize();
          this.fireBullet(e.position, _v2.multiplyScalar(speed));
        }
        Bus.emit('enemy:fire', { enemy: e, pattern: 'spread5' });
        break;
      }
      case 'ring': {
        _v3.crossVectors(_v, e.anchorNormal).normalize();
        const up2 = SV[4].crossVectors(_v3, _v).normalize();
        const n = 14;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + e.tickPhase;
          _v2.copy(_v3).multiplyScalar(Math.cos(a)).addScaledVector(up2, Math.sin(a)).normalize();
          this.fireBullet(e.position, _v2.multiplyScalar(speed));
        }
        Bus.emit('enemy:fire', { enemy: e, pattern: 'ring' });
        break;
      }
    }
  }

  /* ── lock-on query ───────────────────────────────────────────────────── */
  queryScreen(ndc, radius) {
    const cam = this._ctx.camera;
    const aspect = cam.aspect;
    const out = this._queryOut || (this._queryOut = []);
    out.length = 0;
    for (const e of this.active) {
      if (!e.alive || !e.lockable || e.dying) continue;
      _ndc.copy(e.position).project(cam);
      if (_ndc.z > 1 || _ndc.z < -1) continue;
      const d = ndcDistFrac(ndc.x, ndc.y, _ndc.x, _ndc.y, aspect);
      if (d < radius) out.push(e);
    }
    out.sort((a, b) => {
      _ndc.copy(a.position).project(cam);
      const da = ndcDistFrac(ndc.x, ndc.y, _ndc.x, _ndc.y, aspect);
      _ndc.copy(b.position).project(cam);
      const db = ndcDistFrac(ndc.x, ndc.y, _ndc.x, _ndc.y, aspect);
      return da - db;
    });
    return out;
  }

  /* ── per-frame ───────────────────────────────────────────────────────── */
  update(dt, ctx) {
    this._time += dt;
    const t = this._time;
    const rail = ctx.engine.get('rail');
    const player = ctx.engine.get('player');
    const cam = ctx.camera;

    for (const T of this._types.values()) {
      T.glass.mesh.count = T.def.cap;
      T.brass.mesh.count = T.def.cap;
    }

    /* ── enemies ───────────────────────────────────────────────────────── */
    for (let i = this.active.length - 1; i >= 0; i--) {
      const e = this.active[i];
      if (e.external) continue;                       // boss cores self-update
      const T = this._types.get(e.type);
      e.age += dt;

      /* death: dissolve out, then free */
      if (e.dying > 0) {
        e.dying = Math.min(1, e.dying + dt * 2.2);
        e.flash *= Math.exp(-dt * 4);
        this._setState(T, e.slot, e.flash, 0, e.dying, e.seed);
        const sc = e.scale * (1 - e.dying * 0.3);
        _s.setScalar(Math.max(0.001, sc));
        _m.compose(e.position, e.quaternion, _s);
        T.glass.mesh.setMatrixAt(e.slot, _m);
        T.brass.mesh.setMatrixAt(e.slot, _m);
        if (e.dying >= 1) this._free(e);
        continue;
      }

      /* passed the player: leave the stage quietly */
      if (rail && rail.distance > e.railDist + 60) {
        e.dying = 0.6;    // fast silent dissolve, no score
        continue;
      }

      e.flash *= Math.exp(-dt * 7);

      /* materialise: the glass condenses out of the mathematics */
      if (e.materialize < 1) {
        e.materialize = Math.min(1, e.materialize + dt * 2.4);
        e.dissolve = 1 - e.materialize;
      }

      /* ── behaviour: anchored drift + quantised pose ─────────────────── */
      this._behave(e, dt, t, rail, player);

      /* face the player, in discrete ticks — never a smooth track */
      if (player) {
        _v.copy(player.position).sub(e.position);
        const yawW = Math.atan2(_v.x, _v.z);
        const steps = 8 + Math.floor(hash11(e.seed) * 5);
        e.yawTarget = quantAngle(yawW, steps);
      }
      e.yaw = damp(e.yaw, e.yawTarget, 3.2, dt);
      _e.set(0, e.yaw, Math.sin(t * 0.5 + e.seed) * 0.1);
      e.quaternion.setFromEuler(_e);

      /* fire control */
      const F = e.def.fire;
      if (F && player?.alive && !this._bossMode) {
        const distSq = e.position.distanceToSquared(player.position);
        const inFront = _v.copy(e.position).sub(cam.position).dot(cam.getWorldDirection(SV[5])) > 0;
        if (distSq < F.range * F.range && inFront) {
          e.fireClock -= dt * (0.7 + e.aggro * 0.8);
          if (e.fireClock <= F.telegraph && e.telegraph < 1) {
            e.telegraph = Math.min(1, e.telegraph + dt / Math.max(0.1, F.telegraph));
          }
          if (e.fireClock <= 0) {
            e.fireClock = F.period * (0.75 + hash11(e.seed + t) * 0.5) / (0.7 + e.aggro * 0.7);
            e.telegraph = 0;
            this._firePattern(e);
          }
        } else if (e.telegraph > 0) {
          e.telegraph = Math.max(0, e.telegraph - dt * 2);
        }
      } else if (e.telegraph > 0) {
        e.telegraph = Math.max(0, e.telegraph - dt * 2);
      }

      /* write instance */
      this._setState(T, e.slot, e.flash, e.telegraph, e.dissolve, e.seed);
      _s.setScalar(e.scale);
      _m.compose(e.position, e.quaternion, _s);
      T.glass.mesh.setMatrixAt(e.slot, _m);
      T.brass.mesh.setMatrixAt(e.slot, _m);

      /* on-screen flag for bombs & HUD */
      _ndc.copy(e.position).project(cam);
      e.onScreen = Math.abs(_ndc.x) < 1.1 && Math.abs(_ndc.y) < 1.1 && _ndc.z < 1 && _ndc.z > -1;
    }
    for (const T of this._types.values()) {
      T.glass.mesh.instanceMatrix.needsUpdate = true;
      T.brass.mesh.instanceMatrix.needsUpdate = true;
    }

    /* ── bullets ───────────────────────────────────────────────────────── */
    let bi = 0;
    const pPos = player?.position;
    const hitR = CFG.player.hitRadius + 0.42;
    const grazeR = CFG.player.grazeRadius;
    for (const b of this.bullets) {
      if (!b.alive) continue;
      b.age += dt;
      b.pos.addScaledVector(b.vel, dt);

      if (b.age > b.life) { b.alive = false; continue; }

      /* player collision & graze flags (graze handled by Graze module) */
      if (pPos && player.alive) {
        const d2 = b.pos.distanceToSquared(pPos);
        if (d2 < hitR * hitR) {
          b.alive = false;
          if (!player.invulnerable) Bus.emit('player:hit', { damage: 1, position: b.pos });
          continue;
        }
        if (!b.grazed && d2 < grazeR * grazeR && d2 > hitR * hitR * 1.4) {
          b.grazed = true;
          Bus.emit('graze', { position: b.pos, bullet: b });
        }
      }

      /* behind the camera: cull */
      _v.copy(b.pos).sub(cam.position);
      if (_v.dot(cam.getWorldDirection(SV[5])) < -8) { b.alive = false; continue; }

      /* write both the dart and its dark outline */
      _v2.copy(b.vel).normalize();
      _q.setFromUnitVectors(SV[6].set(0, 1, 0), _v2);
      const throb = 1 + Math.sin(b.age * 13 + b.seed * 9) * 0.18;
      _s.setScalar(throb);
      _m.compose(b.pos, _q, _s);
      this._bMesh.setMatrixAt(bi, _m);
      _s.setScalar(2.1);
      _m.compose(b.pos, _q, _s);
      this._oMesh.setMatrixAt(bi, _m);

      const st = this._bState.array;
      st[bi * 4] = 0;
      st[bi * 4 + 1] = Math.min(1, b.age * 5);          // born bloom
      st[bi * 4 + 2] = 0;
      st[bi * 4 + 3] = b.seed;
      bi++;
    }
    this._bMesh.count = bi;
    this._oMesh.count = bi;
    this._bMesh.instanceMatrix.needsUpdate = true;
    this._oMesh.instanceMatrix.needsUpdate = true;
    this._bState.needsUpdate = true;
  }

  /* ── per-type motion scripts ─────────────────────────────────────────── */
  _behave(e, dt, t, rail, player) {
    const seed = e.seed;
    switch (e.type) {
      case 'wisp': {
        // hover + breathing bob; tiny quantised hops every few ticks
        const bob = Math.sin(t * 1.1 + seed) * 1.1 + Math.sin(t * 0.43 + seed * 2.0) * 1.6;
        const sway = Math.sin(t * 0.61 + seed * 3.0) * 1.9;
        e.position.copy(e.anchor)
          .addScaledVector(e.anchorNormal, bob)
          .addScaledVector(e.anchorBinormal, sway);
        if (e.hopT < 1) {
          e.hopT = Math.min(1, e.hopT + dt / e.hopDur);
          const k = tickEase(e.hopT, 0.34, 4.2, 4.6);
          e.position.lerpVectors(e.hopFrom, e.hopTo, k);
        } else if (Math.sin(t * 0.31 + seed * 5.0) > 0.995) {
          e.hopFrom.copy(e.position);
          e.hopTo.copy(e.anchor)
            .addScaledVector(e.anchorBinormal, shash(seed + t) * 6)
            .addScaledVector(e.anchorNormal, shash(seed * 2 + t) * 4);
          e.hopDur = 0.45;
          e.hopT = 0;
        }
        break;
      }
      case 'weaver': {
        // serpentine weave around the anchor, amplitude swells with aggro
        const amp = 6 + e.aggro * 7;
        const ph = t * (1.3 + e.aggro * 0.7) + seed * 2.0;
        e.position.copy(e.anchor)
          .addScaledVector(e.anchorBinormal, Math.sin(ph) * amp)
          .addScaledVector(e.anchorNormal, Math.sin(ph * 0.5 + 1.3) * amp * 0.4);
        break;
      }
      case 'lancer': {
        // heavy repositioning hops: hold... hold... SNAP to a new station
        if (e.hopT < 1) {
          e.hopT = Math.min(1, e.hopT + dt / e.hopDur);
          const k = tickEase(e.hopT, 0.4, 3.6, 4.0);
          e.position.lerpVectors(e.hopFrom, e.hopTo, k);
        } else {
          e.position.copy(e.hopTo);
          const nextHop = 2.2 + hash11(seed + Math.floor(t * 0.4)) * 2.4;
          if ((t + seed) % nextHop < dt) {
            e.hopFrom.copy(e.position);
            e.hopTo.copy(e.anchor)
              .addScaledVector(e.anchorBinormal, shash(seed + t * 1.7) * 14)
              .addScaledVector(e.anchorNormal, shash(seed * 3 + t) * 8);
            e.hopDur = 0.55;
            e.hopT = 0;
          }
        }
        break;
      }
      case 'gyre': {
        // slow majestic orbit drift; the ring itself spins via quantised yaw
        const ph = t * 0.34 + seed;
        e.position.copy(e.anchor)
          .addScaledVector(e.anchorBinormal, Math.sin(ph) * 4)
          .addScaledVector(e.anchorNormal, Math.cos(ph * 0.8) * 3);
        break;
      }
    }
  }
}

function bIndex(enemies, b) { return enemies.bullets.indexOf(b); }

export default Enemies;
