import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn, vec2, vec3, vec4, float, attribute, uv, positionLocal,
  mix, smoothstep, pow, oneMinus, saturate,
} from 'three/tsl';
import Bus from '../core/Bus.js';
import Palette from '../render/Palette.js';
import { clampEmissive } from '../util/mat-nodes.js';

/**
 * TRAILS — camera-facing ribbons with memory.
 *
 * Each trail is a ring buffer of world points; every frame the ribbon is
 * re-skinned perpendicular to the view direction, fading by segment age and
 * pinching at the tail. Wingtip trails on the orrery, homing-lance contrails,
 * boost washes.
 *
 * API: trails.spawn({color:'key', width, life}) → handle
 *        handle.point(worldVec3)   push a point (call every frame while moving)
 *        handle.end()              fade out and release
 */

const MAX_TRAILS = 26;
const SEGS = 26;

const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _side = new THREE.Vector3();
const _cam = new THREE.Vector3();
const _c = new THREE.Color();

function trailMaterial() {
  const m = new MeshBasicNodeMaterial();
  m.name = 'fx.trail';
  m.transparent = true;
  m.blending = THREE.AdditiveBlending;
  m.depthWrite = false;
  m.fog = false;
  m.side = THREE.DoubleSide;
  const aColor = attribute('aColor', 'vec3');
  const aAge = attribute('aAge', 'float');      // 0 head → 1 tail
  m.colorNode = vec3(0.0);
  m.opacityNode = oneMinus(aAge).mul(0.85);
  m.emissiveNode = clampEmissive(
    aColor.mul(oneMinus(aAge).mul(oneMinus(aAge))).mul(1.9).mul(Palette.u.gain), 2.8
  );
  return m;
}

export class Trails {
  constructor() {
    this.name = 'trails';
    this.order = 52;
    this._pool = [];
    this._mat = null;
  }

  async init(ctx) {
    this._ctx = ctx;
    this._mat = trailMaterial();

    for (let i = 0; i < MAX_TRAILS; i++) {
      const geo = new THREE.BufferGeometry();
      const pos = new Float32Array(SEGS * 2 * 3);
      const age = new Float32Array(SEGS * 2);
      const col = new Float32Array(SEGS * 2 * 3);
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('aAge', new THREE.BufferAttribute(age, 1).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
      const idx = new Uint16Array((SEGS - 1) * 6);
      for (let s = 0; s < SEGS - 1; s++) {
        const a = s * 2;
        idx[s * 6] = a; idx[s * 6 + 1] = a + 1; idx[s * 6 + 2] = a + 2;
        idx[s * 6 + 3] = a + 1; idx[s * 6 + 4] = a + 3; idx[s * 6 + 5] = a + 2;
      }
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      const mesh = new THREE.Mesh(geo, this._mat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      ctx.fx.add(mesh);
      this._pool.push({
        mesh, live: false, ending: false,
        pts: Array.from({ length: SEGS }, () => new THREE.Vector3()),
        ages: new Float32Array(SEGS),
        head: 0, count: 0,
        width: 0.1, life: 0.4, fade: 1,
      });
    }
  }

  spawn(opts = {}) {
    for (const t of this._pool) {
      if (t.live) continue;
      t.live = true;
      t.ending = false;
      t.fade = 1;
      t.count = 0;
      t.head = 0;
      t.width = opts.width ?? 0.1;
      t.life = opts.life ?? 0.4;
      _c.copy(typeof opts.color === 'string' ? Palette.get(opts.color) : (opts.color?.isColor ? opts.color : Palette.key));
      const colAttr = t.mesh.geometry.getAttribute('aColor');
      for (let i = 0; i < SEGS * 2; i++) {
        colAttr.array[i * 3] = _c.r; colAttr.array[i * 3 + 1] = _c.g; colAttr.array[i * 3 + 2] = _c.b;
      }
      colAttr.needsUpdate = true;
      t.mesh.visible = true;
      t._opts = opts;
      return {
        point: (p) => this._push(t, p),
        end: () => { t.ending = true; },
        get alive() { return t.live; },
      };
    }
    return { point() {}, end() {}, alive: false };
  }

  _push(t, p) {
    t.pts[t.head].copy(p);
    t.ages[t.head] = 0;
    t.head = (t.head + 1) % SEGS;
    if (t.count < SEGS) t.count++;
  }

  update(dt, ctx) {
    const camPos = ctx.camera.position;
    for (const t of this._pool) {
      if (!t.live) continue;
      // age every point
      for (let i = 0; i < SEGS; i++) t.ages[i] += dt;
      if (t.ending) {
        t.fade -= dt / Math.max(0.05, t.life);
        if (t.fade <= 0 || t.count === 0) {
          t.live = false;
          t.mesh.visible = false;
          continue;
        }
      }

      const posAttr = t.mesh.geometry.getAttribute('position');
      const ageAttr = t.mesh.geometry.getAttribute('aAge');
      const pa = posAttr.array, aa = ageAttr.array;

      // walk newest → oldest
      for (let s = 0; s < SEGS; s++) {
        const idx = ((t.head - 1 - s) + SEGS * 2) % SEGS;
        const p = t.pts[idx];
        const ageN = Math.min(1, t.ages[idx] / t.life);

        if (s < t.count && t.ages[idx] <= t.life) {
          // ribbon side vector: perpendicular to (segment dir × view dir)
          const ni = ((idx - 1) + SEGS) % SEGS;
          _dir.copy(t.pts[ni]).sub(p);
          if (_dir.lengthSq() < 1e-8) _dir.set(0, 0, 1);
          _cam.copy(p).sub(camPos);
          _side.crossVectors(_dir, _cam).normalize();
          const w = t.width * (1 - ageN * 0.75) * t.fade;
          pa[s * 6] = p.x + _side.x * w; pa[s * 6 + 1] = p.y + _side.y * w; pa[s * 6 + 2] = p.z + _side.z * w;
          pa[s * 6 + 3] = p.x - _side.x * w; pa[s * 6 + 4] = p.y - _side.y * w; pa[s * 6 + 5] = p.z - _side.z * w;
          aa[s * 2] = ageN; aa[s * 2 + 1] = ageN;
        } else {
          // collapse unused segments onto the last valid point
          const last = ((t.head - t.count) + SEGS * 2) % SEGS;
          const lp = t.pts[last];
          pa[s * 6] = lp.x; pa[s * 6 + 1] = lp.y; pa[s * 6 + 2] = lp.z;
          pa[s * 6 + 3] = lp.x; pa[s * 6 + 4] = lp.y; pa[s * 6 + 5] = lp.z;
          aa[s * 2] = 1; aa[s * 2 + 1] = 1;
        }
      }
      posAttr.needsUpdate = true;
      ageAttr.needsUpdate = true;
    }
  }
}
export default Trails;
