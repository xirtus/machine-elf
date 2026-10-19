import {
  generateIR, generateNoise, generatePink, generatePluck,
  makeDriveCurve, makeCrushCurve, IR_PRESETS,
} from './Impulse.js';
import { makeWaveCache } from './Synth.js';
import { mulberry32 } from './Scales.js';

/**
 * The master audio graph. Built once, never rebuilt — everything after
 * construction is an AudioParam change, so nothing here allocates per frame.
 *
 *                      ┌ sfxBus ─ sfxDuck ─┐
 *   voices ────────────┤                   ├──> sum ─ glue ─ limiter ─ master ─ analyser ─ out
 *                      │ reverb / delay ───┤
 *   music ─ pitchDelay ┴ filter ─ bank ─ drive ─ crush ─ musicVol ─ musicDuck ┘
 *
 *  - `glue` is a slow compressor that makes the mix cohere under bullet-hell
 *    density; `limiter` is a fast brickwall so we never hit 0dBFS.
 *  - `pitchDelay` is a DelayNode whose delayTime is ramped to produce a real
 *    pitch shift (Doppler). Used for the hitstop pitch dip and dimension warps.
 *  - `drive`/`crush` are dry/wet parallel waveshapers; the dimension depth
 *    opens them up so the deep layers literally degrade.
 */
export class AudioGraph {
  constructor(ctx, cfg) {
    this.ctx = ctx;
    this.cfg = cfg;
    this.rnd = mulberry32(1234567);
    const C = (n) => ctx['create' + n]();

    // ── master chain ────────────────────────────────────────────────────
    this.sum = C('Gain'); this.sum.gain.value = 1;

    this.glue = ctx.createDynamicsCompressor();
    this.glue.threshold.value = -16;
    this.glue.knee.value = 14;
    this.glue.ratio.value = 4.5;
    this.glue.attack.value = 0.004;
    this.glue.release.value = 0.20;

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2.0;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.0008;
    this.limiter.release.value = 0.055;

    this.master = C('Gain');
    this.master.gain.value = cfg.master ?? 0.75;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.55;
    this._fft = new Float32Array(this.analyser.frequencyBinCount);
    this._td = new Float32Array(this.analyser.fftSize);

    this.sum.connect(this.glue);
    this.glue.connect(this.limiter);
    this.limiter.connect(this.master);
    this.master.connect(this.analyser);
    this.analyser.connect(ctx.destination);

    // ── sfx bus ─────────────────────────────────────────────────────────
    this.sfxDuck = C('Gain'); this.sfxDuck.gain.value = 1;
    this.sfxBus = C('Gain'); this.sfxBus.gain.value = cfg.sfx ?? 0.8;
    this.sfxBus.connect(this.sfxDuck);
    this.sfxDuck.connect(this.sum);

    // ── reverb: two spaces, crossfaded by dimension ─────────────────────
    this.reverbSend = C('Gain'); this.reverbSend.gain.value = 1;

    this.convMain = ctx.createConvolver(); this.convMain.normalize = false;
    this.convPlate = ctx.createConvolver(); this.convPlate.normalize = false;
    this.irCache = new Map();
    this.convMain.buffer = this._ir('hall');
    this.convPlate.buffer = this._ir('plate');

    this.toMain = C('Gain'); this.toMain.gain.value = 0.75;
    this.toPlate = C('Gain'); this.toPlate.gain.value = 0.45;
    this.reverbReturn = C('Gain'); this.reverbReturn.gain.value = 0.6;
    // keep the tail out of the sub so the boss stays clean
    this.reverbHP = ctx.createBiquadFilter();
    this.reverbHP.type = 'highpass'; this.reverbHP.frequency.value = 130;
    this.reverbLP = ctx.createBiquadFilter();
    this.reverbLP.type = 'lowpass'; this.reverbLP.frequency.value = 9000;

    this.reverbSend.connect(this.toMain); this.toMain.connect(this.convMain);
    this.reverbSend.connect(this.toPlate); this.toPlate.connect(this.convPlate);
    this.convMain.connect(this.reverbHP); this.convPlate.connect(this.reverbHP);
    this.reverbHP.connect(this.reverbLP);
    this.reverbLP.connect(this.reverbReturn);
    this.reverbReturn.connect(this.sum);

    // ── stereo delay with feedback and cross-bleed ──────────────────────
    this.delaySend = C('Gain'); this.delaySend.gain.value = 1;
    this.delayL = C('Delay'); this.delayR = C('Delay');
    this.delayL.delayTime.value = 0.28;
    this.delayR.delayTime.value = 0.42;
    this.fbL = C('Gain'); this.fbL.gain.value = 0.42;
    this.fbR = C('Gain'); this.fbR.gain.value = 0.46;
    this.dampL = ctx.createBiquadFilter();
    this.dampR = ctx.createBiquadFilter();
    this.dampL.type = this.dampR.type = 'lowpass';
    this.dampL.frequency.value = 3200; this.dampR.frequency.value = 2600;
    this.dampHP = ctx.createBiquadFilter();
    this.dampHP.type = 'highpass'; this.dampHP.frequency.value = 220;
    this.panL = ctx.createStereoPanner ? ctx.createStereoPanner() : C('Gain');
    this.panR = ctx.createStereoPanner ? ctx.createStereoPanner() : C('Gain');
    if (this.panL.pan) { this.panL.pan.value = -0.75; this.panR.pan.value = 0.75; }
    this.delayReturn = C('Gain'); this.delayReturn.gain.value = 0.5;

    this.delaySend.connect(this.dampHP);
    this.dampHP.connect(this.delayL); this.dampHP.connect(this.delayR);
    // ping-pong: each side feeds the other through its damping filter
    this.delayL.connect(this.dampL); this.dampL.connect(this.fbL); this.fbL.connect(this.delayR);
    this.delayR.connect(this.dampR); this.dampR.connect(this.fbR); this.fbR.connect(this.delayL);
    this.delayL.connect(this.panL); this.delayR.connect(this.panR);
    this.panL.connect(this.delayReturn); this.panR.connect(this.delayReturn);
    this.delayReturn.connect(this.sum);

    // ── music chain ─────────────────────────────────────────────────────
    this.musicIn = C('Gain'); this.musicIn.gain.value = 1;

    // Doppler pitch shifter: ramping delayTime *is* a pitch shift.
    this.pitchDelay = C('Delay');
    this.pitchBase = 0.045;
    this.pitchDelay.delayTime.value = this.pitchBase;

    this.musicFilter = ctx.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = 1400;
    this.musicFilter.Q.value = 0.8;

    this.musicHP = ctx.createBiquadFilter();
    this.musicHP.type = 'highpass';
    this.musicHP.frequency.value = 26;

    // resonant filter bank — three parallel peaks, mixed under the dry signal
    this.bankIn = C('Gain');
    this.bankDry = C('Gain'); this.bankDry.gain.value = 1;
    this.bankOut = C('Gain');
    this.bands = [];
    const bandF = [180, 720, 2600];
    for (let i = 0; i < 3; i++) {
      const f = ctx.createBiquadFilter();
      f.type = 'peaking'; f.frequency.value = bandF[i]; f.Q.value = 1.1; f.gain.value = 0;
      this.bankIn.connect(f); f.connect(this.bankOut);
      this.bands.push(f);
    }
    this.bankIn.connect(this.bankDry); this.bankDry.connect(this.bankOut);
    // peaking filters in parallel with dry would double the level; scale down
    this.bankDry.gain.value = 1;
    for (const f of this.bands) f.gain.value = 0;

    // parallel drive
    this.driveIn = C('Gain');
    this.driveShaper = ctx.createWaveShaper();
    this.driveShaper.curve = makeDriveCurve(0.6);
    this.driveShaper.oversample = '2x';
    this.driveWet = C('Gain'); this.driveWet.gain.value = 0;
    this.driveDry = C('Gain'); this.driveDry.gain.value = 1;
    this.driveOut = C('Gain');
    this.driveIn.connect(this.driveShaper); this.driveShaper.connect(this.driveWet);
    this.driveWet.connect(this.driveOut);
    this.driveIn.connect(this.driveDry); this.driveDry.connect(this.driveOut);

    // parallel bitcrush: staircase waveshaper (bit depth) + ring-mod (rate)
    this.crushIn = C('Gain');
    this.crushShaper = ctx.createWaveShaper();
    this.crushShaper.curve = makeCrushCurve(5);
    this.crushRing = C('Gain'); this.crushRing.gain.value = 1;
    this.crushOsc = ctx.createOscillator();
    this.crushOsc.type = 'square';
    this.crushOsc.frequency.value = 5200;
    this.crushDepth = C('Gain'); this.crushDepth.gain.value = 0;
    this.crushOsc.connect(this.crushDepth); this.crushDepth.connect(this.crushRing.gain);
    this.crushWet = C('Gain'); this.crushWet.gain.value = 0;
    this.crushDry = C('Gain'); this.crushDry.gain.value = 1;
    this.crushOut = C('Gain');
    this.crushIn.connect(this.crushShaper); this.crushShaper.connect(this.crushRing);
    this.crushRing.connect(this.crushWet); this.crushWet.connect(this.crushOut);
    this.crushIn.connect(this.crushDry); this.crushDry.connect(this.crushOut);

    // chorus — two modulated delays panned apart
    this.chorusIn = C('Gain');
    this.chorusOut = C('Gain');
    this.chorusDry = C('Gain'); this.chorusDry.gain.value = 1;
    this.chorusWet = C('Gain'); this.chorusWet.gain.value = 0.0;
    this.chorusIn.connect(this.chorusDry); this.chorusDry.connect(this.chorusOut);
    this._chorusLfos = [];
    const cd = [0.011, 0.017];
    for (let i = 0; i < 2; i++) {
      const d = C('Delay'); d.delayTime.value = cd[i];
      const lfo = ctx.createOscillator();
      lfo.type = 'sine'; lfo.frequency.value = 0.19 + i * 0.13;
      const lg = C('Gain'); lg.gain.value = 0.0035;
      lfo.connect(lg); lg.connect(d.delayTime);
      const p = ctx.createStereoPanner ? ctx.createStereoPanner() : C('Gain');
      if (p.pan) p.pan.value = i ? 0.8 : -0.8;
      this.chorusIn.connect(d); d.connect(p); p.connect(this.chorusWet);
      this._chorusLfos.push(lfo);
    }
    this.chorusWet.connect(this.chorusOut);

    this.musicVol = C('Gain'); this.musicVol.gain.value = cfg.music ?? 0.55;
    this.musicDuck = C('Gain'); this.musicDuck.gain.value = 1;

    this.musicReverbSend = C('Gain'); this.musicReverbSend.gain.value = 0.30;
    this.musicDelaySend = C('Gain'); this.musicDelaySend.gain.value = 0.22;

    this.musicIn.connect(this.pitchDelay);
    this.pitchDelay.connect(this.musicHP);
    this.musicHP.connect(this.musicFilter);
    this.musicFilter.connect(this.bankIn);
    this.bankOut.connect(this.driveIn);
    this.driveOut.connect(this.crushIn);
    this.crushOut.connect(this.chorusIn);
    this.chorusOut.connect(this.musicVol);
    this.musicVol.connect(this.musicDuck);
    this.musicDuck.connect(this.sum);
    this.musicVol.connect(this.musicReverbSend); this.musicReverbSend.connect(this.reverbSend);
    this.musicVol.connect(this.musicDelaySend); this.musicDelaySend.connect(this.delaySend);

    // ── shared buffers / tables ─────────────────────────────────────────
    this.noise = generateNoise(ctx, 2.0, 7);
    this.pink = generatePink(ctx, 3.0, 11);
    this.pluckFreq = 110;
    this.pluckBuf = generatePluck(ctx, this.pluckFreq, { seconds: 2.2, damp: 0.35, decay: 0.4, bright: 0.75, seed: 991 });
    this.pluckDarkBuf = generatePluck(ctx, this.pluckFreq, { seconds: 2.6, damp: 0.82, decay: 0.7, bright: 0.2, seed: 313 });
    this.driveCurve = makeDriveCurve(0.85);
    this.waveCache = makeWaveCache(ctx);

    this._started = false;
    this._dip = { until: 0 };
  }

  _ir(name) {
    let b = this.irCache.get(name);
    if (!b) { b = generateIR(this.ctx, IR_PRESETS[name]); this.irCache.set(name, b); }
    return b;
  }

  /** Start the always-on modulators. Safe to call more than once. */
  start(t) {
    if (this._started) return;
    this._started = true;
    const at = t ?? this.ctx.currentTime;
    try {
      this.crushOsc.start(at);
      for (const l of this._chorusLfos) l.start(at);
    } catch (e) { /* already started */ }
  }

  /* ── mixing controls ─────────────────────────────────────────────────── */

  setVolume(kind, v, ramp = 0.05) {
    const t = this.ctx.currentTime;
    const node = kind === 'master' ? this.master : kind === 'music' ? this.musicVol : this.sfxBus;
    node.gain.cancelScheduledValues(t);
    node.gain.setTargetAtTime(Math.max(0, v), t, ramp);
  }

  /** Duck the music under a big impact. amount 0..1 = depth of the dip. */
  duckMusic(amount = 0.55, attack = 0.012, hold = 0.06, release = 0.28) {
    const t = this.ctx.currentTime;
    const g = this.musicDuck.gain;
    const floor = Math.max(0.02, 1 - amount);
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(floor, t + attack);
    g.setValueAtTime(floor, t + attack + hold);
    g.setTargetAtTime(1, t + attack + hold, release / 3);
  }

  /** Duck everything else — for the player getting hit. */
  duckAll(amount = 0.7, attack = 0.008, hold = 0.09, release = 0.4) {
    const t = this.ctx.currentTime;
    const floor = Math.max(0.05, 1 - amount);
    for (const g of [this.musicDuck.gain, this.sfxDuck.gain]) {
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(floor, t + attack);
      g.setValueAtTime(floor, t + attack + hold);
      g.setTargetAtTime(1, t + attack + hold, release / 3);
    }
  }

  /**
   * Doppler pitch shift on the music bus. Negative cents = dip.
   * A DelayNode whose delayTime ramps linearly shifts pitch by
   * (1 - d(delay)/dt); so we solve for the delay excursion.
   */
  pitchShift(cents, duration, release = null) {
    const t = this.ctx.currentTime;
    const rel = release ?? duration * 4.5;
    const ratio = Math.pow(2, cents / 1200);
    const excursion = (1 - ratio) * duration;   // seconds of delay change
    const target = Math.min(0.32, Math.max(0.001, this.pitchBase + excursion));
    const p = this.pitchDelay.delayTime;
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.linearRampToValueAtTime(target, t + duration);
    p.linearRampToValueAtTime(this.pitchBase, t + duration + rel);
    this._dip.until = t + duration + rel;
  }

  /** Music low-pass position — the main "intensity" gesture. */
  setMusicCutoff(hz, ramp = 0.4) {
    const t = this.ctx.currentTime;
    const f = this.musicFilter.frequency;
    f.cancelScheduledValues(t);
    f.setTargetAtTime(Math.max(60, Math.min(20000, hz)), t, ramp / 3);
  }

  /** Scheduled filter sweep on a musical boundary. */
  sweepCutoff(from, to, at, duration) {
    const f = this.musicFilter.frequency;
    f.cancelScheduledValues(at);
    f.setValueAtTime(Math.max(60, from), at);
    f.exponentialRampToValueAtTime(Math.max(60, to), at + duration);
  }

  /**
   * Dimension colour. depth 0..1 — how far from euclidean sanity we are.
   * Opens up distortion, bitcrush, chorus and swaps the reverb space.
   */
  setDimensionColour(depth, opts = {}) {
    const t = this.ctx.currentTime;
    const d = Math.max(0, Math.min(1, depth));
    const set = (p, v, tau = 0.4) => { p.cancelScheduledValues(t); p.setTargetAtTime(v, t, tau); };

    set(this.driveWet.gain, Math.pow(d, 1.4) * 0.55);
    set(this.driveDry.gain, 1 - Math.pow(d, 1.4) * 0.35);
    set(this.crushWet.gain, Math.max(0, d - 0.45) * 1.5 * 0.5);
    set(this.crushDry.gain, 1 - Math.max(0, d - 0.45) * 0.6);
    set(this.crushDepth.gain, Math.max(0, d - 0.55) * 0.7);
    this.crushOsc.frequency.setTargetAtTime(6800 - d * 4200, t, 0.6);
    set(this.chorusWet.gain, 0.12 + d * 0.42);
    set(this.chorusDry.gain, 1 - d * 0.18);

    // filter bank: resonances climb as space stops behaving
    this.bands[0].gain.setTargetAtTime(-2 + d * 5, t, 0.5);
    this.bands[1].gain.setTargetAtTime(d * 6.5, t, 0.5);
    this.bands[2].gain.setTargetAtTime(-1 + d * 4, t, 0.5);
    this.bands[1].Q.setTargetAtTime(1.1 + d * 5, t, 0.5);

    // reverb space
    const irName = opts.ir || (d > 0.66 ? 'voidspace' : d > 0.3 ? 'cathedral' : 'hall');
    this.setReverbSpace(irName, opts.plateMix ?? (0.5 - d * 0.32));
    set(this.reverbReturn.gain, 0.5 + d * 0.35, 0.5);

    // delay times track the dimension so echoes stay musical
    if (opts.beat) {
      this.delayL.delayTime.setTargetAtTime(opts.beat * 0.75, t, 0.3);
      this.delayR.delayTime.setTargetAtTime(opts.beat * 1.5, t, 0.3);
    }
    set(this.fbL.gain, 0.36 + d * 0.22, 0.4);
    set(this.fbR.gain, 0.40 + d * 0.22, 0.4);
  }

  /** Swap the convolver IR without a click (duck the return across the swap). */
  setReverbSpace(name, plateMix = 0.35) {
    if (this._irName === name) {
      this.toPlate.gain.setTargetAtTime(plateMix, this.ctx.currentTime, 0.3);
      return;
    }
    this._irName = name;
    const t = this.ctx.currentTime;
    const g = this.reverbReturn.gain;
    const cur = g.value;
    g.cancelScheduledValues(t);
    g.setValueAtTime(cur, t);
    g.linearRampToValueAtTime(0.0001, t + 0.09);
    const buf = this._ir(name);
    // swap just after the fade lands
    const swap = () => { try { this.convMain.buffer = buf; } catch (e) { /* noop */ } };
    if (typeof setTimeout === 'function') setTimeout(swap, 110); else swap();
    g.linearRampToValueAtTime(cur, t + 0.42);
    this.toPlate.gain.setTargetAtTime(plateMix, t, 0.3);
  }

  /** Set the delay's musical division from the current tempo. */
  setDelayTempo(secondsPerBeat) {
    const t = this.ctx.currentTime;
    this.delayL.delayTime.setTargetAtTime(Math.min(1.4, secondsPerBeat * 0.75), t, 0.25);
    this.delayR.delayTime.setTargetAtTime(Math.min(1.9, secondsPerBeat * 1.5), t, 0.25);
  }

  /* ── analysis (for verification + reactive visuals) ───────────────────── */

  /** Peak + RMS of the final output, in linear units. Allocation-free. */
  levels() {
    const a = this.analyser;
    if (!a) return { rms: 0, peak: 0 };
    a.getFloatTimeDomainData(this._td);
    let s = 0, p = 0;
    for (let i = 0; i < this._td.length; i++) {
      const x = this._td[i];
      s += x * x;
      const ax = x < 0 ? -x : x;
      if (ax > p) p = ax;
    }
    return { rms: Math.sqrt(s / this._td.length), peak: p };
  }

  /** Coarse 4-band energy: sub / low / mid / high, normalised 0..1. */
  bandsEnergy(out) {
    const a = this.analyser;
    a.getFloatFrequencyData(this._fft);
    const n = this._fft.length;
    const nyq = this.ctx.sampleRate / 2;
    const edges = [0, 120, 600, 3000, nyq];
    const res = out || [0, 0, 0, 0];
    for (let b = 0; b < 4; b++) {
      const i0 = Math.floor((edges[b] / nyq) * n);
      const i1 = Math.max(i0 + 1, Math.floor((edges[b + 1] / nyq) * n));
      let acc = 0;
      for (let i = i0; i < i1 && i < n; i++) acc += Math.pow(10, this._fft[i] / 20);
      res[b] = Math.min(1, (acc / (i1 - i0)) * 6);
    }
    return res;
  }

  dispose() {
    try { this.crushOsc.stop(); } catch (e) { /* noop */ }
    for (const l of this._chorusLfos) { try { l.stop(); } catch (e) { /* noop */ } }
    try { this.analyser.disconnect(); this.master.disconnect(); } catch (e) { /* noop */ }
  }
}

export default AudioGraph;
