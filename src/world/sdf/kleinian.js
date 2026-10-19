/**
 * KLEINIAN LIMIT SET — the deepest, least-euclidean dimension.
 *
 * Knighty's Kleinian-group fold: box-clamp, then sphere-invert, then translate.
 * The limit set of the group is a fractal *surface with no interior* — it has
 * corridors that connect to themselves, and horizons that are made of copies
 * of the corridor you are currently in. Nothing here has an "up".
 *
 *   A = ( cSizeX, cSizeY, cSizeZ, invRadius )
 *   B = ( offsetX, offsetY, offsetZ, thickness )
 *
 * The final distance mixes a cylinder trap and a half-space trap, which is what
 * produces the characteristic "hall of tubes that is also a plane" reading.
 *
 * NOTE: the DE is *not* a strict lower bound near the limit set. The marcher
 * compensates with a step-scale < 1 for this dimension.
 */
import {
  Fn, If, Loop, Break, vec3, vec4, float,
  abs, max, min, clamp, dot, length, sqrt, mix,
} from 'three/tsl';

export const deKleinian = Fn(([p, A, B]) => {
  const cs = A.xyz.toVar('cs');
  const invR = A.w.max(0.05).toVar();
  const off = B.xyz.toVar('off');
  const thick = B.w.toVar();

  const z = p.toVar('z');
  const def = float(1).toVar('def');
  const tx = float(1e6).toVar('tx');
  const ty = float(1e6).toVar('ty');
  const tz = float(1e6).toVar('tz');

  Loop({ start: 0, end: 10, type: 'int' }, () => {
    z.assign(clamp(z, cs.negate(), cs).mul(2.0).sub(z));

    const r2 = dot(z, z).max(1e-6).toVar();
    const k = max(invR.div(r2), 1.0).toVar();
    z.mulAssign(k);
    def.mulAssign(k);
    z.addAssign(off);

    tx.assign(min(tx, abs(z.x)));
    ty.assign(min(ty, abs(z.y)));
    tz.assign(min(tz, r2));

    If(def.greaterThan(1e6), () => { Break(); });
  });

  const rxy = length(z.xy).toVar();
  const d = float(0.5).mul(max(rxy.sub(thick), rxy.mul(z.z).div(length(z).max(1e-6))))
    .div(def.max(1e-6));

  return vec4(d, clamp(tx.mul(1.1), 0, 1), clamp(ty.mul(1.1), 0, 1), clamp(sqrt(tz).mul(0.8), 0, 1));
});

deKleinian.setLayout({
  name: 'deKleinian', type: 'vec4',
  inputs: [{ name: 'p', type: 'vec3' }, { name: 'A', type: 'vec4' }, { name: 'B', type: 'vec4' }],
});

export default deKleinian;
