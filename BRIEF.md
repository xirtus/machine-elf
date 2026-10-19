# MACHINE ELF — Shared Build Brief

Read this fully before writing a line. Every agent builds against this contract.

---

## 1. The game

A 3D **rail shooter** — on-rails cinematic flight, lock-on laser salvos, grazing,
huge bosses. Lineage: *Panzer Dragoon Orta*, *Rez*, *Sin & Punishment*, *Sky Fang*.

**World:** DMT hyperspace. You descend through recursive fractal dimensions.
Inhabitants are **clockwork elves made of neon glass** — jewelled automata with
brass escapements visible inside translucent bodies, too many joints, moving in
stop-motion staccato. The terrain *is* mathematics: Mandelbulb cathedrals,
Mandelbox corridors, Apollonian gasket voids. Bosses are not placed in the world —
they **emerge from the geometry itself**, the fractal folding into a face.

Each dimension descends further from euclidean sanity. Dimension 1 still has a
horizon and a sense of up. By dimension 5 there is no up, space is self-similar
at three scales at once, and the geometry breathes.

---

## 2. Art direction — the bar

The failure mode is **"competent tech demo."** Specific bans:

- ❌ **Bloom soup.** Emissive is a scalpel, not a wash. Most of the frame must be
  *dark*. Neon reads as neon only against black. If >30% of pixels are above 0.7
  luma, it's wrong.
- ❌ **Rainbow vomit.** Use the palette system (`render/Palette.js`). Each dimension
  gets 3–4 hues MAX, plus black. Cyan+magenta+black is a palette. Full-spectrum
  hue cycling is a screensaver.
- ❌ **Default Three.js geometry.** No untouched `TorusKnotGeometry`, `BoxGeometry`,
  `SphereGeometry` with a colored material. Every silhouette must be authored or
  procedurally derived. If it looks like a shape primitive, it is wrong.
- ❌ **Uniform motion.** Nothing moves at constant speed. Clockwork elves tick in
  discrete steps with overshoot. Fractals unfold in eased pulses. Constant linear
  rotation is the #1 tell of AI-generated 3D.
- ❌ **Symmetry everywhere.** Break it. Asymmetric detail is what reads as "designed."
- ❌ **Flat lighting.** Rim light, fresnel, interior scatter, or it looks like clay.

The targets, positively stated:

- ✅ **Silhouette first.** Every enemy/boss recognizable as a black shape.
- ✅ **Depth via haze.** Distance fog with hue shift. Layers must separate.
- ✅ **Contrast of scale.** Tiny fast elves against a boss that fills the screen.
- ✅ **Anticipation & follow-through** on every animation. Nothing snaps to a pose
  without a wind-up and a settle.
- ✅ **Material honesty.** Glass refracts and disperses. Brass has anisotropic
  highlights. Neon has falloff. Use `MeshPhysicalNodeMaterial` transmission/
  iridescence/dispersion — this is the money material for the elves.
- ✅ **Readability under chaos.** Player bullets, enemy bullets and scenery must
  never be confusable. Enemy bullets: hot, saturated, high-contrast, always with a
  dark outline/core. Scenery never uses that hue.

---

## 3. Tech constraints — non-negotiable

- **three r185.1**, `three/webgpu` + `three/tsl`. WebGPU backend (WebGL2 fallback
  is automatic; don't code for it specifically).
- **TSL only.** No raw GLSL/WGSL strings. No `ShaderMaterial`. Use `*NodeMaterial`.
- **ESM, plain JS.** No TypeScript. No new npm dependencies — ask first.
- **No external assets.** No image/model/audio file loading. Everything procedural:
  geometry generated in code, textures generated in TSL or on canvas, audio
  synthesized with WebAudio. This is a hard requirement — the build must run from
  source with zero binary assets.
- **60fps at 1080p** on Apple Silicon. Budget below.

### Performance budget

| Resource | Budget |
|---|---|
| Draw calls | < 220 |
| Triangles | < 1.8M |
| Compute passes | < 8 |
| Post passes | < 12 |
| Raymarch steps | ≤ 96, at ≤ half res |

Use `InstancedMesh` for anything appearing >8 times. Pool everything — zero
allocation in `update()`. No `new THREE.Vector3()` inside a frame loop; hoist to
module-scope scratch objects.

---

## 4. Module contract

Registered in `src/main.js`, run by `src/core/Engine.js`. Implement any of:

```js
export class Thing {
  constructor() { this.name = 'thing'; this.order = 50; }
  async init(ctx) {}            // build scene content
  update(dt, ctx) {}            // scaled gameplay step
  lateUpdate(dt, ctx) {}        // after all updates (camera, HUD)
  resize(w, h, ctx) {}
  dispose() {}
}
export default Thing;
```

`ctx = { engine, renderer, scene, camera, world, fx, bus, time, input, cfg }`

- `world` — Group for scene content; shifted during dimension transitions.
- `fx` — Group for additive effects; renders after opaque.
- `dt` is **time-scaled** (0 during hitstop). Use `time.rawDt` for anything that
  must keep moving while frozen (camera shake, UI).

Access another module: `ctx.engine.get('rail')`. Never import another module's
class directly — go through `engine.get()` so load order stays flexible.

### Cross-module APIs you may rely on

```js
engine.get('rail')                        // → Rail
  .sample(t)                              // → {position:Vec3, tangent:Vec3, normal:Vec3, binormal:Vec3}
  .distance                               // scalar, metres travelled along spline
  .speed                                  // current forward speed

engine.get('player')                      // → Player
  .position                               // world Vec3 (read-only)
  .cageOffset                             // Vec2, -1..1 within the movement cage
  .isBoosting, .health, .invulnerable

engine.get('enemies')                     // → Enemies
  .spawn(typeId, opts)                    // → enemy handle
  .active                                 // array of live enemies
  .queryScreen(ndc, radius)               // → enemies near an NDC point, for lock-on

engine.get('particles').burst(kind, position, opts)
engine.get('audio').cue(id, opts)
engine.get('postfx').setPsych(v) / .setWarp(v) / .flash(a)
```

Every enemy/boss **must** expose: `.position` (Vec3), `.radius` (number),
`.hp`, `.alive`, `.takeDamage(n, hitPoint)`, `.lockable` (bool).

---

## 5. Event bus

`import Bus from '../core/Bus.js'` — `Bus.on(name, fn)`, `Bus.emit(name, payload)`.
Canonical events are listed at the top of `src/core/Bus.js`. **Add new events to
that doc comment** when you introduce them.

Emit generously. Audio, particles, HUD and camera all react to events rather than
polling — that's how a hit feels like it lands in every system at once.

---

## 6. TSL cheat sheet — r185 exact API

This is where builds break. Do not improvise; these are verified exports.

```js
import {
  Fn, If, Loop, Break, Return, Switch,
  vec2, vec3, vec4, float, int, uint, bool, mat3, mat4, color,
  uniform, uniformArray, attribute, varying, property,
  positionLocal, positionWorld, positionView, positionGeometry,
  normalLocal, normalWorld, normalView, normalGeometry,
  tangentLocal, bitangentLocal,
  cameraPosition, cameraProjectionMatrix, cameraViewMatrix,
  modelWorldMatrix, modelViewProjection, modelWorldMatrixInverse,
  uv, screenUV, screenCoordinate, screenSize, viewportUV,
  time, deltaTime, frameId, instanceIndex, vertexIndex,
  texture, textureLoad, texture3D, cubeTexture, storageTexture,
  storage, instancedArray, workgroupArray, atomicAdd,
  sin, cos, tan, atan, asin, acos, abs, sign, floor, ceil, fract, round, trunc,
  min, max, clamp, saturate, mix, step, smoothstep, sqrt, inverseSqrt,
  pow, pow2, pow3, exp, exp2, log, log2, mod, length, lengthSq, distance,
  dot, cross, normalize, reflect, refract, faceForward, transpose, inverse,
  oneMinus, negate, reciprocal, degrees, radians, cbrt,
  select, and, or, not, equal, lessThan, greaterThan, greaterThanEqual,
  rotate, rotateUV, spherizeUV, matcapUV, triplanarTexture,
  hash, rand, mx_noise_float, mx_noise_vec3, mx_fractal_noise_float,
  mx_fractal_noise_vec3, mx_worley_noise_float, mx_cell_noise_float,
  oscSine, oscSawtooth, oscTriangle, oscSquare,
  luminance, saturation, hue, vibrance, posterize, grayscale, remap, remapClamp,
  blendScreen, blendOverlay, blendDodge, blendBurn,
  Discard, output, emissive, mrt, pass, mix, dFdx, dFdy, fwidth,
  positionWorldDirection, positionViewDirection, transformDirection,
  cameraNear, cameraFar, linearDepth, viewportDepthTexture, viewportSharedTexture,
} from 'three/tsl';

import {
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshBasicNodeMaterial,
  MeshNormalNodeMaterial, SpriteNodeMaterial, PointsNodeMaterial,
  LineBasicNodeMaterial, Line2NodeMaterial, VolumeNodeMaterial,
  WebGPURenderer, PostProcessing, StorageBufferAttribute, StorageInstancedBufferAttribute,
} from 'three/webgpu';
```

### Rules that trip people up

**No operators.** `a + b` is `a.add(b)`. Chain everything.
```js
const n = positionWorld.mul(0.4).add(time.mul(0.2)).sin().mul(0.5).add(0.5);
```

**`Fn` returns a factory — you must call it.**
```js
const glow = Fn(() => { return vec3(1,0,1); });
material.emissiveNode = glow();            // ✅ note the ()
```

**`Fn` with typed params:**
```js
const sdBox = Fn(([p, b]) => {
  const q = p.abs().sub(b);
  return q.max(vec3(0)).length().add(q.x.max(q.y).max(q.z).min(0));
});
sdBox.setLayout({
  name: 'sdBox', type: 'float',
  inputs: [ {name:'p', type:'vec3'}, {name:'b', type:'vec3'} ]
});
// setLayout is OPTIONAL but makes generated code far cleaner + faster to compile.
```

**Mutable locals need `.toVar()`:**
```js
const t = float(0).toVar();
t.addAssign(0.1);          // ✅
const p = positionLocal.toVar('p');
p.assign(p.mul(2));
```

**Control flow:**
```js
If(d.lessThan(0.001), () => { Break(); })
  .ElseIf(d.greaterThan(100), () => { Break(); })
  .Else(() => { total.addAssign(d); });

Loop({ start: 0, end: 96, type: 'int' }, ({ i }) => {
  // i is an int node
});
Loop(96, ({ i }) => { /* shorthand */ });
```

**Uniforms are live-settable from JS:**
```js
this.uTime = uniform(0);
mat.colorNode = someFn(this.uTime);
// later, in update():
this.uTime.value = t;                       // ✅ no recompile
```
Changing a *node graph* recompiles the shader (frame hitch). Changing `.value`
does not. **Animate via uniforms, never by rebuilding nodes.**

**Compute shaders:**
```js
const positions = instancedArray(COUNT, 'vec3');
const velocities = instancedArray(COUNT, 'vec3');

const updateFn = Fn(() => {
  const p = positions.element(instanceIndex);
  const v = velocities.element(instanceIndex);
  p.addAssign(v.mul(deltaTime));
})().compute(COUNT);

// each frame:
renderer.compute(updateFn);

// render them:
const mat = new SpriteNodeMaterial();
mat.positionNode = positions.element(instanceIndex);   // via instancing
```

**Material node slots:** `colorNode`, `emissiveNode`, `roughnessNode`,
`metalnessNode`, `normalNode`, `opacityNode`, `positionNode` (object-space vertex
displacement), `vertexNode` (full clip-space override), `fragmentNode` (bypasses
all lighting), `outputNode`, plus physical: `transmissionNode`, `thicknessNode`,
`iorNode`, `iridescenceNode`, `dispersionNode`, `clearcoatNode`, `sheenNode`,
`anisotropyNode`, `attenuationColorNode`, `attenuationDistanceNode`.

**Emissive feeds bloom.** `PostFX` reads the MRT `emissive` buffer. If you want
something to glow, it must write `emissiveNode`. A bright `colorNode` will NOT
bloom. Keep emissive values in 0–4; the two-tier bloom amplifies from there.

**Debugging a shader:** `material.fragmentNode = vec4(myValue, 1)` to visualize.
Console shows WGSL compile errors with line numbers — read them, the generated
source is available via `material.fragmentNode.build?.()` or the renderer's
`.debug` flag.

---

## 7. File ownership — DO NOT EDIT FILES YOU DON'T OWN

Conflicts will destroy parallel work. Each agent owns a disjoint set.
Need a change in someone else's file? **Report it, don't make it.**

| Owner | Files |
|---|---|
| *(orchestrator only)* | `src/main.js`, `src/core/*`, `BRIEF.md` |
| fractal | `src/world/Fractal.js`, `src/world/sdf/*` |
| dimensions | `src/world/Dimensions.js`, `src/world/Sky.js` |
| materials | `src/render/Materials.js`, `src/render/Palette.js` |
| rail | `src/game/Rail.js`, `src/game/CameraRig.js` |
| player | `src/game/Player.js`, `src/game/craft/*` |
| weapons | `src/game/Weapons.js`, `src/game/Reticle.js` |
| enemies | `src/game/Enemies.js`, `src/game/Graze.js`, `src/game/enemy/*` |
| bosses | `src/game/Bosses.js`, `src/game/boss/*` |
| fx | `src/fx/Particles.js`, `src/fx/Trails.js`, `src/fx/Impacts.js` |
| audio | `src/audio/*` |
| ui | `src/game/HUD.js`, `src/game/Director.js` |
| postfx | `src/render/PostFX.js` |

Shared helpers go in `src/util/` — **create new files there**, never edit another
agent's util. Prefix with your domain: `src/util/fractal-sdf.js`.

---

## 8. Verifying your work

Dev server runs at **http://localhost:5183** (already running — Vite HMR is live,
just save and it reloads). Check it. Actually look at it.

```js
// in the browser console
__engine.renderer.info          // draw calls, triangles
__engine.get('yourmodule')      // your instance
__bus.emit('dimension:enter', {index: 3})
__cfg.debug.hitboxes = true
```

**Before you report done:**
1. Page loads with **zero console errors**. Check. A WGSL compile error kills the
   whole frame, not just your material.
2. Your system is visibly doing what you claim, at 60fps.
3. `__engine.renderer.info.render.drawCalls` hasn't ballooned.
4. You have looked at it and it does not look cheap.

Report back: what you built, what it looks like, what's still weak, and any change
you need from a file you don't own.
