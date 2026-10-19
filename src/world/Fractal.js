import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn, If, Loop, Break, Switch, vec2, vec3, vec4, float, int, uniform,
  positionWorld, cameraPosition, time,
  sin, cos, abs, dot, length, normalize, mix, smoothstep, step,
  pow, max, min, clamp, oneMinus, saturate, exp, sqrt, fract, floor, Discard,
  cross, sign, select,
} from 'three/tsl';
import Bus from '../core/Bus.js';
import Palette from '../render/Palette.js';
import DIMENSIONS from '../util/fractal-dimensions.js';
import { clampEmissive } from '../util/mat-nodes.js';
import { gmod, rotX, rotY, rotZ, trapCurve } from './sdf/common.js';
import { deMandelbulb } from './sdf/mandelbulb.js';
import { deMandelbox } from './sdf/mandelbox.js';
import { deApollonian } from './sdf/apollonian.js';
import { deMenger } from './sdf/menger.js';
import { deKleinian } from './sdf/kleinian.js';

/**
 * THE MATHEMATICS — the raymarched fractal dimension itself.
 *
 * A camera-locked shell; every fragment casts one ray into the distance
 * estimator of the current dimension. Rays that strike structure are shaded
 * from orbit traps (the DE's own memory of the iteration) and write the deep
 * backdrop; rays that escape Discard and let the sky through.
 *
 * Everything is uniform-driven: a dimension shift is a parameter lerp, so
 * the world *melts* from a Mandelbulb cathedral into a Kleinian limit set
 * rather than cutting.
 *
 * Perf: bounding-sphere entry, distance-relative epsilon, 56-step ceiling.
 */

const STEPS = 72;
const BOUND_R = 2.35;     // fractal-local bounding sphere

const _v = new THREE.Vector3();
const _f = new THREE.Vector3();

export class Fractal {
  constructor() {
    this.name = 'fractal';
    this.order = 9;

    this.uA = uniform(new THREE.Vector4());
    this.uB = uniform(new THREE.Vector4());
    this.uDe = uniform(0, 'int');
    this.uScale = uniform(130);
    this.uOrigin = uniform(new THREE.Vector3(0, 0, -160));
    this.uRot = uniform(new THREE.Vector3());
    this.uRepeat = uniform(new THREE.Vector3(1e6, 1e6, 1e6));
    this.uEps = uniform(0.0011);
    this.uStepScale = uniform(0.9);
    this.uFogDensity = uniform(0.0026);
    this.uBand = uniform(new THREE.Vector2(7, 0));     // trap curve k, phase
    this.uIrid = uniform(3.4);
    this.uRim = uniform(1.5);
    this.uCore = uniform(0.9);
    this.uGlow = uniform(0.55);
    this.uSun = uniform(new THREE.Vector3(0.5, 0.62, -0.6));
    this.uMelt = uniform(0);                            // 0..1 transition melt
    this.uDebug = uniform(0, 'int');

    this.index = 0;
    this._needAnchor = true;
    this._from = null;
    this._to = DIMENSIONS[0];
    this._blend = 1;
    this._time = 0;
  }

  async init(ctx) {
    this._ctx = ctx;

    const de = Fn(([p]) => {
      const A = this.uA, B = this.uB;
      const out = vec4(1e5, 0, 0, 0).toVar();
      Switch(this.uDe)
        .Case(0, () => { out.assign(deMandelbulb(p, A, B)); })
        .Case(1, () => { out.assign(deMandelbox(p, A, B)); })
        .Case(2, () => { out.assign(deApollonian(p, A, B)); })
        .Case(3, () => { out.assign(deMenger(p, A, B)); })
        .Case(4, () => { out.assign(deKleinian(p, A, B)); })
        .Default(() => { out.assign(deMandelbulb(p, A, B)); });
      return out;
    });
    de.setLayout({ name: 'fractalDE', type: 'vec4', inputs: [{ name: 'p', type: 'vec3' }] });

    /* world-space point → fractal-local (no domain repeat: large-period
       gmod round-trips destroy f32 precision) */
    const toLocal = Fn(([w]) => {
      const p = w.sub(this.uOrigin).div(this.uScale);
      return rotZ(rotY(rotX(p, this.uRot.x.negate()), this.uRot.y.negate()), this.uRot.z.negate());
    });
    toLocal.setLayout({ name: 'toLocal', type: 'vec3', inputs: [{ name: 'w', type: 'vec3' }] });

    const toLocalDir = Fn(([d]) => {
      return rotZ(rotY(rotX(d, this.uRot.x.negate()), this.uRot.y.negate()), this.uRot.z.negate());
    });
    toLocalDir.setLayout({ name: 'toLocalDir', type: 'vec3', inputs: [{ name: 'd', type: 'vec3' }] });

    const shaded = (wantEmissive, tag) => Fn(() => {
      const roW = cameraPosition;
      const rdW = normalize(positionWorld.sub(cameraPosition)).toVar();
      const ro = toLocal(roW).toVar('ro2' + tag);
      const rd = normalize(toLocalDir(rdW)).toVar('rd2' + tag);

      const b = dot(ro, rd).toVar();
      const c = dot(ro, ro).sub(float(BOUND_R * BOUND_R)).toVar();
      const h = b.mul(b).sub(c).toVar();
      If(h.lessThan(0.0), () => { Discard(); });
      const sh = sqrt(h).toVar();
      const t0 = max(b.negate().sub(sh), float(0.0)).toVar();
      const t1 = b.negate().add(sh).toVar();

      const t = t0.toVar('t' + tag);
      const hitT = float(-1.0).toVar('hitT' + tag);
      const traps = vec4(0).toVar('traps' + tag);
      const stepsUsed = float(0).toVar('stepsUsed' + tag);

      Loop({ start: 0, end: STEPS, type: 'int' }, ({ i }) => {
        If(t.greaterThan(t1), () => { Break(); });
        const pos = ro.add(rd.mul(t)).toVar();
        const d4 = de(pos);
        const eps = this.uEps.mul(t).add(0.00012);
        If(d4.x.lessThan(eps), () => {
          hitT.assign(t); traps.assign(d4); stepsUsed.assign(float(i));
          Break();
        });
        t.addAssign(d4.x.mul(this.uStepScale));
      });
      If(hitT.lessThan(0.0), () => { Discard(); });

      const posL = ro.add(rd.mul(hitT)).toVar();
      const distW = hitT.mul(this.uScale);
      const e = float(0.0012);
      const grad = vec3(
        de(posL.add(vec3(e, 0, 0))).x.sub(de(posL.sub(vec3(e, 0, 0))).x),
        de(posL.add(vec3(0, e, 0))).x.sub(de(posL.sub(vec3(0, e, 0))).x),
        de(posL.add(vec3(0, 0, e))).x.sub(de(posL.sub(vec3(0, 0, e))).x)
      ).toVar();
      const nRaw = grad.div(max(length(grad), float(1e-5)));
      // face-forward: WGSL has no faceforward builtin — flip toward the ray origin
      const n = nRaw.mul(select(dot(nRaw, rd).greaterThan(0.0), float(-1.0), float(1.0))).toVar('nrm' + tag);

      const sun = normalize(this.uSun).toVar();
      const dif = clamp(dot(n, sun), 0.0, 1.0).add(clamp(dot(n, sun.negate()), 0.0, 1.0).mul(0.35));
      const ao = oneMinus(saturate(stepsUsed.div(float(STEPS)).mul(1.15)));

      /* raw traps, pow-shaped — trapCurve saturates and kills the gradients */
      const t0c = pow(saturate(traps.y), float(3.4));        // filigree — sparse, sharp
      const t1c = pow(saturate(traps.z), float(3.0));        // shell banding
      const t2c = saturate(traps.w);                          // core proximity

      const keyC = Palette.u.key, accC = Palette.u.accent, rimC = Palette.u.rim;
      const voidC = Palette.u.void, fogC = Palette.u.fog;

      /* silhouette-first albedo: the body is a near-black mass; only filigree
         edges catch the key hue. No full-spectrum iridescence — the phase
         only travels between the dimension's own slots. */
      const insideDark = oneMinus(smoothstep(float(0.04), float(0.6), hitT));  // inside the solid
      const albedo = mix(voidC.mul(1.3), keyC.mul(0.55), t0c.mul(0.9).add(0.015))
        .add(accC.mul(pow(t1c, float(2.2)).mul(0.28)));
      const lit = albedo.mul(dif.mul(1.05).add(0.15)).mul(ao.mul(0.7).add(0.3));
      const fres = pow(oneMinus(saturate(dot(n, rd.negate()))), float(3.0));
      const rim = rimC.mul(fres.mul(this.uRim).mul(0.5));
      // palette-honest iridescence: phase ramps rim→key→accent only
      const iridPhase = t0c.mul(this.uIrid).add(t2c.mul(this.uIrid.mul(0.55)))
        .add(time.mul(0.05)).add(this.uMelt.mul(2.2));
      const iridH = sin(iridPhase).mul(0.5).add(0.5);
      const iridH2 = cos(iridPhase.mul(0.73).add(1.3)).mul(0.5).add(0.5);
      const sheen = mix(mix(rimC, keyC, iridH), accC, iridH2.mul(t1c.mul(0.6).add(0.12)))
        .mul(fres).mul(this.uIrid.mul(0.14))
        .mul(oneMinus(insideDark.mul(0.92)));
      const fogAmt = oneMinus(exp(distW.mul(this.uFogDensity).negate()));
      // far field sinks to near-black so only silhouettes cut the fog
      const outside = mix(lit.add(rim).add(sheen), fogC.mul(0.62), fogAmt.pow(float(1.55)));
      // inside the solid: not a black-out — you are inside neon glass.
      // Dark mass threaded with filigree veins; the sun gradient carves
      // the surfaces so corridors read in three dimensions.
      const interior = voidC.mul(0.5)
        .add(keyC.mul(pow(t0c, float(1.6)).mul(0.75)))
        .add(accC.mul(pow(t1c, float(3.0)).mul(0.2)));
      const col = mix(outside, interior, insideDark);

      const crev = oneMinus(t2c);
      const coreGlow = keyC.mul(crev.mul(crev).mul(this.uCore).mul(1.5));
      const bandGlow = accC.mul(pow(t1c, float(4.0)).mul(this.uGlow).mul(0.9));
      const far = oneMinus(fogAmt.mul(0.9)).mul(oneMinus(insideDark.mul(0.82)));
      const emis = clampEmissive(
        coreGlow.add(bandGlow).mul(far).mul(ao.mul(0.5).add(0.5)).mul(Palette.u.gain), 2.6);

      return wantEmissive ? emis : col;
    });

    const mat = new MeshBasicNodeMaterial();
    mat.name = 'fractal';
    mat.fog = false;
    mat.side = THREE.BackSide;
    mat.depthWrite = false;
    mat.depthTest = true;

    const colRes = shaded(false, 'c')();
    const emisRes = shaded(true, 'e')();   // separate graph: the Discard must live in each
    if (typeof location !== 'undefined' && location.search.includes('marchdebug')) {
      // DEBUG: green = hit (brightness ∝ 1/t), red = bounding-sphere miss
      mat.colorNode = Fn(() => {
        const ro = toLocal(cameraPosition).toVar('dro');
        const rd = normalize(toLocalDir(normalize(positionWorld.sub(cameraPosition)))).toVar('drd');
        const b = dot(ro, rd).toVar();
        const c = dot(ro, ro).sub(float(BOUND_R * BOUND_R)).toVar();
        const h = b.mul(b).sub(c).toVar();
        If(h.lessThan(0.0), () => { Discard(); });
        const sh = sqrt(h).toVar();
        const t0 = max(b.negate().sub(sh), float(0.0)).toVar();
        const t1 = b.negate().add(sh).toVar();
        const t = t0.toVar('dt');
        const hitT = float(-1).toVar('dhit');
        Loop({ start: 0, end: 56, type: 'int' }, () => {
          If(t.greaterThan(t1), () => { Break(); });
          const d4 = de(ro.add(rd.mul(t)));
          If(d4.x.lessThan(this.uEps.mul(t).add(0.00012)), () => { hitT.assign(t); Break(); });
          t.addAssign(d4.x.mul(this.uStepScale));
        });
        If(hitT.lessThan(0.0), () => { Discard(); });
        const d4h = de(ro.add(rd.mul(hitT)));
        const t0c = trapCurve(d4h.y, this.uBand.x);
        const t1c = trapCurve(d4h.z, this.uBand.x.mul(0.5).add(1.0));
        const t2c = trapCurve(d4h.w, this.uBand.x.mul(0.35).add(0.8));
        const distW = hitT.mul(this.uScale);
        const fogAmt = oneMinus(exp(distW.mul(this.uFogDensity).negate()));
        const mode = new URLSearchParams(location.search).get('marchdebug');
        if (mode === 'terms') {
          // live term inspector: __fractal.uDebug.value = 0..6
          const e2 = float(0.0012);
          const posL2 = ro.add(rd.mul(hitT)).toVar();
          const grad2 = vec3(
            de(posL2.add(vec3(e2, 0, 0))).x.sub(de(posL2.sub(vec3(e2, 0, 0))).x),
            de(posL2.add(vec3(0, e2, 0))).x.sub(de(posL2.sub(vec3(0, e2, 0))).x),
            de(posL2.add(vec3(0, 0, e2))).x.sub(de(posL2.sub(vec3(0, 0, e2))).x)
          ).toVar();
          const n2 = grad2.div(max(length(grad2), float(1e-5)));
          const sun2 = normalize(this.uSun);
          const dif2 = clamp(dot(n2, sun2), 0.0, 1.0);
          const ao2 = float(1.0);   // skip stepsUsed in debug
          const keyC = Palette.u.key, accC = Palette.u.accent, rimC = Palette.u.rim;
          const voidC = Palette.u.void, fogC = Palette.u.fog;
          const albedo2 = mix(voidC.mul(3.0), keyC.mul(0.75), t0c.mul(0.8).add(0.16)).add(accC.mul(t1c.mul(0.42)));
          const lit2 = albedo2.mul(dif2.mul(1.1).add(0.22));
          const insideDark2 = smoothstep(float(0.6), float(0.04), hitT);
          const out = vec3(0).toVar();
          Switch(this.uDebug)
            .Case(0, () => { out.assign(albedo2); })
            .Case(1, () => { out.assign(vec3(dif2)); })
            .Case(2, () => { out.assign(lit2); })
            .Case(3, () => { out.assign(vec3(fogAmt)); })
            .Case(4, () => { out.assign(vec3(insideDark2)); })
            .Case(5, () => { out.assign(keyC); })
            .Default(() => { out.assign(vec3(fogC)); });
          return out;
        }
        if (mode === 'n') {
          const e = float(0.0012);
          const posL = ro.add(rd.mul(hitT)).toVar();
          const grad = vec3(
            de(posL.add(vec3(e, 0, 0))).x.sub(de(posL.sub(vec3(e, 0, 0))).x),
            de(posL.add(vec3(0, e, 0))).x.sub(de(posL.sub(vec3(0, e, 0))).x),
            de(posL.add(vec3(0, 0, e))).x.sub(de(posL.sub(vec3(0, 0, e))).x)
          ).toVar();
          const n = grad.div(max(length(grad), float(1e-5)));
          return n.mul(0.5).add(0.5);
        }
        // R = t0 filigree, G = t1 shells, B = t2 core
        return vec3(t0c, t1c, t2c).mul(oneMinus(fogAmt.mul(0.8)));
      })();
      mat.emissiveNode = vec3(0);
    } else {
      mat.colorNode = colRes;
      mat.emissiveNode = emisRes;
    }

    const geo = new THREE.BoxGeometry(2, 2, 2);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.scale.setScalar(2300);
    this.mesh.renderOrder = -100;
    this.mesh.frustumCulled = false;
    ctx.world.add(this.mesh);

    this._apply(DIMENSIONS[0], 1);

    Bus.on('dimension:shift', (d) => {
      if (typeof d?.to !== 'number') return;
      const to = DIMENSIONS[d.to % DIMENSIONS.length];
      const from = DIMENSIONS[(d.from ?? this.index) % DIMENSIONS.length] || this._to;
      this._lerpDefs(from, to, d.progress ?? 0);
    });
    Bus.on('dimension:enter', (d) => {
      if (typeof d?.index !== 'number') return;
      this.index = d.index % DIMENSIONS.length;
      this._apply(DIMENSIONS[this.index], 1);
      this._needAnchor = true;
    });
    Bus.on('rail:extended', () => {
      // the world grew: consider re-anchoring beyond the fresh horizon
      this._needAnchor = true;
    });

    window.__fractal = this;
  }

  /** Write one def's numbers into the uniforms (t=1) or a blend of two. */
  _lerpDefs(A, B, t) {
    const e = t * t * (3 - 2 * t);
    const L = (a, b) => a + (b - a) * e;
    this.uA.value.set(L(A.A[0], B.A[0]), L(A.A[1], B.A[1]), L(A.A[2], B.A[2]), L(A.A[3], B.A[3]));
    this.uB.value.set(L(A.B[0], B.B[0]), L(A.B[1], B.B[1]), L(A.B[2], B.B[2]), L(A.B[3], B.B[3]));
    this.uScale.value = L(A.scale, B.scale);
    this.uEps.value = L(A.epsRel, B.epsRel);
    this.uStepScale.value = L(A.stepScale, B.stepScale);
    this.uFogDensity.value = L(A.fogDensity, B.fogDensity);
    this.uBand.value.set(L(A.band[0], B.band[0]), L(A.band[1], B.band[1]));
    this.uIrid.value = L(A.irid, B.irid);
    this.uRim.value = L(A.rimStrength, B.rimStrength);
    this.uCore.value = L(A.coreEmis, B.coreEmis);
    this.uGlow.value = L(A.glowStrength, B.glowStrength);
    this.uRot.value.set(L(A.rot[0], B.rot[0]), L(A.rot[1], B.rot[1]), L(A.rot[2], B.rot[2]));
    this.uSun.value.set(L(A.sunDir[0], B.sunDir[0]), L(A.sunDir[1], B.sunDir[1]), L(A.sunDir[2], B.sunDir[2]));
    this.uMelt.value = Math.sin(Math.min(1, t) * Math.PI);   // peak mid-transition
    this.uDe.value = e < 0.5 ? (DIMENSIONS.indexOf(A)) : (DIMENSIONS.indexOf(B));
  }

  _apply(def) {
    this._lerpDefs(def, def, 1);
    this.uMelt.value = 0;
    this.uDe.value = DIMENSIONS.indexOf(def);
    this._baseA = def.A.slice();
    this._baseB = def.B.slice();
  }

  update(dt, ctx) {
    this._time += dt;
    const rail = ctx.engine.get('rail');
    this.mesh.position.copy(ctx.camera.position);

    // The mathematics is ANCHORED IN THE WORLD, not chasing the player:
    // you genuinely fly toward the cathedral, past it, through it. It only
    // re-anchors when the rail outgrows the current structure.
    if (rail?.current && this._needAnchor) {
      const def = DIMENSIONS[this.index] || DIMENSIONS[0];
      const ahead = rail.sampleDistance(Math.min(rail.distance + (def.anchorAhead ?? 900), rail.length - 120));
      _f.copy(ahead.position)
        .addScaledVector(ahead.normal, def.origin[1])
        .addScaledVector(ahead.binormal, def.origin[0]);
      this.uOrigin.value.copy(_f);
      this._needAnchor = false;
    } else if (rail?.current && !this._needAnchor) {
      // drift imperceptibly toward the next anchor so re-anchoring never pops
      _v.copy(this.uOrigin.value);
      const def = DIMENSIONS[this.index] || DIMENSIONS[0];
      const ahead = rail.sampleDistance(Math.min(rail.distance + (def.anchorAhead ?? 900), rail.length - 120));
      _f.copy(ahead.position)
        .addScaledVector(ahead.normal, def.origin[1])
        .addScaledVector(ahead.binormal, def.origin[0]);
      const reAnchor = Math.max(200, Math.min(500, (def.anchorAhead ?? 900) * 1.15));
      if (_v.distanceToSquared(_f) > reAnchor * reAnchor) this._needAnchor = true;
    }

    // slow breathing of the iteration params — the world is alive
    if (this._baseA && this._blend >= 1) {
      const t = this._time;
      this.uA.value.w = this._baseA[3] + Math.sin(t * 0.043) * 0.35;
      this.uA.value.x = this._baseA[0] + Math.sin(t * 0.027) * 0.12;
    }
    this.uMelt.value *= Math.exp(-dt * 1.4);
  }
}

export default Fractal;
