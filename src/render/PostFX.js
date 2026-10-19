import * as THREE from 'three';
import { RenderPipeline } from 'three/webgpu';
import {
  pass, mrt, output, emissive, uniform, vec2, vec3, vec4, float,
  screenUV, mix, smoothstep, length, sin, cos, time, fract, dot, clamp,
  pow, add, mul, sub, saturate, Fn, oneMinus, max, min, abs, floor,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { film } from 'three/addons/tsl/display/FilmNode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import Bus from '../core/Bus.js';
import Time from '../core/Time.js';

/**
 * The look. Everything that makes neon glass read as *lit from inside*
 * rather than "a bright material" happens here.
 *
 * Chain:
 *   scene(MRT color+emissive)
 *     ├─ emissive → bloom(wide, soft)   ← the hyperspace glow
 *     └─ color                          ← base
 *   composite → radial chromatic aberration (speed-reactive)
 *             → barrel/vignette + scanline shimmer
 *             → AgX tonemap → SMAA
 *
 * Uniforms driven by gameplay:
 *   warp     0..1  boost / dimension-shift intensity
 *   damage   0..1  red-out on hit
 *   psych    0..1  hue-rotation madness as you descend
 */
export class PostFX {
  constructor() {
    this.name = 'postfx';
    this.order = 1000;
    this.enabled = true;

    this.uWarp = uniform(0);
    this.uDamage = uniform(0);
    this.uPsych = uniform(0);
    this.uAberration = uniform(0.6);
    this.uVignette = uniform(0.78);
    this.uFlash = uniform(0);
    this.uBloomStrength = uniform(0.5);

    this._warpTarget = 0;
    this._flashTarget = 0;
  }

  async init(ctx) {
    const { renderer, scene, camera } = ctx;

    const scenePass = pass(scene, camera, { samples: 0 });
    scenePass.setMRT(mrt({ output, emissive }));
    this.scenePass = scenePass;

    const colorNode = scenePass.getTextureNode('output');
    const emissiveNode = scenePass.getTextureNode('emissive');

    // Two-tier bloom: a tight core glow and a wide atmospheric haze.
    // Splitting them is what keeps neon from turning into fog soup.
    const bloomCore = bloom(emissiveNode, 0.62, 0.30, 0.0);
    const bloomHaze = bloom(emissiveNode, 0.30, 1.10, 0.0);
    this.bloomCore = bloomCore;
    this.bloomHaze = bloomHaze;

    const lit = colorNode.rgb.add(bloomCore.rgb.mul(this.uBloomStrength))
                         .add(bloomHaze.rgb.mul(this.uBloomStrength.mul(0.7)));

    // ── radial chromatic aberration, stronger toward frame edges ──────────
    const uWarp = this.uWarp, uPsych = this.uPsych, uAb = this.uAberration;

    const aberrated = Fn(() => {
      const uv = screenUV;
      const c = uv.sub(vec2(0.5));
      const r2 = dot(c, c);
      const amount = uAb.mul(float(0.0022).add(uWarp.mul(0.016))).mul(r2.mul(2.2).add(0.25));

      const rC = colorNode.sample(uv.sub(c.mul(amount))).r;
      const gC = lit.g;
      const bC = colorNode.sample(uv.add(c.mul(amount))).b;

      // recombine: aberrate the *base* channels, keep bloom coherent
      const base = vec3(rC, gC, bC);
      const glow = bloomCore.rgb.mul(this.uBloomStrength).add(bloomHaze.rgb.mul(this.uBloomStrength.mul(0.7)));
      return base.add(glow);
    })();

    // ── psychedelic hue drift (subtle at psych=0, unhinged at 1) ─────────
    const psyched = Fn(() => {
      const col = aberrated;
      const k = uPsych;
      // cheap YIQ-space hue rotation
      const ang = time.mul(0.35).add(screenUV.y.mul(2.4)).mul(k);
      const cs = cos(ang), sn = sin(ang);
      const yiqY = dot(col, vec3(0.299, 0.587, 0.114));
      const yiqI = dot(col, vec3(0.596, -0.274, -0.322));
      const yiqQ = dot(col, vec3(0.211, -0.523, 0.312));
      const i2 = yiqI.mul(cs).sub(yiqQ.mul(sn));
      const q2 = yiqI.mul(sn).add(yiqQ.mul(cs));
      const rot = vec3(
        yiqY.add(i2.mul(0.956)).add(q2.mul(0.621)),
        yiqY.sub(i2.mul(0.272)).sub(q2.mul(0.647)),
        yiqY.sub(i2.mul(1.106)).add(q2.mul(1.703))
      );
      return mix(col, rot, k.mul(0.75));
    })();

    // ── vignette, damage red-out, white flash ────────────────────────────
    const uVig = this.uVignette, uDmg = this.uDamage, uFlash = this.uFlash;
    const graded = Fn(() => {
      const uv = screenUV;
      const d = length(uv.sub(vec2(0.5))).mul(1.414);
      const vig = oneMinus(smoothstep(float(0.45), float(1.0), d).mul(uVig));
      let col = psyched.mul(vig);

      // damage: crimson bloom pushed in from the edges
      const edge = smoothstep(float(0.25), float(0.95), d);
      col = mix(col, col.mul(vec3(1.6, 0.18, 0.28)).add(vec3(0.32, 0.0, 0.06).mul(edge)), uDmg.mul(edge));

      col = col.add(vec3(uFlash));
      return vec4(col, 1.0);
    })();

    // ── tonemap (AgX-ish filmic, hand-rolled for punchy neon) ────────────
    const tonemapped = Fn(() => {
      // Stephen Hill ACES fit — blacks stay black, neon rolls off white-hot
      const x = max(vec3(0.0), graded.rgb.mul(0.82));
      const t = x.mul(x.mul(2.51).add(0.03)).div(x.mul(x.mul(2.43).add(0.59)).add(0.14));
      return vec4(clamp(t, vec3(0.0), vec3(1.0)), 1.0);
    })();

    const aa = smaa(tonemapped);

    const post = new RenderPipeline(renderer);
    post.outputColorSpace = THREE.SRGBColorSpace;
    post.outputNode = film(aa, float(0.026));
    this.post = post;

    Bus.on('camera:flash', (d) => { this._flashTarget = Math.max(this._flashTarget, d?.amount ?? 0.5); });
    Bus.on('player:hit', () => { this.uDamage.value = 1.0; });
    Bus.on('player:boost', (d) => { this._warpTarget = d?.on ? 1 : 0; });
    // sine spike across the melt: 0 → 1 → 0, never sticks
    Bus.on('dimension:shift', (d) => { this._warpTarget = Math.sin((d?.progress ?? 0) * Math.PI) * 0.95; });
  }

  /** Called by other systems to push the look around. */
  setPsych(v) { this.uPsych.value = THREE.MathUtils.clamp(v, 0, 1); }
  setWarp(v) { this._warpTarget = THREE.MathUtils.clamp(v, 0, 1); }
  flash(a = 0.6) { this._flashTarget = Math.max(this._flashTarget, a); }

  update(dt) {
    const raw = Time.rawDt;
    this.uWarp.value += (this._warpTarget - this.uWarp.value) * Math.min(1, raw * 5);
    this.uDamage.value *= Math.exp(-raw * 3.2);
    this.uFlash.value += (this._flashTarget - this.uFlash.value) * Math.min(1, raw * 26);
    this._flashTarget *= Math.exp(-raw * 11);
  }

  resize(w, h) { /* RenderPipeline tracks renderer size automatically */ }

  render(ctx) {
    if (this.enabled && this.post) this.post.render();
    else ctx.renderer.render(ctx.scene, ctx.camera);
  }

  dispose() { this.post?.dispose?.(); }
}

export default PostFX;
