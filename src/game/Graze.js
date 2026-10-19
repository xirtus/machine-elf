import * as THREE from 'three';
import Bus from '../core/Bus.js';
import CFG from '../core/Config.js';

/**
 * GRAZE — flying close enough to death to drink it.
 *
 * Enemies flags bullets that pass through the graze band; this module owns
 * what that MEANS: a chain that climbs while you keep kissing bullets, the
 * overdrive meter it charges, and the score it drips. When the meter is
 * full the bomb (B) detonates every on-screen threat.
 *
 * The graze moment itself is produced everywhere else through the `graze`
 * event: particles spark, audio sheens, the HUD pops the chain.
 */
export class Graze {
  constructor() {
    this.name = 'graze';
    this.order = 42;

    this.chain = 0;
    this.meter = 0;              // 0..1 — full = bomb ready
    this.totalGrazed = 0;
    this._chainTimer = 0;
    this._unsub = [];
  }

  async init(ctx) {
    this._ctx = ctx;
    this._unsub.push(Bus.on('graze', (d) => this._onGraze(d)));
    this._unsub.push(Bus.on('player:hit', () => this._breakChain(0.5)));
    this._unsub.push(Bus.on('player:dead', () => this._breakChain(0)));
  }

  _onGraze(d) {
    const G = CFG.graze;
    this.chain = Math.min(G.maxChain, this.chain + 1);
    this._chainTimer = G.chainWindow;
    this.totalGrazed++;
    const before = this.meter;
    this.meter = Math.min(1, this.meter + G.chargePer * (1 + this.chain * 0.01));
    Bus.emit('score:add', { amount: Math.round(G.scorePer * (1 + this.chain * 0.05)) });
    Bus.emit('graze:chain', {
      position: d?.position, chain: this.chain,
      intensity: Math.min(1, 0.3 + this.chain / G.maxChain),
    });
    if (before < 1 && this.meter >= 1) Bus.emit('graze:charged', {});
  }

  _breakChain(keepMeterFrac) {
    if (this.chain > 4) Bus.emit('graze:break', { chain: this.chain });
    this.chain = 0;
    this.meter *= keepMeterFrac;
    this._chainTimer = 0;
  }

  /** Consume the bomb if charged. Returns true if it fired. */
  tryBomb() {
    if (this.meter < 1) return false;
    this.meter = 0;
    return true;
  }

  update(dt) {
    if (this._chainTimer > 0) {
      this._chainTimer -= dt;
      if (this._chainTimer <= 0) this._breakChain(1);
    }
  }
}
export default Graze;
