/**
 * MANDELBULB — the cathedral. Power-8 by default but the power is a live
 * uniform, so `Dimensions` can breathe it between 3 and 12 and the whole
 * skyline unfolds.
 *
 *   A = ( power, bailout, juliaBlend, shellPhase )
 *   B = ( juliaC.x, juliaC.y, juliaC.z, unused )
 *
 * Setting `juliaBlend` > 0 lerps the additive constant from `p` (Mandelbrot,
 * a single bounded solid) toward a fixed C (Julia, an unbounded lattice of
 * tendrils you can actually fly through). That one slider is the difference
 * between "an object in the distance" and "a world around you".
 *
 * Orbit traps:
 *   t0  min |z.x|           → thin vertical filigree
 *   t1  min |z.xz| radius   → shell banding
 *   t2  min dot(z,z)        → the classic bulb "core glow"
 */
import {
  Fn, If, Loop, Break, vec3, vec4, float,
  abs, max, min, clamp, dot, length, sin, cos, atan, acos, pow, log, sqrt, mix,
} from 'three/tsl';

export const deMandelbulb = Fn(([p, A, B]) => {
  const power = A.x.toVar();
  const bail = A.y.max(1.2).toVar();
  const c = mix(p, B.xyz, A.z).toVar('c');

  const z = p.toVar('z');
  const dr = float(1).toVar('dr');
  const r = float(0).toVar('r');
  const tx = float(1e6).toVar('tx');
  const ty = float(1e6).toVar('ty');
  const tz = float(1e6).toVar('tz');
  const it = float(0).toVar('it');

  Loop({ start: 0, end: 9, type: 'int' }, () => {
    r.assign(length(z));
    If(r.greaterThan(bail), () => { Break(); });

    // derivative of |z|^power
    dr.assign(pow(r, power.sub(1.0)).mul(power).mul(dr).add(1.0));

    const theta = acos(clamp(z.z.div(r.max(1e-7)), -1.0, 1.0)).mul(power).toVar();
    const phi = atan(z.y, z.x).mul(power).add(A.w).toVar();
    const zr = pow(r, power).toVar();
    const st = sin(theta).toVar();

    z.assign(vec3(st.mul(cos(phi)), st.mul(sin(phi)), cos(theta)).mul(zr).add(c));

    tx.assign(min(tx, abs(z.x)));
    ty.assign(min(ty, length(z.xz)));
    tz.assign(min(tz, dot(z, z)));
    it.addAssign(1.0);
  });

  // Analytic Douady–Hubbard distance estimate.
  const d = float(0.5).mul(log(r.max(1e-6))).mul(r).div(dr.max(1e-6));

  return vec4(d, clamp(tx.mul(1.6), 0, 1), clamp(ty.mul(0.85), 0, 1), clamp(sqrt(tz).mul(0.9), 0, 1));
});

deMandelbulb.setLayout({
  name: 'deMandelbulb', type: 'vec4',
  inputs: [{ name: 'p', type: 'vec3' }, { name: 'A', type: 'vec4' }, { name: 'B', type: 'vec4' }],
});

export default deMandelbulb;
