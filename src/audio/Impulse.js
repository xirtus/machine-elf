import { mulberry32 } from './Scales.js';

/**
 * Procedurally synthesised impulse responses for ConvolverNode.
 *
 * No IR files — hard constraint. These are built from a noise field shaped by:
 *   1. a sparse set of *early reflections* (discrete taps in the first ~150ms),
 *      which is what actually makes a space read as a size rather than a wash;
 *   2. an exponential-ish late tail whose density ramps in;
 *   3. progressive high-frequency damping via a one-pole lowpass whose cutoff
 *      falls over the length of the tail (air absorption + soft surfaces);
 *   4. a low-cut so the tail never muddies the sub, which the boss needs.
 *
 * Stereo decorrelation comes from independent noise streams plus offset early
 * reflection times per channel — a mono IR duplicated to two channels sounds
 * like a wide mono cave, not a room.
 */

export const IR_PRESETS = {
  /** The fractal cathedrals. Enormous, slow, glassy. */
  cathedral: {
    seconds: 6.2, decay: 2.35, preDelay: 0.035,
    early: 22, earlySpread: 0.16, earlyGain: 0.55,
    dampStart: 9000, dampEnd: 900, lowCut: 0.986,
    diffusion: 0.55, width: 1.0, seed: 1337,
  },
  /** Mid-size stone hall — default for gameplay. */
  hall: {
    seconds: 2.9, decay: 3.1, preDelay: 0.018,
    early: 16, earlySpread: 0.085, earlyGain: 0.6,
    dampStart: 11000, dampEnd: 1500, lowCut: 0.982,
    diffusion: 0.45, width: 0.9, seed: 90210,
  },
  /** Bright metallic plate — for glass shatter and clockwork. */
  plate: {
    seconds: 1.55, decay: 4.4, preDelay: 0.004,
    early: 9, earlySpread: 0.022, earlyGain: 0.35,
    dampStart: 15000, dampEnd: 4200, lowCut: 0.972,
    diffusion: 0.8, width: 1.0, seed: 5150,
  },
  /** Tiny tight ambience so dry hits still have a body. */
  room: {
    seconds: 0.55, decay: 7.5, preDelay: 0.002,
    early: 7, earlySpread: 0.014, earlyGain: 0.5,
    dampStart: 12000, dampEnd: 3000, lowCut: 0.965,
    diffusion: 0.6, width: 0.7, seed: 8080,
  },
  /** Non-euclidean: long, undamped, ringing. Deep dimensions. */
  voidspace: {
    seconds: 4.6, decay: 1.7, preDelay: 0.06,
    early: 30, earlySpread: 0.3, earlyGain: 0.75,
    dampStart: 13000, dampEnd: 2600, lowCut: 0.99,
    diffusion: 0.3, width: 1.0, seed: 24601,
  },
};

/**
 * @param {BaseAudioContext} ctx
 * @param {object} p preset (see IR_PRESETS)
 * @returns {AudioBuffer} stereo IR, peak-normalised
 */
export function generateIR(ctx, p) {
  const sr = ctx.sampleRate;
  const len = Math.max(64, Math.floor(p.seconds * sr));
  const buf = ctx.createBuffer(2, len, sr);
  const rnd = mulberry32(p.seed >>> 0);

  const pre = Math.floor(p.preDelay * sr);
  const dampStart = Math.min(p.dampStart, sr * 0.45);
  const dampEnd = Math.min(p.dampEnd, sr * 0.45);

  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    // slight per-channel time skew so the two ears disagree about the room
    const skew = ch === 0 ? 0 : Math.floor(sr * 0.0021 * p.width);
    const lp = { z: 0 };
    const hp = { z: 0, y: 0 };

    // ---- late tail: noise * envelope, density ramping in ------------------
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const rel = i / len;
      if (i < pre + skew) { d[i] = 0; continue; }
      const te = (i - pre - skew) / sr;

      // envelope: exponential decay with a short build so it does not start
      // at full density (that reads as a gated reverb, not a space)
      const build = 1 - Math.exp(-te * (60 / (1 + p.diffusion * 8)));
      const env = Math.exp(-te * p.decay) * build;

      // sparse -> dense grain gate. Early tail is discrete echoes; late tail
      // fills in. This is what gives a sense of physical size.
      const density = Math.min(1, 0.06 + rel * 14 * (0.3 + p.diffusion));
      const g = rnd() < density ? (rnd() * 2 - 1) : 0;

      // progressive damping: cutoff glides from dampStart down to dampEnd
      const fc = dampStart + (dampEnd - dampStart) * Math.min(1, Math.pow(rel, 0.55));
      const a = 1 - Math.exp((-2 * Math.PI * fc) / sr);
      lp.z += a * (g - lp.z);

      // one-pole high-pass to keep the tail out of the sub region
      const x = lp.z;
      hp.y = p.lowCut * (hp.y + x - hp.z);
      hp.z = x;

      d[i] = hp.y * env;
      void t;
    }

    // ---- early reflections: discrete taps, the "shape" of the space -------
    for (let k = 0; k < p.early; k++) {
      // non-uniform spacing — uniform taps sound like a comb filter
      const frac = Math.pow((k + 1) / p.early, 1.35);
      const jitter = 1 + (rnd() * 2 - 1) * 0.35;
      const tt = p.preDelay + frac * p.earlySpread * jitter + (ch ? 0.0013 * rnd() : 0);
      const idx = Math.floor(tt * sr);
      if (idx >= len - 4) continue;
      const amp = p.earlyGain * Math.pow(1 - frac, 1.5) * (0.5 + rnd() * 0.5)
        * (rnd() < 0.5 ? -1 : 1);
      // 4-sample smear so the tap is a reflection, not a click
      d[idx] += amp;
      d[idx + 1] += amp * 0.55;
      d[idx + 2] += amp * -0.28;
      d[idx + 3] += amp * 0.12;
    }
  }

  // ---- normalise to a predictable wet level -------------------------------
  let peak = 0;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
  }
  if (peak > 0) {
    const s = 0.86 / peak;
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] *= s;
    }
  }
  return buf;
}

/** White noise buffer, shared by every noise-based voice. */
export function generateNoise(ctx, seconds = 2.0, seed = 7) {
  const sr = ctx.sampleRate;
  const len = Math.floor(seconds * sr);
  const buf = ctx.createBuffer(2, len, sr);
  const rnd = mulberry32(seed);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = rnd() * 2 - 1;
  }
  return buf;
}

/** Pink-ish noise (Voss-McCartney, 5 rows) — the wind/engine bed. */
export function generatePink(ctx, seconds = 3.0, seed = 11) {
  const sr = ctx.sampleRate;
  const len = Math.floor(seconds * sr);
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const rnd = mulberry32(seed + ch * 977);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    let peak = 0;
    for (let i = 0; i < len; i++) {
      const w = rnd() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      const v = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
      d[i] = v;
      const a = Math.abs(v); if (a > peak) peak = a;
    }
    if (peak > 0) { const s = 0.9 / peak; for (let i = 0; i < len; i++) d[i] *= s; }
  }
  return buf;
}

/**
 * Karplus-Strong plucked string rendered offline into a buffer.
 *
 * WebAudio cannot do real KS with a DelayNode feedback loop: any cycle in the
 * graph is forced to a minimum of one render quantum (128 samples), capping the
 * fundamental at ~375Hz. So we render the string in JS once and repitch it with
 * playbackRate, which also scales the decay — which is what a real string does.
 *
 * @param {BaseAudioContext} ctx
 * @param {number} freq  reference pitch of the rendered buffer
 * @param {object} o     { seconds, damp 0..1, decay 0..1, bright 0..1, seed }
 */
export function generatePluck(ctx, freq, o = {}) {
  const sr = ctx.sampleRate;
  const seconds = o.seconds ?? 2.4;
  const damp = o.damp ?? 0.5;
  const decayAmt = o.decay ?? 0.5;
  const bright = o.bright ?? 0.5;
  const len = Math.floor(seconds * sr);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  const rnd = mulberry32(o.seed ?? 424242);

  const N = Math.max(4, Math.round(sr / freq));
  const line = new Float32Array(N);
  // excitation: noise shaped toward the bright end, plus a little DC-free ramp
  let dcAcc = 0;
  for (let i = 0; i < N; i++) {
    const w = rnd() * 2 - 1;
    const shaped = w * (0.4 + bright * 0.6) + Math.sin((i / N) * Math.PI * 2) * (0.35 - bright * 0.3);
    line[i] = shaped;
    dcAcc += shaped;
  }
  const dc = dcAcc / N;
  for (let i = 0; i < N; i++) line[i] -= dc;

  // loop filter: one-pole lowpass + loss. damp controls brightness loss/round.
  const loss = 0.9965 - decayAmt * 0.006;
  const a = 0.5 + damp * 0.42;    // averaging coefficient
  let idx = 0, prev = 0, peak = 0;
  for (let i = 0; i < len; i++) {
    const cur = line[idx];
    const filt = (cur * (1 - a * 0.5) + prev * (a * 0.5));
    prev = cur;
    line[idx] = filt * loss;
    d[i] = cur;
    const abs = Math.abs(cur); if (abs > peak) peak = abs;
    idx++; if (idx >= N) idx = 0;
  }
  // gentle fade-out on the last 5% so a truncated buffer never clicks
  const fade = Math.floor(len * 0.05);
  for (let i = 0; i < fade; i++) {
    d[len - 1 - i] *= i / fade;
  }
  if (peak > 0) { const s = 0.92 / peak; for (let i = 0; i < len; i++) d[i] *= s; }
  return buf;
}

/** Waveshaper transfer curve: soft asymmetric tube-ish saturation. */
export function makeDriveCurve(amount = 0.5, n = 2048) {
  const c = new Float32Array(n);
  const k = amount * 60 + 0.6;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    // asymmetry adds even harmonics -> warmth rather than fizz
    const xa = x + amount * 0.12 * x * x;
    c[i] = Math.tanh(xa * k) / Math.tanh(k);
  }
  return c;
}

/**
 * Bit-depth reduction as a waveshaper curve. A true quantiser: the transfer
 * function is a staircase, which is exactly what a bitcrusher's amplitude
 * stage does. (Sample-rate crushing is done separately by ring-modulating.)
 */
export function makeCrushCurve(bits = 6, n = 8192) {
  const c = new Float32Array(n);
  const levels = Math.max(2, Math.pow(2, bits));
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.round(x * levels * 0.5) / (levels * 0.5);
  }
  return c;
}

export default generateIR;
