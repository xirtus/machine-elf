/**
 * Pitch material for the generative score.
 *
 * Everything in the audio system that makes a pitch goes through here, so that
 * gameplay sounds (lock ticks, hits, grazes) land in the same key as the music.
 * That is the whole Rez trick: shooting is playing.
 *
 * Degrees are *scale* degrees, not semitones, and they wrap across octaves —
 * `degree 9` in a 7-note mode is the 3rd degree one octave up. Negative degrees
 * work too. This lets a lock-on chain of 8 just be degrees 0..7 and always
 * sound like a run up the mode.
 */

export const SCALES = {
  // consonant, still has a floor under it
  dorian:      [0, 2, 3, 5, 7, 9, 10],
  aeolian:     [0, 2, 3, 5, 7, 8, 10],
  phrygian:    [0, 1, 3, 5, 7, 8, 10],
  pentaMinor:  [0, 3, 5, 7, 10],
  // no tonic, no gravity — first step away from euclidean sanity
  wholeTone:   [0, 2, 4, 6, 8, 10],
  // symmetric, endlessly self-similar: the fractal scale
  octatonic:   [0, 1, 3, 4, 6, 7, 9, 10],
  // messiaen 3rd mode — three identical cells, breathes at three scales
  mode3:       [0, 2, 3, 4, 6, 7, 8, 10, 11],
  // wide inharmonic leaps for the deepest layer
  alien:       [0, 1, 4, 6, 7, 11],
};

/**
 * Per-degree cent offsets. Applied on top of the 12-TET scale so the deeper
 * dimensions drift off the grid without losing their harmonic identity.
 * Values are irrational-ish and deliberately non-repeating.
 */
export const MICROTONAL = [0, -13.7, 8.2, -21.4, 15.9, -6.3, 27.1, -18.5, 4.4, -31.2];

export const A4 = 440;

export function midiToFreq(m) {
  return A4 * Math.pow(2, (m - 69) / 12);
}

export function freqToMidi(f) {
  return 69 + 12 * Math.log2(f / A4);
}

/** Note name → midi. 'D3' → 50. Used only for readable dimension defs. */
const NOTE_IDX = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export function noteToMidi(name) {
  const m = /^([A-G])([#b]?)(-?\d+)$/.exec(name);
  if (!m) return 60;
  let v = NOTE_IDX[m[1]];
  if (m[2] === '#') v += 1;
  else if (m[2] === 'b') v -= 1;
  return v + (parseInt(m[3], 10) + 1) * 12;
}

/**
 * Scale degree → midi note (float; may carry microtonal cents as a fraction).
 * @param {number} root   root midi note
 * @param {number[]} scale semitone offsets
 * @param {number} degree  scale degree, wraps octaves, may be negative
 * @param {number} detune  0..1 amount of microtonal drift to apply
 */
export function degreeToMidi(root, scale, degree, detune = 0) {
  const n = scale.length;
  const d = Math.round(degree);
  const oct = Math.floor(d / n);
  let i = d - oct * n;
  if (i < 0) i += n;
  let midi = root + oct * 12 + scale[i];
  if (detune > 0) midi += (MICROTONAL[i % MICROTONAL.length] / 100) * detune;
  return midi;
}

export function degreeToFreq(root, scale, degree, detune = 0) {
  return midiToFreq(degreeToMidi(root, scale, degree, detune));
}

/** Snap an arbitrary frequency to the nearest in-scale pitch. */
export function snapFreq(freq, root, scale, detune = 0) {
  const midi = freqToMidi(freq);
  const n = scale.length;
  // search a couple of octaves around
  let best = midi, bestErr = 1e9;
  const baseOct = Math.round((midi - root) / 12);
  for (let o = baseOct - 1; o <= baseOct + 1; o++) {
    for (let i = 0; i < n; i++) {
      const cand = degreeToMidi(root, scale, o * n + i, detune);
      const err = Math.abs(cand - midi);
      if (err < bestErr) { bestErr = err; best = cand; }
    }
  }
  return midiToFreq(best);
}

/** Deterministic small PRNG — sound must be reproducible for offline verification. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export default SCALES;
