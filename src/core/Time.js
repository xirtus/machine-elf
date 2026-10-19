import Bus from './Bus.js';

/**
 * Global clock with time dilation, hitstop and smooth slow-motion ramps.
 * Systems read `Time.dt` (scaled, for gameplay) or `Time.rawDt` (unscaled,
 * for UI/camera-shake that must not freeze during hitstop).
 */
class Clock {
  constructor() {
    this.dt = 0;          // scaled delta, clamped
    this.rawDt = 0;       // unscaled delta, clamped
    this.elapsed = 0;     // scaled accumulated time (drives shaders)
    this.rawElapsed = 0;
    this.frame = 0;
    this.scale = 1;       // target time scale
    this._scaleNow = 1;   // smoothed
    this._hitstop = 0;
    this._last = 0;
    this.maxDt = 1 / 20;  // never step more than 50ms of sim
    this.fps = 60;
    this._fpsAcc = 0;
    this._fpsCount = 0;

    Bus.on('time:hitstop', (d) => this.hitstop(d?.duration ?? 0.06));
  }

  start() { this._last = performance.now() / 1000; }

  /** Freeze gameplay for `sec` real seconds — the punch behind every impact. */
  hitstop(sec) { this._hitstop = Math.max(this._hitstop, sec); }

  /** Ramp toward a time scale (0.25 = bullet time). Reset with setScale(1). */
  setScale(s) { this.scale = s; }

  tick(now) {
    const t = now / 1000;
    let raw = t - this._last;
    this._last = t;
    if (!Number.isFinite(raw) || raw < 0) raw = 0;
    raw = Math.min(raw, this.maxDt);

    this.rawDt = raw;
    this.rawElapsed += raw;

    // fps meter
    this._fpsAcc += raw; this._fpsCount++;
    if (this._fpsAcc > 0.5) {
      this.fps = this._fpsCount / this._fpsAcc;
      this._fpsAcc = 0; this._fpsCount = 0;
    }

    let target = this.scale;
    if (this._hitstop > 0) {
      this._hitstop -= raw;
      target = 0.015; // not a hard zero — impacts still breathe
    }
    // critically-damped-ish approach; instant on freeze, eased on release
    const k = target < this._scaleNow ? 45 : 9;
    this._scaleNow += (target - this._scaleNow) * Math.min(1, raw * k);

    this.dt = raw * this._scaleNow;
    this.elapsed += this.dt;
    this.frame++;
    return this.dt;
  }
}

export const Time = new Clock();
export default Time;
