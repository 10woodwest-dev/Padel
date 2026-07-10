// ============================================================================
// constants.js — Court dimensions (FIP regulation), physics constants and
// every gameplay tunable in one place. All units are SI (metres, seconds,
// kilograms, radians) unless stated otherwise.
// ============================================================================

// ---------------------------------------------------------------------------
// COURT — regulation padel court: 20 m x 10 m, net at z = 0.
// Team 0 (human side) occupies z > 0, Team 1 occupies z < 0.
// ---------------------------------------------------------------------------
export const COURT = {
  length: 20,
  width: 10,
  halfLength: 10,
  halfWidth: 5,

  // The service line sits 6.95 m from the net on each side; the service box
  // is the area between the net and the service line, split by a centre line.
  serviceLineZ: 6.95,

  // Wall heights (classic FIP layout):
  //  - back walls: 3 m glass + 1 m metallic mesh above (4 m total)
  //  - side walls: stepped glass at the back corners (3 m high for the first
  //    2 m, 2 m high for the next 2 m), metallic mesh (3 m) along the middle.
  backGlassHeight: 3,
  backTotalHeight: 4,
  sideGlassHighHeight: 3,   // first 2 m from each back wall
  sideGlassHighLength: 2,
  sideGlassLowHeight: 2,    // next 2 m
  sideGlassLowLength: 2,
  sideMeshHeight: 3,        // middle 12 m of each side wall
  sideCornerMeshHeight: 4,  // mesh above the 3 m corner glass reaches 4 m

  lineWidth: 0.05,
};

export const NET = {
  heightCenter: 0.88,
  heightPosts: 0.92,
  bandThickness: 0.05, // white tape along the top — deflects rather than kills
};

// ---------------------------------------------------------------------------
// BALL — padel balls are near-identical to tennis balls, pressurised slightly
// lower (regulation rebound 135–145 cm from a 2.54 m drop → COR ≈ 0.74).
// ---------------------------------------------------------------------------
export const BALL = {
  radius: 0.033,
  mass: 0.0565,

  gravity: 9.81,

  // Quadratic air drag  a = -kd |v| v.  kd = ½·ρ·Cd·A / m ≈ 0.020 m⁻¹ gives a
  // tennis-ball-like terminal velocity of ~22 m/s: fast drives sit down,
  // lobs hang, nothing floats like an arcade ball.
  dragK: 0.020,

  // Magnus (spin lift)  a = S (ω × v), clamped. Tuned so a 300 rad/s topspin
  // drive at 25 m/s dips visibly but does not loop like table tennis.
  magnusK: 0.00042,
  magnusMaxAccel: 10,
  spinDecayTau: 9,   // seconds — air slowly bleeds spin
  maxSpin: 550,      // rad/s hard clamp

  // Per-surface bounce response: [normal restitution, friction coefficient].
  // Friction is what couples spin <-> tangential velocity in the impulse
  // bounce model (see ball.js), so it shapes how topspin "kicks".
  surfaces: {
    // 0.775 lands the 2.54 m drop test inside the regulation 1.35–1.45 m
    // window WITH air drag applied (0.75 measured ~1.30 m).
    floor: { restitution: 0.775, friction: 0.55 },
    // Glass: clean, springy, predictable — the defining padel rebound.
    glass: { restitution: 0.80, friction: 0.28 },
    // Metallic mesh: dead and messy — low restitution plus a random normal
    // jitter (radians) so rebounds are believable but not fully predictable.
    mesh:  { restitution: 0.32, friction: 0.65, normalJitter: 0.28 },
  },

  // Net body absorbs nearly all energy; the top band deflects instead.
  netAbsorb: 0.10,       // velocity multiplier when hitting the net body
  netBandDeflect: 0.55,  // velocity multiplier for a cord clip

  restHeight: 0.034,     // considered "rolling/dead" below this + low speed
  restSpeed: 0.8,
};

// Physics runs on a fixed timestep independent of frame rate.
export const PHYSICS = {
  dt: 1 / 240,
  maxSubSteps: 12,
};

// ---------------------------------------------------------------------------
// PLAYER locomotion & hitting. Movement uses acceleration + drag (momentum),
// a turn-rate limit, and stamina/balance modifiers — no gliding.
// ---------------------------------------------------------------------------
export const MOVE = {
  baseSpeed: 6.2,        // sprint m/s at speed stat 100
  minSpeedFactor: 0.62,  // speed stat 0 → 62 % of base
  baseAccel: 18,         // m/s² at accel stat 100
  minAccelFactor: 0.55,
  friction: 7,           // ground drag (1/s) with no input — hard athletic braking, ~0.9 m from full sprint, never an instant stop
  turnRate: 9,           // rad/s facing slew — you cannot snap 180° instantly
  backpedalFactor: 0.72, // moving against your facing is slower
  aiSpeedFactor: 0.94,   // AI players slightly slower than their stats imply

  staminaDrainSprint: 2.4,   // %/s while moving near max speed
  staminaRegen: 4.5,         // %/s while nearly still
  staminaLowThreshold: 30,   // below this, speed and shot quality suffer
  staminaMinFactor: 0.78,    // speed multiplier at zero stamina
};

export const HIT = {
  reachBase: 1.35,       // metres from body centre at reach stat 100 (racket incl.)
  reachMin: 1.12,
  overheadReachBonus: 0.55, // extra vertical reach for overheads
  sweetSpot: 0.85,       // ideal contact distance from body centre
  windup: 0.10,          // s between button press and swing becoming "active"
  activeWindow: 0.24,    // s the swing can connect
  recoverTime: 0.38,     // s of reduced control after a swing
  whiffRecover: 0.5,     // s penalty after swinging at nothing
  volleyMaxDistFromNet: 4.2, // heuristic: hits nearer the net auto-count as volleys
  bodyRadius: 0.26,      // ball striking the body (not racket) loses the point
  bodyHeight: 1.9,
};

// ---------------------------------------------------------------------------
// SCORING
// ---------------------------------------------------------------------------
export const RULES = {
  setsToWin: 1,          // prototype: one set match
  gamesPerSet: 6,
  tieBreakAt: 6,
  goldenPointDefault: false, // advantage scoring by default; toggle in menu
};

// AI difficulty presets — reaction (s), speed & consistency multipliers,
// aggression bias, and tactical IQ (probability of picking the best-scored
// shot instead of sampling among the top options).
export const DIFFICULTY = {
  easy:   { reaction: 0.34, speed: 0.82, consistency: 0.70, aggression: 0.85, iq: 0.55, errorScale: 1.65 },
  medium: { reaction: 0.22, speed: 0.92, consistency: 0.88, aggression: 1.00, iq: 0.78, errorScale: 1.15 },
  hard:   { reaction: 0.13, speed: 1.00, consistency: 1.00, aggression: 1.12, iq: 0.93, errorScale: 0.80 },
};

export const COLORS = {
  courtBlue: 0x2f6d9e,
  courtBlueDark: 0x275d88,
  outerFloor: 0x233240,
  lines: 0xf5f8fa,
  glassTint: 0xbfe3ef,
  meshWire: 0x1b2b33,
  netCord: 0x111418,
  netBand: 0xf2f4f6,
  frame: 0x10161b,
  skyTop: 0x0d1522,
  skyBottom: 0x2a3d55,
};
