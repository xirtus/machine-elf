/**
 * MENGER / JERUSALEM HYBRID — the sacred-geometry cathedral.
 *
 * A Menger sponge is a cube with cross-shaped voids punched through it,
 * recursively. A Jerusalem cube instead punches *cube* voids of two sizes.
 * Blending the two subtraction primitives per iteration (`A.z`) gives a
 * building that is neither, and that is where the "cathedral" reads come from:
 * rose windows in the cross arms, buttresses in the cube corners.
 *
 * Each iteration is rotated slightly (`A.w`) so the sponge is never perfectly
 * axis-aligned — that single term is the difference between "3D primitive"
 * and "architecture".
 *
 *   A = ( baseSize, thickness, jerusalemMix, iterTwist )
 *   B = ( offsetX, offsetY, offsetZ, chamfer )
 *
 * Orbit traps: distance to the cell centre, the cut depth and the iteration
 * at which the surface was resolved (packed as a 0..1 "depth of detail").
 */
import {
  Fn, If, Loop, Break, vec3, vec4, float,
  abs, max, min, clamp, dot, length, sin, cos, mix, sqrt,
} from 'three/tsl';
import { sdBox, gmod } from './common.js';

export const deMenger = Fn(([p, A, B]) => {
  const baseSize = A.x.max(0.2).toVar();
  const thick = A.y.toVar();
  const jer = A.z.toVar();
  const twist = A.w.toVar();

  const q = p.add(B.xyz).toVar('q');
  const d = sdBox(q, vec3(baseSize)).toVar('d');

  const s = float(1).toVar('s');
  const tx = float(1e6).toVar('tx');
  const ty = float(1e6).toVar('ty');
  const lvl = float(0).toVar('lvl');

  Loop({ start: 0, end: 5, type: 'int' }, () => {
    // fold into the 3-cell
    const a = gmod(q.mul(s), float(2.0)).sub(1.0).toVar('a');
    s.mulAssign(3.0);

    // per-iteration rotation about Y — kills the perfect lattice
    const cs = cos(twist.mul(lvl.add(1.0))).toVar();
    const sn = sin(twist.mul(lvl.add(1.0))).toVar();
    a.assign(vec3(a.x.mul(cs).add(a.z.mul(sn)), a.y, a.z.mul(cs).sub(a.x.mul(sn))));

    const r = abs(float(1.0).sub(abs(a).mul(3.0).mul(thick))).toVar('r');

    // Menger: intersection of three infinite square tubes
    const da = max(r.x, r.y).toVar();
    const db = max(r.y, r.z).toVar();
    const dc = max(r.z, r.x).toVar();
    const cross = min(da, min(db, dc)).sub(1.0).div(s).toVar();

    // Jerusalem: a cube void plus its smaller siblings at the corners
    const cube = max(r.x, max(r.y, r.z)).sub(1.0).div(s).toVar();
    const cut = mix(cross, cube.mul(0.86).add(B.w.div(s)), jer).toVar();

    d.assign(max(d, cut));

    tx.assign(min(tx, length(a.xy)));
    ty.assign(min(ty, abs(a.z)));
    lvl.addAssign(1.0);
  });

  return vec4(d, clamp(tx.mul(1.4), 0, 1), clamp(ty.mul(1.7), 0, 1), clamp(lvl.mul(0.2), 0, 1));
});

deMenger.setLayout({
  name: 'deMenger', type: 'vec4',
  inputs: [{ name: 'p', type: 'vec3' }, { name: 'A', type: 'vec4' }, { name: 'B', type: 'vec4' }],
});

export default deMenger;
