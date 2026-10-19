import * as THREE from 'three';
import Bus from '../core/Bus.js';

/**
 * IMPACTS — the choreography of a hit.
 *
 * Every gameplay event lands in FOUR systems at once: particles here, a
 * shake, a hitstop, an audio cue. That simultaneity is the difference
 * between "a number went down" and "I felt that in my hands". This module
 * is the wiring that makes hits land.
 */
const _v = new THREE.Vector3();

export class Impacts {
  constructor() {
    this.name = 'impacts';
    this.order = 54;
    this._unsub = [];
  }

  async init(ctx) {
    this._ctx = ctx;
    const P = () => ctx.engine.get('particles');

    this._unsub.push(Bus.on('weapon:hit', (d) => {
      P()?.burst('flash', d.position, { color: 'glow', size: 2.6, life: 0.22 });
      P()?.burst('spark', d.position, { color: 'key', count: 6, speed: 18, size: 0.5, life: 0.5 });
      if (d.killed) Bus.emit('time:hitstop', { duration: 0.045 });
    }));

    this._unsub.push(Bus.on('enemy:killed', (d) => {
      const big = d.bossCore || (d.enemy?.def?.hp ?? 1) > 4;
      P()?.burst('ring', d.position, { color: big ? 'accent' : 'key', size: big ? 9 : 4, life: 0.7 });
      P()?.burst('shatter', d.position, { color: 'key', count: big ? 26 : 12, speed: big ? 22 : 15, size: 0.9, life: 1.1 });
      P()?.burst('spark', d.position, { color: 'accent', count: big ? 18 : 8, speed: 26, size: 0.6, life: 0.6 });
      P()?.burst('flash', d.position, { color: 'glow', size: big ? 8 : 3.4, life: 0.3 });
      Bus.emit('camera:shake', { amount: big ? 0.55 : 0.22, duration: big ? 0.6 : 0.3 });
      Bus.emit('time:hitstop', { duration: big ? 0.09 : 0.05 });
    }));

    this._unsub.push(Bus.on('player:hit', (d) => {
      const p = ctx.engine.get('player');
      if (!p) return;
      P()?.burst('shatter', p.position, { color: 'hostile', count: 20, speed: 20, size: 0.8, life: 0.9 });
      P()?.burst('flash', p.position, { color: 'hostile', size: 5, life: 0.3 });
      P()?.burst('ring', p.position, { color: 'hostile', size: 5, life: 0.6 });
    }));

    this._unsub.push(Bus.on('player:dead', (d) => {
      const pos = d?.position || _v.set(0, 0, 0);
      P()?.burst('shatter', pos, { color: 'key', count: 60, speed: 30, size: 1.2, life: 1.8 });
      P()?.burst('flash', pos, { color: 'glow', size: 14, life: 0.8 });
      P()?.burst('ring', pos, { color: 'accent', size: 12, life: 1.2 });
    }));

    this._unsub.push(Bus.on('graze:chain', (d) => {
      if (!d?.position) return;
      P()?.burst('spark', d.position, {
        color: 'accent', count: 2 + Math.min(6, d.chain >> 2),
        speed: 10, size: 0.42, life: 0.4,
      });
    }));

    this._unsub.push(Bus.on('player:bomb', (d) => {
      const pos = d?.position || ctx.engine.get('player')?.position;
      if (!pos) return;
      P()?.burst('ring', pos, { color: 'glow', size: 16, life: 1.1 });
      P()?.burst('ring', pos, { color: 'key', size: 10, life: 0.8 });
      P()?.burst('flash', pos, { color: 'glow', size: 22, life: 0.5 });
      Bus.emit('time:hitstop', { duration: 0.12 });
    }));

    this._unsub.push(Bus.on('weapon:fire', (d) => {
      const p = ctx.engine.get('player');
      if (!p) return;
      P()?.burst('flash', p.muzzleL, { color: 'key', size: 1.6, life: 0.16 });
      P()?.burst('flash', p.muzzleR, { color: 'key', size: 1.6, life: 0.16 });
    }));

    this._unsub.push(Bus.on('gate:pass', (d) => {
      const rail = ctx.engine.get('rail');
      const pos = rail ? rail.sampleDistance(d.dist).position : null;
      if (pos && P()) {
        P().burst('ring', pos, { color: 'accent', size: 10, life: 0.8 });
        P().burst('spark', pos, { color: 'glow', count: 16, speed: 20, size: 0.6, life: 0.7 });
      }
    }));

    this._unsub.push(Bus.on('dimension:shiftStart', () => {
      const p = ctx.engine.get('player');
      if (p) P()?.burst('mote', p.position, { count: 30, color: 'rim', speed: 3, size: 0.8, life: 4 });
    }));
  }

  dispose() { for (const u of this._unsub) u(); }
}
export default Impacts;
