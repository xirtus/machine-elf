/**
 * mat-oklch.js — perceptual colour for the palette system.
 *
 * OWNER: materials agent.
 *
 * Interpolating hex colours through sRGB is the single most reliable way to make
 * a game look cheap: cyan→magenta passes through mud, and equal RGB steps are
 * not equal perceptual steps so gradients band. Everything the art direction
 * touches is authored in OKLCH (perceptual lightness, chroma, hue) and converted
 * to *linear* sRGB exactly once, at the point a THREE.Color is written.
 *
 * All functions are allocation-free except where a target object is not supplied.
 */

/* scratch — module scope so nothing allocates in a transition loop */
const _lab = { L: 0, a: 0, b: 0 };
const _rgb = { r: 0, g: 0, b: 0 };
const DEG = Math.PI / 180;

/** OKLCH → OKLab (in place into out). h in degrees. */
export function lchToLab(L, C, h, out = _lab) {
  const r = h * DEG;
  out.L = L; out.a = C * Math.cos(r); out.b = C * Math.sin(r);
  return out;
}

/** OKLab → linear-sRGB. Components may fall outside [0,1] (out of gamut). */
export function labToLinear(L, a, b, out = _rgb) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  out.r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  out.g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  out.b = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  return out;
}

/** linear-sRGB → OKLab. */
export function linearToLab(r, g, b, out = _lab) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  out.L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  out.a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  out.b = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return out;
}

const inGamut = (c, eps = 1e-4) =>
  c.r >= -eps && c.g >= -eps && c.b >= -eps &&
  c.r <= 1 + eps && c.g <= 1 + eps && c.b <= 1 + eps;

/**
 * OKLCH → linear sRGB with gamut mapping: if the requested chroma is not
 * displayable, chroma is reduced (lightness and hue preserved) rather than the
 * channels being clipped — clipping shifts hue, which is exactly the artefact
 * that makes saturated neon go orange-ish at the top end.
 */
export function oklchToLinear(L, C, h, out = { r: 0, g: 0, b: 0 }) {
  lchToLab(L, C, h, _lab);
  labToLinear(_lab.L, _lab.a, _lab.b, out);
  if (inGamut(out)) return clamp01(out);

  let lo = 0, hi = C;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) * 0.5;
    lchToLab(L, mid, h, _lab);
    labToLinear(_lab.L, _lab.a, _lab.b, out);
    if (inGamut(out)) lo = mid; else hi = mid;
  }
  lchToLab(L, lo, h, _lab);
  labToLinear(_lab.L, _lab.a, _lab.b, out);
  return clamp01(out);
}

function clamp01(c) {
  c.r = c.r < 0 ? 0 : c.r > 1 ? 1 : c.r;
  c.g = c.g < 0 ? 0 : c.g > 1 ? 1 : c.g;
  c.b = c.b < 0 ? 0 : c.b > 1 ? 1 : c.b;
  return c;
}

/** Shortest-arc hue interpolation in degrees. */
export function lerpHue(a, b, t) {
  let d = ((b - a) % 360 + 540) % 360 - 180;
  return a + d * t;
}

/**
 * Interpolate two OKLCH triples. Lightness and chroma linearly, hue along the
 * short arc. If either endpoint is near-achromatic its hue is ignored so greys
 * don't drag the transition through an arbitrary hue.
 */
export function lerpLCH(A, B, t, out = [0, 0, 0]) {
  const [L0, C0, H0] = A, [L1, C1, H1] = B;
  out[0] = L0 + (L1 - L0) * t;
  out[1] = C0 + (C1 - C0) * t;
  const h0 = C0 < 0.012 ? H1 : H0;
  const h1 = C1 < 0.012 ? H0 : H1;
  out[2] = lerpHue(h0, h1, t);
  return out;
}

/** Convenience: OKLCH → '#rrggbb' (sRGB-encoded, for CSS/HUD). */
export function oklchToHex(L, C, h) {
  const c = oklchToLinear(L, C, h, { r: 0, g: 0, b: 0 });
  const e = (v) => {
    const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.round(Math.max(0, Math.min(1, s)) * 255);
  };
  return `#${((e(c.r) << 16) | (e(c.g) << 8) | e(c.b)).toString(16).padStart(6, '0')}`;
}

/** Perceptual distance between two OKLCH triples (for palette QA). */
export function lchDistance(A, B) {
  const a = lchToLab(A[0], A[1], A[2], { L: 0, a: 0, b: 0 });
  const b = lchToLab(B[0], B[1], B[2], { L: 0, a: 0, b: 0 });
  const dL = a.L - b.L, da = a.a - b.a, db = a.b - b.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

export default { lchToLab, labToLinear, linearToLab, oklchToLinear, lerpLCH, lerpHue, oklchToHex, lchDistance };
