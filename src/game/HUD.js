import * as THREE from 'three';
import Bus from '../core/Bus.js';
import CFG from '../core/Config.js';
import Palette from '../render/Palette.js';

/**
 * THE HUD — chrome for the descent.
 *
 * Everything is typography and hairlines: monospaced, letterspaced, glowing
 * in palette slots against the dark. No boxes, no panels, no skeuomorphs.
 * The HUD should feel like the instrument cluster of a ritual.
 *
 * Owns: score/combo, integrity pips, overdrive meter, boss bar, the centre
 * cards (dimension titles, WARNING, game over), and the attract screen.
 */

export class HUD {
  constructor() {
    this.name = 'hud';
    this.order = 95;
    this._unsub = [];
    this._score = 0;
    this._shownScore = 0;
    this._comboHide = 0;
  }

  async init(ctx) {
    this._ctx = ctx;
    const ui = document.getElementById('ui');

    const style = document.createElement('style');
    style.textContent = `
      .hud { position:absolute; pointer-events:none; z-index:15;
             color:var(--pal-key); text-transform:uppercase; }
      .hud .lbl { font-size:9px; letter-spacing:.42em; opacity:.55; }
      .hud .big { font-size:22px; letter-spacing:.2em; color:var(--pal-glow);
                  text-shadow:0 0 14px var(--pal-key); font-variant-numeric:tabular-nums; }

      #hud-score { left:28px; top:22px; }
      #hud-combo { left:28px; top:66px; transition:opacity .3s; }
      #hud-combo .val { font-size:15px; color:var(--pal-accent);
                        text-shadow:0 0 10px var(--pal-accent); letter-spacing:.2em; }
      #hud-hi { right:28px; top:22px; text-align:right; }
      #hud-dim { right:28px; bottom:22px; text-align:right; font-size:10px;
                 letter-spacing:.34em; color:var(--pal-rim); }
      #hud-dim .name { color:var(--pal-key); text-shadow:0 0 10px var(--pal-key); }

      #hud-vitals { left:28px; bottom:24px; }
      #hud-pips { display:flex; gap:7px; margin-top:6px; }
      .pip { width:10px; height:10px; transform:rotate(45deg);
             border:1px solid var(--pal-key);
             background:color-mix(in srgb, var(--pal-key) 65%, transparent);
             box-shadow:0 0 8px color-mix(in srgb, var(--pal-key) 60%, transparent);
             transition:all .25s; }
      .pip.off { background:transparent; border-color:color-mix(in srgb, var(--pal-rim) 50%, transparent);
                 box-shadow:none; }
      #hud-meter { width:150px; height:3px; margin-top:10px;
                   background:color-mix(in srgb, var(--pal-rim) 26%, transparent); }
      #hud-meter i { display:block; height:100%; width:0%;
                     background:var(--pal-accent);
                     box-shadow:0 0 8px var(--pal-accent); transition:width .18s ease; }
      #hud-meter.ready i { animation:meterpulse .5s ease-in-out infinite alternate; }
      @keyframes meterpulse { from { filter:brightness(1);} to { filter:brightness(2.1);} }
      #hud-bomblbl { font-size:9px; letter-spacing:.4em; margin-top:5px; opacity:0; transition:opacity .3s;
                     color:var(--pal-accent); }
      #hud-bomblbl.on { opacity:1; }

      #hud-boss { left:50%; top:26px; transform:translateX(-50%); width:min(560px,60vw);
                  text-align:center; opacity:0; transition:opacity .6s; }
      #hud-boss.on { opacity:1; }
      #hud-boss .name { font-size:12px; letter-spacing:.55em; color:var(--pal-hostile);
                        text-shadow:0 0 12px var(--pal-hostile); margin-bottom:7px; }
      #hud-boss .bar { height:2px; background:color-mix(in srgb, var(--pal-hostile) 22%, transparent); }
      #hud-boss .bar i { display:block; height:100%; background:var(--pal-hostile);
                         box-shadow:0 0 10px var(--pal-hostile); transition:width .12s; }

      .card {
        position:absolute; left:50%; top:38%; transform:translate(-50%,-50%);
        text-align:center; pointer-events:none; z-index:30; opacity:0;
        transition:opacity .5s ease;
      }
      .card.on { opacity:1; }
      .card .over { font-size:11px; letter-spacing:.7em; color:var(--pal-accent); margin-bottom:14px; }
      .card .title { font-size:34px; letter-spacing:.34em; color:var(--pal-glow);
                     text-shadow:0 0 24px var(--pal-key); }
      .card .sub { font-size:10px; letter-spacing:.5em; color:var(--pal-rim); margin-top:14px; }
      .card.warn .title { color:var(--pal-hostile); text-shadow:0 0 24px var(--pal-hostile);
                          animation:warnstrobe .5s steps(2) infinite; }
      @keyframes warnstrobe { 50% { opacity:.35; } }

      #hud-center-hint {
        position:absolute; left:50%; bottom:14%; transform:translateX(-50%);
        font-size:11px; letter-spacing:.5em; color:var(--pal-key); opacity:0;
        transition:opacity .6s; text-transform:uppercase; z-index:30; pointer-events:none;
      }
      #hud-center-hint.on { opacity:.9; animation:hintpulse 1.6s ease-in-out infinite; }
      @keyframes hintpulse { 50% { opacity:.45; } }

      #hud-vignette {
        position:fixed; inset:0; pointer-events:none; z-index:12; opacity:0;
        background:radial-gradient(ellipse at center, transparent 52%, rgba(255,30,80,.28) 100%);
        transition:opacity .4s;
      }
    `;
    document.head.appendChild(style);

    ui.insertAdjacentHTML('beforeend', `
      <div class="hud" id="hud-score"><div class="lbl">Score</div><div class="big" id="score-val">0</div></div>
      <div class="hud" id="hud-combo" style="opacity:0"><span class="val" id="combo-val">×1.0</span>
        <span class="lbl" id="combo-chain"></span></div>
      <div class="hud" id="hud-hi"><div class="lbl">High</div><div class="big" id="hi-val" style="font-size:15px">0</div></div>
      <div class="hud" id="hud-dim"><span class="name" id="dim-name"></span><br><span id="dim-sub"></span></div>
      <div class="hud" id="hud-vitals">
        <div class="lbl">Integrity</div>
        <div id="hud-pips"></div>
        <div id="hud-meter"><i></i></div>
        <div id="hud-bomblbl">Overdrive — B</div>
      </div>
      <div class="hud" id="hud-boss"><div class="name" id="boss-name"></div><div class="bar"><i id="boss-fill"></i></div></div>
      <div class="card" id="card"><div class="over" id="card-over"></div><div class="title" id="card-title"></div><div class="sub" id="card-sub"></div></div>
      <div id="hud-center-hint"></div>
      <div id="hud-vignette"></div>
    `);

    this._$ = (id) => document.getElementById(id);
    const pips = this._$('hud-pips');
    for (let i = 0; i < CFG.player.maxHealth; i++) {
      const p = document.createElement('div');
      p.className = 'pip';
      pips.appendChild(p);
    }

    /* ── events ────────────────────────────────────────────────────────── */
    this._unsub.push(Bus.on('score:change', (d) => { this._score = d.total; }));
    this._unsub.push(Bus.on('combo:change', (d) => {
      const el = this._$('hud-combo');
      if (d.tier > 0) {
        el.style.opacity = 1;
        this._$('combo-val').textContent = `×${(1 + d.tier * 0.5).toFixed(1)}`;
        this._$('combo-chain').textContent = ` ${d.value} chain`;
        this._comboHide = 0;
      } else el.style.opacity = 0;
    }));
    this._unsub.push(Bus.on('boss:spawn', (d) => {
      this._$('boss-name').textContent = d.name ?? 'THE ENTITY';
      this._$('hud-boss').classList.add('on');
      this._card('SOMETHING ASSEMBLES', d.name ?? '', 'it noticed you', true, 2.6);
    }));
    this._unsub.push(Bus.on('boss:phase', (d) => {
      this._card('', `PHASE ${['I', 'II', 'III'][d.phase] ?? d.phase}`, '', true, 1.2);
    }));
    this._unsub.push(Bus.on('boss:dead', () => {
      this._$('hud-boss').classList.remove('on');
      this._card('ENTITY DISSOLVED', '', '+descend', false, 2.2);
    }));
    this._unsub.push(Bus.on('dimension:enter', (d) => {
      const pal = Palette.def;
      this._$('dim-name').textContent = pal.name;
      this._$('dim-sub').textContent = `dimension ${Math.round(Palette.current) + 1} of ${Palette.count}`;
      if (!d?.initial) this._card('DESCEND', pal.name, 'the mathematics deepens', false, 2.8);
    }));
    this._unsub.push(Bus.on('player:hit', () => this._vitals()));
    this._unsub.push(Bus.on('player:respawn', () => this._vitals()));
    this._unsub.push(Bus.on('player:dead', () => {
      this._vitals();
      this._card('THE ORRERY SHATTERS', '', 'reforming…', true, 2.2);
    }));
    this._unsub.push(Bus.on('graze:charged', () => {
      this._$('hud-meter').classList.add('ready');
      this._$('hud-bomblbl').classList.add('on');
    }));
    this._unsub.push(Bus.on('player:bomb', () => {
      this._$('hud-meter').classList.remove('ready');
      this._$('hud-bomblbl').classList.remove('on');
    }));
    this._unsub.push(Bus.on('game:state', (d) => this._onState(d)));
    this._unsub.push(Bus.on('game:loop', (d) => {
      this._card('THE CYCLE TURNS', `DESCENT ${(d?.loop ?? 1) + 1}`, 'deeper still — nothing here has a bottom', false, 3.4);
    }));
    this._unsub.push(Bus.on('gate:pass', (d) => {
      this._toast(`THREADED  +${Math.round(250 * (0.5 + (d?.precision ?? 0.5)))}`, 'accent');
    }));
    this._unsub.push(Bus.on('game:start', () => this._onState({ state: 'attract' })));

    this._vitals();
  }

  /** Small transient line above the bottom edge — rewards, tutorials. */
  _toast(text, slot = 'key', seconds = 1.6) {
    const hint = this._$('hud-center-hint');
    hint.textContent = text;
    hint.style.color = `var(--pal-${slot})`;
    hint.classList.add('on');
    clearTimeout(this._toastTid);
    this._toastTid = setTimeout(() => hint.classList.remove('on'), seconds * 1000);
  }

  _tutorial() {
    // timed teaching beats across the first dimension
    const steps = [
      [2.0, 'hold fire to paint locks — release to fire', 4.2],
      [8.5, 'thread the toothed gates for speed + score', 4.0],
      [15.0, 'magenta fire kills — skim it to charge overdrive', 4.6],
      [22.0, 'press B when the meter burns', 3.6],
      [30.0, 'something vast waits at the end of the segment', 4.0],
    ];
    let t = 0;
    this._tutorialTimers = steps.map(([at, text, dur]) =>
      setTimeout(() => {
        if (this._ctx.engine.get('director')?.state === 'run') this._toast(text, 'key', dur);
      }, at * 1000)
    );
  }

  _card(over, title, sub, warn, seconds) {
    const card = this._$('card');
    this._$('card-over').textContent = over;
    this._$('card-title').textContent = title;
    this._$('card-sub').textContent = sub;
    card.classList.toggle('warn', !!warn);
    card.classList.add('on');
    clearTimeout(this._cardTid);
    if (seconds) this._cardTid = setTimeout(() => card.classList.remove('on'), seconds * 1000);
  }

  _onState(d) {
    const hint = this._$('hud-center-hint');
    if (d.state !== 'attract' && d.state !== 'gameover') hint.classList.remove('on');
    switch (d.state) {
      case 'attract':
        this._card('MACHINE ELF', 'HYPERSPACE DESCENT', 'survive the descent — six dimensions deep, then deeper', false, 0);
        hint.textContent = 'click or press enter to descend';
        hint.classList.add('on');
        break;
      case 'run':
        this._$('card').classList.remove('on');
        hint.classList.remove('on');
        if (!this._didTutorial && this._ctx.engine.get('director')?.dimension === 0) {
          this._didTutorial = true;
          this._tutorial();
        }
        break;
      case 'gameover':
        this._card('THE DESCENT ENDS', `SCORE ${this._score}`, 'click or press enter to descend again', true, 0);
        hint.textContent = '';
        break;
      case 'down':
        break;
    }
    this._$('hi-val').textContent = String(d.hi ?? this._score).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  _vitals() {
    const p = this._ctx.engine.get('player');
    if (!p) return;
    const pips = this._$('hud-pips').children;
    for (let i = 0; i < pips.length; i++) pips[i].classList.toggle('off', i >= p.health);
    this._$('hud-vignette').style.opacity = p.health <= 1 && p.alive ? 1 : 0;
  }

  update(dt, ctx) {
    /* score counts up toward the true value — the odometer read */
    if (this._shownScore !== this._score) {
      const d = this._score - this._shownScore;
      this._shownScore += Math.ceil(d * Math.min(1, dt * 9)) || d;
      if (Math.abs(this._score - this._shownScore) < 2) this._shownScore = this._score;
      this._$('score-val').textContent = String(this._shownScore).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    /* overdrive meter */
    const graze = ctx.engine.get('graze');
    if (graze) this._$('hud-meter').firstElementChild.style.width = `${Math.round(graze.meter * 100)}%`;

    /* boss bar */
    const bosses = ctx.engine.get('bosses');
    if (bosses?.current) {
      const b = bosses.current;
      this._$('boss-fill').style.width = `${Math.max(0, (b.hp / b.maxHp) * 100)}%`;
    }
  }

  dispose() { for (const u of this._unsub) u(); }
}
export default HUD;
