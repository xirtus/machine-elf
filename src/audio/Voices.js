/**
 * Voice pool with a hard cap, age/priority stealing and per-cue throttling.
 *
 * A bullet-hell can ask for two hundred sounds a second. Without a cap, the
 * WebAudio graph grows unbounded, the render thread misses its deadline and the
 * whole context crackles and eventually dies. So:
 *
 *   - A fixed number of *slots* is allocated up front. Each slot owns a
 *     permanent node chain (gain -> panner/flat -> dry/reverb/delay sends).
 *     Nothing in this file allocates nodes after construction.
 *   - Source nodes (oscillators / buffer sources) are created per note — they
 *     have to be, WebAudio one-shots are single-use — but they are *tracked*
 *     on the slot so a stolen voice can be hard-stopped rather than left
 *     burning CPU until its scheduled end.
 *   - Stealing picks the lowest priority, then the oldest. A request that is
 *     lower priority than every live voice is refused outright rather than
 *     kicking something that matters.
 *   - Per-cue-id throttling (min retrigger interval + max concurrent) stops a
 *     single event type from eating the whole pool.
 */

const MAX_SRC_PER_VOICE = 24;

export class VoicePool {
  /**
   * @param {BaseAudioContext} ctx
   * @param {{dry:AudioNode, reverb:AudioNode, delay:AudioNode}} dests
   * @param {object} opts { max, panner:{refDistance,maxDistance,rolloff} }
   */
  constructor(ctx, dests, opts = {}) {
    this.ctx = ctx;
    this.max = opts.max ?? 40;
    this.slots = [];
    this.free = [];
    this.active = [];
    this._gen = 1;
    this._steals = 0;
    this._refusals = 0;
    this._throttled = 0;
    this._spawned = 0;
    this._peakActive = 0;

    // per-id bookkeeping (plain objects, keyed by cue id — created once per id)
    this._lastAt = Object.create(null);
    this._countById = Object.create(null);
    this.rules = Object.create(null);     // id -> {minInterval, maxConcurrent}

    const pan = opts.panner ?? {};
    for (let i = 0; i < this.max; i++) {
      const out = ctx.createGain();
      out.gain.value = 1;

      const panner = ctx.createPanner();
      panner.panningModel = 'equalpower';   // HRTF x40 voices is not affordable
      panner.distanceModel = 'inverse';
      panner.refDistance = pan.refDistance ?? 14;
      panner.maxDistance = pan.maxDistance ?? 600;
      panner.rolloffFactor = pan.rolloff ?? 0.9;
      panner.coneInnerAngle = 360;
      panner.positionZ.value = -1;

      const panGain = ctx.createGain(); panGain.gain.value = 0;
      const flat = ctx.createGain(); flat.gain.value = 1;
      const sum = ctx.createGain(); sum.gain.value = 1;

      const dry = ctx.createGain(); dry.gain.value = 1;
      const wet = ctx.createGain(); wet.gain.value = 0;
      const dly = ctx.createGain(); dly.gain.value = 0;

      out.connect(panner); panner.connect(panGain); panGain.connect(sum);
      out.connect(flat); flat.connect(sum);
      sum.connect(dry); dry.connect(dests.dry);
      if (dests.reverb) { sum.connect(wet); wet.connect(dests.reverb); }
      if (dests.delay) { sum.connect(dly); dly.connect(dests.delay); }

      const v = {
        index: i, id: null, priority: 0, gen: 0,
        start: 0, end: 0, busy: false,
        out, panner, panGain, flat, dry, wet, dly,
        srcs: new Array(MAX_SRC_PER_VOICE).fill(null), nsrc: 0,
      };
      this.slots.push(v);
      this.free.push(v);
    }
  }

  /** Declare throttling for a cue id. Called once at setup — no allocation later. */
  setRule(id, minInterval, maxConcurrent) {
    this.rules[id] = { minInterval, maxConcurrent };
    if (this._countById[id] === undefined) this._countById[id] = 0;
    if (this._lastAt[id] === undefined) this._lastAt[id] = -1e9;
  }

  /** Retire any voice whose scheduled end has passed. Cheap, no allocation. */
  reap(now) {
    const a = this.active;
    for (let i = a.length - 1; i >= 0; i--) {
      const v = a[i];
      if (v.end <= now) {
        this._release(v);
        a[i] = a[a.length - 1];
        a.pop();
      }
    }
  }

  _release(v) {
    v.busy = false;
    v.gen++;
    for (let i = 0; i < v.nsrc; i++) v.srcs[i] = null;
    v.nsrc = 0;
    if (v.id != null && this._countById[v.id] !== undefined) {
      this._countById[v.id] = Math.max(0, this._countById[v.id] - 1);
    }
    v.id = null;
    this.free.push(v);
  }

  _kill(v, now) {
    // fast fade so stealing never clicks, then hard-stop the sources
    try {
      v.out.gain.cancelScheduledValues(now);
      v.out.gain.setValueAtTime(v.out.gain.value, now);
      v.out.gain.linearRampToValueAtTime(0, now + 0.008);
    } catch (e) { /* param races are not worth a log line */ }
    for (let i = 0; i < v.nsrc; i++) {
      const s = v.srcs[i];
      if (!s) continue;
      try { s.stop(now + 0.01); } catch (e) { /* already stopped */ }
    }
    this._steals++;
  }

  /**
   * Reserve a voice.
   * @param {string} id        cue id (for throttling + debugging)
   * @param {number} priority  higher survives longer
   * @param {number} when      scheduled start time (ctx time)
   * @param {number} duration  expected duration in seconds
   * @returns {object|null} voice, or null if throttled/refused
   */
  alloc(id, priority, when, duration) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    this.reap(now);

    const rule = this.rules[id];
    if (rule) {
      const last = this._lastAt[id] ?? -1e9;
      if (when - last < rule.minInterval) { this._throttled++; return null; }
      if ((this._countById[id] ?? 0) >= rule.maxConcurrent) { this._throttled++; return null; }
    }

    let v = this.free.pop();
    if (!v) {
      // steal: lowest priority, then oldest
      let victim = null;
      const a = this.active;
      for (let i = 0; i < a.length; i++) {
        const c = a[i];
        if (!victim || c.priority < victim.priority ||
          (c.priority === victim.priority && c.start < victim.start)) victim = c;
      }
      if (!victim || victim.priority > priority) { this._refusals++; return null; }
      this._kill(victim, now);
      const idx = a.indexOf(victim);
      if (idx >= 0) { a[idx] = a[a.length - 1]; a.pop(); }
      this._release(victim);
      v = this.free.pop();
      if (!v) { this._refusals++; return null; }
    }

    v.busy = true;
    v.id = id;
    v.priority = priority;
    v.start = when;
    v.end = when + Math.max(0.02, duration);
    v.nsrc = 0;
    // reset the persistent chain
    const g = v.out.gain;
    try {
      g.cancelScheduledValues(now);
      g.setValueAtTime(1, Math.max(now, when - 0.001));
    } catch (e) { g.value = 1; }
    v.panGain.gain.value = 0;
    v.flat.gain.value = 1;
    v.wet.gain.value = 0;
    v.dly.gain.value = 0;
    v.dry.gain.value = 1;

    this.active.push(v);
    if (this.active.length > this._peakActive) this._peakActive = this.active.length;
    this._spawned++;
    if (this._countById[id] === undefined) this._countById[id] = 0;
    this._countById[id]++;
    this._lastAt[id] = when;
    return v;
  }

  /** Track a source node so a steal can stop it. Returns the node. */
  track(v, node) {
    if (v.nsrc < MAX_SRC_PER_VOICE) v.srcs[v.nsrc++] = node;
    return node;
  }

  /** Position a voice in world space (enables the panner path). */
  place(v, x, y, z) {
    const p = v.panner;
    if (p.positionX) {
      p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z;
    } else if (p.setPosition) {
      p.setPosition(x, y, z);
    }
    v.panGain.gain.value = 1;
    v.flat.gain.value = 0;
  }

  /** Send levels, 0..1. */
  send(v, reverb, delay) {
    if (reverb !== undefined) v.wet.gain.value = reverb;
    if (delay !== undefined) v.dly.gain.value = delay;
  }

  /** Extend a voice's lifetime (for sounds whose length is decided late). */
  hold(v, endTime) { if (endTime > v.end) v.end = endTime; }

  get stats() {
    return {
      max: this.max,
      active: this.active.length,
      peakActive: this._peakActive,
      spawned: this._spawned,
      steals: this._steals,
      refusals: this._refusals,
      throttled: this._throttled,
    };
  }

  resetStats() {
    this._steals = 0; this._refusals = 0; this._throttled = 0;
    this._spawned = 0; this._peakActive = this.active.length;
  }

  killAll() {
    const now = this.ctx.currentTime;
    const a = this.active;
    for (let i = a.length - 1; i >= 0; i--) { this._kill(a[i], now); this._release(a[i]); }
    a.length = 0;
  }
}

export default VoicePool;
