import * as THREE from 'three';
import Bus from './Bus.js';

/**
 * Unified input. Exposes a normalized aim point in NDC (-1..1) plus discrete
 * actions, sourced from pointer, keyboard or gamepad — whichever moved last.
 *
 *   Input.aim      THREE.Vector2 in NDC, y-up
 *   Input.move     THREE.Vector2 stick for craft translation (-1..1)
 *   Input.fire     boolean (held)
 *   Input.boost    boolean (held)
 *   Input.pressed(action) — edge-triggered, consumed per frame
 */
const ACTIONS = ['fire', 'boost', 'bomb', 'pause', 'start'];

class InputSystem {
  constructor() {
    this.aim = new THREE.Vector2(0, 0);
    this.aimRaw = new THREE.Vector2(0, 0);
    this.move = new THREE.Vector2(0, 0);
    this.fire = false;
    this.boost = false;
    this.bomb = false;
    this.source = 'pointer';
    this.enabled = true;

    this._keys = new Set();
    this._edges = new Set();
    this._prev = {};
    this._mouseFire = false;
    this._mouseBoost = false;
    for (const a of ACTIONS) this._prev[a] = false;
    this._padIndex = null;
    this._bound = false;
  }

  attach(canvas) {
    if (this._bound) return;
    this._bound = true;
    this.canvas = canvas;

    const onPointer = (e) => {
      if (!this.enabled) return;
      const r = canvas.getBoundingClientRect();
      this.aimRaw.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -(((e.clientY - r.top) / r.height) * 2 - 1)
      );
      this.source = 'pointer';
    };
    window.addEventListener('pointermove', onPointer, { passive: true });
    window.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      onPointer(e);
      if (e.button === 0) this._mouseFire = true;
      if (e.button === 2) this._mouseBoost = true;
    });
    window.addEventListener('pointerup', (e) => {
      if (e.button === 0) this._mouseFire = false;
      if (e.button === 2) this._mouseBoost = false;
    });
    window.addEventListener('blur', () => { this._keys.clear(); this._mouseFire = false; this._mouseBoost = false; });
    window.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this._keys.add(e.code);
      this.source = 'keyboard';
      const a = this._actionForKey(e.code);
      if (a) { this._edges.add(a); e.preventDefault(); }
    });
    window.addEventListener('keyup', (e) => this._keys.delete(e.code));

    window.addEventListener('gamepadconnected', (e) => {
      this._padIndex = e.gamepad.index;
      Bus.emit('input:gamepad', { connected: true });
    });
    window.addEventListener('gamepaddisconnected', () => {
      this._padIndex = null;
      Bus.emit('input:gamepad', { connected: false });
    });
  }

  _actionForKey(code) {
    switch (code) {
      case 'Space': case 'KeyJ': return 'fire';
      case 'ShiftLeft': case 'ShiftRight': case 'KeyK': return 'boost';
      case 'KeyB': case 'KeyL': return 'bomb';
      case 'Escape': return 'pause';
      case 'Enter': return 'start';
      default: return null;
    }
  }

  /** Edge-triggered action test; consumes the edge. */
  pressed(action) {
    if (this._edges.has(action)) { this._edges.delete(action); return true; }
    return false;
  }

  update(dt) {
    if (!this.enabled) { this.move.set(0, 0); return; }

    // ---- keyboard translation ----
    let kx = 0, ky = 0;
    if (this._keys.has('KeyA') || this._keys.has('ArrowLeft')) kx -= 1;
    if (this._keys.has('KeyD') || this._keys.has('ArrowRight')) kx += 1;
    if (this._keys.has('KeyW') || this._keys.has('ArrowUp')) ky += 1;
    if (this._keys.has('KeyS') || this._keys.has('ArrowDown')) ky -= 1;

    const keyFire = this._keys.has('Space') || this._keys.has('KeyJ');
    const keyBoost = this._keys.has('ShiftLeft') || this._keys.has('ShiftRight') || this._keys.has('KeyK');
    this.fire = keyFire || !!this._mouseFire;
    this.boost = keyBoost || !!this._mouseBoost;

    // ---- gamepad ----
    let gx = 0, gy = 0, ax = 0, ay = 0, gfire = false, gboost = false;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = this._padIndex != null ? pads[this._padIndex] : (pads && pads[0]);
    if (pad && pad.connected) {
      const dz = (v) => (Math.abs(v) < 0.14 ? 0 : (v - Math.sign(v) * 0.14) / 0.86);
      gx = dz(pad.axes[0] || 0); gy = -dz(pad.axes[1] || 0);
      ax = dz(pad.axes[2] || 0); ay = -dz(pad.axes[3] || 0);
      gfire = (pad.buttons[7]?.value ?? 0) > 0.25 || pad.buttons[0]?.pressed;
      gboost = (pad.buttons[6]?.value ?? 0) > 0.25 || pad.buttons[1]?.pressed;
      if (gx || gy || ax || ay || gfire || gboost) this.source = 'gamepad';
      if (pad.buttons[2]?.pressed) this._edges.add('bomb');
      if (pad.buttons[9]?.pressed) this._edges.add('pause');
    }

    // ---- resolve ----
    if (this.source === 'gamepad') {
      this.move.set(gx, gy);
      // right stick nudges the reticle; falls back to left stick if unused
      const rx = ax || gx, ry = ay || gy;
      this.aimRaw.x = THREE.MathUtils.clamp(this.aimRaw.x + rx * dt * 2.4, -1, 1);
      this.aimRaw.y = THREE.MathUtils.clamp(this.aimRaw.y + ry * dt * 2.4, -1, 1);
      this.fire = this.fire || gfire;
      this.boost = this.boost || gboost;
    } else if (this.source === 'keyboard' && (kx || ky)) {
      this.move.set(kx, ky);
      // aim follows the craft when flying on keys
      this.aimRaw.lerp(this.move, Math.min(1, dt * 4));
    } else {
      // pointer: craft chases the cursor
      this.move.set(this.aimRaw.x, this.aimRaw.y);
      if (kx || ky) this.move.set(kx, ky);
    }

    if (this.move.lengthSq() > 1) this.move.normalize();

    // smoothed aim for the reticle so it never feels jittery
    this.aim.lerp(this.aimRaw, Math.min(1, dt * 22));
  }
}

export const Input = new InputSystem();
export default Input;
