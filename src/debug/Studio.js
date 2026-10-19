import * as THREE from 'three';
import {
  lathe, jewel, strut, blade, gear, shardRing, cage, compose,
} from '../util/enemy-geometry.js';
import { makeNeonGlass, makeClockworkBrass } from '../util/enemy-materials.js';
import { neonGlass, clockworkBrass } from '../render/Materials.js';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { vec3 } from 'three/tsl';

/**
 * STUDIO — dev-only specimen inspection harness (load with ?studio).
 *
 * Freezes the rail, replaces the chase camera with an eased orbit rig, and
 * lets the console drive every visual subject in isolation:
 *
 *   __studio.subject('craft'|'wisp'|'weaver'|'lancer'|'gyre'|'boss0..2'|'none')
 *   __studio.orbit({az, el, dist})     azimuth/elevation radians, metres
 *   __studio.slow(v)                   gameplay time scale while orbiting
 *   __studio.pause() / __studio.resume()
 *
 * Elf specimens are standalone meshes built from the same geometry defs the
 * live enemies use, so materials can be judged one subject at a time.
 */

const ELF_DEFS = {
  wisp: () => ({
    glass: compose([
      { geo: jewel({ sides: 6, seed: 11, height: 0.75, radius: 0.42 }), p: [0, 0, 0] },
      { geo: shardRing({ count: 5, radius: 0.5, size: 0.1, seed: 21 }), p: [0, -0.1, 0] },
    ]),
    brass: compose([
      { geo: gear({ teeth: 8, rOuter: 0.3, rInner: 0.2, thick: 0.05, seed: 5, gap: 1 }), p: [0, -0.32, 0] },
    ]),
  }),
  weaver: () => ({
    glass: compose([
      { geo: lathe({ sides: 6, seed: 31, jitter: 0.12, twist: 0.8, profile: [[0, -1.1], [0.3, -0.6], [0.42, 0], [0.26, 0.7], [0, 1.25]] }), p: [0, 0, 0], e: [Math.PI / 2, 0, 0] },
      { geo: blade({ seed: 7 }), p: [0.34, 0, 0.1], e: [0, 0, -0.5] },
      { geo: blade({ seed: 9 }), p: [-0.36, 0, -0.06], e: [0, 0, 2.6] },
    ]),
    brass: compose([
      { geo: strut({ len: 1.3, r0: 0.05, r1: 0.02, sides: 3, seed: 13 }), p: [0, 0.15, 0.3], e: [0.9, 0, 0] },
      { geo: gear({ teeth: 7, rOuter: 0.22, rInner: 0.14, thick: 0.05, seed: 17, gap: 0 }), p: [0, 0, -0.5] },
    ]),
  }),
  lancer: () => ({
    glass: compose([
      { geo: lathe({ sides: 8, seed: 41, jitter: 0.1, profile: [[0, -1.3], [0.55, -0.9], [0.75, -0.2], [0.6, 0.5], [0.3, 1.0], [0, 1.35]] }), p: [0, 0, 0], e: [Math.PI / 2, 0, 0] },
      { geo: shardRing({ count: 8, radius: 0.85, size: 0.14, seed: 51, tilt: 0.2 }), p: [0, 0, 0.2], e: [Math.PI / 2, 0, 0] },
    ]),
    brass: compose([
      { geo: gear({ teeth: 11, rOuter: 0.5, rInner: 0.34, thick: 0.09, seed: 23, gap: 2 }), p: [0.75, 0.1, 0], e: [0, 0, Math.PI / 2] },
      { geo: gear({ teeth: 9, rOuter: 0.4, rInner: 0.26, thick: 0.08, seed: 29, gap: 1 }), p: [-0.72, -0.05, 0.1], e: [0, 0, Math.PI / 2] },
      { geo: cage({ ribs: 4, height: 1.4, radius: 0.5, seed: 37 }), p: [0, 0, 0.6], e: [Math.PI / 2, 0, 0] },
    ]),
  }),
  gyre: () => ({
    glass: compose([
      { geo: shardRing({ count: 9, radius: 1.0, size: 0.22, seed: 61, wobble: 0.3, tilt: 0.5 }), p: [0, 0, 0] },
      { geo: jewel({ sides: 7, seed: 67, height: 0.9, radius: 0.4, jitter: 0.22 }), p: [0, 0, 0] },
    ]),
    brass: compose([
      { geo: gear({ teeth: 13, rOuter: 0.62, rInner: 0.45, thick: 0.07, seed: 71, gap: 2 }), p: [0, 0, 0] },
    ]),
  }),
};

export class Studio {
  constructor() {
    this.name = 'studio';
    this.order = 110;             // after camerarig — we override the view
    this.active = typeof location !== 'undefined' && location.search.includes('studio');
    this.target = null;
    this.az = 0.7; this.el = 0.28; this.dist = 12;
    this._az = 0.7; this._el = 0.28; this._dist = 12;
    this.slow = 1;
    this._spin = 0.12;
    this._specimens = new THREE.Group();
    this._hold = new THREE.Vector3(0, 0, -80);
  }

  async init(ctx) {
    if (!this.active) return;
    this._ctx = ctx;
    const rail = ctx.engine.get('rail');
    if (rail) rail.paused = true;
    const rig = ctx.engine.get('camerarig');
    if (rig) rig.enabled = false;
    this._specimens.name = 'studioSpecimens';
    ctx.world.add(this._specimens);

    const glass = makeNeonGlass({ instanced: false });
    const brass = makeClockworkBrass({ instanced: false });
    const stamp = (geo, tintRGB) => {
      // per-vertex instance channels the elf materials expect
      const n = geo.attributes.position.count;
      const tint = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        tint[i * 3] = tintRGB[0]; tint[i * 3 + 1] = tintRGB[1]; tint[i * 3 + 2] = tintRGB[2];
      }
      const state = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) state[i * 4 + 3] = Math.random();
      geo.setAttribute('aTint', new THREE.BufferAttribute(tint, 3));
      geo.setAttribute('aState', new THREE.BufferAttribute(state, 4));
      return geo;
    };
    for (const [type, build] of Object.entries(ELF_DEFS)) {
      const g = new THREE.Group();
      g.name = `studio:${type}`;
      const def = build();
      // palette-flavoured tints: glass key-cyan, brass gold — like the live
      // elves get from Enemies._tintFor
      const gm = new THREE.Mesh(stamp(def.glass, [0.18, 0.55, 0.75]), glass);
      const bm = new THREE.Mesh(stamp(def.brass, [0.95, 0.72, 0.28]), brass);
      g.add(gm, bm);
      g.position.set(40, 0, -60);
      g.visible = false;
      this._specimens.add(g);
    }

    const specimens = this._specimens;
    window.__studio = {
      mat: (kind) => {
        let gMat = null, bMat = null;
        if (kind === 1) { gMat = neonGlass({ tint: 'key', core: 'accent', cache: false }); bMat = clockworkBrass({ cache: false }); }
        else if (kind === 2) {
          const mk = () => { const m = new MeshBasicNodeMaterial(); m.colorNode = vec3(0.6, 0.9, 1.0); return m; };
          gMat = mk(); bMat = mk();
        }
        for (const child of specimens.children) {
          const gm = child.children[0], bm = child.children[1];
          if (!gm) continue;
          if (gMat) gm.material = gMat;
          if (bMat) bm.material = bMat;
        }
        return 'mats:' + (kind || 'fallback');
      },
      hud: (on) => { const ui = document.getElementById('ui'); if (ui) ui.style.display = on === false ? 'none' : ''; return 'hud:' + (on !== false); },
      bg: (on) => {
        const f = this._ctx.engine.get('fractal');
        if (f?.mesh) f.mesh.visible = on !== false;
        const dims = this._ctx.engine.get('dimensions');
        if (dims?._fields) for (const fl of dims._fields) fl.mesh.visible = on !== false;
        return 'bg:' + (on !== false);
      },
      subject: (s) => this.subject(s),
      orbit: (o) => { if (o?.az != null) this._az = o.az; if (o?.el != null) this._el = o.el; if (o?.dist != null) this._dist = o.dist; if (o?.spin != null) this._spin = o.spin; },
      slow: (v) => { this.slow = v; },
      pause: () => { const r = ctx.engine.get('rail'); if (r) r.paused = true; },
      resume: () => { const r = ctx.engine.get('rail'); if (r) r.paused = false; },
    };
    this.subject('craft');
    console.log('[studio] active — __studio.subject(...), __studio.orbit({az,el,dist})');
  }

  subject(s) {
    const { engine } = this._ctx;
    for (const child of this._specimens.children) child.visible = false;
    this.target = null;
    this._spin = 0.12;

    switch (s) {
      case 'craft':
        this.target = engine.get('player')?.root || null;
        this._dist = 8.5; this._el = 0.10; this._az = Math.PI; this._spin = 0.05;
        break;
      case 'wisp': case 'weaver': case 'lancer': case 'gyre': {
        const spec = this._specimens.getObjectByName(`studio:${s}`);
        if (spec) { spec.visible = true; this.target = spec; }
        this._dist = s === 'gyre' ? 7 : 4.6; this._el = 0.22; this._az = Math.PI;
        break;
      }
      case 'boss0': case 'boss1': case 'boss2': {
        const kind = Number(s.slice(-1));
        engine.get('bosses')?.spawn(kind);
        const b = engine.get('bosses')?.current;
        this.target = b?.group || null;
        this._dist = kind === 2 ? 52 : 46; this._el = 0.24; this._az = Math.PI; this._spin = 0.04;
        break;
      }
      case 'origin': {
        const fr = engine.get('fractal');
        if (fr?.uOrigin?.value) this._hold.copy(fr.uOrigin.value);
        this._dist = 10; this._el = 0.3; this._az = 0; this._spin = 0.25;
        break;
      }
      case 'none':
        this._dist = 60; this._spin = 0;
        break;
    }
    return this.target ? (this.target.name || 'subject') : 'none';
  }

  update(dt, ctx) {
    if (!this.active) return;
    const { camera, engine, time } = ctx;
    const rail = engine.get('rail');
    if (rail) rail.paused = true;
    const rig = engine.get('camerarig');
    if (rig) rig.enabled = false;

    const k = Math.min(1, time.rawDt * 4);
    this.az += (this._az - this.az) * k;
    this.el += (this._el - this.el) * k;
    this.dist += (this._dist - this.dist) * k;

    const focus = new THREE.Vector3();
    if (this.target) this.target.getWorldPosition(focus);
    else focus.copy(this._hold);

    // slow drift so the subject stays alive in-frame
    if (this.target && this._spin) {
      this._az += this._spin * dt;
    }

    const pos = new THREE.Vector3(
      focus.x + Math.cos(this.az) * Math.cos(this.el) * this.dist,
      focus.y + Math.sin(this.el) * this.dist,
      focus.z + Math.sin(this.az) * Math.cos(this.el) * this.dist
    );
    camera.position.lerp(pos, Math.min(1, time.rawDt * 6));
    camera.lookAt(focus);

    engine.get('sky')?.mesh?.position.copy(camera.position);

    // subtle idle animation so the specimen reads alive
    if (this.target && this.target.name?.startsWith('studio:')) {
      const t = time.elapsed;
      this.target.rotation.y = Math.sin(t * 0.4) * 0.5;
      this.target.rotation.x = Math.sin(t * 0.23) * 0.12;
    }
  }
}
export default Studio;
