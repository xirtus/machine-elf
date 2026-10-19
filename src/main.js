import { Node } from 'three/webgpu';
import * as TSL from 'three/tsl';
import * as THREE from 'three';
window.__tsl = TSL;
window.__THREE = THREE;
if (location.search.includes('tsldebug')) Node.captureStackTrace = true;
import Engine from './core/Engine.js';
import Time from './core/Time.js';
import PostFX from './render/PostFX.js';
import Bus from './core/Bus.js';
import CFG from './core/Config.js';

const bootEl = document.getElementById('boot');
const bootMsg = document.getElementById('bootmsg');
const bootBar = document.getElementById('bootbar');
const errEl = document.getElementById('err');

function fatal(e) {
  console.error(e);
  errEl.style.display = 'grid';
  errEl.textContent =
    `HYPERSPACE COLLAPSE\n\n${e?.stack || e}\n\n` +
    `This build needs WebGPU (Chrome 113+, Edge, or Safari 18+).`;
  bootEl.classList.add('hidden');
}

async function main() {
  const canvas = document.getElementById('gl');
  const engine = new Engine(canvas);
  window.__engine = engine;   // debug handle
  window.__time = Time;
  window.__bus = Bus;
  window.__cfg = CFG;
  window.__time = Time;

  engine.add(new PostFX());

  // Modules are registered here in dependency order. Each is an independent
  // system implementing the contract documented in core/Engine.js.
  const mods = await Promise.all([
    import('./render/Materials.js'),
    import('./world/Dimensions.js'),
    import('./world/Fractal.js'),
    import('./world/Sky.js'),
    import('./game/Rail.js'),
    import('./game/Player.js'),
    import('./game/Reticle.js'),
    import('./game/Weapons.js'),
    import('./game/Graze.js'),
    import('./game/Enemies.js'),
    import('./game/Bosses.js'),
    import('./fx/Particles.js'),
    import('./fx/Trails.js'),
    import('./fx/Impacts.js'),
    import('./audio/Audio.js'),
    import('./game/Director.js'),
    import('./game/HUD.js'),
    import('./game/CameraRig.js'),
    import('./debug/Studio.js'),
  ]);
  const skip = new Set((location.search.match(/skip=([\w,]+)/)?.[1] ?? '').split(',').filter(Boolean));
  for (const m of mods) {
    const Cls = m.default;
    if (Cls && !skip.has(Cls.name.toLowerCase().replace(/[^a-z]/g, ''))) engine.add(new Cls());
  }
  if (skip.size) console.log('[boot] skipping:', [...skip].join(','));

  await engine.boot((p, name) => {
    bootBar.style.width = `${Math.round(p * 100)}%`;
    bootMsg.textContent = name ? `compiling ${name}` : 'initializing hyperspace';
  });

  bootMsg.textContent = 'descend';

  engine.start();
  // hold the veil until real frames are on screen — a cold shader cache
  // can stall first presentation for seconds; never show a black void
  await new Promise((r) => {
    const check = () => (engine.framesRendered ?? 0) >= 4 ? r() : setTimeout(check, 90);
    check();
  });
  bootEl.classList.add('hidden');
  Bus.emit('game:start', {});
}

main().catch(fatal);
window.addEventListener('unhandledrejection', (e) => fatal(e.reason));
