/**
 * APOLLONIAN GASKET — the "impossible machine" void.
 *
 * Kaleidoscopic inversion IFS (after Iñigo Quílez's classic): fold space into
 * the unit cell, invert about the origin, repeat. What falls out is a nest of
 * mutually-tangent spheres at every scale — a machine with no smallest part.
 *
 *   A = ( s, foldSkew, planeMix, iterFade )
 *        s        1.0 .. 1.6   the inversion radius; the single most
 *                              expressive parameter (1.2 is the sweet spot)
 *        foldSkew              breaks the perfect lattice symmetry
 *        planeMix  0..1        blends the DE between the y-plane trap (open,
 *                              cavernous) and a radial trap (closed, beady)
 *   B = ( offX, offY, offZ, twist )
 *
 * Orbit traps: |p.x|, |p.z| and r², captured at the *tightest* iterate — this
 * is what draws the concentric rings inside every sphere.
 */
import {
  Fn, If, Loop, Break, vec3, vec4, float,
  abs, max, min, clamp, dot, length, fract, sin, cos, sqrt, mix,
} from 'three/tsl';

export const deApollonian = Fn(([p, A, B]) => {
  const s = A.x.toVar();
  const skew = A.y.toVar();
  const planeMix = A.z.toVar();

  const z = p.add(B.xyz).toVar('z');
  const scale = float(1).toVar('scale');
  const tx = float(1e6).toVar('tx');
  const ty = float(1e6).toVar('ty');
  const tz = float(1e6).toVar('tz');

  Loop({ start: 0, end: 8, type: 'int' }, () => {
    z.assign(fract(z.mul(0.5).add(0.5)).mul(2.0).sub(1.0));

    // asymmetry: a slight shear per iteration so it never reads as a grid
    z.assign(vec3(z.x.add(z.y.mul(skew)), z.y, z.z.sub(z.y.mul(skew))));

    const r2 = dot(z, z).max(1e-6).toVar();
    tx.assign(min(tx, abs(z.x)));
    ty.assign(min(ty, abs(z.z)));
    tz.assign(min(tz, r2));

    const k = s.div(r2).toVar();
    z.mulAssign(k);
    scale.mulAssign(k);

    If(scale.greaterThan(1e7), () => { Break(); });
  });

  // Two readings of the same orbit: a plane trap (open caverns) and a tube
  // trap (beaded tendrils). Blending them re-shapes the whole space.
  const dPlane = float(0.25).mul(abs(z.y)).div(scale).toVar();
  const dTube = length(z.xz).sub(0.06).mul(0.25).div(scale).toVar();
  const d = mix(dPlane, max(dPlane, dTube), planeMix).toVar();

  return vec4(d, clamp(tx.mul(1.9), 0, 1), clamp(ty.mul(1.9), 0, 1), clamp(sqrt(tz).mul(1.25), 0, 1));
});

deApollonian.setLayout({
  name: 'deApollonian', type: 'vec4',
  inputs: [{ name: 'p', type: 'vec3' }, { name: 'A', type: 'vec4' }, { name: 'B', type: 'vec4' }],
});

export default deApollonian;
