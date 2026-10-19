import * as THREE from 'three';
import { MeshBasicNodeMaterial, LineBasicNodeMaterial } from 'three/webgpu';
import {
  Fn, vec2, vec3, vec4, float, uniform, attribute, positionLocal, normalLocal,
  time, sin, cos, abs, dot, length, normalize, mix, smoothstep, step, pow,
  max, min, clamp, oneMinus, saturate, cross, uv,
} from 'three/tsl';
import Bus from '../core/Bus.js';
import CFG from '../core/Config.js';
import Palette from '../render/Palette.js';
import { neonGlass, clockworkBrass, sacredGeometry, voidMatte } from '../render/Materials.js';
import { clampEmissive } from '../util/mat-nodes.js';
import {
  makeHullGeometry, makeSeamGeometry, makeVaneGeometry, makeHoopGeometry,
  makeCoreGeometry, makeShardGeometry, makeNozzleGeometry, makePlumeGeometry,
  bakeShatter, HULL_BOUNDS,
} from '../util/craft-geometry.js';
import { Spring, damp, clamp as clampN, easeBackOut } from '../util/craft-math.js';

/**
 * THE ORRERY — the player craft.
 *
 * A blown-glass dragonfly orrery: a lofted jewel fuselage you can see the
 * burning core through, four brass vanes, two ticking gimbal hoops, a court
 * of sigil shards in a tilted orbit, and twin plumes that flare with boost.
 *
 * Movement is Panzer Dragoon: the craft lives in a 2D cage perpendicular to
 * the rail, chases the reticle, and banks *far* more than it translates —
 * the lean sells the speed. Everything springy, nothing linear.
 *
 * Death is a full glass shatter: the hull's bakeShatter attributes blow the
 * surface into a thousand tumbling fragments, then the craft re-materialises.
 */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();

export class Player {
  constructor() {
    this.name = 'player';
    this.order = 30;

    this.position = new THREE.Vector3();
    this.cageOffset = new THREE.Vector2();
    this.velocity = new THREE.Vector2();     // cage-space, for banking
    this.isBoosting = false;
    this.health = CFG.player.maxHealth;
    this.maxHealth = CFG.player.maxHealth;
    this.invulnerable = false;
    this.alive = true;
    this.radius = CFG.player.hitRadius;

    this.muzzleL = new THREE.Vector3();
    this.muzzleR = new THREE.Vector3();
    this.nose = new THREE.Vector3();

    this._bank = new Spring(9, 0.62);
    this._pitch = new Spring(8, 0.7);
    this._yaw = new Spring(7, 0.72);
    this._iframes = 0;
    this._deadTime = 0;
    this._respawnAt = 0;
    this._uDeath = uniform(0);
    this._uBoost = uniform(0);
    this._uFlash = uniform(0);
    this._boostPrev = false;
    this._time = 0;
  }

  async init(ctx) {
    this._ctx = ctx;
    const glass = neonGlass({ tint: 'key', core: 'accent', dispersion: 6.0, coreGain: 2.1, rimGain: 1.85, thickness: 1.1, detail: 2.4 });
    const brass = clockworkBrass({ tint: 'accent', glow: 0.7 });
    this._glass = glass;

    const root = new THREE.Group();
    root.name = 'craft';
    this.root = root;
    ctx.world.add(root);

    /* ── fuselage: hero transmission glass ─────────────────────────────── */
    const hullData = makeHullGeometry({});
    this.hull = new THREE.Mesh(hullData.geometry, glass);
    root.add(this.hull);

    /* emissive seam filaments traced on the hull surface */
    const seamGeo = makeSeamGeometry(hullData.rings, hullData.N, hullData.M, {});
    const seamMat = new LineBasicNodeMaterial();
    seamMat.transparent = true;
    seamMat.blending = THREE.AdditiveBlending;
    seamMat.depthWrite = false;
    seamMat.colorNode = Palette.u.accent.mul(1.5);
    this.seams = new THREE.LineSegments(seamGeo, seamMat);
    root.add(this.seams);

    /* ── the core: a furnace jewel visible through the hull ────────────── */
    const coreMat = new MeshBasicNodeMaterial();
    coreMat.name = 'craft.core';
    const pulse = sin(time.mul(2.3)).mul(0.5).add(0.5);
    coreMat.colorNode = vec3(0.0);
    coreMat.emissiveNode = clampEmissive(
      mix(Palette.u.accent, Palette.u.glow, pulse.mul(0.45))
        .mul(pulse.mul(0.5).add(0.55))
        .add(vec3(this._uFlash).mul(2.0)),
      2.2
    );
    this.core = new THREE.Mesh(makeCoreGeometry({ seed: 7, count: 46, radius: 0.34 }), coreMat);
    this.core.position.set(0, 0.02, -0.15);
    this.core.scale.setScalar(0.8);
    root.add(this.core);

    /* ── brass vanes: four dragonfly wings, swept ──────────────────────── */
    const vaneGeo = makeVaneGeometry({});
    this.vanes = [];
    const vaneDefs = [
      { p: [0.42, 0.14, 0.30], e: [0.06, -0.22, 0.34], s: 1.0 },   // starboard high
      { p: [-0.42, 0.10, 0.34], e: [0.10, 0.24, -2.99], s: 0.94 }, // port high (mirrored, asymmetric)
      { p: [0.36, -0.20, 0.52], e: [-0.14, -0.30, 2.72], s: 0.72 },// starboard low
      { p: [-0.38, -0.22, 0.50], e: [-0.08, 0.26, -0.5], s: 0.78 },// port low
    ];
    for (const d of vaneDefs) {
      const v = new THREE.Mesh(vaneGeo, brass);
      v.position.fromArray(d.p);
      v.rotation.set(d.e[0], d.e[1], d.e[2]);
      v.scale.setScalar(d.s);
      root.add(v);
      this.vanes.push(v);
    }

    /* ── gimbal hoops: ticking clockwork orrery rings ──────────────────── */
    this.hoops = [];
    const hoopMat = sacredGeometry({
      lineColor: 'accent', altColor: 'key', freq: 4.0, rings: 0.2, spokes: 0.9,
      spokeCount: 16, intensity: 2.4, transparentBody: true,
    });
    const h1 = new THREE.Mesh(makeHoopGeometry({ R: 0.92, segs: 72, teeth: 22, toothAmp: 0.05 }), hoopMat);
    h1.position.set(0, 0.02, -0.2);
    h1.rotation.x = Math.PI / 2;
    root.add(h1);
    const h2 = new THREE.Mesh(makeHoopGeometry({ R: 0.62, segs: 56, teeth: 15, toothAmp: 0.07 }), brass);
    h2.position.set(0, 0.05, 0.55);
    h2.rotation.y = Math.PI / 2.4;
    root.add(h2);
    this.hoops.push(h1, h2);

    /* ── shard court: five sigils in a slow tilted orbit ───────────────── */
    this.shards = [];
    const shardGeo = makeShardGeometry({ seed: 31, count: 9, radius: 0.16 });
    for (let i = 0; i < 5; i++) {
      const s = new THREE.Mesh(shardGeo, glass);
      root.add(s);
      this.shards.push({ mesh: s, phase: (i / 5) * Math.PI * 2, r: 1.35 + (i % 2) * 0.22, tilt: 0.5 + i * 0.13, speed: 0.35 + (i % 3) * 0.14 });
    }

    /* ── engines: nozzles + additive plumes ────────────────────────────── */
    const nozGeo = makeNozzleGeometry({});
    this.plumes = [];
    const plumeMat = new MeshBasicNodeMaterial();
    plumeMat.name = 'craft.plume';
    plumeMat.transparent = true;
    plumeMat.blending = THREE.AdditiveBlending;
    plumeMat.depthWrite = false;
    plumeMat.side = THREE.DoubleSide;
    const uBoost = this._uBoost;
    plumeMat.colorNode = vec3(0.0);
    plumeMat.opacityNode = Fn(() => {
      const axial = uv().y.oneMinus();          // 1 at nozzle → 0 at tail
      return pow(axial, float(1.6)).mul(0.75);
    })();
    plumeMat.emissiveNode = Fn(() => {
      const axial = uv().y.oneMinus();
      const flick = sin(time.mul(31.0).add(positionLocal.y.mul(8.0))).mul(0.5).add(0.5);
      const hot = mix(Palette.u.glow, Palette.u.key, axial.mul(0.8));
      return clampEmissive(
        hot.mul(pow(axial, float(2.6)).mul(1.15).mul(flick.mul(0.4).add(0.7)))
           .mul(uBoost.mul(1.3).add(0.55)),
        2.6
      );
    })();
    const plumeGeo = makePlumeGeometry({ length: 2.1, r0: 0.13, r1: 0.035 });
    for (const side of [-1, 1]) {
      const nz = new THREE.Mesh(nozGeo, brass);
      nz.position.set(side * 0.30, 0.02, HULL_BOUNDS.z1 - 0.28);
      nz.rotation.x = Math.PI / 2;      // nozzle axis along +Z (rear)
      root.add(nz);
      const pl = new THREE.Mesh(plumeGeo, plumeMat);
      pl.position.set(side * 0.30, 0.02, HULL_BOUNDS.z1 - 0.1);
      pl.rotation.x = -Math.PI / 2;     // plume extends backward
      root.add(pl);
      this.plumes.push(pl);
    }

    /* ── death shatter hull (hidden until needed) ──────────────────────── */
    const shatterGeo = bakeShatter(hullData.geometry.clone(), { cell: 0.34, seed: 5, speed: 7.0 });
    const shatterMat = new MeshBasicNodeMaterial();
    shatterMat.name = 'craft.shatter';
    shatterMat.transparent = true;
    shatterMat.depthWrite = false;
    const uDeath = this._uDeath;
    const aC = attribute('aCenter', 'vec3');
    const aV = attribute('aVel', 'vec3');
    const aS = attribute('aSpin', 'vec4');
    shatterMat.positionNode = Fn(() => {
      const t = uDeath.sub(aS.w.mul(0.35)).max(float(0.0));
      // Rodrigues rotation about the spin axis
      const ax = normalize(aS.xyz.add(vec3(1e-5)));
      const ang = t.mul(length(aS.xyz));
      const rel = positionLocal.sub(aC);
      const rot = rel.mul(cos(ang))
        .add(cross(ax, rel).mul(sin(ang)))
        .add(ax.mul(dot(ax, rel)).mul(oneMinus(cos(ang))));
      return aC.add(rot).add(aV.mul(t)).add(vec3(0, t.mul(t).mul(-1.2), 0));
    })();
    shatterMat.opacityNode = oneMinus(smoothstep(float(0.55), float(1.0), uDeath));
    shatterMat.emissiveNode = clampEmissive(
      mix(Palette.u.key, Palette.u.glow, uDeath).mul(uDeath.oneMinus().mul(2.2).add(0.4)),
      3.0
    );
    shatterMat.colorNode = vec3(0.01);
    this.shatter = new THREE.Mesh(shatterGeo, shatterMat);
    this.shatter.visible = false;
    root.add(this.shatter);

    // muzzle hardpoints (local)
    this._muzzleLLocal = new THREE.Vector3(-0.52, -0.05, -1.1);
    this._muzzleRLocal = new THREE.Vector3(0.52, -0.05, -1.1);

    Bus.on('player:hit', (d) => this._onHit(d));
    window.__player = this;
  }

  /* ── damage / death ──────────────────────────────────────────────────── */
  _onHit(d) {
    if (!this.alive || this.invulnerable) return;
    this.health = Math.max(0, this.health - (d?.damage ?? 1));
    this._uFlash.value = 1;
    Bus.emit('camera:shake', { amount: 0.7, duration: 0.5 });
    Bus.emit('time:hitstop', { duration: 0.09 });
    if (this.health <= 0) this._die();
    else {
      this.invulnerable = true;
      this._iframes = CFG.player.iframes;
    }
  }

  _die() {
    this.alive = false;
    this._deadTime = 0;
    this._uDeath.value = 0.0001;
    this.shatter.visible = true;
    this.hull.visible = false;
    this.seams.visible = false;
    this.core.visible = false;
    for (const v of this.vanes) v.visible = false;
    for (const h of this.hoops) h.visible = false;
    for (const s of this.shards) s.mesh.visible = false;
    for (const p of this.plumes) p.visible = false;
    Bus.emit('player:dead', { position: this.position });
    Bus.emit('camera:shake', { amount: 1.6, duration: 1.4 });
    Bus.emit('time:hitstop', { duration: 0.22 });
  }

  respawn() {
    this.alive = true;
    this.health = this.maxHealth;
    this.invulnerable = true;
    this._iframes = 3.0;
    this._uDeath.value = 0;
    this.shatter.visible = false;
    this.hull.visible = true;
    this.seams.visible = true;
    this.core.visible = true;
    for (const v of this.vanes) v.visible = true;
    for (const h of this.hoops) h.visible = true;
    for (const s of this.shards) s.mesh.visible = true;
    for (const p of this.plumes) p.visible = true;
    Bus.emit('player:respawn', {});
  }

  /* ── per-frame ───────────────────────────────────────────────────────── */
  update(dt, ctx) {
    this._time += dt;
    const { input } = ctx;
    const rail = ctx.engine.get('rail');
    if (!rail?.current) return;
    const P = CFG.player;

    /* death shatter progress runs on scaled time so hitstop still shows it */
    if (!this.alive) {
      this._deadTime += dt;
      this._uDeath.value = Math.min(1, this._uDeath.value + dt * 0.85);
      this.root.position.copy(this.position);
      this.root.quaternion.copy(rail.current.quaternion);
      return;
    }

    /* ── cage motion: chase the reticle, soft-edged ────────────────────── */
    const tx = clampN(input.move.x, -1, 1);
    const ty = clampN(input.move.y, -1, 1);
    const k = 1 - Math.exp(-P.moveSmooth * dt);
    const nx = this.cageOffset.x + (tx - this.cageOffset.x) * k;
    const ny = this.cageOffset.y + (ty - this.cageOffset.y) * k;
    this.velocity.set(
      (nx - this.cageOffset.x) / Math.max(dt, 1e-4),
      (ny - this.cageOffset.y) / Math.max(dt, 1e-4)
    );
    this.cageOffset.set(nx, ny);

    /* ── boost ─────────────────────────────────────────────────────────── */
    const boosting = !!input.boost && this.alive;
    if (boosting !== this._boostPrev) {
      this._boostPrev = boosting;
      this.isBoosting = boosting;
      Bus.emit('player:boost', { on: boosting });
    }
    this._uBoost.value += ((boosting ? 1 : 0) - this._uBoost.value) * Math.min(1, dt * 5);

    /* ── pose: rail frame + banked local attitude ──────────────────────── */
    rail.cageToWorld(this.cageOffset.x, this.cageOffset.y, 0, this.position);
    this.root.position.copy(this.position);

    const vx = clampN(this.velocity.x, -2.4, 2.4);
    const vy = clampN(this.velocity.y, -2.4, 2.4);
    this._bank.target = -vx * P.bankMax * 0.5 - rail.current.bank * 0.35;
    this._pitch.target = -vy * P.pitchMax * 0.55;
    this._yaw.target = -vx * P.yawMax * 0.5;
    const bank = this._bank.step(dt);
    const pitch = this._pitch.step(dt);
    const yaw = this._yaw.step(dt);
    _e.set(pitch, yaw, bank, 'XYZ');
    _q.setFromEuler(_e);
    this.root.quaternion.copy(rail.current.quaternion).multiply(_q);

    /* ── secondary motion: the orrery ticks ────────────────────────────── */
    const t = this._time;
    // hoops tick in quanta — the escapement read
    const h1t = t * 0.9;
    const h1tick = Math.floor(h1t) + easeBackOut(Math.min(1, h1t - Math.floor(h1t)) / 0.24, 2.2);
    this.hoops[0].rotation.y = h1tick * (Math.PI / 11);
    const h2t = t * 0.6;
    const h2tick = Math.floor(h2t) + easeBackOut(Math.min(1, h2t - Math.floor(h2t)) / 0.3, 2.4);
    this.hoops[1].rotation.z = -h2tick * (Math.PI / 9);

    // shard court: tilted orbit, breathing radius
    for (const s of this.shards) {
      const a = s.phase + t * s.speed;
      const r = s.r * (1 + Math.sin(t * 0.7 + s.phase * 2.0) * 0.08);
      s.mesh.position.set(
        Math.cos(a) * r,
        Math.sin(a) * r * Math.sin(s.tilt) * 0.5 + Math.sin(t * 0.5 + s.phase) * 0.1,
        Math.sin(a) * r * Math.cos(s.tilt) * 0.6 - 0.1
      );
      s.mesh.rotation.set(t * 0.8 + s.phase, a, s.tilt);
    }

    // vanes flex with bank — the dragonfly read
    this.vanes[0].rotation.z = 0.34 + bank * 0.22;
    this.vanes[1].rotation.z = -2.99 + bank * 0.22;
    this.vanes[2].rotation.z = 2.72 + bank * 0.14;
    this.vanes[3].rotation.z = -0.5 + bank * 0.14;

    // plumes flare with boost & speed
    const flare = 0.55 + this._uBoost.value * 0.9 + (rail.speed / 160) * 0.25;
    for (const p of this.plumes) {
      p.scale.set(0.8, 0.8, flare);
      p.visible = this._uBoost.value > 0.02 || rail.speed > 40;
    }

    // core follows flash decay
    this._uFlash.value *= Math.exp(-dt * 6);

    // iframe blink — the craft strobes, not the world
    if (this.invulnerable) {
      this._iframes -= dt;
      const blink = Math.sin(t * 34) > 0 ? 1 : 0.25;
      this.hull.visible = blink > 0.5;
      if (this._iframes <= 0) { this.invulnerable = false; this.hull.visible = true; }
    }

    /* muzzle world positions */
    this.muzzleL.copy(this._muzzleLLocal).applyQuaternion(this.root.quaternion).add(this.position);
    this.muzzleR.copy(this._muzzleRLocal).applyQuaternion(this.root.quaternion).add(this.position);
    this.nose.set(0, 0, HULL_BOUNDS.z0).applyQuaternion(this.root.quaternion).add(this.position);
  }
}
export default Player;
