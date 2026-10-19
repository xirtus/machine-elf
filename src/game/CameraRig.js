import * as THREE from 'three';
import Bus from '../core/Bus.js';
import CFG from '../core/Config.js';
import Time from '../core/Time.js';
import { springBasis3, springQuat, expSmooth, noise1, fbm1, clamp } from '../util/rail-spring.js';

/**
 * THE EYE — a chase camera with actual cinematography.
 *
 * Three rules that separate "game camera" from "a camera on a drone flown
 * by a professional":
 *
 *  1. The camera is a body with momentum (second-order spring), so it lags
 *     *into* a turn and breathes out of it. Lerp cannot do this.
 *  2. It looks where you're *going* (down-rail lookahead blended with the
 *     craft), not at the craft. Banking comes from the rail's curvature,
 *     felt a beat before the corner arrives.
 *  3. Shake is trauma², never linear — a small hit is a shiver, a big hit
 *     is an event. Shake runs on rawDt so hitstop doesn't freeze the flinch.
 */

const _target = new THREE.Vector3();
const _look = new THREE.Vector3();
const _up = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _qLook = new THREE.Quaternion();
const _qBank = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const _v = new THREE.Vector3();
const _right = new THREE.Vector3();
const _upv = new THREE.Vector3();
const _fwd = new THREE.Vector3();

export class CameraRig {
  constructor() {
    this.name = 'camerarig';
    this.order = 90;               // after everything that moves

    this._pos = new THREE.Vector3();
    this._vel = new THREE.Vector3();
    this._prevTarget = new THREE.Vector3();
    this._started = false;
    this._omega = new THREE.Vector3(4.2, 5.6, 30);     // right, up, forward gains
    this._zeta = new THREE.Vector3(0.72, 0.82, 1.0);
    this._quatVel = new THREE.Vector3();   // angular velocity for springQuat
    this._bank = 0;
    this._fov = CFG.render.fov;
    this._trauma = 0;
    this._shakeT = 0;
    this._boostBlend = 0;
    this._started = false;
    this._unsub = [];

    this._warpSpeed = 0;           // extra during dimension melts
    this.enabled = true;          // studio harness can suspend us
  }

  async init(ctx) {
    this._ctx = ctx;
    this._unsub.push(Bus.on('camera:shake', (d) => {
      this._trauma = Math.min(1.4, this._trauma + (d?.amount ?? 0.5) * 0.5);
      this._shakeT = Math.max(this._shakeT, d?.duration ?? 0.4);
    }));
    this._unsub.push(Bus.on('dimension:shift', (d) => {
      this._warpTarget = Math.sin((d?.progress ?? 0) * Math.PI);
    }));
    this._unsub.push(Bus.on('dimension:enter', () => { this._warpTarget = 0; }));
    this._warpTarget = 0;

    // snap to the rail on first frame — no opening lurch
    const rail = ctx.engine.get('rail');
    if (rail?.current) {
      const s = rail.current;
      this._pos.copy(s.position)
        .addScaledVector(s.tangent, -CFG.camera.followDistance)
        .addScaledVector(s.normal, CFG.camera.followHeight);
      ctx.camera.position.copy(this._pos);
      _m.lookAt(this._pos, s.position, s.normal);
      ctx.camera.quaternion.setFromRotationMatrix(_m);
      this._prevTarget.copy(this._pos);
      this._started = true;
    }
  }

  /** External impulse — explosions, graze flicks, boss stomps. */
  shake(amount = 0.5, duration = 0.4) {
    this._trauma = Math.min(1.4, this._trauma + amount * 0.5);
    this._shakeT = Math.max(this._shakeT, duration);
  }

  update(dt, ctx) {
    if (this.enabled === false) return;
    const { camera } = ctx;
    const rawDt = Time.rawDt || dt;
    const rail = ctx.engine.get('rail');
    const player = ctx.engine.get('player');
    if (!rail?.current) return;
    const C = CFG.camera;

    const cur = rail.current;

    /* ── positional target: behind & above the craft's rail frame ─────── */
    _target.copy(cur.position)
      .addScaledVector(cur.tangent, -C.followDistance)
      .addScaledVector(cur.normal, C.followHeight);
    // the camera shares some of the player's cage offset — keeps the craft
    // readable at cage edges without pinning the view to it
    if (player) {
      _target.addScaledVector(cur.binormal, player.cageOffset.x * CFG.player.cageWidth * 0.16);
      _target.addScaledVector(cur.normal, player.cageOffset.y * CFG.player.cageHeight * 0.16);
    }

    // feed-forward the rail's own motion: the spring only fights acceleration,
    // so straights are locked-on and only corners swing
    _right.copy(cur.binormal);
    _upv.copy(cur.normal);
    _fwd.copy(cur.tangent).negate();   // rail frames: forward is -Z
    if (this._started) {
      this._pos.add(_v.copy(_target).sub(this._prevTarget));
    }
    this._prevTarget.copy(_target);
    springBasis3(this._pos, this._vel, _target, _right, _upv, _fwd, this._omega, this._zeta, dt);

    /* ── look target: down-rail, blended toward the craft ─────────────── */
    const ahead = rail.sampleAhead(C.lookAhead);
    _look.copy(ahead.position);
    if (player) _look.lerp(player.position, 0.38);

    _m.lookAt(this._pos, _look, cur.normal);
    _qLook.setFromRotationMatrix(_m);

    /* bank: rail curvature felt ahead of the corner + a whisper of craft roll */
    const lat = rail.curvatureLatAt(rail.t);
    const bankTarget = clamp(-lat * 34, -1, 1) * C.bankAmount * 0.5
      + (player ? -player.velocity.x * 0.02 : 0);
    this._bank = expSmooth(this._bank, clamp(bankTarget, -0.6, 0.6), C.bankSmooth, dt);
    _axis.set(0, 0, 1);
    _qBank.setFromAxisAngle(_axis, this._bank);
    _qLook.multiply(_qBank);

    springQuat(camera.quaternion, this._quatVel, _qLook, 6.8, 0.92, dt, 14);

    camera.position.copy(this._pos);

    /* ── FOV: boost kick + dimension-warp stretch ──────────────────────── */
    const boostOn = player?.isBoosting ? 1 : 0;
    this._boostBlend = expSmooth(this._boostBlend, boostOn, C.fovSmooth, dt);
    this._warpSpeed = expSmooth(this._warpSpeed, this._warpTarget, 3.2, dt);
    const fovTarget = CFG.render.fov + this._boostBlend * C.fovKick + this._warpSpeed * 16;
    if (Math.abs(fovTarget - this._fov) > 0.01) {
      this._fov = fovTarget;
      camera.fov = this._fov;
      camera.updateProjectionMatrix();
    }

    /* ── trauma shake (rawDt: hitstop must not freeze the flinch) ──────── */
    if (this._shakeT > 0) this._shakeT -= rawDt;
    this._trauma = Math.max(0, this._trauma - rawDt * 1.35);
    const sh = this._trauma * this._trauma;
    if (sh > 0.0001) {
      const t = Time.rawElapsed * 31;
      camera.position.x += fbm1(t, 3) * sh * 0.55;
      camera.position.y += fbm1(t * 1.13, 17) * sh * 0.45;
      camera.position.z += fbm1(t * 0.91, 41) * sh * 0.35;
      _axis.set(0, 0, 1);
      _qBank.setFromAxisAngle(_axis, noise1(t * 1.7, 91) * sh * 0.05);
      camera.quaternion.multiply(_qBank);
    }
  }
}
export default CameraRig;
