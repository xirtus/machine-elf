import * as THREE from 'three';
import Bus from '../core/Bus.js';
import CFG from '../core/Config.js';
import { hash11 } from '../util/enemy-math.js';

/**
 * THE DIRECTOR — pacing, waves, score, the descent itself.
 *
 * Structure of a run:
 *   attract → RUN (waves synced to rail motifs, ~60 s per dimension)
 *           → BOSS at 80% of the segment (rail slows, entity assembles)
 *           → SHIFT (dimension melt) → next RUN, deeper and less euclidean.
 *
 * Death costs your combo and your chain, not the run — until the third
 * death, which ends it. Score authority lives here and ONLY here: kills and
 * grazes feed in, score:change flows out.
 */

const WAVES = {
  0: ['wisp-arc', 'wisp-arc', 'weaver-cross'],
  1: ['wisp-arc', 'weaver-cross', 'lancer-phalanx'],
  2: ['weaver-cross', 'lancer-phalanx', 'wisp-ring'],
  3: ['lancer-phalanx', 'gyre-gate', 'wisp-ring'],
  4: ['gyre-gate', 'weaver-cross', 'lancer-phalanx', 'wisp-ring'],
  5: ['gyre-gate', 'lancer-phalanx', 'weaver-cross', 'wisp-ring'],
};

export class Director {
  constructor() {
    this.name = 'director';
    this.order = 80;

    this.state = 'attract';
    this.score = 0;
    this.hi = 0;
    this.combo = 0;
    this.comboTier = 0;
    this.multiplier = 1;
    this.deaths = 0;
    this.dimension = 0;
    this.loops = 0;

    this._comboTimer = 0;
    this._waveClock = 3.0;
    this._bossSpawned = false;
    this._musicClock = 0;
    this._respawnClock = 0;
    this._unsub = [];
  }

  async init(ctx) {
    this._ctx = ctx;
    try { this.hi = parseInt(localStorage.getItem('machineelf.hi') || '0', 10) || 0; } catch (e) { /* private mode */ }

    this._unsub.push(Bus.on('enemy:killed', (d) => this._onKill(d)));
    this._unsub.push(Bus.on('score:add', (d) => this._addScore(d?.amount ?? 0)));
    this._unsub.push(Bus.on('boss:dead', () => this._onBossDead()));
    this._unsub.push(Bus.on('gate:pass', (d) => {
      this._addScore(Math.round(250 * (0.5 + (d?.precision ?? 0.5))));
      Bus.emit('audio:cue', { id: 'gate:pass' });
    }));
    this._unsub.push(Bus.on('player:dead', () => this._onPlayerDead()));
    this._unsub.push(Bus.on('game:start', () => {
      // fired at boot; we hold in attract until a gesture
      this._setState('attract');
    }));
    window.__director = this;
  }

  _setState(s) {
    this.state = s;
    Bus.emit('game:state', { state: s, score: this.score, hi: this.hi, dimension: this.dimension });
  }

  startRun() {
    const { engine } = this._ctx;
    this.score = 0;
    this.combo = 0;
    this.deaths = 0;
    this.dimension = 0;
    this.loops = 0;
    this._bossSpawned = false;
    this._waveClock = 2.0;
    Bus.emit('score:change', { total: this.score, added: 0 });
    this._setState('run');
    Bus.emit('audio:cue', { id: 'run:start' });
  }

  _onKill(d) {
    const S = CFG.scoring;
    this.combo++;
    this._comboTimer = S.comboWindow;
    let tier = 0;
    for (let i = 0; i < S.tiers.length; i++) if (this.combo >= S.tiers[i]) tier = i;
    if (tier !== this.comboTier) {
      this.comboTier = tier;
      Bus.emit('combo:change', { value: this.combo, tier });
    }
    this.multiplier = 1 + tier * 0.5;
    this._addScore(Math.round((d?.value ?? 100) * this.multiplier));
  }

  _addScore(n) {
    if (!n) return;
    this.score += n;
    if (this.score > this.hi) {
      this.hi = this.score;
      try { localStorage.setItem('machineelf.hi', String(this.hi)); } catch (e) { /* noop */ }
    }
    Bus.emit('score:change', { total: this.score, added: n });
  }

  _onBossDead() {
    this._addScore(15000 + this.dimension * 5000);
    this._setState('shift');
    const dims = this._ctx.engine.get('dimensions');
    const next = (this.dimension + 1) % 6;
    if (next === 0) {
      this.loops++;
      Bus.emit('game:loop', { loop: this.loops });
    }
    dims?.goTo(next, 3.6);
    this.dimension = next;
    // rail regenerates itself on dimension:enter; fresh segment, fresh boss
    this._bossSpawned = false;
    setTimeout(() => { if (this.state === 'shift') this._setState('run'); }, 4200);
  }

  _onPlayerDead() {
    this.deaths++;
    this.combo = 0;
    this.comboTier = 0;
    this.multiplier = 1;
    Bus.emit('combo:change', { value: 0, tier: 0 });
    this._respawnClock = 2.6;
    this._setState(this.deaths >= 3 ? 'gameover' : 'down');
  }

  _restart() {
    const dims = this._ctx.engine.get('dimensions');
    if (this.dimension !== 0) dims?.goTo(0, 2.0);
    this.dimension = 0;
    this._ctx.engine.get('player')?.respawn();
    this.startRun();
  }

  /* ── waves ───────────────────────────────────────────────────────────── */
  _spawnWave() {
    const enemies = this._ctx.engine.get('enemies');
    if (!enemies || enemies.active.length > 13) return;
    const table = WAVES[this.dimension] || WAVES[0];
    const kind = table[Math.floor(hash11(this.score * 0.013 + this._waveClock * 7.7) * table.length)];
    const aggro = Math.min(1, 0.35 + this.dimension * 0.11 + this.loops * 0.15);

    switch (kind) {
      case 'wisp-arc': {
        const n = 4 + Math.floor(hash11(this._waveClock * 31) * 3);
        for (let i = 0; i < n; i++) {
          const t = n === 1 ? 0 : (i / (n - 1)) - 0.5;
          enemies.spawn('wisp', { ahead: 200 + i * 12, ox: t * 1.7, oy: Math.sin(t * Math.PI) * 0.5 + 0.2, aggro });
        }
        break;
      }
      case 'weaver-cross': {
        for (let i = 0; i < 2 + (this.dimension > 2 ? 1 : 0); i++) {
          enemies.spawn('weaver', { ahead: 215 + i * 26, ox: (i % 2 ? -0.6 : 0.6), oy: 0.1 + i * 0.25, aggro });
        }
        break;
      }
      case 'lancer-phalanx': {
        enemies.spawn('lancer', { ahead: 235, ox: 0, oy: 0.25, aggro });
        enemies.spawn('wisp', { ahead: 215, ox: -0.8, oy: -0.2, aggro });
        enemies.spawn('wisp', { ahead: 215, ox: 0.8, oy: -0.2, aggro });
        break;
      }
      case 'wisp-ring': {
        const n = 6;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          enemies.spawn('wisp', { ahead: 225, ox: Math.cos(a) * 0.9, oy: Math.sin(a) * 0.55, aggro });
        }
        break;
      }
      case 'gyre-gate': {
        enemies.spawn('gyre', { ahead: 245, ox: 0, oy: 0.15, aggro });
        enemies.spawn('weaver', { ahead: 225, ox: -0.7, oy: 0.4, aggro });
        enemies.spawn('weaver', { ahead: 225, ox: 0.7, oy: -0.3, aggro });
        break;
      }
    }
    Bus.emit('director:wave', { kind });
  }

  update(dt, ctx) {
    const { input, engine } = this._ctx;
    const rail = engine.get('rail');
    const player = engine.get('player');

    /* combo decay */
    if (this._comboTimer > 0) {
      this._comboTimer -= dt;
      if (this._comboTimer <= 0 && this.combo > 0) {
        this.combo = 0;
        if (this.comboTier !== 0) Bus.emit('combo:change', { value: 0, tier: 0 });
        this.comboTier = 0;
        this.multiplier = 1;
      }
    }

    switch (this.state) {
      case 'attract':
        if (input.pressed('start') || input.fire) this.startRun();
        break;

      case 'run': {
        if (!rail) break;
        this._waveClock -= dt;
        if (this._waveClock <= 0) {
          this._waveClock = Math.max(1.6, 3.4 - this.dimension * 0.3 - this.loops * 0.3);
          this._spawnWave();
        }
        if (!this._bossSpawned && rail.progress > 0.8) {
          this._bossSpawned = true;
          this._setState('boss');
          rail.speedScale = 0.34;
          engine.get('enemies')?.clearBullets();
          engine.get('bosses')?.spawn(this.dimension % 3, { escalation: this.loops + this.dimension * 0.4 });
        }
        break;
      }

      case 'boss':
        break;

      case 'shift':
        break;

      case 'down':
        this._respawnClock -= dt;
        if (this._respawnClock <= 0) {
          player?.respawn();
          this._setState('run');
        }
        break;

      case 'gameover':
        if (input.pressed('start') || (input.fire && this._respawnClock < -1.5)) this._restart();
        this._respawnClock -= dt;
        break;
    }

    /* music intensity follows the heat of the moment */
    this._musicClock -= dt;
    if (this._musicClock <= 0) {
      this._musicClock = 0.6;
      const enemies = engine.get('enemies');
      const n = enemies ? enemies.active.length : 0;
      const boss = this.state === 'boss' ? 0.45 : 0;
      const intensity = Math.min(1, 0.22 + n * 0.06 + boss + this.dimension * 0.04);
      Bus.emit('music:intensity', { value: intensity, state: this.state });
    }
  }
}
export default Director;
