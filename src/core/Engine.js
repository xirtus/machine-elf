import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import Bus from './Bus.js';
import Time from './Time.js';
import Input from './Input.js';
import CFG from './Config.js';

/**
 * Owns the renderer, scene graph root, camera and the frame loop.
 *
 * ── Module contract ──────────────────────────────────────────────────────
 * Register objects with `engine.add(module)`. A module may implement any of:
 *
 *   name        : string                     (required, for debug/ordering)
 *   order       : number                     (default 0; lower runs first)
 *   async init(ctx)                          — build scene content
 *   update(dt, ctx)                          — scaled gameplay step
 *   lateUpdate(dt, ctx)                      — after all updates (camera, HUD)
 *   resize(w, h, ctx)
 *   dispose()
 *
 * ctx = { engine, renderer, scene, camera, world, fx, bus, time, input, cfg }
 *
 * `world` is a THREE.Group for anything that should be shifted during a
 * dimension transition; `fx` is a Group for additive/effects geometry that
 * must render after opaque world content.
 * ────────────────────────────────────────────────────────────────────────
 */
export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    this.modules = [];
    this._byName = new Map();
    this.running = false;
    this.renderScale = 1;
    this._scaleAcc = 0;
    this._frameTimes = [];
    this.paused = false;

    this.scene = new THREE.Scene();
    this.world = new THREE.Group(); this.world.name = 'world';
    this.fx = new THREE.Group(); this.fx.name = 'fx';
    this.scene.add(this.world, this.fx);

    this.camera = new THREE.PerspectiveCamera(
      CFG.render.fov, 1, CFG.render.near, CFG.render.far
    );
    this.camera.position.set(0, 2, 10);
    this.scene.add(this.camera);
  }

  get ctx() {
    return {
      engine: this, renderer: this.renderer, scene: this.scene,
      camera: this.camera, world: this.world, fx: this.fx,
      bus: Bus, time: Time, input: Input, cfg: CFG,
    };
  }

  add(module) {
    if (!module || !module.name) throw new Error('Engine.add: module needs a name');
    if (this._byName.has(module.name)) throw new Error(`duplicate module "${module.name}"`);
    this.modules.push(module);
    this._byName.set(module.name, module);
    this.modules.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return module;
  }

  get(name) { return this._byName.get(name); }

  async boot(onProgress = () => {}) {
    const supported = typeof navigator !== 'undefined' && !!navigator.gpu;
    this.renderer = new WebGPURenderer({
      canvas: this.canvas,
      antialias: false,          // TRAA/SMAA handles this in the post chain
      forceWebGL: !supported,
      powerPreference: 'high-performance',
      alpha: false,
    });
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.toneMapping = THREE.NoToneMapping;    // tonemapped in post
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    await this.renderer.init();
    this.backend = supported ? 'webgpu' : 'webgl2';
    console.log(`[engine] backend: ${this.backend}`);

    Input.attach(this.canvas);
    this._resize();
    window.addEventListener('resize', () => this._resize(), { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.paused = true;
      else { this.paused = false; Time.start(); }
    });

    const ctx = this.ctx;
    const total = this.modules.length || 1;
    let done = 0;
    for (const m of this.modules) {
      if (m.init) await m.init(ctx);
      done++;
      onProgress(done / total, m.name);
    }
    return this;
  }

  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.width = w; this.height = h;
    const dpr = Math.min(window.devicePixelRatio || 1, CFG.render.maxPixelRatio);
    this.renderer.setPixelRatio(dpr * this.renderScale);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const ctx = this.ctx;
    for (const m of this.modules) m.resize?.(w, h, ctx);
    Bus.emit('engine:resize', { width: w, height: h });
  }

  /** Nudge internal resolution to hold framerate. Called once a second. */
  _adapt() {
    const fps = Time.fps;
    const { minScale, maxScale } = CFG.render;
    let s = this.renderScale;
    if (fps < 52 && s > minScale) s = Math.max(minScale, s - 0.08);
    else if (fps > 58 && s < maxScale) s = Math.min(maxScale, s + 0.04);
    if (Math.abs(s - this.renderScale) > 0.005) {
      this.renderScale = s;
      const dpr = Math.min(window.devicePixelRatio || 1, CFG.render.maxPixelRatio);
      this.renderer.setPixelRatio(dpr * s);
      this.renderer.setSize(this.width, this.height, false);
    }
  }

  start() {
    this.running = true;
    Time.start();
    // WebGPURenderer drives its own loop so it can recover from device-lost.
    this.renderer.setAnimationLoop((now) => { if (this.running) this.frame(now); });
  }

  stop() { this.running = false; this.renderer.setAnimationLoop(null); }

  _moduleError(m, phase, e) {
    const key = `${m.name}:${phase}`;
    this._errSeen = this._errSeen || new Set();
    window.__frameErrors = window.__frameErrors || [];
    window.__frameErrors.push(`${key}: ${e?.stack || e}`);
    if (!this._errSeen.has(key)) {
      this._errSeen.add(key);
      console.error(`[engine] ${m.name}.${phase} threw:`, e);
    }
  }

  frame(now) {
    if (this.paused) { Time.start(); return; }
    this.framesRendered = (this.framesRendered || 0) + 1;
    const dt = Time.tick(now ?? performance.now());
    const ctx = this.ctx;

    Input.update(Time.rawDt);

    for (let i = 0; i < this.modules.length; i++) {
      try { this.modules[i].update?.(dt, ctx); }
      catch (e) { this._moduleError(this.modules[i], 'update', e); }
    }
    for (let i = 0; i < this.modules.length; i++) {
      try { this.modules[i].lateUpdate?.(dt, ctx); }
      catch (e) { this._moduleError(this.modules[i], 'lateUpdate', e); }
    }

    this._scaleAcc += Time.rawDt;
    if (this._scaleAcc > 1.0) { this._scaleAcc = 0; this._adapt(); }

    const post = this._byName.get('postfx');
    if (post?.render) post.render(ctx);
    else this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.stop();
    for (const m of this.modules) m.dispose?.();
    this.renderer?.dispose();
  }
}

export default Engine;
