import * as THREE from 'three';
import {
  neonGlass, clockworkBrass, sacredGeometry, fractalShell, hostileEnergy, voidMatte,
} from '../render/Materials.js';
import { lathe, jewel, gear, shardRing, compose } from './enemy-geometry.js';

/**
 * Material showcase grid — a dev-only diagnostic (enabled via the SHOWCASE
 * flag in render/Materials.js). Rows of jewelled test subjects under a
 * lattice so transmission/dispersion have something to bend.
 */
export function buildShowcase(ctx) {
  const group = new THREE.Group();
  group.name = 'matShowcase';

  const bodyGeo = compose([
    { geo: jewel({ sides: 7, seed: 3, height: 1.0, radius: 0.5 }), p: [0, 0, 0] },
    { geo: shardRing({ count: 6, radius: 0.7, size: 0.1, seed: 5 }), p: [0, 0, 0] },
  ]);
  const brassGeo = gear({ teeth: 11, rOuter: 0.5, rInner: 0.34, thick: 0.08, seed: 7, gap: 1 });
  const latheGeo = lathe({ sides: 8, seed: 9, profile: [[0, -1], [0.7, -0.5], [0.9, 0.2], [0.4, 0.8], [0, 1.2]] });

  const rows = [
    neonGlass({}),
    neonGlass({ tint: 'accent', core: 'key' }),
    clockworkBrass({}),
    sacredGeometry({}),
    fractalShell({}),
    hostileEnergy({}),
    voidMatte({}),
  ];
  const geos = [bodyGeo, bodyGeo, brassGeo, latheGeo, latheGeo, bodyGeo, latheGeo];

  rows.forEach((mat, i) => {
    const mesh = new THREE.Mesh(geos[i], mat);
    const a = (i / rows.length) * Math.PI * 2;
    mesh.position.set(Math.cos(a) * 7, 0, Math.sin(a) * 7);
    group.add(mesh);
  });

  // backdrop lattice — gives glass something to refract
  const lat = sacredGeometry({ freq: 8, intensity: 1.4 });
  const back = new THREE.Mesh(new THREE.PlaneGeometry(30, 12), lat);
  back.position.set(0, 0, -10);
  group.add(back);

  ctx.world.add(group);
  if (ctx.camera) { ctx.camera.position.set(0, 4, 14); ctx.camera.lookAt(0, 0, 0); }

  return {
    update(dt) { group.rotation.y += dt * 0.1; },
    dispose() { ctx.world.remove(group); },
  };
}
export default buildShowcase;
