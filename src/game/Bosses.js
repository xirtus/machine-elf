import * as THREE from 'three';
import Bus from '../core/Bus.js';
import CFG from '../core/Config.js';
import Time from '../core/Time.js';
import Palette from '../render/Palette.js';
import { neonGlass, sacredGeometry, voidMatte, clockworkBrass } from '../render/Materials.js';
import { makeHoopGeometry, makeCoreGeometry, makeShardGeometry } from '../util/craft-geometry.js';
import { lathe, jewel, gear, shardRing, cage, compose } from '../util/enemy-geometry.js';
import { tickEase, hash11, shash, quantAngle, damp } from '../util/enemy-math.js';

/**
 * THE ENTITIES — colossal bosses that are not placed in the world but
 * ASSEMBLE out of it: rings descend from the fractal skyline, teeth slot
 * into place one by one with escapement ticks, and then the thing opens
 * its core and notices you.
 *
 * Three archetypes, cycling with escalation:
 *   0  THE ESCAPEMENT — concentric toothed rings around a furnace jewel.
 *      Radial bullet walls; teeth detach as adds in phase 2.
 *   1  APOLLONIAN MOTHER — a gasket of void-dark spheres orbiting a core
 *      that only opens between volleys. Spawns wisps.
 *   2  THE CHOIR OF TEETH — an arc of crystal spires; each spire is a
 *      lockable shard of the whole, and they sing before they fire.
 *
 * A boss fight never stops the rail — it slows it. You are always flying
 * through the thing's shadow.
 */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();

const BOSS_NAMES = ['THE ESCAPEMENT', 'APOLLONIAN MOTHER', 'THE CHOIR OF TEETH'];

export class Bosses {
  constructor() {
    this.name = 'bosses';
    this.order = 46;
    this.current = null;
    this._unsub = [];
  }

  async init(ctx) {
    this._ctx = ctx;
    window.__bosses = this;
  }

  /* ════════════════════════════════════════════════════════════════════ */
  /* construction                                                          */
  /* ════════════════════════════════════════════════════════════════════ */

  spawn(kind, opts = {}) {
    if (this.current) return null;
    const ctx = this._ctx;
    const rail = ctx.engine.get('rail');
    const escalation = opts.escalation ?? 0;

    const b = {
      kind, name: BOSS_NAMES[kind % 3],
      group: new THREE.Group(),
      parts: [], cores: [],
      hp: 0, maxHp: 0,
      phase: 0, state: 'emerging',
      t: 0, emergeT: 0, dieT: 0,
      railDist: (rail?.distance ?? 0) + 300,
      approach: 76 + escalation * 6,
      sway: { x: 0, y: 0, tx: 0, ty: 0, clock: 0 },
      patClock: 2.2, patIndex: 0, ringClock: 0,
      escalation,
      alive: true,
    };
    b.group.scale.setScalar(1.7);          // COLOSSAL
    ctx.world.add(b.group);

    if (kind % 3 === 0) this._buildEscapement(b);
    else if (kind % 3 === 1) this._buildMother(b);
    else this._buildChoir(b);

    // total HP across cores is the boss bar
    b.maxHp = b.cores.reduce((s, c) => s + c.hp, 0) * (1 + escalation * 0.35);
    b.hp = b.maxHp;

    this.current = b;
    Bus.emit('boss:spawn', { boss: this._public(b), name: b.name });
    Bus.emit('camera:shake', { amount: 0.8, duration: 1.6 });
    return b;
  }

  _public(b) {
    return {
      name: b.name, kind: b.kind,
      get hp() { return b.hp; },
      get maxHp() { return b.maxHp; },
      get phase() { return b.phase; },
      get alive() { return b.alive; },
      position: b.group.position,
    };
  }

  _addCore(b, mesh, radius, hpFrac) {
    const core = {
      external: true, alive: true, lockable: false,   // unlocked after emerge
      dying: false, onScreen: true,
      position: new THREE.Vector3(),
      radius,
      hp: 0, maxHp: 0,
      value: 5000,
      mesh,
      takeDamage: (n, pt, o) => this._damageCore(b, core, n, pt, o),
    };
    core.hp = core.maxHp = hpFrac;
    b.cores.push(core);
    return core;
  }

  _buildEscapement(b) {
    const ctx = this._ctx;
    const ringMat = voidMatte({ rim: 1.6, scale: 0.22 });
    const etchMat = sacredGeometry({ freq: 2.2, rings: 1.0, spokes: 0.55, spokeCount: 22, intensity: 4.2, thickness: 1.8, transparentBody: true });

    const radii = [26, 19, 13, 7.5];
    for (let i = 0; i < radii.length; i++) {
      const geo = makeHoopGeometry({
        R: radii[i], segs: 96, teeth: 18 + i * 4, toothAmp: 0.05 + i * 0.012,
      });
      const mesh = new THREE.Mesh(geo, i % 2 ? ringMat : etchMat);
      mesh.rotation.x = Math.PI / 2;
      b.group.add(mesh);
      b.parts.push({
        mesh, kind: 'ring', dir: i % 2 ? -1 : 1,
        rate: 0.11 + i * 0.07, tickStep: Math.PI / (9 + i * 3),
        tick: 0, emergeDelay: i * 0.35,
      });
    }
    const coreMesh = new THREE.Mesh(
      makeCoreGeometry({ seed: 3, count: 40, radius: 3.4 }),
      neonGlass({ tint: 'accent', core: 'glow', dispersion: 7, coreGain: 2.0, cache: false })
    );
    b.group.add(coreMesh);
    b.parts.push({ mesh: coreMesh, kind: 'core', rate: 0.4, emergeDelay: 1.5 });
    this._addCore(b, coreMesh, 4.6, 1.0);

    // halo of orbiting shards
    const shardGeo = makeShardGeometry({ seed: 13, count: 9, radius: 1.4 });
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(shardGeo, ringMat);
      b.group.add(m);
      b.parts.push({ mesh: m, kind: 'orbit', phase: (i / 8) * Math.PI * 2, r: 32, rate: 0.16, emergeDelay: 1.0 + i * 0.12 });
    }
  }

  _buildMother(b) {
    const darkMat = voidMatte({ rim: 2.2, scale: 0.5, rimPower: 2.6 });
    const glass = neonGlass({ tint: 'key', core: 'accent', dispersion: 5, coreGain: 2.2, cache: false });

    // shell: two hemispheric lathes that open like a seed pod
    for (const side of [-1, 1]) {
      const shell = new THREE.Mesh(
        lathe({ sides: 9, seed: 51 + side, jitter: 0.16, profile: [[0, -1], [0.9, -0.6], [1.25, 0], [0.9, 0.7], [0.2, 1]] }),
        darkMat
      );
      shell.scale.setScalar(9);
      shell.rotation.z = side * 0.12;
      b.group.add(shell);
      b.parts.push({ mesh: shell, kind: 'shell', side, open: 0, emergeDelay: 0.2 });
    }
    // the brood: gasket spheres on an orbit
    const broodGeo = jewel({ sides: 8, seed: 61, height: 1, radius: 0.62, jitter: 0.14 });
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(broodGeo, darkMat);
      m.scale.setScalar(4.2 - (i % 3) * 0.7);
      b.group.add(m);
      b.parts.push({ mesh: m, kind: 'brood', phase: (i / 6) * Math.PI * 2, r: 17 + (i % 2) * 6, rate: 0.22 + (i % 3) * 0.05, emergeDelay: 0.7 + i * 0.16 });
    }
    const coreMesh = new THREE.Mesh(makeCoreGeometry({ seed: 9, count: 44, radius: 3.0 }), glass);
    b.group.add(coreMesh);
    b.parts.push({ mesh: coreMesh, kind: 'core', rate: 0.3, emergeDelay: 1.4 });
    this._addCore(b, coreMesh, 4.2, 1.0);
  }

  _buildChoir(b) {
    const glass = neonGlass({ tint: 'key', core: 'accent', dispersion: 6, coreGain: 2.2, rimGain: 1.6, cache: false });
    const dark = voidMatte({ rim: 1.0, scale: 0.7 });

    // arc of seven spires
    const spireGeo = compose([
      { geo: lathe({ sides: 6, seed: 71, jitter: 0.14, twist: 0.35, profile: [[0, -1.7], [0.34, -1.1], [0.2, -0.2], [0.3, 0.5], [0.1, 1.3], [0, 1.8]] }), p: [0, 0, 0] },
      { geo: gear({ teeth: 8, rOuter: 0.42, rInner: 0.3, thick: 0.06, seed: 73, gap: 1 }), p: [0, -0.7, 0] },
    ]);
    for (let i = 0; i < 7; i++) {
      const a = ((i / 6) - 0.5) * Math.PI * 0.9;
      const m = new THREE.Mesh(spireGeo, glass);
      const r = 24;
      m.position.set(Math.sin(a) * r, Math.cos(a * 0.7) * 6 - 2, -Math.abs(Math.cos(a)) * 4);
      m.scale.setScalar(6.5 - Math.abs(i - 3) * 0.55);
      b.group.add(m);
      const part = { mesh: m, kind: 'spire', phase: i, emergeDelay: 0.25 + i * 0.18, baseY: m.position.y };
      b.parts.push(part);
      // the three middle spires are lockable shards of the choir
      if (i >= 2 && i <= 4) {
        this._addCore(b, m, 4.4, 0.34);
      }
    }
    // the conductor: a dark jewel hanging below
    const condMesh = new THREE.Mesh(jewel({ sides: 8, seed: 79, height: 3.2, radius: 1.4, jitter: 0.1 }), dark);
    condMesh.position.set(0, -10, 0);
    b.group.add(condMesh);
    b.parts.push({ mesh: condMesh, kind: 'conductor', rate: 0.5, emergeDelay: 1.6 });
  }

  /* ════════════════════════════════════════════════════════════════════ */
  /* damage / phases / death                                               */
  /* ════════════════════════════════════════════════════════════════════ */

  _damageCore(b, core, n, hitPoint, opts = {}) {
    if (!b.alive || b.state !== 'fighting') return false;
    core.hp -= n;
    b.hp -= n;
    const wasPhase = b.phase;
    const frac = b.hp / b.maxHp;
    b.phase = frac > 0.66 ? 0 : frac > 0.33 ? 1 : 2;
    if (b.phase !== wasPhase) {
      Bus.emit('boss:phase', { boss: this._public(b), phase: b.phase });
      Bus.emit('camera:shake', { amount: 0.9, duration: 0.8 });
      Bus.emit('time:hitstop', { duration: 0.14 });
      b.patClock = 1.6;   // a beat of silence, then the new pattern
    }
    if (core.hp <= 0 && core.alive) {
      core.alive = false;
      core.lockable = false;
      Bus.emit('enemy:killed', { enemy: core, position: core.position, value: core.value, bossCore: true });
    }
    if (b.hp <= 0) {
      this._startDeath(b);
      return true;
    }
    return false;
  }

  _startDeath(b) {
    b.state = 'dying';
    b.dieT = 0;
    for (const c of b.cores) c.lockable = false;
    Time.setScale(0.35);
    Bus.emit('camera:shake', { amount: 1.5, duration: 2.2 });
  }

  _finishDeath(b) {
    const ctx = this._ctx;
    Time.setScale(1);
    ctx.engine.get('enemies')?.clearBullets();
    for (const c of b.cores) ctx.engine.get('enemies')?.removeExternal(c);
    ctx.world.remove(b.group);
    b.group.traverse((o) => { o.geometry?.dispose?.(); });
    b.alive = false;
    Bus.emit('boss:dead', { boss: this._public(b), position: b.group.position });
    this.current = null;
  }

  /* ════════════════════════════════════════════════════════════════════ */
  /* per-frame                                                             */
  /* ════════════════════════════════════════════════════════════════════ */

  update(dt, ctx) {
    const b = this.current;
    if (!b) return;
    const rail = ctx.engine.get('rail');
    const enemies = ctx.engine.get('enemies');
    const player = ctx.engine.get('player');
    b.t += dt;

    /* station-keeping: hold ahead of the rail, swaying */
    if (rail) {
      const targetDist = rail.distance + b.approach;
      b.railDist = damp(b.railDist, Math.max(b.railDist, targetDist), 1.2, dt);
      b.railDist = Math.max(b.railDist, rail.distance + 55);
      const s = rail.sampleDistance(Math.min(b.railDist, rail.length - 60));
      b.sway.clock -= dt;
      if (b.sway.clock <= 0) {
        b.sway.clock = 2.2 + hash11(b.t) * 2.4;
        b.sway.tx = shash(b.t * 1.31) * 16;
        b.sway.ty = shash(b.t * 1.77 + 5) * 9;
      }
      b.sway.x = damp(b.sway.x, b.sway.tx, 0.8, dt);
      b.sway.y = damp(b.sway.y, b.sway.ty, 0.8, dt);
      b.group.position.copy(s.position)
        .addScaledVector(s.binormal, b.sway.x)
        .addScaledVector(s.normal, b.sway.y + 4);
      b.group.quaternion.copy(s.quaternion);
    }

    /* state machine */
    if (b.state === 'emerging') this._updateEmerge(b, dt, ctx);
    else if (b.state === 'fighting') this._updateFight(b, dt, ctx);
    else if (b.state === 'dying') this._updateDying(b, dt, ctx);

    /* parts motion — everything ticks, nothing drifts */
    for (const p of b.parts) {
      const emergeK = Math.min(1, Math.max(0, (b.emergeT - p.emergeDelay) / 0.6));
      const ek = b.state === 'emerging' ? tickEase(emergeK, 0.5, 3.2, 3.6) : 1;
      switch (p.kind) {
        case 'ring': {
          const tt = b.t * p.rate * p.dir + p.tick;
          const tick = Math.floor(tt);
          const frac = tt - tick;
          const ang = (tick + tickEase(frac, 0.35, 4.0, 4.4)) * p.tickStep * 8;
          p.mesh.rotation.z = ang;
          p.mesh.scale.setScalar(Math.max(0.001, ek));
          break;
        }
        case 'orbit': {
          const a = p.phase + b.t * p.rate;
          p.mesh.position.set(Math.cos(a) * p.r, Math.sin(a * 0.7) * 6, Math.sin(a) * p.r);
          p.mesh.rotation.set(b.t * 0.7 + p.phase, a, p.phase);
          p.mesh.scale.setScalar(Math.max(0.001, ek * 1.4));
          break;
        }
        case 'core': {
          p.mesh.rotation.y = b.t * p.rate;
          p.mesh.rotation.x = Math.sin(b.t * 0.23) * 0.4;
          const pulse = 1 + Math.sin(b.t * 2.1) * 0.06;
          p.mesh.scale.setScalar(Math.max(0.001, ek * pulse));
          break;
        }
        case 'shell': {
          p.open = damp(p.open ?? 0, b.phase >= 1 || b.state === 'dying' ? 1 : (Math.sin(b.t * 0.5) > 0.2 ? 0.7 : 0.1), 2.0, dt);
          p.mesh.rotation.z = p.side * (0.12 + p.open * 0.55);
          p.mesh.position.x = p.side * p.open * 4;
          p.mesh.scale.setScalar(9 * Math.max(0.001, ek));
          break;
        }
        case 'brood': {
          const a = p.phase + b.t * p.rate;
          p.mesh.position.set(Math.cos(a) * p.r, Math.sin(a * 1.3) * 5, Math.sin(a) * p.r);
          p.mesh.rotation.y = a * 2;
          break;
        }
        case 'spire': {
          p.mesh.position.y = p.baseY + Math.sin(b.t * 0.7 + p.phase) * 1.4;
          p.mesh.rotation.y = quantAngle(b.t * 0.2 + p.phase, 8);
          break;
        }
        case 'conductor': {
          p.mesh.rotation.y = b.t * p.rate;
          p.mesh.position.y = -10 + Math.sin(b.t * 0.9) * 1.2;
          p.mesh.scale.setScalar(Math.max(0.001, ek));
          break;
        }
      }
    }

    /* sync core lock positions */
    for (const c of b.cores) {
      c.mesh.getWorldPosition(c.position);
      if (b.state === 'fighting' && !c.lockable && c.alive) c.lockable = true;
    }
  }

  _updateEmerge(b, dt, ctx) {
    b.emergeT += dt;
    const post = ctx.engine.get('postfx');
    post?.setWarp(Math.min(0.8, b.emergeT * 0.4));
    if (b.emergeT > 2.6) {
      b.state = 'fighting';
      b.emergeT = 10;
      post?.setWarp(0);
      Bus.emit('boss:engaged', { boss: this._public(b) });
    }
  }

  _updateFight(b, dt, ctx) {
    const enemies = ctx.engine.get('enemies');
    const player = ctx.engine.get('player');
    if (!player?.alive) return;
    b.patClock -= dt;
    const speedMul = 1 + b.phase * 0.3 + b.escalation * 0.15;

    if (b.kind % 3 === 0) {
      /* ESCAPEMENT: radial tooth walls + aimed bursts */
      b.ringClock -= dt;
      if (b.ringClock <= 0) {
        b.ringClock = (b.phase === 2 ? 1.6 : 2.4) / speedMul;
        const n = 18 + b.phase * 6;
        const spin = b.t * 0.4;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + spin;
          _v.set(Math.cos(a), Math.sin(a), 0).applyQuaternion(b.group.quaternion);
          _v2.copy(b.group.position).addScaledVector(_v, 12);
          enemies.fireBullet(_v2, _v.multiplyScalar(34 * speedMul), { life: 9 });
        }
        Bus.emit('boss:pattern', { name: 'ringwall' });
      }
      if (b.patClock <= 0) {
        b.patClock = 3.4 / speedMul;
        _v.copy(player.position).sub(b.group.position).normalize();
        for (let i = 0; i < 3 + b.phase; i++) {
          _v2.copy(_v);
          _v3.set(shash(i * 3.3), shash(i * 7.1), shash(i * 1.9)).multiplyScalar(0.14);
          _v2.add(_v3).normalize();
          enemies.fireBullet(b.group.position, _v2.multiplyScalar(52 * speedMul));
        }
        Bus.emit('boss:pattern', { name: 'burst' });
      }
      if (b.phase >= 1 && b.parts.length && Math.random() < dt * 0.25) {
        ctx.engine.get('enemies').spawn('wisp', { ahead: b.approach - 20, aggro: 0.7 });
      }
    } else if (b.kind % 3 === 1) {
      /* MOTHER: spreads from the brood + wisp spawns */
      if (b.patClock <= 0) {
        b.patClock = (3.0 - b.phase * 0.5) / speedMul;
        let fired = 0;
        for (const p of b.parts) {
          if (p.kind !== 'brood') continue;
          if ((fired + b.patIndex) % 2) continue;
          p.mesh.getWorldPosition(_v2);
          _v.copy(player.position).sub(_v2).normalize();
          _v3.set(shash(b.t + p.phase), shash(b.t * 2 + p.phase), 0).multiplyScalar(0.2);
          _v.add(_v3).normalize();
          enemies.fireBullet(_v2, _v.multiplyScalar(46 * speedMul));
          fired++;
        }
        b.patIndex++;
        Bus.emit('boss:pattern', { name: 'brood' });
      }
      if (Math.random() < dt * (0.12 + b.phase * 0.1)) {
        enemies.spawn('wisp', { ahead: b.approach - 30, aggro: 0.8 });
      }
    } else {
      /* CHOIR: telegraphed aimed streams, one spire at a time */
      if (b.patClock <= 0) {
        b.patClock = (0.55 - b.phase * 0.1) / speedMul;
        const spires = b.parts.filter((p) => p.kind === 'spire');
        const p = spires[b.patIndex % spires.length];
        b.patIndex++;
        p.mesh.getWorldPosition(_v2);
        _v.copy(player.position).sub(_v2).normalize();
        enemies.fireBullet(_v2, _v.multiplyScalar(72 * speedMul));
      }
    }
  }

  _updateDying(b, dt, ctx) {
    b.dieT += dt;
    const enemies = ctx.engine.get('enemies');

    // cores pop in sequence
    const idx = Math.floor(b.dieT / 0.4);
    if (idx < b.cores.length && !b.cores[idx]._popped) {
      b.cores[idx]._popped = true;
      const c = b.cores[idx];
      ctx.engine.get('particles')?.burst('ring', c.position, { color: 'accent', size: 8, speed: 30 });
      ctx.engine.get('particles')?.burst('shatter', c.position, { color: 'key', count: 40, speed: 26 });
      Bus.emit('camera:shake', { amount: 0.8, duration: 0.5 });
    }
    // parts shake apart
    for (const p of b.parts) {
      p.mesh.rotation.x += dt * shash(p.emergeDelay * 7) * 0.8;
      p.mesh.position.y += dt * shash(p.emergeDelay * 13) * 4;
    }
    if (b.dieT > 0.34 * b.cores.length + 0.75) {
      ctx.engine.get('particles')?.burst('flash', b.group.position, { color: 'glow', size: 60 });
      ctx.engine.get('particles')?.burst('ring', b.group.position, { color: 'glow', size: 30, speed: 90 });
      ctx.engine.get('particles')?.burst('shatter', b.group.position, { color: 'accent', count: 90, speed: 44 });
      ctx.engine.get('postfx')?.flash(0.9);
      this._finishDeath(b);
    }
  }
}
export default Bosses;
