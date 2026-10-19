/**
 * The five dimensions, as data.
 *
 * Both the GPU raymarcher (`world/Fractal.js`) and the CPU distance mirror
 * (`util/fractal-de.js`) read these *same numbers*, which is the only reason
 * `distanceAt()` agrees with what you can see on screen.
 *
 * `A` / `B` are the two vec4 parameter bundles handed to the distance
 * estimator — see the header of each file in `world/sdf/`.
 *
 * Field notes:
 *   scale     world units per fractal unit. The fractal lives in a ~±2 box;
 *             scale 140 means the structure is ~560 m across.
 *   origin    where that box sits in world space. Fractal.js slides this to
 *             keep the player inside the interesting part.
 *   repeat    domain repetition period in *fractal* units; 0 = off. Repetition
 *             breaks the Lipschitz bound, hence the lower `stepScale`.
 *   epsRel    hit threshold as a fraction of ray distance — this is the main
 *             quality/perf dial. 0.0012 ≈ one pixel at 1080p half-res.
 *   stepScale <1 for folding DEs that overshoot. Kleinian needs 0.6.
 */

export const DIMENSIONS = [
  {
    id: 'cathedral',
    name: 'I — MANDELBULB CATHEDRAL',
    de: 0,
    // power, bailout, juliaBlend, shellPhase
    A: [8.0, 2.6, 0.0, 0.0],
    B: [0.32, -0.18, 0.44, 0.0],
    scale: 250, origin: [170, -70, 0], anchorAhead: 1050, rot: [0.0, 0.0, 0.0],
    repeat: [0, 0, 0],
    epsRel: 0.0011, stepScale: 0.92, fogDensity: 0.0026,
    palette: {
      a: 0x07213a, b: 0x11d8ff, c: 0xff2fa8,
      rim: 0x9ce8ff, glow: 0x1a6ea8,
      fogNear: 0x050c18, fogFar: 0x01030a,
    },
    band: [7.0, 0.0], irid: 3.4, rimStrength: 2.6, coreEmis: 0.9,
    glowStrength: 0.55, sunDir: [0.5, 0.62, -0.6],
  },
  {
    id: 'corridors',
    name: 'II — MANDELBOX CORRIDORS',
    de: 1,
    // scale, minR2, fixedR2, foldLimit
    A: [-2.62, 0.34, 1.0, 1.0],
    B: [0.0, 0.0, 0.0, 0.035],
    scale: 46, origin: [0, 0, 0], anchorAhead: 170, rot: [0.0, 0.0, 0.0],
    repeat: [0, 0, 0],
    epsRel: 0.0013, stepScale: 0.86, fogDensity: 0.006,
    palette: {
      a: 0x1c0526, b: 0xff2f6b, c: 0xffc24a,
      rim: 0xff7ad0, glow: 0x8a1c5c,
      fogNear: 0x0d0410, fogFar: 0x030106,
    },
    band: [9.0, 1.6], irid: 4.2, rimStrength: 2.4, coreEmis: 1.1,
    glowStrength: 0.7, sunDir: [-0.4, 0.5, -0.76],
  },
  {
    id: 'void',
    name: 'III — APOLLONIAN VOID',
    de: 2,
    // s, foldSkew, planeMix, iterFade
    A: [1.22, 0.06, 0.35, 0.0],
    B: [0.0, 0.0, 0.0, 0.0],
    scale: 34, origin: [0, 0, 0], anchorAhead: 300, rot: [0.3, 0.0, 0.15],
    repeat: [0, 0, 0],
    epsRel: 0.0014, stepScale: 0.8, fogDensity: 0.008,
    palette: {
      a: 0x02120f, b: 0x22ffc3, c: 0xf7f2c8,
      rim: 0x6effe0, glow: 0x0e6b5a,
      fogNear: 0x02100d, fogFar: 0x000403,
    },
    band: [11.0, 2.4], irid: 5.0, rimStrength: 2.2, coreEmis: 1.5,
    glowStrength: 0.85, sunDir: [0.2, -0.8, -0.56],
  },
  {
    id: 'reliquary',
    name: 'IV — MENGER RELIQUARY',
    de: 3,
    // baseSize, thickness, jerusalemMix, iterTwist
    A: [1.0, 1.0, 0.34, 0.11],
    B: [0.0, 0.0, 0.0, 0.05],
    scale: 110, origin: [-90, -60, 0], anchorAhead: 430, rot: [0.22, 0.0, 0.0],
    repeat: [0, 0, 0],
    epsRel: 0.0012, stepScale: 0.9, fogDensity: 0.0055,
    palette: {
      a: 0x120b02, b: 0xffb229, c: 0x2f6bff,
      rim: 0xffd98a, glow: 0x8a5a12,
      fogNear: 0x0a0710, fogFar: 0x020208,
    },
    band: [6.0, 0.8], irid: 2.6, rimStrength: 2.4, coreEmis: 0.8,
    glowStrength: 0.5, sunDir: [0.62, 0.44, -0.65],
  },
  {
    id: 'limitset',
    name: 'V — KLEINIAN LIMIT SET',
    de: 4,
    // cSizeX, cSizeY, cSizeZ, invRadius
    A: [0.808, 0.808, 1.137, 0.94],
    B: [-0.532, -0.156, -0.148, 0.7],
    scale: 26, origin: [0, 0, 0], anchorAhead: 260, rot: [0.0, 0.0, 0.0],
    repeat: [0, 0, 0],
    epsRel: 0.0016, stepScale: 0.6, fogDensity: 0.012,
    palette: {
      a: 0x1a0320, b: 0xff4bd8, c: 0x28f0ff,
      rim: 0xffa8f0, glow: 0x5c1a7a,
      fogNear: 0x0a0212, fogFar: 0x020006,
    },
    band: [13.0, 3.1], irid: 6.0, rimStrength: 3.4, coreEmis: 1.9,
    glowStrength: 0.95, sunDir: [-0.3, 0.2, -0.93],
  },
];

export default DIMENSIONS;
