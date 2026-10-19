import * as THREE from 'three';
import Bus from '../core/Bus.js';
import CFG from '../core/Config.js';
import AudioGraph from './Graph.js';
import VoicePool from './Voices.js';
import { fm, supersaw, wavetable, pluck, metal, noiseBand, hit } from './Synth.js';
import { SCALES, degreeToFreq, midiToFreq, snapFreq, mulberry32 } from './Scales.js';

/**
 * AUDIO — the adaptive score and every sound the world makes.
 *
 * MUSIC: a lookahead scheduler on a 16th-note grid. Each dimension has a
 * root note (descending) and a scale (dorian → phrygian → whole-tone →
 * octatonic → messiaen mode 3 → alien) so the harmony literally loses its
 * floor as you descend. Layers gate in with combat intensity: sub pulse,
 * Karplus bass, glass arp, clockwork hats, and a pad that breathes the
 * current chord. Bosses get toms and an alarm fifth.
 *
 * SFX: a cue table over the voice pool, wired to bus events. Everything
 * positional is panned/attenuated relative to the camera. Hitstop dips the
 * music pitch. Dimension shifts pitch-ramp the whole mix.
 */

const DIMS = [
  { root: 50, scale: 'dorian', bpm: 96 },
  { root: 47, scale: 'phrygian', bpm: 102 },
  { root: 45, scale: 'wholeTone', bpm: 108 },
  { root: 43, scale: 'octatonic', bpm: 114 },
  { root: 41, scale: 'mode3', bpm: 122 },
  { root: 38, scale: 'alien', bpm: 132 },
];

const _v = new THREE.Vector3();

export class Audio {
  constructor() {
    this.name = 'audio';
    this.order = 70;
    this.ready = false;
    this.intensity = 0.25;
    this.dimension = 0;
    this._unsub = [];
  }

  async init(ctx) {
    this._ctx = ctx;
    const unlock = () => {
      if (this.ready) return;
      this._boot();
    };
    window.addEventListener('pointerdown', unlock, { once: false });
    window.addEventListener('keydown', unlock, { once: false });
    this._unlock = unlock;
  }

  _boot() {
    if (this.ready) return;
    this.ready = true;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctxA = new AC({ latencyHint: 'interactive' });
    this.ctxA.resume();
    this.graph = new AudioGraph(this.ctxA, CFG.audio);
    this.graph.start();
    this.pool = new VoicePool(this.ctxA, {
      dry: this.graph.sfxBus,
      reverb: this.graph.reverbSend,
      delay: this.graph.delaySend,
    }, { max: 42 });
    this.K = {
      ctx: this.ctxA,
      rnd: this.graph.rnd,
      noise: this.graph.noise,
      pink: this.graph.pink,
      pluck: this.graph.pluckBuf,
      pluckDark: this.graph.pluckDarkBuf,
      pluckFreq: this.graph.pluckFreq,
      wave: this.graph.waveCache,
      track: (v, n) => this.pool.track(v, n),
    };

    /* cue throttling rules — the mix survives bullet-hell density */
    this.pool.setRule('weapon:pulse', 0.045, 5);
    this.pool.setRule('weapon:lock', 0.03, 8);
    this.pool.setRule('weapon:hit', 0.05, 6);
    this.pool.setRule('enemy:fire', 0.06, 6);
    this.pool.setRule('graze', 0.05, 4);
    this.pool.setRule('enemy:killed', 0.07, 4);

    /* sequencer state */
    this._step = 0;
    this._nextT = this.ctxA.currentTime + 0.1;
    this._chordBar = 0;

    this._wire();
    this.graph.setDimensionColour(0, { beat: 60 / DIMS[0].bpm });
    Bus.emit('audio:ready', {});
  }

  _wire() {
    const on = (n, f) => this._unsub.push(Bus.on(n, f));
    on('weapon:lockAdd', (d) => this.cue('lock', { n: d?.count ?? 1 }));
    on('weapon:fire', (d) => this.cue('salvo', { n: d?.count ?? 1 }));
    on('weapon:pulse', (d) => this.cue('pulse', { position: d?.position }));
    on('weapon:hit', (d) => this.cue('hit', { position: d?.position, killed: d?.killed }));
    on('enemy:killed', (d) => this.cue('kill', { position: d?.position, big: d?.bossCore || (d?.enemy?.def?.hp ?? 1) > 4 }));
    on('enemy:fire', () => this.cue('enemyFire', {}));
    on('graze:chain', (d) => this.cue('graze', { chain: d?.chain ?? 1 }));
    on('graze:charged', () => this.cue('charged', {}));
    on('player:hit', () => this.cue('playerHit', {}));
    on('player:dead', () => this.cue('playerDead', {}));
    on('player:bomb', () => this.cue('bomb', {}));
    on('player:boost', (d) => this.cue(d?.on ? 'boostOn' : 'boostOff', {}));
    on('boss:spawn', () => this.cue('bossSpawn', {}));
    on('boss:phase', () => this.cue('bossPhase', {}));
    on('boss:dead', () => this.cue('bossDead', {}));
    on('boss:pattern', () => this.cue('bossPattern', {}));
    on('audio:cue', (d) => { if (d?.id) this.cue(d.id, d.opts || d); });
    on('dimension:shiftStart', () => this.cue('shiftStart', {}));
    on('dimension:enter', (d) => this.cue('dimensionEnter', { index: d?.index ?? 0 }));
    on('game:state', (d) => {
      if (d?.state === 'run') this.cue('runStart', {});
      if (d?.state === 'gameover') this.cue('gameover', {});
    });
    on('music:intensity', (d) => {
      this.intensity += ((d?.value ?? 0.3) - this.intensity) * 0.4;
      this._boss = d?.state === 'boss';
    });
    on('dimension:enter', (d) => {
      this.dimension = (d?.index ?? 0) % DIMS.length;
      if (this.graph) {
        const dim = DIMS[this.dimension];
        this.graph.setDimensionColour(this.dimension / (DIMS.length - 1), { beat: 60 / dim.bpm });
      }
    });
  }

  /** Position a voice in camera space so panners do something true. */
  _place(v, worldPos) {
    if (!worldPos) return;
    const cam = this._ctx.camera;
    _v.copy(worldPos).sub(cam.position);
    // camera-space: rotate into view frame
    _v.applyQuaternion(cam.getWorldQuaternion(_q).invert());
    this.pool.place(v, _v.x, _v.y, _v.z);
  }

  /* ── the cue table ───────────────────────────────────────────────────── */
  cue(id, opts = {}) {
    if (!this.ready) return;
    const ctxA = this.ctxA;
    const t = ctxA.currentTime;
    const K = this.K;
    const dim = DIMS[this.dimension];
    const scale = SCALES[dim.scale];
    const root = dim.root;

    const V = (cid, pri, dur) => this.pool.alloc(cid, pri, t, dur);

    switch (id) {
      case 'lock': {
        const v = V('weapon:lock', 2, 0.1);
        if (!v) return;
        const f = degreeToFreq(root + 24, scale, 2 + (opts.n ?? 1), 0.2);
        wavetable(K, v, t, { freq: f, wave: 'tick', gain: 0.16, decay: 0.05, cutoff: 8000 });
        this.pool.send(v, 0.1, 0.3);
        break;
      }
      case 'salvo': {
        const n = opts.n ?? 1;
        for (let i = 0; i < Math.min(n, 8); i++) {
          const v = V('weapon:fire', 3, 0.3);
          if (!v) continue;
          const at = t + i * CFG.weapons.salvoDelay;
          fm(K, v, at, {
            freq: 880 - i * 60, freqEnd: 220, ratio: 2.02, index: 6,
            decay: 0.22, gain: 0.20, carrierType: 'sawtooth',
          });
          noiseBand(K, v, at, { f0: 2400, f1: 500, decay: 0.16, gain: 0.07, q: 1.6 });
          this.pool.send(v, 0.15, 0.35);
        }
        break;
      }
      case 'pulse': {
        const v = V('weapon:pulse', 2, 0.15);
        if (!v) return;
        fm(K, v, t, { freq: 620, freqEnd: 190, ratio: 3.01, index: 3.4, decay: 0.1, gain: 0.13 });
        if (opts.position) this._place(v, opts.position);
        break;
      }
      case 'hit': {
        const v = V('weapon:hit', 3, 0.2);
        if (!v) return;
        metal(K, v, t, { freq: 1900 + this.graph.rnd() * 700, table: 'glass', partials: 3, decay: 0.14, gain: 0.12 });
        if (opts.position) this._place(v, opts.position);
        if (opts.killed) this.pool.send(v, 0.3, 0.2);
        break;
      }
      case 'kill': {
        const v = V('enemy:killed', 5, 0.9);
        if (!v) return;
        const g = opts.big ? 0.5 : 0.3;
        metal(K, v, t, { freq: opts.big ? 500 : 950, table: 'glass', partials: 6, decay: opts.big ? 1.1 : 0.6, gain: g, stagger: 0.008 });
        noiseBand(K, v, t, { f0: 3400, f1: 700, decay: 0.3, gain: g * 0.5, q: 0.9 });
        fm(K, v, t, { freq: 130, freqEnd: 46, ratio: 1.01, index: 1.2, decay: 0.5, gain: g * 1.1 });
        if (opts.position) this._place(v, opts.position);
        this.pool.send(v, 0.4, 0.15);
        if (opts.big) this.graph.duckMusic(0.4, 0.01, 0.08, 0.5);
        break;
      }
      case 'enemyFire': {
        const v = V('enemy:fire', 1, 0.2);
        if (!v) return;
        fm(K, v, t, { freq: 240, freqEnd: 420, ratio: 1.5, index: 2.2, decay: 0.12, gain: 0.07 });
        break;
      }
      case 'graze': {
        const v = V('graze', 3, 0.3);
        if (!v) return;
        const f = degreeToFreq(root + 36, scale, Math.min(11, 3 + (opts.chain ?? 0) / 3), 0.35);
        wavetable(K, v, t, { freq: f, wave: 'glass', gain: 0.12, decay: 0.22, cutoff: 9000 });
        noiseBand(K, v, t, { f0: 5200, f1: 8600, decay: 0.12, gain: 0.05, q: 3 });
        this.pool.send(v, 0.35, 0.4);
        break;
      }
      case 'charged': {
        const v = V('ui', 6, 1.2);
        if (!v) return;
        for (let i = 0; i < 4; i++) {
          wavetable(K, v, t + i * 0.07, {
            freq: degreeToFreq(root + 24, scale, i * 2, 0.1), wave: 'glass',
            gain: 0.16, decay: 0.5,
          });
        }
        this.pool.send(v, 0.5, 0.3);
        break;
      }
      case 'playerHit': {
        const v = V('player:hit', 9, 1.0);
        if (!v) return;
        fm(K, v, t, { freq: 90, freqEnd: 32, ratio: 0.51, index: 5, decay: 0.7, gain: 0.65 });
        metal(K, v, t, { freq: 700, table: 'bell', partials: 5, decay: 0.5, gain: 0.3, bend: 0.6 });
        noiseBand(K, v, t, { f0: 900, f1: 120, decay: 0.5, gain: 0.3, q: 0.7 });
        this.graph.duckAll(0.75);
        this.graph.pitchShift(-380, 0.09, 0.5);
        this.pool.send(v, 0.5, 0.1);
        break;
      }
      case 'playerDead': {
        const v = V('player:dead', 10, 2.4);
        if (!v) return;
        metal(K, v, t, { freq: 340, table: 'glass', partials: 7, decay: 2.0, gain: 0.5, stagger: 0.03 });
        fm(K, v, t, { freq: 60, freqEnd: 24, ratio: 0.5, index: 8, decay: 1.8, gain: 0.6 });
        this.graph.pitchShift(-900, 0.5, 1.8);
        this.graph.duckAll(0.5, 0.02, 0.4, 1.4);
        this.pool.send(v, 0.7, 0.2);
        break;
      }
      case 'bomb': {
        const v = V('bomb', 9, 2.0);
        if (!v) return;
        fm(K, v, t, { freq: 55, freqEnd: 20, ratio: 0.5, index: 10, decay: 1.6, gain: 0.8 });
        noiseBand(K, v, t, { f0: 4000, f1: 200, decay: 1.4, gain: 0.4, q: 0.5 });
        metal(K, v, t + 0.05, { freq: 1200, table: 'glass', partials: 7, decay: 1.2, gain: 0.3 });
        this.graph.duckMusic(0.6, 0.01, 0.2, 0.9);
        this.pool.send(v, 0.6, 0.1);
        break;
      }
      case 'boostOn': {
        const v = V('boost', 4, 0.8);
        if (!v) return;
        noiseBand(K, v, t, { f0: 300, f1: 3400, decay: 0.6, sweepTime: 0.5, gain: 0.16, q: 1.8, attack: 0.08 });
        this.pool.send(v, 0.2, 0.3);
        break;
      }
      case 'boostOff': {
        const v = V('boost', 4, 0.5);
        if (!v) return;
        noiseBand(K, v, t, { f0: 2600, f1: 500, decay: 0.35, gain: 0.08, q: 1.4 });
        break;
      }
      case 'bossSpawn': {
        const v = V('boss', 10, 4);
        if (!v) return;
        supersaw(K, v, t, {
          freq: midiToFreq(root - 12), voices: 6, detune: 26, cutoff: 300,
          cutoffEnd: 2400, cutoffTime: 2.6, gain: 0.4, attack: 1.8, hold: 1.4, release: 1.6,
        });
        fm(K, v, t, { freq: 38, freqEnd: 30, ratio: 0.5, index: 3, decay: 3.2, gain: 0.5, attack: 1.2 });
        this.pool.send(v, 0.65, 0.2);
        break;
      }
      case 'bossPhase': {
        const v = V('boss', 8, 1.2);
        if (!v) return;
        wavetable(K, v, t, { freq: midiToFreq(root + 6), wave: 'voice', gain: 0.3, decay: 0.8, cutoff: 2200 });
        wavetable(K, v, t + 0.12, { freq: midiToFreq(root + 6 + 6), wave: 'voice', gain: 0.24, decay: 0.7, cutoff: 2600 });
        this.pool.send(v, 0.5, 0.4);
        break;
      }
      case 'bossPattern': {
        const v = V('boss:pattern', 2, 0.4);
        if (!v) return;
        fm(K, v, t, { freq: 180, freqEnd: 90, ratio: 2.0, index: 2, decay: 0.3, gain: 0.1 });
        break;
      }
      case 'bossDead': {
        const v = V('boss', 10, 4);
        if (!v) return;
        metal(K, v, t, { freq: 240, table: 'glass', partials: 7, decay: 2.6, gain: 0.6, stagger: 0.05 });
        fm(K, v, t, { freq: 48, freqEnd: 19, ratio: 0.5, index: 9, decay: 3.0, gain: 0.7 });
        noiseBand(K, v, t, { f0: 5000, f1: 150, decay: 2.2, gain: 0.35, q: 0.5 });
        this.graph.pitchShift(-500, 0.7, 2.2);
        this.graph.duckMusic(0.55, 0.02, 0.5, 1.6);
        this.pool.send(v, 0.8, 0.3);
        break;
      }
      case 'shiftStart': {
        const v = V('shift', 9, 3.6);
        if (!v) return;
        noiseBand(K, v, t, { f0: 200, f1: 6800, decay: 3.0, sweepTime: 2.9, gain: 0.3, q: 2.2, attack: 1.4 });
        supersaw(K, v, t, {
          freq: midiToFreq(root), voices: 5, detune: 40, cutoff: 500,
          cutoffEnd: 6000, cutoffTime: 3.0, gain: 0.25, attack: 2.2, hold: 0.8, release: 1.2,
        });
        this.graph.pitchShift(700, 3.0, 1.4);
        this.pool.send(v, 0.7, 0.4);
        break;
      }
      case 'dimensionEnter': {
        const v = V('shift', 8, 3);
        if (!v) return;
        const dim2 = DIMS[(opts.index ?? 0) % DIMS.length];
        const sc = SCALES[dim2.scale];
        for (let i = 0; i < 5; i++) {
          pluck(K, v, t + i * 0.16, {
            freq: degreeToFreq(dim2.root + 12, sc, [0, 2, 4, 1, 3][i], 0.25),
            gain: 0.2, decay: 1.4,
          });
        }
        this.pool.send(v, 0.6, 0.45);
        break;
      }
      case 'gate:pass': {
        const v = V('ui', 5, 0.8);
        if (!v) return;
        for (let i = 0; i < 3; i++) {
          wavetable(K, v, t + i * 0.05, {
            freq: degreeToFreq(root + 24, scale, i * 2 + 1, 0.1), wave: 'glass',
            gain: 0.18, decay: 0.4,
          });
        }
        noiseBand(K, v, t, { f0: 3000, f1: 7000, decay: 0.3, gain: 0.08, q: 2.5 });
        this.pool.send(v, 0.4, 0.4);
        break;
      }
      case 'runStart': {
        this._step = 0;
        this._nextT = this.ctxA.currentTime + 0.15;
        break;
      }
      case 'gameover': {
        const v = V('ui', 8, 3);
        if (!v) return;
        supersaw(K, v, t, {
          freq: midiToFreq(root - 6), voices: 5, detune: 18, cutoff: 900,
          gain: 0.3, attack: 1.2, hold: 1.2, release: 2.4, wave: 'hollow',
        });
        this.pool.send(v, 0.6, 0.3);
        break;
      }
    }
  }

  /* ── the generative score ────────────────────────────────────────────── */
  _schedule() {
    const ctxA = this.ctxA;
    const dim = DIMS[this.dimension];
    const spb = 60 / dim.bpm / 4;              // 16th note
    const scale = SCALES[dim.scale];
    const root = dim.root;
    const rnd = this._musicRnd || (this._musicRnd = mulberry32(999));

    while (this._nextT < ctxA.currentTime + 0.18) {
      const t = this._nextT;
      const s = this._step;
      const bar = Math.floor(s / 16);
      const beat16 = s % 16;
      const I = this.intensity;
      const boss = this._boss;

      /* sub pulse — the floor of the world */
      if (I > 0.12 && beat16 % 4 === 0) {
        const v = this.pool.alloc('mus:sub', 1, spb * 4, );
        if (v) {
          fm(this.K, v, t, {
            freq: midiToFreq(root - 12 + (beat16 === 8 ? -2 : 0)),
            ratio: 0.5, index: 1.4, decay: spb * 3.4, gain: 0.34 + I * 0.1,
          });
          v.flat.gain.value = 1;   // music voices stay centred
        }
      }

      /* clockwork hats — quantised ticks, slightly swung */
      if (I > 0.4 && beat16 % 2 === 1) {
        const v = this.pool.alloc('mus:hat', 0, 0.06);
        if (v) {
          wavetable(this.K, v, t + (beat16 % 4 === 3 ? spb * 0.12 : 0), {
            freq: 6800 + rnd() * 1600, wave: 'tick', gain: 0.05 + I * 0.05, decay: 0.035, cutoff: 11000,
          });
        }
      }

      /* bass pluck on a walking degree */
      if (I > 0.25 && (beat16 === 0 || beat16 === 7 || beat16 === 10 || (boss && beat16 === 12))) {
        const v = this.pool.alloc('mus:bass', 1, spb * 3);
        if (v) {
          const deg = [0, 0, 3, 2, 0, 4, 3, 1][(bar * 3 + beat16) % 8];
          pluck(this.K, v, t, {
            freq: degreeToFreq(root, scale, deg, 0.15),
            gain: 0.26, decay: spb * 5, dark: this.dimension >= 3,
          });
        }
      }

      /* glass arp — degree walk with dimension-flavoured leaps */
      if (I > 0.45 && beat16 % 2 === 0) {
        const v = this.pool.alloc('mus:arp', 0, 0.4);
        if (v) {
          const walk = [0, 4, 2, 6, 1, 5, 3, 7][Math.floor(rnd() * 8)] + (boss ? 7 : 0);
          wavetable(this.K, v, t, {
            freq: degreeToFreq(root + 12, scale, walk, this.dimension * 0.14),
            wave: this.dimension >= 2 ? 'voice' : 'glass',
            gain: 0.10 + I * 0.08, decay: spb * 2.2, cutoff: 7000,
          });
          this.pool.send(v, 0.3, 0.4);
        }
      }

      /* the pad — one chord per two bars, breathing */
      if (beat16 === 0 && bar % 2 === 0) {
        const v = this.pool.alloc('mus:pad', 2, spb * 32);
        if (v) {
          const degs = this.dimension >= 2 ? [0, 2, 5] : [0, 2, 4];
          for (let i = 0; i < degs.length; i++) {
            supersaw(this.K, v, t + i * 0.09, {
              freq: degreeToFreq(root, scale, degs[i], this.dimension * 0.1),
              voices: 4, detune: 10 + this.dimension * 5,
              cutoff: 700 + I * 900 + this.dimension * 160,
              gain: 0.11, attack: spb * 8, hold: spb * 16, release: spb * 10,
              wave: this.dimension >= 4 ? 'voice' : undefined,
              drift: 3 + this.dimension * 2,
            });
          }
          this.pool.send(v, 0.45, 0.25);
        }
      }

      /* boss toms + alarm */
      if (boss) {
        if (beat16 === 4 || beat16 === 12) {
          const v = this.pool.alloc('mus:tom', 2, 0.3);
          if (v) fm(this.K, v, t, { freq: 96, freqEnd: 55, ratio: 1.02, index: 1.6, decay: 0.22, gain: 0.3 });
        }
        if (beat16 === 0 && bar % 4 === 2) {
          const v = this.pool.alloc('mus:alarm', 2, 1.2);
          if (v) {
            wavetable(this.K, v, t, { freq: degreeToFreq(root + 12, scale, 1, 0.3), wave: 'voice', gain: 0.12, decay: 0.9, cutoff: 3000 });
            this.pool.send(v, 0.4, 0.5);
          }
        }
      }

      /* music filter tracks intensity */
      if (beat16 === 0) {
        this.graph.setMusicCutoff(500 + I * 4200, spb * 12);
      }

      this._nextT += spb;
      this._step++;
    }
    this.pool.reap(ctxA.currentTime);
  }

  update(dt) {
    if (!this.ready) return;
    if (this.ctxA.state === 'suspended') this.ctxA.resume();
    this._schedule();
  }

  dispose() {
    for (const u of this._unsub) u();
    this.graph?.dispose();
    this.ctxA?.close();
  }
}

const _q = new THREE.Quaternion();

export default Audio;
