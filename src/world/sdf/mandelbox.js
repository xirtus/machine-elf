/**
 * MANDELBOX — the corridor generator. Negative scales give the endless
 * cross-braced hangar/tunnel architecture; positive scales give jewelled
 * clusters. The box+sphere fold is branchless here:
 *
 *   f = fixedR2 / clamp(r2, minR2, fixedR2)
 *
 * reproduces the three-case sphere fold exactly with one clamp.
 *
 *   A = ( scale, minR2, fixedR2, foldLimit )
 *   B = ( offsetX, offsetY, offsetZ, twist )   twist = per-iteration Z rotation
 *
 * Orbit traps:
 *   t0  min |z.x|      → the girder highlights
 *   t1  min |z.z|      → cross-bracing
 *   t2  min r2         → interior glow pockets
 */
import {
  Fn, If, Loop, Break, vec3, vec4, float,
  abs, max, min, clamp, dot, length, sin, cos, sqrt, mix,
} from 'three/tsl';

export const deMandelbox = Fn(([p, A, B]) => {
  const scale = A.x.toVar();
  const minR2 = A.y.max(1e-4).toVar();
  const fixR2 = A.z.max(A.y.add(1e-3)).toVar();
  const lim = A.w.toVar();
  const off = B.xyz.toVar();
  const tw = B.w.toVar();

  const z = p.add(off).toVar('z');
  const dr = float(1).toVar('dr');
  const tx = float(1e6).toVar('tx');
  const ty = float(1e6).toVar('ty');
  const tz = float(1e6).toVar('tz');

  Loop({ start: 0, end: 11, type: 'int' }, () => {
    // box fold
    z.assign(clamp(z, vec3(lim.negate()), vec3(lim)).mul(2.0).sub(z));

    // sphere fold (branchless three-case)
    const r2 = dot(z, z).toVar();
    const f = fixR2.div(clamp(r2, minR2, fixR2)).toVar();
    z.mulAssign(f);
    dr.mulAssign(f);

    // conformal step
    z.assign(z.mul(scale).add(p));
    dr.assign(dr.mul(abs(scale)).add(1.0));

    // asymmetry — a small twist per iteration keeps it from reading as a lattice
    const cs = cos(tw).toVar(), sn = sin(tw).toVar();
    z.assign(vec3(z.x.mul(cs).sub(z.y.mul(sn)), z.x.mul(sn).add(z.y.mul(cs)), z.z));

    tx.assign(min(tx, abs(z.x)));
    ty.assign(min(ty, abs(z.z)));
    tz.assign(min(tz, dot(z, z)));

    If(dot(z, z).greaterThan(4096.0), () => { Break(); });
  });

  const d = length(z).div(abs(dr).max(1e-6));

  return vec4(d, clamp(tx.mul(0.55), 0, 1), clamp(ty.mul(0.55), 0, 1), clamp(sqrt(tz).mul(0.42), 0, 1));
});

deMandelbox.setLayout({
  name: 'deMandelbox', type: 'vec4',
  inputs: [{ name: 'p', type: 'vec3' }, { name: 'A', type: 'vec4' }, { name: 'B', type: 'vec4' }],
});

export default deMandelbox;
