/**
 * Palette.js — the colour authority for MACHINE ELF.
 *
 * OWNER: materials agent.  No art direction should be improvised anywhere else:
 * if you are about to type a hex literal in a gameplay file, use a slot here.
 *
 * ── The model ────────────────────────────────────────────────────────────────
 * Six dimensions of descent. Each is 3 scenery hues + 1 reserved hostile hue +
 * a fog and a void, authored in OKLCH so transitions stay saturated instead of
 * passing through mud. Slots, and what they mean:
 *
 *   key      the dominant hue. Glass bodies, dominant architecture.
 *   accent   the second hue. Brass, highlights, secondary structure.
 *   rim      the dark third hue. Rim light, deep shadow chroma, silhouette edge.
 *   hostile  ENEMY FIRE ONLY. Scenery must never use this hue. See below.
 *   fog      distance haze — dark, low chroma, hue-shifted from `rim`.
 *   void     the near-black the whole frame sits in. Not pure black: chroma in
 *            the darks is what separates "moody" from "broken".
 *   glow     derived: the near-white hot core of emissive things, tinted by key.
 *   ink      derived: void pushed darker, for silhouette masses.
 *
 * ── The hostile-hue contract ─────────────────────────────────────────────────
 * `hostile` is pinned to the magenta-rose band (OKLCH hue 344–358) in EVERY
 * dimension, and no scenery slot is ever authored into 330–360. Enemy fire is
 * therefore the same colour all game long — the player never has to relearn
 * "what will kill me" at a dimension boundary, which is the single most common
 * readability failure in a bullet-hell. Readability beats novelty; the
 * dimensions express themselves through the other three hues.
 *
 * ── Live retint ──────────────────────────────────────────────────────────────
 * Every slot is exposed both as a JS THREE.Color (HUD, particles, CSS) and as a
 * TSL `uniform(new THREE.Color())`. Materials reference the uniform node, so a
 * dimension shift retints every material in the world by writing `.value` —
 * zero shader recompiles, zero hitch.
 *
 *   import Palette from '../render/Palette.js';
 *   mat.emissiveNode = Palette.u.accent.mul(2.0);   // in a material
 *   hudEl.style.color = Palette.css('key');         // in the DOM
 *   Palette.lerpTo(3, t);                           // during a transition
 */

import * as THREE from 'three';
import { uniform, float, vec3 } from 'three/tsl';
import { oklchToLinear, lerpLCH, oklchToHex, lchDistance } from '../util/mat-oklch.js';
import Bus from '../core/Bus.js';

/* ────────────────────────────────────────────────────────────────────────── */
/* the palettes                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

/** OKLCH triples: [lightness 0..1, chroma 0..0.37, hue degrees]. */
export const PALETTES = [
  {
    id: 'D1', name: 'Cathedral Glass',
    mood: 'Ordered awe. Stained glass lit from behind by a sun you cannot see. ' +
          'Still has a horizon and a sense of up.',
    key:     [0.780, 0.150, 205],  // clean cyan
    accent:  [0.845, 0.135,  92],  // pale gold
    rim:     [0.420, 0.165, 275],  // deep indigo
    hostile: [0.640, 0.300, 352],  // searing magenta-rose  (RESERVED)
    fog:     [0.185, 0.055, 252],
    void:    [0.055, 0.028, 265],
    params: { fogDensity: 0.0060, emissiveGain: 1.00, psych: 0.00, envIntensity: 0.95 },
  },
  {
    id: 'D2', name: 'Verdigris Engine',
    mood: 'Older, oxidised, mechanical. Copper gone green over centuries of ' +
          'ticking. The machine is bigger than the cathedral was.',
    key:     [0.745, 0.128, 168],  // verdigris
    accent:  [0.790, 0.150,  68],  // hot amber
    rim:     [0.360, 0.075, 200],  // slate teal
    hostile: [0.640, 0.300, 350],
    fog:     [0.160, 0.048, 192],
    void:    [0.048, 0.022, 198],
    params: { fogDensity: 0.0078, emissiveGain: 1.05, psych: 0.10, envIntensity: 0.85 },
  },
  {
    id: 'D3', name: 'Ultraviolet Choir',
    mood: 'Colder and higher. Everything is singing at a frequency you can see ' +
          'but not hear. Up is now a suggestion.',
    key:     [0.705, 0.195, 300],  // electric lilac
    accent:  [0.930, 0.040, 230],  // ice white
    rim:     [0.395, 0.160, 262],  // abyss blue
    hostile: [0.660, 0.300, 356],
    fog:     [0.150, 0.070, 286],
    void:    [0.050, 0.034, 296],
    params: { fogDensity: 0.0092, emissiveGain: 1.10, psych: 0.24, envIntensity: 0.75 },
  },
  {
    id: 'D4', name: 'Mercury Sutra',
    mood: 'Liquid metal silence. Chrome scripture. Nothing here is warm and ' +
          'nothing here is quite still.',
    key:     [0.880, 0.038, 222],  // mercury
    accent:  [0.700, 0.145, 158],  // jade
    rim:     [0.330, 0.120, 250],  // ink blue
    hostile: [0.620, 0.300, 348],
    fog:     [0.140, 0.038, 226],
    void:    [0.042, 0.020, 236],
    params: { fogDensity: 0.0105, emissiveGain: 1.12, psych: 0.40, envIntensity: 1.05 },
  },
  {
    id: 'D5', name: 'Ash Vermilion',
    mood: 'Something is burning underneath the maths. Sage ash over a vermilion ' +
          'core. Self-similar at three scales at once.',
    key:     [0.585, 0.055, 138],  // sage ash
    accent:  [0.640, 0.190,  38],  // vermilion
    rim:     [0.275, 0.085, 308],  // smoke violet
    hostile: [0.660, 0.300, 344],
    fog:     [0.135, 0.042,  46],
    void:    [0.040, 0.018,  30],
    params: { fogDensity: 0.0125, emissiveGain: 1.18, psych: 0.60, envIntensity: 0.70 },
  },
  {
    id: 'D6', name: 'Bone Reliquary',
    mood: 'The bottom. Dry bone-white, an arterial orange that is not lit by ' +
          'anything, and a violet that eats light. Nothing here wants you.',
    key:     [0.905, 0.030,  88],  // bone white
    accent:  [0.585, 0.215,  42],  // blood orange
    rim:     [0.235, 0.130, 296],  // void violet
    hostile: [0.680, 0.310, 346],
    fog:     [0.115, 0.045, 300],
    void:    [0.030, 0.016, 292],
    params: { fogDensity: 0.0150, emissiveGain: 1.25, psych: 0.85, envIntensity: 0.55 },
  },
];

export const SLOTS = ['key', 'accent', 'rim', 'hostile', 'fog', 'void'];
/** Slots a scenery/enemy-body material is allowed to tint with. */
export const SCENERY_SLOTS = ['key', 'accent', 'rim', 'fog', 'void'];

/* ────────────────────────────────────────────────────────────────────────── */

const _lch = { key: [0, 0, 0], accent: [0, 0, 0], rim: [0, 0, 0], hostile: [0, 0, 0], fog: [0, 0, 0], void: [0, 0, 0] };
const _rgb = { r: 0, g: 0, b: 0 };
const _scratchLCH = [0, 0, 0];

function writeColor(col, lch) {
  oklchToLinear(lch[0], lch[1], lch[2], _rgb);
  // Renderer output is sRGB and colour management is on, so authored values are
  // written as LINEAR — converting again would double-encode and wash the darks.
  col.setRGB(_rgb.r, _rgb.g, _rgb.b, THREE.LinearSRGBColorSpace);
  return col;
}

class PaletteSystem {
  constructor() {
    /** Index of the palette currently displayed (fractional during a lerp). */
    this.current = 0;
    this.from = 0;
    this.to = 0;
    this.t = 0;

    /** JS-side live colours. Read them; do not mutate them. */
    this.colors = {
      key: new THREE.Color(), accent: new THREE.Color(), rim: new THREE.Color(),
      hostile: new THREE.Color(), fog: new THREE.Color(), void: new THREE.Color(),
      glow: new THREE.Color(), ink: new THREE.Color(),
    };

    /** Live scalar parameters (fog density, emissive gain, psych level). */
    this.params = { fogDensity: 0.006, emissiveGain: 1, psych: 0, envIntensity: 1 };

    /**
     * TSL uniforms. Materials embed these nodes; the dimension shift writes
     * `.value` and the whole world retints with no recompile.
     */
    this.u = {
      key: uniform(new THREE.Color()),
      accent: uniform(new THREE.Color()),
      rim: uniform(new THREE.Color()),
      hostile: uniform(new THREE.Color()),
      fog: uniform(new THREE.Color()),
      void: uniform(new THREE.Color()),
      glow: uniform(new THREE.Color()),
      ink: uniform(new THREE.Color()),
      /** Fractional dimension index 0..5 — for materials that escalate. */
      dim: uniform(0),
      /** Normalised descent 0..1. Drives "how far from euclidean sanity". */
      depth: uniform(0),
      /** Global emissive multiplier. Directors can dip this for a blackout. */
      gain: uniform(1),
      /** 0..1 psychedelia, mirrors PostFX.setPsych. */
      psych: uniform(0),
    };

    this._listeners = new Set();
    this._cssEl = null;
    this._bound = false;

    this.set(0);
  }

  /* ── authoring accessors ─────────────────────────────────────────────── */

  get key() { return this.colors.key; }
  get accent() { return this.colors.accent; }
  get rim() { return this.colors.rim; }
  get hostile() { return this.colors.hostile; }
  get fog() { return this.colors.fog; }
  get void() { return this.colors.void; }
  get glow() { return this.colors.glow; }
  get ink() { return this.colors.ink; }

  /** The definition object of the nearest whole dimension. */
  get def() { return PALETTES[Math.round(this.current) % PALETTES.length]; }
  get name() { return this.def.name; }
  get count() { return PALETTES.length; }

  /** Live colour for a slot name. Returns the shared instance — do not mutate. */
  get(slot) { return this.colors[slot] || this.colors.key; }

  /** '#rrggbb' for a slot — for HUD text, CSS, canvas 2D. */
  css(slot) {
    const c = this.colors[slot] || this.colors.key;
    return `#${c.clone().convertLinearToSRGB().getHexString()}`;
  }

  /** 0xrrggbb integer (sRGB-encoded) for a slot. */
  hex(slot) {
    return this.colors[slot] ? this.colors[slot].clone().convertLinearToSRGB().getHex() : 0xffffff;
  }

  /**
   * A perceptual variant of a slot — brighter, more/less saturated, hue-nudged —
   * without leaving the palette. Allocates; call at build time, not per frame.
   * @example Palette.shade('accent', { dL: +0.12, dC: -0.04 })
   */
  shade(slot, { dL = 0, dC = 0, dH = 0 } = {}, target = new THREE.Color()) {
    const s = _lch[slot] || _lch.key;
    _scratchLCH[0] = THREE.MathUtils.clamp(s[0] + dL, 0, 1);
    _scratchLCH[1] = Math.max(0, s[1] + dC);
    _scratchLCH[2] = s[2] + dH;
    return writeColor(target, _scratchLCH);
  }

  /** The live OKLCH triple of a slot (read-only). */
  lch(slot) { return _lch[slot] || _lch.key; }

  /* ── transitions ─────────────────────────────────────────────────────── */

  /** Snap to a dimension palette. Emits `palette:change`. */
  set(index) {
    const i = ((index | 0) % PALETTES.length + PALETTES.length) % PALETTES.length;
    this.from = i; this.to = i; this.t = 1; this.current = i;
    this._apply(PALETTES[i], PALETTES[i], 0, i);
    return this;
  }

  /**
   * Blend the live palette toward `index`. `t` is 0..1 absolute progress from
   * whatever palette was current when the transition began. Call every frame of
   * a dimension shift; call with t>=1 (or `set`) to land.
   */
  lerpTo(index, t) {
    const i = ((index | 0) % PALETTES.length + PALETTES.length) % PALETTES.length;
    if (i !== this.to) { this.from = Math.round(this.current); this.to = i; }
    this.t = THREE.MathUtils.clamp(t, 0, 1);
    // smootherstep — a linear colour ramp reads as a crossfade, an eased one
    // reads as an event
    const e = this.t * this.t * this.t * (this.t * (this.t * 6 - 15) + 10);
    const A = PALETTES[this.from], B = PALETTES[this.to];
    this.current = this.from + (this.to - this.from) * e;
    this._apply(A, B, e, this.current);
    if (this.t >= 1) { this.from = this.to; }
    return this;
  }

  /** Advance a transition by dt at `rate` units/sec. Convenience for Dimensions. */
  step(dt, rate = 0.5) {
    if (this.t < 1) this.lerpTo(this.to, this.t + dt * rate);
    return this;
  }

  _apply(A, B, e, currentIdx) {
    for (let s = 0; s < SLOTS.length; s++) {
      const slot = SLOTS[s];
      lerpLCH(A[slot], B[slot], e, _lch[slot]);
      writeColor(this.colors[slot], _lch[slot]);
      this.u[slot].value.copy(this.colors[slot]);
    }

    // derived slots
    // glow: the hot core of any emissive thing — near-white, faintly key-tinted,
    // so bullets/cores read as "energy" rather than "a coloured ball".
    _scratchLCH[0] = 0.985;
    _scratchLCH[1] = Math.min(0.055, _lch.key[1] * 0.35);
    _scratchLCH[2] = _lch.key[2];
    writeColor(this.colors.glow, _scratchLCH);
    this.u.glow.value.copy(this.colors.glow);

    // ink: the silhouette black. Chromatic, never 0,0,0.
    _scratchLCH[0] = _lch.void[0] * 0.55;
    _scratchLCH[1] = _lch.void[1] * 0.8;
    _scratchLCH[2] = _lch.void[2];
    writeColor(this.colors.ink, _scratchLCH);
    this.u.ink.value.copy(this.colors.ink);

    // scalar params
    const pa = A.params, pb = B.params;
    const p = this.params;
    p.fogDensity = pa.fogDensity + (pb.fogDensity - pa.fogDensity) * e;
    p.emissiveGain = pa.emissiveGain + (pb.emissiveGain - pa.emissiveGain) * e;
    p.psych = pa.psych + (pb.psych - pa.psych) * e;
    p.envIntensity = pa.envIntensity + (pb.envIntensity - pa.envIntensity) * e;

    this.u.dim.value = currentIdx;
    this.u.depth.value = currentIdx / (PALETTES.length - 1);
    this.u.gain.value = p.emissiveGain;
    this.u.psych.value = p.psych;

    this._pushCSS();
    for (const fn of this._listeners) { try { fn(this); } catch (err) { console.error('[palette]', err); } }
    Bus.emit('palette:change', { palette: this, index: currentIdx, def: this.def });
  }

  /* ── plumbing ────────────────────────────────────────────────────────── */

  /** Subscribe to retints (env maps, canvas textures, DOM). Returns unsubscribe. */
  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  /**
   * Mirror the palette into CSS custom properties on :root so the HUD and any
   * DOM overlay retint for free: `color: var(--pal-key)`.
   */
  _pushCSS() {
    if (typeof document === 'undefined') return;
    const st = document.documentElement.style;
    for (let i = 0; i < SLOTS.length; i++) st.setProperty(`--pal-${SLOTS[i]}`, this.css(SLOTS[i]));
    st.setProperty('--pal-glow', this.css('glow'));
    st.setProperty('--pal-ink', this.css('ink'));
  }

  /** Auto-follow the canonical dimension events. Called once by Materials.init. */
  bindBus() {
    if (this._bound) return this;
    this._bound = true;
    Bus.on('dimension:enter', (d) => { if (typeof d?.index === 'number') this.set(d.index); });
    Bus.on('dimension:shift', (d) => {
      if (typeof d?.to === 'number') this.lerpTo(d.to, d.progress ?? 0);
    });
    return this;
  }

  /* ── QA ──────────────────────────────────────────────────────────────── */

  /**
   * Assert the art-direction invariants. Logged once at boot in dev:
   *  - no scenery slot lands in the reserved hostile band
   *  - hostile is perceptually far from every scenery hue in its dimension
   *  - the void is actually dark
   */
  audit(verbose = false) {
    const problems = [];
    for (const P of PALETTES) {
      for (const slot of SCENERY_SLOTS) {
        const h = ((P[slot][2] % 360) + 360) % 360;
        if (P[slot][1] > 0.05 && h > 330 && h < 360) {
          problems.push(`${P.id}.${slot} hue ${h.toFixed(0)}° is inside the reserved hostile band`);
        }
        const d = lchDistance(P[slot], P.hostile);
        if (P[slot][1] > 0.08 && d < 0.20) {
          problems.push(`${P.id}.${slot} is only ΔE ${d.toFixed(3)} from hostile — bullets will vanish`);
        }
      }
      if (P.void[0] > 0.09) problems.push(`${P.id}.void L=${P.void[0]} is too bright to sit a neon frame on`);
      const hh = ((P.hostile[2] % 360) + 360) % 360;
      if (hh < 340 || hh > 360) problems.push(`${P.id}.hostile left the reserved magenta-rose band`);
    }
    if (verbose || problems.length) {
      console[problems.length ? 'warn' : 'log'](
        `[palette] audit: ${problems.length ? problems.join('\n  ') : 'all invariants hold'}`);
    }
    return problems;
  }

  /** Debug: dump every palette as hex, for eyeballing in the console. */
  table() {
    return PALETTES.map((P) => {
      const row = { dimension: `${P.id} ${P.name}` };
      for (const s of SLOTS) row[s] = oklchToHex(P[s][0], P[s][1], P[s][2]);
      return row;
    });
  }
}

export const Palette = new PaletteSystem();
export default Palette;
