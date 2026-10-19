import * as THREE from 'three';
import Bus from '../core/Bus.js';

/**
 * THE RETICLE — the sweep-beam sight and everything it touches.
 *
 * DOM, not WebGL: DOM gives us crisp 1px geometry at any resolution, free
 * text rendering, and palette-reactive CSS variables. The reticle breathes
 * with the sweep; lock markers are thorn-diamonds that bite onto their
 * target and spin; graze popups rise like sparks.
 */

const _v = new THREE.Vector3();

export class Reticle {
  constructor() {
    this.name = 'reticle';
    this.order = 85;
    this._markers = [];
    this._pops = [];
    this._unsub = [];
  }

  async init(ctx) {
    this._ctx = ctx;
    const ui = document.getElementById('ui');

    const style = document.createElement('style');
    style.textContent = `
      #reticle {
        position:absolute; width:0; height:0; left:0; top:0;
        pointer-events:none; z-index:20; will-change:transform;
      }
      #reticle .ring {
        position:absolute; left:-23px; top:-23px; width:46px; height:46px;
        border:1.5px solid var(--pal-key);
        border-radius:50%;
        box-shadow:0 0 9px color-mix(in srgb, var(--pal-key) 75%, transparent),
                   inset 0 0 7px color-mix(in srgb, var(--pal-key) 45%, transparent),
                   0 0 2px rgba(0,0,0,.9);
        transition: transform .18s ease, border-color .18s ease;
      }
      #reticle::before {
        content:''; position:absolute; left:-30px; top:-30px; width:60px; height:60px;
        border-radius:50%; border:1px solid rgba(0,0,0,.55); filter:blur(1.5px);
      }
      #reticle.locking .ring { transform: scale(0.82); border-color: var(--pal-key); }
      #reticle .tick {
        position:absolute; left:-1px; top:-34px; width:2.5px; height:10px;
        background:var(--pal-glow); transform-origin:1.25px 34px;
        box-shadow:0 0 7px var(--pal-key), 0 0 2px rgba(0,0,0,.8);
      }
      #reticle .tick:nth-child(2) { transform:rotate(90deg); }
      #reticle .tick:nth-child(3) { transform:rotate(180deg); }
      #reticle .tick:nth-child(4) { transform:rotate(270deg); }
      #reticle .dot {
        position:absolute; left:-1.5px; top:-1.5px; width:3px; height:3px;
        background:var(--pal-glow); border-radius:50%;
        box-shadow:0 0 8px var(--pal-key);
      }
      .lockmark {
        position:absolute; width:26px; height:26px; margin:-13px 0 0 -13px;
        pointer-events:none; z-index:19; will-change:transform;
        animation:lockspin 1.1s linear infinite;
      }
      .lockmark i {
        display:block; width:100%; height:100%;
        border:1.5px solid var(--pal-accent);
        transform:rotate(45deg) scale(0.72);
        box-shadow:0 0 10px color-mix(in srgb, var(--pal-accent) 70%, transparent),
                   inset 0 0 8px color-mix(in srgb, var(--pal-accent) 40%, transparent);
      }
      .lockmark.born i { animation:lockbite .22s cubic-bezier(.2,2.4,.4,1); }
      @keyframes lockspin { to { transform:rotate(360deg); } }
      @keyframes lockbite { 0% { transform:rotate(45deg) scale(1.7); } 100% { transform:rotate(45deg) scale(0.72); } }
      .grazepop {
        position:absolute; pointer-events:none; z-index:21;
        color:var(--pal-accent); font-size:11px; letter-spacing:.18em;
        text-shadow:0 0 8px var(--pal-accent);
        animation:gpop .8s cubic-bezier(.1,.7,.3,1) forwards;
        will-change:transform,opacity;
      }
      @keyframes gpop {
        0% { transform:translate(-50%,-50%) scale(.6); opacity:0; }
        12% { opacity:1; transform:translate(-50%,-60%) scale(1.15); }
        100% { transform:translate(-50%,-190%) scale(.9); opacity:0; }
      }
      .hitmark {
        position:absolute; width:14px; height:14px; margin:-7px 0 0 -7px;
        pointer-events:none; z-index:21; animation:hitflash .22s ease-out forwards;
      }
      .hitmark::before, .hitmark::after {
        content:''; position:absolute; left:6px; top:0; width:2px; height:14px;
        background:var(--pal-glow); box-shadow:0 0 6px var(--pal-key);
      }
      .hitmark::before { transform:rotate(45deg); }
      .hitmark::after { transform:rotate(-45deg); }
      @keyframes hitflash { 0% { transform:scale(1.6); opacity:1; } 100% { transform:scale(0.7); opacity:0; } }
    `;
    document.head.appendChild(style);

    this._el = document.createElement('div');
    this._el.id = 'reticle';
    this._el.innerHTML = `<div class="ring"></div><div class="tick"></div><div class="tick"></div><div class="tick"></div><div class="tick"></div><div class="dot"></div>`;
    ui.appendChild(this._el);

    // pooled lock markers + popups
    for (let i = 0; i < 10; i++) {
      const m = document.createElement('div');
      m.className = 'lockmark';
      m.innerHTML = '<i></i>';
      m.style.display = 'none';
      ui.appendChild(m);
      this._markers.push({ el: m, target: null });
    }

    this._unsub.push(Bus.on('graze:chain', (d) => {
      if (!d?.position || d.chain % 2) return;
      this._popup(`+${120 * (1 + Math.floor(d.chain * 0.05))}`, d.position);
    }));
    this._unsub.push(Bus.on('weapon:hit', (d) => {
      if (d?.position) this._hitmark(d.position);
    }));
  }

  _popup(text, worldPos) {
    _v.copy(worldPos).project(this._ctx.camera);
    if (_v.z > 1) return;
    const x = (_v.x * 0.5 + 0.5) * innerWidth;
    const y = (-_v.y * 0.5 + 0.5) * innerHeight;
    let pop = this._pops.find((p) => !p.busy);
    if (!pop) {
      if (this._pops.length >= 12) return;
      const el = document.createElement('div');
      el.className = 'grazepop';
      document.getElementById('ui').appendChild(el);
      pop = { el, busy: false };
      this._pops.push(pop);
    }
    pop.busy = true;
    pop.el.textContent = text;
    pop.el.style.left = `${x}px`;
    pop.el.style.top = `${y}px`;
    pop.el.style.display = 'block';
    pop.el.style.animation = 'none';
    void pop.el.offsetWidth;                    // restart the CSS animation
    pop.el.style.animation = '';
    clearTimeout(pop.tid);
    pop.tid = setTimeout(() => { pop.busy = false; pop.el.style.display = 'none'; }, 820);
  }

  _hitmark(worldPos) {
    _v.copy(worldPos).project(this._ctx.camera);
    if (_v.z > 1) return;
    const m = document.createElement('div');
    m.className = 'hitmark';
    m.style.left = `${(_v.x * 0.5 + 0.5) * innerWidth}px`;
    m.style.top = `${(-_v.y * 0.5 + 0.5) * innerHeight}px`;
    document.getElementById('ui').appendChild(m);
    setTimeout(() => m.remove(), 240);
  }

  update(dt, ctx) {
    const { input, camera } = ctx;
    const weapons = ctx.engine.get('weapons');

    /* reticle position */
    const x = (input.aim.x * 0.5 + 0.5) * innerWidth;
    const y = (-input.aim.y * 0.5 + 0.5) * innerHeight;
    this._el.style.transform = `translate(${x}px, ${y}px)`;
    this._el.classList.toggle('locking', !!weapons?.locking);

    /* lock markers track their targets */
    const locks = weapons?.locks ?? [];
    for (let i = 0; i < this._markers.length; i++) {
      const mk = this._markers[i];
      const lock = locks[i];
      if (!lock || !lock.target?.alive) {
        if (mk.target) { mk.target = null; mk.el.style.display = 'none'; }
        continue;
      }
      if (mk.target !== lock.target) {
        mk.target = lock.target;
        mk.el.classList.remove('born');
        void mk.el.offsetWidth;
        mk.el.classList.add('born');
      }
      _v.copy(lock.target.position).project(camera);
      if (_v.z > 1) { mk.el.style.display = 'none'; continue; }
      mk.el.style.display = 'block';
      const lx = (_v.x * 0.5 + 0.5) * innerWidth;
      const ly = (-_v.y * 0.5 + 0.5) * innerHeight;
      const s = 1 + (locks.filter((l) => l.target === lock.target).indexOf(lock)) * 0.45;
      mk.el.style.transform = `translate(${lx}px, ${ly}px) scale(${s})`;
    }
  }

  dispose() { for (const u of this._unsub) u(); }
}
export default Reticle;
