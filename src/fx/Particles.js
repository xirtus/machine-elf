import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn, If, Discard, vec2, vec3, vec4, float, int, uniform, attribute,
  positionLocal, uv, cameraWorldMatrix, cameraPosition, time as tslTime,
  sin, cos, length, normalize, mix, smoothstep, step, pow, oneMinus, saturate,
  cross, dot, fract, floor, hash, select,
} from 'three/tsl';
import Bus from '../core/Bus.js';
import Palette from '../render/Palette.js';
import { clampEmissive } from '../util/mat-nodes.js';
import { makeShardGeometry } from '../util/craft-geometry.js';

/**
 * PARTICLES — fully GPU-parametric. The CPU writes a ring-buffer of spawn
 * attributes (birth time, origin, velocity, size, colour, kind); the vertex
 * shader integrates position from age every frame. Per-frame CPU cost of
 * 4000 live particles: zero.
 *
 *   kind 0  mote    — slow luminous dust, the depth cue of hyperspace
 *   kind 1  spark   — fast bright dot with drag
 *   kind 2  shard   — glass sliver: stretched along velocity, tumbling flash
 *   kind 3  ring    — expanding shockwave annulus
 *   kind 4  flash   — one big soft pop of light
 *   kind 5  ember   — rises against gravity, long-lived
 *
 * Two draws: a billboard pool (motes/sparks/rings/flashes/embers) and a
 * velocity-aligned streak pool (shards). All additive, all emissive-fed.
 */

const GLOW_CAP = 2048;
const STREAK_CAP = 1024;

const _c = new THREE.Color();

function glowMaterial() {
  // packed: A=(birth,life,size,kind) B=(pos.xyz,seed) C=(vel.xyz,—)
  const aA = attribute('aA', 'vec4');
  const aB = attribute('aB', 'vec4');
  const aC = attribute('aC', 'vec4');
  const aColor = attribute('aColor', 'vec3');
  const aBirth = aA.x, aLife = aA.y, aSize = aA.z, aKind = aA.w;
  const aPos = aB.xyz, aSeed = aB.w;
  const aVel = aC.xyz;

  const age = tslTime.sub(aBirth);
  const t = saturate(age.div(aLife));
  const dead = age.lessThan(0.0).or(t.greaterThanEqual(1.0));

  // parametric integration: drag for sparks, rise for embers
  const drag = select(aKind.equal(1.0), float(0.88), float(1.0));
  const grav = select(aKind.equal(5.0), float(2.2), float(0.0));
  const integ = aVel.mul(age.mul(drag)).add(vec3(0, 1, 0).mul(grav.mul(age).mul(age).mul(0.5)));
  const center = aPos.add(integ);

  // camera basis (world space) — columns of the camera's world matrix
  const right = cameraWorldMatrix.element(0).xyz;
  const up = cameraWorldMatrix.element(1).xyz;

  // rings grow fast then huge; everything else breathes
  const grow = select(aKind.equal(3.0), t.mul(3.2).add(0.25), t.mul(0.4).add(0.85));
  const size = aSize.mul(grow);
  const world = center.add(right.mul(positionLocal.x.mul(size))).add(up.mul(positionLocal.y.mul(size)));

  const fadeIn = smoothstep(float(0.0), float(0.06), t);
  const fadeOut = oneMinus(smoothstep(float(0.55), float(1.0), t));

  const m = new MeshBasicNodeMaterial();
  m.name = 'fx.glow';
  m.transparent = true;
  m.blending = THREE.AdditiveBlending;
  m.depthWrite = false;
  m.fog = false;

  m.positionNode = world;

  const radial = uv().sub(vec2(0.5)).length().mul(2.0);
  const dotMask = smoothstep(float(1.0), float(0.25), radial);
  // ring annulus: radius sweeps outward with t
  const ringR = t.mul(0.9).add(0.05);
  const ringMask = smoothstep(float(0.22), float(0.0), radial.sub(ringR).abs());
  const flashMask = smoothstep(float(1.0), float(0.0), radial).pow(float(2.2));

  const mask = select(aKind.equal(3.0), ringMask,
    select(aKind.equal(4.0), flashMask, dotMask));

  const gain = select(aKind.equal(4.0), float(3.2),
    select(aKind.equal(3.0), float(1.8),
      select(aKind.equal(0.0), float(0.5), float(1.5))));

  m.colorNode = vec3(0.0);
  m.opacityNode = mask.mul(fadeIn).mul(fadeOut);
  m.emissiveNode = Fn(() => {
    If(dead, () => Discard());
    const tw = select(aKind.equal(0.0),
      floor(fract(tslTime.mul(0.8).add(aSeed)).mul(3.0)).div(3.0).mul(0.6).add(0.4),
      float(1.0));
    return clampEmissive(
      aColor.mul(mask).mul(fadeIn).mul(fadeOut).mul(gain).mul(tw).mul(Palette.u.gain), 3.4
    );
  })();
  return m;
}

function streakMaterial() {
  const aA = attribute('aA', 'vec4');
  const aB = attribute('aB', 'vec4');
  const aC = attribute('aC', 'vec4');
  const aColor = attribute('aColor', 'vec3');
  const aBirth = aA.x, aLife = aA.y, aSize = aA.z;
  const aPos = aB.xyz, aSeed = aB.w;
  const aVel = aC.xyz;

  const age = tslTime.sub(aBirth);
  const t = saturate(age.div(aLife));
  const dead = age.lessThan(0.0).or(t.greaterThanEqual(1.0));

  const grav = vec3(0, -3.2, 0);
  const center = aPos.add(aVel.mul(age)).add(grav.mul(age.mul(age).mul(0.5)));

  const axis = normalize(aVel.add(vec3(1e-5)));
  const toCam = normalize(cameraPosition.sub(center));
  const side = normalize(cross(axis, toCam).add(vec3(1e-6)));

  const len = aSize.mul(2.6).mul(t.oneMinus().mul(0.5).add(0.6));
  const wid = aSize.mul(0.16);
  const world = center
    .add(axis.mul(positionLocal.y.mul(len)))
    .add(side.mul(positionLocal.x.mul(wid)));

  const fade = oneMinus(smoothstep(float(0.4), float(1.0), t));
  const flicker = hash(aSeed.add(floor(tslTime.mul(24.0)))).mul(0.7).add(0.3);

  const m = new MeshBasicNodeMaterial();
  m.name = 'fx.streak';
  m.transparent = true;
  m.blending = THREE.AdditiveBlending;
  m.depthWrite = false;
  m.fog = false;
  m.side = THREE.DoubleSide;

  m.positionNode = world;
  m.colorNode = vec3(0.0);
  m.opacityNode = fade;
  m.emissiveNode = Fn(() => {
    If(dead, () => Discard());
    return clampEmissive(
      aColor.mul(fade).mul(flicker).mul(2.2).mul(Palette.u.gain), 3.2
    );
  })();
  return m;
}

export class Particles {
  constructor() {
    this.name = 'particles';
    this.order = 50;
    this._glowHead = 0;
    this._streakHead = 0;
    this._moteClock = 0;
  }

  async init(ctx) {
    this._ctx = ctx;

    const mk = (cap, mat) => {
      const geo = new THREE.PlaneGeometry(2, 2);
      geo.deleteAttribute('normal');
      const attrs = {
        aA: new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4),
        aB: new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4),
        aC: new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4),
        aColor: new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3),
      };
      for (let i = 0; i < cap; i++) { attrs.aA.array[i * 4] = -1000; attrs.aA.array[i * 4 + 1] = 1; }
      for (const k of Object.keys(attrs)) {
        attrs[k].setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute(k, attrs[k]);
      }
      const mesh = new THREE.InstancedMesh(geo, mat, cap);
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);   // identity; real pos in attrs
      mesh.frustumCulled = false;
      const ident = new THREE.Matrix4();
      for (let i = 0; i < cap; i++) mesh.setMatrixAt(i, ident);
      ctx.fx.add(mesh);
      return { mesh, attrs, cap };
    };

    this._glow = mk(GLOW_CAP, glowMaterial());
    this._streak = mk(STREAK_CAP, streakMaterial());
    window.__particles = this;
  }

  _write(pool, i, birth, life, pos, vel, size, color, kind, seed) {
    const a = pool.attrs;
    a.aA.array[i * 4] = birth; a.aA.array[i * 4 + 1] = life; a.aA.array[i * 4 + 2] = size; a.aA.array[i * 4 + 3] = kind;
    a.aB.array[i * 4] = pos.x; a.aB.array[i * 4 + 1] = pos.y; a.aB.array[i * 4 + 2] = pos.z; a.aB.array[i * 4 + 3] = seed;
    a.aC.array[i * 4] = vel.x; a.aC.array[i * 4 + 1] = vel.y; a.aC.array[i * 4 + 2] = vel.z; a.aC.array[i * 4 + 3] = 0;
    a.aColor.array[i * 3] = color.r; a.aColor.array[i * 3 + 1] = color.g; a.aColor.array[i * 3 + 2] = color.b;
  }

  _dirty(pool) {
    for (const k of Object.keys(pool.attrs)) pool.attrs[k].needsUpdate = true;
  }

  /**
   * burst('shatter', pos, {count, color:'key', speed, size, life, dir, spread})
   * kind ∈ mote | spark | shard | ring | flash | ember
   */
  burst(kind, position, opts = {}) {
    const kindId = { mote: 0, spark: 1, shard: 2, ring: 3, flash: 4, ember: 5 }[kind] ?? 1;
    const count = opts.count ?? (kindId === 3 || kindId === 4 ? 1 : 14);
    const speed = opts.speed ?? (kindId === 1 ? 22 : kindId === 2 ? 16 : kindId === 5 ? 4 : 8);
    const life = opts.life ?? (kindId === 0 ? 9 : kindId === 3 ? 0.9 : kindId === 4 ? 0.5 : kindId === 5 ? 2.4 : 0.8);
    const size = opts.size ?? (kindId === 3 ? 6 : kindId === 4 ? 10 : kindId === 0 ? 0.5 : 0.9);
    _c.copy(opts.color && typeof opts.color === 'string' ? Palette.get(opts.color) : (opts.color?.isColor ? opts.color : Palette.key));
    if (opts.bright) _c.multiplyScalar(opts.bright);
    const now = this._ctx.time.elapsed;
    const dir = opts.dir;
    const spread = opts.spread ?? 1;

    for (let n = 0; n < count; n++) {
      const seed = Math.random();
      // random unit vector, biased along dir if given
      const u = Math.random() * 2 - 1, ph = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      _v3x = r * Math.cos(ph); _v3y = r * Math.sin(ph); _v3z = u;
      _vel.set(_v3x, _v3y, _v3z);
      if (dir) _vel.lerp(_dir.copy(dir).normalize(), 1 - spread).normalize();
      _vel.multiplyScalar(speed * (0.4 + Math.random() * 0.9));

      if (kindId === 2) {
        const i = this._streakHead;
        this._streakHead = (this._streakHead + 1) % this._streak.cap;
        this._write(this._streak, i, now, life * (0.7 + Math.random() * 0.6), position, _vel, size * (0.6 + Math.random() * 0.8), _c, 2, seed);
      } else {
        const i = this._glowHead;
        this._glowHead = (this._glowHead + 1) % this._glow.cap;
        const lifeJ = life * (0.75 + Math.random() * 0.5);
        const sizeJ = size * (0.7 + Math.random() * 0.7);
        this._write(this._glow, i, now, lifeJ, position, kindId === 3 || kindId === 4 ? _zero : _vel, sizeJ, _c, kindId, seed);
      }
    }
    this._dirty(this._glow);
    this._dirty(this._streak);
  }

  update(dt, ctx) {
    /* ambient mote field — the dust of hyperspace, always drifting past */
    this._moteClock -= dt;
    if (this._moteClock <= 0) {
      this._moteClock = 0.22;
      const cam = ctx.camera;
      _vel.set(0, 0, 0);
      _pos.copy(cam.position)
        .addScaledVector(cam.getWorldDirection(_dir), 60 + Math.random() * 160)
        .add(_rand.set((Math.random() - 0.5) * 90, (Math.random() - 0.5) * 60, (Math.random() - 0.5) * 60));
      this.burst('mote', _pos, {
        count: 1, color: Math.random() < 0.7 ? 'rim' : 'key',
        speed: 0.4, size: 0.5 + Math.random() * 0.7, life: 8,
      });
    }
  }
}

const _v3 = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _rand = new THREE.Vector3();
const _zero = new THREE.Vector3();
let _v3x = 0, _v3y = 0, _v3z = 0;

export default Particles;
