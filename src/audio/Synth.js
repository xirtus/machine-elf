/**
 * Reusable synth voices.
 *
 * Every function here takes (kit, voice, time, opts), builds its nodes into
 * `voice.out`, registers its sources with the pool so they can be stolen, and
 * returns the time it finishes. Nothing here reads the clock — everything is
 * scheduled ahead on the AudioContext timeline, so these all render bit-exact
 * in an OfflineAudioContext, which is how the SFX table gets verified.
 *
 * The palette:
 *   fm()        two-operator FM — bells, clangs, sub thumps, roars
 *   supersaw()  detuned unison stack — pads, leads, the neon wash
 *   wavetable() PeriodicWave oscillator — glassy, formant-ish tones
 *   pluck()     Karplus-Strong string played from a pre-rendered buffer
 *   metal()     inharmonic partial bank + noise transient — clockwork glass
 *   noiseBand() bandpass-swept noise burst — whooshes, air, impacts
 *   granular()  scattered short grains — boss roars, texture beds
 *   subDrop()   pitch-falling sine — weight under every impact
 */

const MIN_GAIN = 0.0006;

/* ── envelopes ─────────────────────────────────────────────────────────── */

/** Percussive exponential decay. Cheap, and the shape most hits want. */
export function hit(param, t, peak, decay, delay = 0.0008) {
  param.setValueAtTime(0.0001, t);
  param.exponentialRampToValueAtTime(Math.max(peak, MIN_GAIN), t + delay);
  param.exponentialRampToValueAtTime(MIN_GAIN, t + delay + decay);
  param.setValueAtTime(0, t + delay + decay + 0.001);
  return t + delay + decay + 0.002;
}

/** Full AHDSR. Returns end time. */
export function adsr(param, t, o) {
  const peak = o.peak ?? 1;
  const a = o.attack ?? 0.005;
  const d = o.decay ?? 0.1;
  const s = o.sustain ?? 0;
  const h = o.hold ?? 0;
  const r = o.release ?? 0.08;
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + a);
  if (s > 0) {
    param.exponentialRampToValueAtTime(Math.max(peak * s, MIN_GAIN), t + a + d);
    param.setValueAtTime(Math.max(peak * s, MIN_GAIN), t + a + d + h);
    param.exponentialRampToValueAtTime(MIN_GAIN, t + a + d + h + r);
  } else {
    param.exponentialRampToValueAtTime(MIN_GAIN, t + a + d);
  }
  const end = t + a + d + h + (s > 0 ? r : 0);
  param.setValueAtTime(0, end + 0.001);
  return end + 0.002;
}

/* ── wavetables ────────────────────────────────────────────────────────── */

const WAVE_SPECS = {
  // bright, glassy, odd-weighted — the neon elves
  glass: (n) => (n % 2 ? 1 / Math.pow(n, 1.35) : 0.28 / Math.pow(n, 1.9)),
  // hollow woodwind-ish, missing 2nd and 4th
  hollow: (n) => (n === 2 || n === 4 ? 0.02 : 1 / Math.pow(n, 1.6)),
  // organ-ish stacked octaves and fifths
  organ: (n) => (n === 1 ? 1 : n === 2 ? 0.55 : n === 3 ? 0.34 : n === 4 ? 0.28
    : n === 6 ? 0.16 : n === 8 ? 0.12 : 0.03 / n),
  // buzzing sawtooth with rolled-off top (band-limited, no aliasing fizz)
  buzz: (n) => 1 / n * Math.exp(-n / 26),
  // formant-ish vowel bump around the 5th partial — vocal, unsettling
  voice: (n) => (1 / Math.pow(n, 1.2)) * (1 + 2.4 * Math.exp(-Math.pow(n - 5, 2) / 6)),
  // very thin, high — the clockwork tick
  tick: (n) => (n > 3 ? 1 / Math.pow(n, 0.7) * Math.exp(-n / 18) : 0.15),
};

/** Cached PeriodicWave factory. Waves are built once per context. */
export function makeWaveCache(ctx) {
  const cache = new Map();
  return (name, partials = 32) => {
    const key = name + ':' + partials;
    let w = cache.get(key);
    if (w) return w;
    const spec = WAVE_SPECS[name] || WAVE_SPECS.glass;
    const real = new Float32Array(partials + 1);
    const imag = new Float32Array(partials + 1);
    for (let n = 1; n <= partials; n++) {
      imag[n] = spec(n);
      // small deterministic phase scatter keeps the peak down (crest factor)
      real[n] = spec(n) * 0.25 * Math.sin(n * 2.399963);
    }
    w = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    cache.set(key, w);
    return w;
  };
}

/* ── inharmonic partial tables ─────────────────────────────────────────── */

export const PARTIALS = {
  // free circular plate — glass
  glass: [1, 2.76, 5.40, 8.93, 13.34, 18.64, 24.7],
  // tubular bell
  bell: [1, 2.0, 3.01, 4.15, 5.43, 6.79, 8.21, 9.55],
  // struck brass escapement — deliberately ugly ratios
  clockwork: [1, 1.732, 2.618, 3.141, 4.669, 5.877, 7.389],
  // thin shard, very high and dense
  shard: [1, 2.41, 3.86, 5.11, 6.72, 8.13, 9.94, 11.7, 13.9],
};

/* ── voices ────────────────────────────────────────────────────────────── */

/**
 * Two-operator FM. `ratio` sets timbre (integer = harmonic, irrational = clangy),
 * `index` is modulation depth in multiples of the carrier frequency.
 */
export function fm(k, v, t, o) {
  const ctx = k.ctx;
  const freq = o.freq ?? 220;
  const ratio = o.ratio ?? 2;
  const index = o.index ?? 3;
  const decay = o.decay ?? 0.4;
  const gain = o.gain ?? 0.3;

  const car = k.track(v, ctx.createOscillator());
  car.type = o.carrierType || 'sine';
  car.frequency.setValueAtTime(freq, t);
  if (o.freqEnd !== undefined) {
    car.frequency.exponentialRampToValueAtTime(Math.max(8, o.freqEnd), t + (o.pitchTime ?? decay));
  }

  const mod = k.track(v, ctx.createOscillator());
  mod.type = o.modType || 'sine';
  mod.frequency.setValueAtTime(freq * ratio, t);
  if (o.freqEnd !== undefined) {
    mod.frequency.exponentialRampToValueAtTime(Math.max(8, o.freqEnd * ratio), t + (o.pitchTime ?? decay));
  }

  const modGain = ctx.createGain();
  const idxDecay = o.indexDecay ?? decay * 0.6;
  modGain.gain.setValueAtTime(freq * index, t);
  modGain.gain.exponentialRampToValueAtTime(Math.max(freq * index * (o.indexEnd ?? 0.02), 0.01), t + idxDecay);
  mod.connect(modGain); modGain.connect(car.frequency);

  const amp = ctx.createGain();
  const end = o.sustain
    ? adsr(amp.gain, t, { peak: gain, attack: o.attack ?? 0.01, decay: decay * 0.5, sustain: o.sustain, hold: o.hold ?? 0.1, release: o.release ?? decay })
    : hit(amp.gain, t, gain, decay, o.attack ?? 0.002);
  car.connect(amp); amp.connect(o.dest || v.out);

  mod.start(t); car.start(t);
  mod.stop(end + 0.01); car.stop(end + 0.01);
  return end;
}

/** Detuned unison stack. The wide neon pad / lead. */
export function supersaw(k, v, t, o) {
  const ctx = k.ctx;
  const freq = o.freq ?? 110;
  const n = o.voices ?? 5;
  const spread = o.detune ?? 14;          // cents at the edges
  const gain = (o.gain ?? 0.25) / Math.sqrt(n);
  const type = o.type || 'sawtooth';

  const amp = ctx.createGain();
  const filt = ctx.createBiquadFilter();
  filt.type = o.filterType || 'lowpass';
  filt.frequency.setValueAtTime(o.cutoff ?? 1800, t);
  filt.Q.value = o.q ?? 0.9;
  if (o.cutoffEnd !== undefined) {
    filt.frequency.exponentialRampToValueAtTime(Math.max(60, o.cutoffEnd), t + (o.cutoffTime ?? 0.6));
  }

  for (let i = 0; i < n; i++) {
    const osc = k.track(v, ctx.createOscillator());
    if (o.wave) osc.setPeriodicWave(k.wave(o.wave)); else osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    const dt = n === 1 ? 0 : ((i / (n - 1)) * 2 - 1) * spread;
    osc.detune.setValueAtTime(dt + (o.detuneOffset ?? 0), t);
    if (o.freqEnd !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(8, o.freqEnd), t + (o.pitchTime ?? 0.5));
    // slow independent drift so the stack never phase-locks into a beep
    const drift = k.track(v, ctx.createOscillator());
    drift.type = 'sine';
    drift.frequency.value = 0.07 + i * 0.031 + (o.driftRate ?? 0);
    const dg = ctx.createGain();
    dg.gain.value = o.drift ?? 4.5;
    drift.connect(dg); dg.connect(osc.detune);
    drift.start(t);
    osc.connect(filt);
    osc.start(t);
    const stopAt = t + (o.life ?? 4);
    osc.stop(stopAt); drift.stop(stopAt);
  }
  filt.connect(amp);
  amp.connect(o.dest || v.out);

  const end = adsr(amp.gain, t, {
    peak: gain, attack: o.attack ?? 0.6, decay: o.decayT ?? 0.5,
    sustain: o.sustainLvl ?? 0.7, hold: o.hold ?? 1.2, release: o.release ?? 1.4,
  });
  return end;
}

/** Single PeriodicWave oscillator with a filter — the cheap workhorse tone. */
export function wavetable(k, v, t, o) {
  const ctx = k.ctx;
  const osc = k.track(v, ctx.createOscillator());
  osc.setPeriodicWave(k.wave(o.wave || 'glass', o.partials || 32));
  osc.frequency.setValueAtTime(o.freq ?? 440, t);
  if (o.freqEnd !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(8, o.freqEnd), t + (o.pitchTime ?? 0.15));
  }
  if (o.detune) osc.detune.setValueAtTime(o.detune, t);

  let node = osc;
  if (o.cutoff) {
    const f = ctx.createBiquadFilter();
    f.type = o.filterType || 'lowpass';
    f.frequency.setValueAtTime(o.cutoff, t);
    f.Q.value = o.q ?? 1;
    if (o.cutoffEnd) f.frequency.exponentialRampToValueAtTime(Math.max(40, o.cutoffEnd), t + (o.cutoffTime ?? 0.2));
    osc.connect(f); node = f;
  }
  const amp = ctx.createGain();
  node.connect(amp); amp.connect(o.dest || v.out);
  const end = o.sustain
    ? adsr(amp.gain, t, { peak: o.gain ?? 0.25, attack: o.attack ?? 0.004, decay: o.decay ?? 0.1, sustain: o.sustain, hold: o.hold ?? 0.1, release: o.release ?? 0.2 })
    : hit(amp.gain, t, o.gain ?? 0.25, o.decay ?? 0.25, o.attack ?? 0.003);
  osc.start(t); osc.stop(end + 0.02);
  return end;
}

/** Karplus-Strong pluck, repitched from the pre-rendered string buffer. */
export function pluck(k, v, t, o) {
  const ctx = k.ctx;
  const freq = o.freq ?? 330;
  const src = k.track(v, ctx.createBufferSource());
  const buf = o.dark ? k.pluckDark : k.pluck;
  src.buffer = buf;
  src.playbackRate.value = freq / k.pluckFreq;
  if (o.bend) {
    src.playbackRate.setValueAtTime(freq / k.pluckFreq * o.bend, t);
    src.playbackRate.exponentialRampToValueAtTime(freq / k.pluckFreq, t + (o.bendTime ?? 0.06));
  }
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.setValueAtTime(o.cutoff ?? Math.min(16000, freq * 12), t);
  f.frequency.exponentialRampToValueAtTime(Math.max(200, (o.cutoffEnd ?? freq * 3)), t + (o.decay ?? 0.8));
  f.Q.value = o.q ?? 0.4;

  const amp = ctx.createGain();
  const dur = Math.min((o.decay ?? 0.9), (buf.duration * k.pluckFreq) / freq);
  const end = hit(amp.gain, t, o.gain ?? 0.3, dur, 0.0015);
  src.connect(f); f.connect(amp); amp.connect(o.dest || v.out);
  src.start(t); src.stop(end + 0.02);
  return end;
}

/**
 * Physically-flavoured metallic/glass hit: an inharmonic partial bank where
 * each partial has its own decay (high partials die first, as they do in a
 * real plate), plus a bandpassed noise transient for the strike itself.
 */
export function metal(k, v, t, o) {
  const ctx = k.ctx;
  const base = o.freq ?? 900;
  const table = PARTIALS[o.table || 'glass'];
  const count = Math.min(o.partials ?? 6, table.length);
  const decay = o.decay ?? 0.7;
  const g = (o.gain ?? 0.3) / Math.sqrt(count);
  let end = t;

  for (let i = 0; i < count; i++) {
    const ratio = table[i] * (1 + (k.rnd() - 0.5) * (o.jitter ?? 0.012));
    const f = base * ratio;
    if (f > 19000) continue;
    const osc = k.track(v, ctx.createOscillator());
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f, t);
    if (o.bend) osc.frequency.exponentialRampToValueAtTime(f * o.bend, t + decay * 0.5);
    const amp = ctx.createGain();
    // partial-dependent decay: k/f, so the top shears off first
    const d = Math.max(0.03, decay * Math.pow(0.72, i) * (0.75 + k.rnd() * 0.5));
    const a = g * Math.pow(0.78, i) * (0.6 + k.rnd() * 0.8);
    const e = hit(amp.gain, t + i * (o.stagger ?? 0), a, d, 0.001);
    if (e > end) end = e;
    osc.connect(amp); amp.connect(o.dest || v.out);
    osc.start(t); osc.stop(e + 0.02);
  }

  // strike transient
  if ((o.strike ?? 1) > 0) {
    const n = k.track(v, ctx.createBufferSource());
    n.buffer = k.noise;
    n.playbackRate.value = 0.8 + k.rnd() * 0.6;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(base * (o.strikeMul ?? 3.2), t);
    bp.frequency.exponentialRampToValueAtTime(Math.max(120, base * 1.1), t + 0.05);
    bp.Q.value = o.strikeQ ?? 1.4;
    const ng = ctx.createGain();
    const e = hit(ng.gain, t, (o.gain ?? 0.3) * 0.5 * (o.strike ?? 1), o.strikeDecay ?? 0.045, 0.0006);
    n.connect(bp); bp.connect(ng); ng.connect(o.dest || v.out);
    n.start(t, k.rnd() * 1.5); n.stop(e + 0.02);
    if (e > end) end = e;
  }
  return end;
}

/** Bandpass-swept noise burst. Whooshes, air, breath, impact grit. */
export function noiseBand(k, v, t, o) {
  const ctx = k.ctx;
  const src = k.track(v, ctx.createBufferSource());
  src.buffer = o.pink ? k.pink : k.noise;
  src.playbackRate.value = o.rate ?? 1;
  src.loop = !!o.loop;

  const f = ctx.createBiquadFilter();
  f.type = o.filterType || 'bandpass';
  const f0 = o.f0 ?? 800, f1 = o.f1 ?? f0;
  const dur = o.decay ?? 0.3;
  f.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + (o.sweepTime ?? dur));
  f.Q.value = o.q ?? 1.2;

  let node = f;
  if (o.hp) {
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = o.hp; hp.Q.value = 0.7;
    f.connect(hp); node = hp;
  }
  const amp = ctx.createGain();
  const end = o.attack !== undefined && o.attack > 0.02
    ? adsr(amp.gain, t, { peak: o.gain ?? 0.25, attack: o.attack, decay: dur * 0.5, sustain: o.sustainLvl ?? 0, hold: o.hold ?? 0, release: o.release ?? dur })
    : hit(amp.gain, t, o.gain ?? 0.25, dur, o.attack ?? 0.004);
  src.connect(f); node.connect(amp); amp.connect(o.dest || v.out);
  src.start(t, o.offset ?? (k.rnd() * 1.2)); src.stop(end + 0.02);
  return end;
}

/** Sine with an exponential pitch drop. The weight under every impact. */
export function subDrop(k, v, t, o) {
  const ctx = k.ctx;
  const osc = k.track(v, ctx.createOscillator());
  osc.type = o.type || 'sine';
  const f0 = o.f0 ?? 140, f1 = o.f1 ?? 38;
  const decay = o.decay ?? 0.32;
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(12, f1), t + (o.pitchTime ?? decay * 0.7));
  const amp = ctx.createGain();
  const end = hit(amp.gain, t, o.gain ?? 0.4, decay, o.attack ?? 0.002);
  let node = osc;
  if (o.drive) {
    const ws = ctx.createWaveShaper();
    ws.curve = k.driveCurve;
    osc.connect(ws); node = ws;
  }
  node.connect(amp); amp.connect(o.dest || v.out);
  osc.start(t); osc.stop(end + 0.02);
  return end;
}

/**
 * Granular texture: scattered short grains from the noise/pink buffer, each
 * with its own pitch, pan and window. This is where the boss roar gets its
 * "made of a thousand small things" quality.
 */
export function granular(k, v, t, o) {
  const ctx = k.ctx;
  const n = Math.min(o.grains ?? 14, 18);
  const spread = o.spread ?? 0.55;
  const grainLen = o.grainLen ?? 0.09;
  const g = (o.gain ?? 0.3) / Math.sqrt(n);
  let end = t;
  for (let i = 0; i < n; i++) {
    const src = k.track(v, ctx.createBufferSource());
    src.buffer = o.pink ? k.pink : k.noise;
    src.playbackRate.value = (o.rate ?? 0.35) * (1 + (k.rnd() - 0.5) * (o.rateJitter ?? 0.7));
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = (o.f0 ?? 220) * Math.pow(2, (k.rnd() * 2 - 1) * (o.octaves ?? 1.6));
    bp.Q.value = o.q ?? 5;
    const amp = ctx.createGain();
    const st = t + k.rnd() * spread;
    const len = grainLen * (0.5 + k.rnd());
    amp.gain.setValueAtTime(0, st);
    amp.gain.linearRampToValueAtTime(g * (0.4 + k.rnd() * 0.6), st + len * 0.35);
    amp.gain.linearRampToValueAtTime(0, st + len);
    src.connect(bp); bp.connect(amp); amp.connect(o.dest || v.out);
    src.start(st, k.rnd() * 1.5); src.stop(st + len + 0.01);
    if (st + len > end) end = st + len;
  }
  return end;
}

/** Reverse swell — noise or tone ramping *up* into a hit. Transition glue. */
export function reverseSwell(k, v, t, o) {
  const ctx = k.ctx;
  const dur = o.duration ?? 1.2;
  const src = k.track(v, ctx.createBufferSource());
  src.buffer = k.noise;
  src.loop = true;
  src.playbackRate.setValueAtTime(0.4, t);
  src.playbackRate.linearRampToValueAtTime(2.2, t + dur);
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.setValueAtTime(o.f0 ?? 180, t);
  f.frequency.exponentialRampToValueAtTime(o.f1 ?? 6500, t + dur);
  f.Q.value = o.q ?? 3.5;
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.exponentialRampToValueAtTime(o.gain ?? 0.3, t + dur);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.06);
  amp.gain.setValueAtTime(0, t + dur + 0.08);
  src.connect(f); f.connect(amp); amp.connect(o.dest || v.out);
  src.start(t); src.stop(t + dur + 0.1);
  return t + dur + 0.1;
}

export default { fm, supersaw, wavetable, pluck, metal, noiseBand, subDrop, granular, reverseSwell, hit, adsr };
