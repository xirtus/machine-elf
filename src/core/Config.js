/**
 * Central tuning. Anything a designer would twiddle lives here, not inline.
 * Values are chosen for a 16:9 view at 70° vertical FOV.
 */
export const CFG = {
  render: {
    fov: 68,
    near: 0.1,
    far: 4000,
    exposure: 1.05,
    maxPixelRatio: 2,
    // adaptive resolution bounds — engine scales between these to hold 60fps
    minScale: 0.62,
    maxScale: 1.0,
  },

  camera: {
    // camera trails behind the rail node; player craft sits ahead of it
    followDistance: 9.2,
    followHeight: 2.15,
    lookAhead: 26,
    // how hard the camera banks with player input (radians)
    bankAmount: 0.42,
    bankSmooth: 3.2,
    // positional lag: lower = looser, more cinematic
    posSmooth: 5.5,
    rotSmooth: 6.5,
    fovKick: 9,        // extra degrees at full boost
    fovSmooth: 4.0,
  },

  player: {
    // player moves inside a 2D "cage" perpendicular to the rail
    cageWidth: 15.5,
    cageHeight: 9.0,
    moveSpeed: 26,
    moveSmooth: 9.0,
    // craft visually banks/pitches far more than it translates
    bankMax: 1.15,
    pitchMax: 0.55,
    yawMax: 0.38,
    hitRadius: 0.55,     // tiny hurtbox — bullet-hell rules
    grazeRadius: 2.6,
    iframes: 1.4,
    maxHealth: 5,
    boostMul: 1.75,
  },

  weapons: {
    lockRadius: 0.16,      // fraction of screen height
    maxLocks: 8,
    lockTime: 0.085,       // sweep dwell per lock
    salvoDelay: 0.045,
    homingSpeed: 118,
    homingTurn: 9.5,
    damage: 1,
    pulseRate: 0.09,       // rapid-fire fallback
    pulseDamage: 0.34,
  },

  graze: {
    scorePer: 120,
    chainWindow: 1.1,
    maxChain: 64,
    // grazing charges the overdrive meter
    chargePer: 0.028,
  },

  scoring: {
    comboWindow: 2.4,
    tiers: [0, 8, 20, 40, 80, 150],
  },

  audio: {
    master: 0.75,
    music: 0.55,
    sfx: 0.8,
  },

  debug: {
    stats: false,
    freeCam: false,
    hitboxes: false,
    skipIntro: false,
  },
};

export default CFG;
