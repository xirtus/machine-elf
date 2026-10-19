import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn, vec2, vec3, vec4, float, uniform, positionLocal, time, hash,
  sin, cos, abs, fract, floor, dot, length, normalize, mix, smoothstep, step,
  pow, max, min, clamp, oneMinus, saturate, exp, atan,
} from 'three/tsl';
import Bus from '../core/Bus.js';
import Palette from '../render/Palette.js';
import { fbm, clampEmissive } from '../util/mat-nodes.js';

/**
 * THE FIRMAMENT — the void everything floats in.
 *
 * Not a "space skybox". A DMT void: near-black with chroma, a dust of
 * needle-point stars that tick like clockwork, a slow nebula current in the
 * dimension's rim hue, and — deepest of all — the glow of whatever is
 * *underneath* hyperspace, straight down.
 *
 * Art-direction rules honoured here:
 *   - never brighter than ~0.25 luma except individual star pixels
 *   - hues come from Palette uniforms only (retints with the dimension)
 *   - nothing moves at constant speed: stars tick, nebula breathes
 *   - psych uniform warps the star field into trails as you descend
 */

const STAR_FREQ_A = 34.0;
const STAR_FREQ_B = 78.0;

export class Sky {
  constructor() {
    this.name = 'sky';
    this.order = 8;
    this.uWarp = uniform(0);      // boost/stretch
    this.uDescent = uniform(0);   // 0..1 how deep we are (drives nebula density)
    this._psychTarget = 0;
  }

  async init(ctx) {
    const { world } = ctx;

    const uWarp = this.uWarp;
    const uDescent = this.uDescent;
    const uPsych = Palette.u.psych;

    const dir = normalize(positionLocal);           // sphere local = direction

    /* ── base void: vertical gradient, chroma in the dark ─────────────── */
    const voidC = Palette.u.void;
    const fogC = Palette.u.fog;
    const keyC = Palette.u.key;
    const rimC = Palette.u.rim;
    const accC = Palette.u.accent;
    const glowC = Palette.u.glow;

    const up = dir.y;
    const base = mix(
      fogC.mul(0.22),                      // below: a whisper of haze, not a floor
      voidC,
      smoothstep(float(-0.35), float(0.5), up)
    );

    /* the light from underneath: a deep accent glow at nadir that breathes */
    const nadirGlow = accC.mul(
      smoothstep(float(-0.25), float(-0.95), up)
        .mul(0.05)
        .mul(sin(time.mul(0.23)).mul(0.25).add(0.75))
    );

    /* ── nebula current: band-limited fbm drifting on a slow gyre ─────── */
    const gyre = vec3(
      dir.x,
      dir.y.mul(0.6).add(sin(time.mul(0.021)).mul(0.08)),
      dir.z
    );
    const nebP = gyre.mul(2.6).add(vec3(time.mul(0.008), time.mul(0.013), 0.0));
    const neb = fbm(nebP, 4);
    const neb2 = fbm(gyre.mul(6.1).sub(vec3(0.0, time.mul(0.005), time.mul(0.009))), 3);
    // thin filaments: |fbm-0.5| ridged
    const filament = oneMinus(abs(neb2.mul(2.0).sub(1.0)));
    const nebMask = smoothstep(float(0.62), float(0.97), neb)
      .mul(uDescent.mul(0.45).add(0.28));
    // hue stays in rim/key: accent here reads as mud against the void
    const nebCol = mix(rimC.mul(0.8), keyC.mul(0.7), neb2.mul(0.5)).mul(nebMask).mul(0.14);
    const filCol = keyC.mul(pow(filament, float(7.0)).mul(nebMask).mul(0.20));

    /* ── clockwork stars: two densities, quantised twinkle ────────────── */
    const stars = Fn(() => {
      const acc = vec3(0).toVar();
      // psych streaks the field radially — smear the lookup along the view
      const smear = uPsych.mul(0.06).add(uWarp.mul(0.10));
      const dWarp = normalize(dir.add(vec3(0.0, 0.0, smear.mul(dir.z.negate()))));

      for (const [freq, thresh, gain] of [[STAR_FREQ_A, 0.78, 1.0], [STAR_FREQ_B, 0.86, 0.6]]) {
        const p = dWarp.mul(float(freq));
        const cell = floor(p);
        const h = hash(cell);
        const sx = hash(cell.add(vec3(13.7, 1.3, 7.1)));
        const sy = hash(cell.add(vec3(3.1, 17.7, 11.3)));
        const sz = hash(cell.add(vec3(9.2, 5.7, 2.9)));
        const spos = vec3(sx, sy, sz);
        const dd = length(fract(p).sub(spos));
        const on = step(float(thresh), h);
        // quantised twinkle: 4 discrete brightness steps, ticking — not a sine
        const tick = floor(fract(time.mul(0.6).add(h.mul(40.0))).mul(4.0)).div(4.0);
        const tw = tick.mul(0.5).add(0.5);
        const star = smoothstep(float(0.10), float(0.0), dd)
          .mul(on)
          .mul(tw)
          .mul(float(gain));
        acc.addAssign(glowC.mul(star.mul(h.mul(1.6).add(0.6))));
      }
      return acc;
    });

    /* ── the mechanism overhead: faint concentric firmament rings ─────── */
    const rings = Fn(() => {
      const az = atan(dir.z, dir.x);
      const el = dir.y;
      // polar rings near zenith, ticking in discrete steps
      const tickT = floor(time.mul(2.2)).div(2.2);       // hard-quantised time
      const r = length(dir.xz);
      const ringPat = sin(r.mul(46.0).sub(tickT.mul(0.8))).mul(0.5).add(0.5);
      const spokes = sin(az.mul(24.0).add(tickT.mul(0.5))).mul(0.5).add(0.5);
      const zenith = smoothstep(float(0.55), float(0.95), el);
      const pat = pow(ringPat, float(14.0)).add(pow(spokes.mul(ringPat), float(10.0)).mul(0.5));
      return rimC.mul(pat.mul(zenith).mul(0.10));
    });

    const mat = new MeshBasicNodeMaterial();
    mat.name = 'sky';
    mat.fog = false;
    mat.side = THREE.BackSide;
    mat.depthWrite = false;

    mat.colorNode = Fn(() => {
      return base
        .add(nadirGlow)
        .add(nebCol)
        .add(filCol)
        .add(stars().mul(0.85))
        .add(rings());
    })();

    // only stars and the hottest filaments feed bloom
    mat.emissiveNode = clampEmissive(
      stars().mul(1.35).add(filCol.mul(1.2)).add(rings().mul(1.5)).mul(Palette.u.gain),
      2.2
    );

    const geo = new THREE.IcosahedronGeometry(3400, 3);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.renderOrder = -101;
    this.mesh.frustumCulled = false;
    world.add(this.mesh);

    // lights: a dim hemisphere wash + a key dir so non-emissive things read
    this.hemi = new THREE.HemisphereLight(0x334466, 0x05060a, 0.85);
    ctx.scene.add(this.hemi);
    this.key = new THREE.DirectionalLight(0xffffff, 1.35);
    this.key.position.set(30, 60, -40);
    ctx.scene.add(this.key);
    this.fill = new THREE.DirectionalLight(0x8899ff, 0.4);
    this.fill.position.set(-40, -20, 30);
    ctx.scene.add(this.fill);

    this._unsub = Palette.onChange(() => {
      this.hemi.color.copy(Palette.fog).multiplyScalar(2.2);
      this.hemi.groundColor.copy(Palette.void);
      this.key.color.copy(Palette.glow);
      this.fill.color.copy(Palette.rim).multiplyScalar(1.6);
    });
    this._unsub();

    Bus.on('player:boost', (d) => { this._warpT = d?.on ? 1 : 0; });
    this._warpT = 0;
  }

  update(dt, ctx) {
    // the sphere rides the camera — parallax-free void
    this.mesh.position.copy(ctx.camera.position);
    this._warpT = Math.max(this._warpT ?? 0, 0);
    this.uWarp.value += ((this._warpT) - this.uWarp.value) * Math.min(1, dt * 3);
    this.uDescent.value = Palette.u.depth.value;
  }
}
export default Sky;
