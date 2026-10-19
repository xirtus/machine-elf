import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn, vec2, vec3, vec4, float, uniform, attribute, positionLocal,
  time, sin, cos, length, normalize, mix, smoothstep, pow, oneMinus, saturate, uv,
} from 'three/tsl';
import Bus from '../core/Bus.js';
import CFG from '../core/Config.js';
import Palette from '../render/Palette.js';
import { clampEmissive } from '../util/mat-nodes.js';
import { dart } from '../util/enemy-geometry.js';
import { steerToward, damp, clamp as clampN, hash1 } from '../util/weap-math.js';

/**
 * THE SALVO — lock-on homing lasers, Panzer Dragoon style.
 *
 * Hold fire: the reticle is a sweep beam. Anything lockable it dwells on
 * accrues a lock every ~85 ms, up to eight, marked by the reticle and a
 * rising audio tick. Release: the orrery fires one homing lance per lock,
 * staggered 45 ms apart, alternating wing hardpoints, each with its own
 * slight oversteer personality so a full salvo reads as a *burst*, not a
 * blob.
 *
 * Tap fire with nothing locked: pulse bolts down the reticle ray — the
 * always-available fallback so the trigger never feels dead.
 *
 * Player ordnance is keyed off Palette `key`/`glow` — NEVER the hostile hue.
 */

const MAX_MISSILES = 64;
const MAX_BOLTS = 48;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _ndc = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);
const _steer = new THREE.Vector3();

function missileMaterial() {
  const m = new MeshBasicNodeMaterial();
  m.name = 'weap.lance';
  const life = attribute('aLife', 'float');       // 1→0 over flight
  m.colorNode = vec3(0.0);
  m.emissiveNode = Fn(() => {
    const core = smoothstep(float(0.5), float(0.05), length(positionLocal.xz));
    const body = mix(Palette.u.key, Palette.u.glow, core.mul(0.9));
    return clampEmissive(body.mul(core.mul(2.2).add(0.7)).mul(life.mul(0.4).add(0.72)).mul(2.0), 3.6);
  })();
  return m;
}

function boltMaterial() {
  const m = new MeshBasicNodeMaterial();
  m.name = 'weap.bolt';
  const life = attribute('aLife', 'float');
  m.colorNode = vec3(0.0);
  m.emissiveNode = Fn(() => {
    const core = smoothstep(float(0.6), float(0.0), length(positionLocal.xy));
    return clampEmissive(
      mix(Palette.u.glow, Palette.u.key, 0.35).mul(core.mul(2.8).add(0.4)).mul(life.mul(0.5).add(0.6)).mul(1.8),
      3.8
    );
  })();
  return m;
}

export class Weapons {
  constructor() {
    this.name = 'weapons';
    this.order = 44;

    this.locks = [];               // {target, born} — Reticle reads this
    this.locking = false;
    this._lockTimer = 0;
    this._holdTime = 0;
    this._fireWas = false;
    this._pulseTimer = 0;
    this._salvoQueue = [];         // pending missile launches {target, at}
    this._salvoClock = 0;
    this._muzzleFlip = false;

    this._missiles = [];
    this._bolts = [];
  }

  async init(ctx) {
    this._ctx = ctx;

    /* missile pool: faceted lances */
    const lanceGeo = dart({ seed: 91, len: 1.4, r: 0.16 });
    const lcount = MAX_MISSILES;
    const lifeAttr = new THREE.InstancedBufferAttribute(new Float32Array(lcount).fill(1), 1);
    lifeAttr.setUsage(THREE.DynamicDrawUsage);
    lanceGeo.setAttribute('aLife', lifeAttr);
    this._mLife = lifeAttr;
    this._mMesh = new THREE.InstancedMesh(lanceGeo, missileMaterial(), lcount);
    this._mMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._mMesh.frustumCulled = false;
    this._mMesh.count = 0;
    ctx.fx.add(this._mMesh);

    for (let i = 0; i < lcount; i++) {
      this._missiles.push({
        alive: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        target: null, age: 0, life: 0, wobble: 0, trail: null,
      });
    }

    /* bolt pool: stretched darts */
    const boltGeo = dart({ seed: 47, len: 1.1, r: 0.10 });
    const blife = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BOLTS).fill(1), 1);
    blife.setUsage(THREE.DynamicDrawUsage);
    boltGeo.setAttribute('aLife', blife);
    this._bLife = blife;
    this._bMesh = new THREE.InstancedMesh(boltGeo, boltMaterial(), MAX_BOLTS);
    this._bMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._bMesh.frustumCulled = false;
    this._bMesh.count = 0;
    ctx.fx.add(this._bMesh);

    for (let i = 0; i < MAX_BOLTS; i++) {
      this._bolts.push({
        alive: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), age: 0, life: 0,
      });
    }

    Bus.on('player:bomb', (d) => this._bomb(d));
    Bus.on('enemy:killed', (d) => this._onTargetKilled(d?.enemy));
  }

  /* ── lock sweep ──────────────────────────────────────────────────────── */
  _sweepLocks(dt, enemies, camera) {
    this._lockTimer -= dt;
    if (this._lockTimer > 0) return;
    const W = CFG.weapons;
    const found = enemies.queryScreen(this._ctx.input.aim, W.lockRadius * 2.2);
    if (!found || found.length === 0) return;
    // prefer fewest-locked, nearest-to-reticle
    let best = null, bestScore = Infinity;
    for (const e of found) {
      if (!e.lockable || !e.alive) continue;
      let n = 0;
      for (const l of this.locks) if (l.target === e) n++;
      if (n >= 3) continue;
      _ndc.copy(e.position).project(camera);
      const d = Math.hypot(_ndc.x - this._ctx.input.aim.x, _ndc.y - this._ctx.input.aim.y);
      const score = d + n * 0.3;
      if (score < bestScore) { bestScore = score; best = e; }
    }
    if (!best) return;
    this._lockTimer = W.lockTime;
    if (this.locks.length < W.maxLocks) {
      this.locks.push({ target: best, born: this._ctx.time.elapsed });
      Bus.emit('weapon:lockAdd', { target: best, count: this.locks.length });
    }
  }

  _clearLocks() {
    if (this.locks.length) Bus.emit('weapon:lockClear', {});
    this.locks.length = 0;
  }

  _onTargetKilled(enemy) {
    if (!enemy) return;
    for (let i = this.locks.length - 1; i >= 0; i--) {
      if (this.locks[i].target === enemy) this.locks.splice(i, 1);
    }
    for (const m of this._missiles) {
      if (m.alive && m.target === enemy) m.target = null;
    }
  }

  /* ── firing ──────────────────────────────────────────────────────────── */
  _releaseSalvo() {
    const n = this.locks.length;
    if (!n) return;
    const targets = this.locks.map((l) => l.target);
    this._clearLocks();
    for (let i = 0; i < n; i++) {
      this._salvoQueue.push({ target: targets[i], at: this._salvoClock + i * CFG.weapons.salvoDelay });
    }
    Bus.emit('weapon:fire', { targets, count: n });
  }

  _launchMissile(target) {
    const player = this._ctx.engine.get('player');
    if (!player?.alive) return;
    let m = null;
    for (const c of this._missiles) if (!c.alive) { m = c; break; }
    if (!m) return;
    this._muzzleFlip = !this._muzzleFlip;
    m.alive = true;
    m.pos.copy(this._muzzleFlip ? player.muzzleL : player.muzzleR);
    // launch outward+forward so the salvo blooms before converging
    _dir.copy(target.position).sub(m.pos).normalize();
    _v.set(this._muzzleFlip ? -1 : 1, 0.35, 0).applyQuaternion(player.root.quaternion);
    m.vel.copy(_dir).multiplyScalar(30).addScaledVector(_v, 26);
    m.target = target;
    m.age = 0;
    m.life = 1;
    m.wobble = hash1(this._salvoClock * 91.7) * 2 - 1;
    const trails = this._ctx.engine.get('trails');
    if (trails) m.trail = trails.spawn({ color: 'key', width: 0.085, life: 0.42, every: 0.008 });
  }

  _fireBolt() {
    const player = this._ctx.engine.get('player');
    if (!player?.alive) return;
    let b = null;
    for (const c of this._bolts) if (!c.alive) { b = c; break; }
    if (!b) return;
    this._muzzleFlip = !this._muzzleFlip;
    b.alive = true;
    b.pos.copy(this._muzzleFlip ? player.muzzleL : player.muzzleR);
    // ray from camera through the reticle, out to 300 m
    _ndc.set(this._ctx.input.aim.x, this._ctx.input.aim.y, 0.5).unproject(this._ctx.camera);
    _dir.copy(_ndc).sub(this._ctx.camera.position).normalize();
    _v.copy(this._ctx.camera.position).addScaledVector(_dir, 300);
    b.vel.copy(_v).sub(b.pos).normalize().multiplyScalar(240);
    b.age = 0;
    b.life = 1;
    Bus.emit('weapon:pulse', { position: b.pos });
  }

  _bomb(d) {
    // overdrive detonation: everything on screen takes heavy damage
    const enemies = this._ctx.engine.get('enemies');
    if (!enemies) return;
    Bus.emit('camera:shake', { amount: 1.2, duration: 0.9 });
    this._ctx.engine.get('postfx')?.flash(0.85);
    for (const e of enemies.active) {
      if (e.alive && e.onScreen) e.takeDamage(6, e.position, { bomb: true });
    }
    enemies.clearBullets();
  }

  /* ── per-frame ───────────────────────────────────────────────────────── */
  update(dt, ctx) {
    const { input, camera } = ctx;
    const enemies = ctx.engine.get('enemies');
    const player = ctx.engine.get('player');
    const W = CFG.weapons;
    this._salvoClock += dt;

    /* bomb */
    if (input.pressed('bomb')) {
      const graze = ctx.engine.get('graze');
      if (graze?.tryBomb()) Bus.emit('player:bomb', { position: player?.position });
    }

    /* trigger edges */
    const fire = !!input.fire && player?.alive;
    if (fire && !this._fireWas) { this._holdTime = 0; this._pulseTimer = 0; }
    if (fire) {
      this._holdTime += dt;
      this.locking = true;
      this._sweepLocks(dt, enemies, camera);
      // pulse fallback: holding with nothing under the reticle still shoots
      if (this.locks.length === 0 && this._holdTime > 0.14) {
        this._pulseTimer -= dt;
        if (this._pulseTimer <= 0) {
          this._pulseTimer = W.pulseRate;
          this._fireBolt();
        }
      }
    } else {
      if (this._fireWas) this._releaseSalvo();
      else if (this.locks.length) this._clearLocks();
      this.locking = false;
    }
    this._fireWas = fire;

    /* salvo queue */
    while (this._salvoQueue.length && this._salvoQueue[0].at <= this._salvoClock) {
      const s = this._salvoQueue.shift();
      if (s.target?.alive) this._launchMissile(s.target);
    }

    /* ── missiles ──────────────────────────────────────────────────────── */
    let mi = 0;
    for (const m of this._missiles) {
      if (!m.alive) continue;
      m.age += dt;
      const speed = Math.min(W.homingSpeed, 30 + m.age * 260);
      if (m.target?.alive) {
        _dir.copy(m.target.position).sub(m.pos).normalize();
        _v2.copy(m.vel).normalize();
        steerToward(
          _v2.x, _v2.y, _v2.z, _dir.x, _dir.y, _dir.z,
          W.homingTurn * (1 + m.wobble * 0.22) * dt, _steer
        );
        m.vel.copy(_steer).multiplyScalar(speed);
      } else {
        m.vel.setLength(Math.min(W.homingSpeed, m.vel.length() + 160 * dt));
      }
      m.pos.addScaledVector(m.vel, dt);
      m.life = 1 - Math.max(0, m.age - 3.2) / 0.8;

      // fuse
      let hit = false;
      if (m.target?.alive) {
        const r = m.target.radius + 0.6;
        if (m.pos.distanceToSquared(m.target.position) < r * r) {
          const killed = m.target.takeDamage(W.damage, m.pos, { weapon: 'lance' });
          Bus.emit('weapon:hit', { target: m.target, position: m.pos, damage: W.damage, killed });
          hit = true;
        }
      }
      if (hit || m.age > 4.0 || m.life <= 0) {
        m.alive = false;
        if (m.trail) { m.trail.end(); m.trail = null; }
        continue;
      }
      if (m.trail) m.trail.point(m.pos);

      _q.setFromUnitVectors(_up, _v2.copy(m.vel).normalize());
      _s.set(1, 1, 1);
      _m.compose(m.pos, _q, _s);
      this._mMesh.setMatrixAt(mi, _m);
      this._mLife.array[mi] = m.life;
      mi++;
    }
    this._mMesh.count = mi;
    this._mMesh.instanceMatrix.needsUpdate = true;
    this._mLife.needsUpdate = true;

    /* ── bolts ─────────────────────────────────────────────────────────── */
    let bi = 0;
    for (const b of this._bolts) {
      if (!b.alive) continue;
      b.age += dt;
      b.pos.addScaledVector(b.vel, dt);
      b.life = 1 - Math.max(0, b.age - 0.9) / 0.35;

      // hit test against active enemies (cheap sphere sweep)
      let dead = b.age > 1.25;
      if (!dead && enemies) {
        for (const e of enemies.active) {
          if (!e.alive || !e.lockable) continue;
          const r = e.radius + 0.35;
          if (b.pos.distanceToSquared(e.position) < r * r) {
            const killed = e.takeDamage(W.pulseDamage, b.pos, { weapon: 'bolt' });
            Bus.emit('weapon:hit', { target: e, position: b.pos, damage: W.pulseDamage, killed });
            dead = true;
            break;
          }
        }
      }
      if (dead) { b.alive = false; continue; }

      _q.setFromUnitVectors(_up, _v2.copy(b.vel).normalize());
      _m.compose(b.pos, _q, _s);
      this._bMesh.setMatrixAt(bi, _m);
      this._bLife.array[bi] = b.life;
      bi++;
    }
    this._bMesh.count = bi;
    this._bMesh.instanceMatrix.needsUpdate = true;
    this._bLife.needsUpdate = true;
  }
}
export default Weapons;
