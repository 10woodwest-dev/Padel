// ============================================================================
// shots.js — The shot table and everything that turns an intention
// ("chiquita to the server's feet") into ball velocity + spin.
//
//  * Each shot has a preferred contact-height window, speed range, spin
//    profile, base error, tactical tags and AI weighting hints.
//  * A drag/Magnus-aware ballistic solver iterates a mini-simulation until
//    the launch velocity actually lands the ball on the intended spot —
//    so AI and player shots are placed believably despite real air physics.
//  * Shot quality (timing, contact height, balance, orientation, stamina,
//    player skill) scales speed and scatters placement; bad contact can
//    produce genuine mishits.
// ============================================================================

import { BALL, COURT, MOVE } from './constants.js';
import {
  v3, vSub, vScale, vCross, vNorm, vLen, clamp, lerp, randGauss, rand,
} from './mathUtils.js';
import { netHeightAt } from './ball.js';

// ---------------------------------------------------------------------------
// Shot table.
//   contact: [min, ideal, max] height (m) — quality falls off toward edges
//   speed:   [min, max] launch speed (m/s); power selects within the range
//   spinTop: rad/s around the horizontal axis ⊥ travel (positive = topspin,
//            negative = slice/underspin)
//   spinSide: rad/s around the vertical axis (víbora curl)
//   loft:    multiplier on flight time — >1 arcs higher (lobs), <1 drills flat
//   error:   base placement scatter (m) at quality 1 on medium difficulty
//   stat:    roster stat that scales this shot's quality
//   tags:    used by AI decision-making and feedback text
// ---------------------------------------------------------------------------
export const SHOTS = {
  drive: {
    label: 'Flat drive', contact: [0.35, 0.85, 1.45], speed: [15, 23],
    spinTop: 40, spinSide: 0, loft: 1.0, error: 0.55, stat: 'consistency',
    tags: ['groundstroke', 'neutral'],
    purpose: 'Direct pace through the middle or at the net player.',
  },
  topspin: {
    label: 'Topspin drive', contact: [0.3, 0.7, 1.3], speed: [13.5, 20],
    spinTop: 230, spinSide: 0, loft: 1.08, error: 0.45, stat: 'consistency',
    tags: ['groundstroke', 'neutral', 'safe'],
    purpose: 'Dipping drive — safe aggression, drops at the net player\'s feet.',
  },
  lob: {
    label: 'Lob', contact: [0.2, 0.55, 1.2], speed: [11.5, 15.5],
    spinTop: -30, spinSide: 0, loft: 1.75, error: 0.8, stat: 'lob',
    tags: ['defensive', 'reset'],
    purpose: 'Throw the net players back, take the net yourself.',
  },
  volley: {
    label: 'Volley', contact: [0.55, 1.15, 1.95], speed: [11, 18],
    spinTop: -90, spinSide: 0, loft: 0.9, error: 0.5, stat: 'volley',
    tags: ['net', 'attacking'],
    purpose: 'Punched volley, deep or into the gap; keeps the net.',
  },
  blockVolley: {
    label: 'Block volley', contact: [0.45, 1.0, 1.95], speed: [7.5, 11],
    spinTop: -60, spinSide: 0, loft: 1.0, error: 0.42, stat: 'volley',
    tags: ['net', 'soft'],
    purpose: 'Absorb pace, drop the ball short and low.',
  },
  bandeja: {
    label: 'Bandeja', contact: [1.55, 2.05, 2.65], speed: [12.5, 16.5],
    spinTop: -150, spinSide: -40, loft: 1.02, error: 0.5, stat: 'bandeja',
    tags: ['overhead', 'control'],
    purpose: 'Sliced control overhead — deep, dies off the glass, holds the net.',
  },
  vibora: {
    label: 'Víbora', contact: [1.5, 1.95, 2.55], speed: [14, 18.5],
    spinTop: -110, spinSide: -230, loft: 0.95, error: 0.6, stat: 'vibora',
    tags: ['overhead', 'attacking'],
    purpose: 'Whipping side-slice overhead — skids low and curls into the fence.',
  },
  smash: {
    label: 'Smash', contact: [1.85, 2.5, 3.2], speed: [21, 33],
    spinTop: 160, spinSide: 0, loft: 0.62, error: 0.75, stat: 'smash',
    tags: ['overhead', 'kill'],
    purpose: 'Bounce it over the glass or through the gap — the point-ender.',
  },
  wallDefence: {
    label: 'Wall return', contact: [0.2, 0.6, 1.5], speed: [11, 15],
    spinTop: -50, spinSide: 0, loft: 1.45, error: 0.7, stat: 'defence',
    tags: ['defensive', 'wall', 'reset'],
    purpose: 'Off the rebound — buy time, push them off the net.',
  },
  chiquita: {
    label: 'Chiquita', contact: [0.25, 0.55, 1.0], speed: [9.5, 12],
    spinTop: 130, spinSide: 0, loft: 1.05, error: 0.4, stat: 'defence',
    tags: ['soft', 'approach'],
    purpose: 'Slow dipping ball at the net players\' feet, then move in.',
  },
  serve: {
    label: 'Serve', contact: [0.3, 0.6, 0.95], speed: [12, 16],
    spinTop: -70, spinSide: -60, loft: 0.95, error: 0.5, stat: 'consistency',
    tags: ['serve'],
    purpose: 'Underarm, diagonal, sliding low toward glass or the T.',
  },
};

// ---------------------------------------------------------------------------
// Ballistic solver — find v0 so the ball is at `target` after time T, under
// gravity + drag + Magnus. Vacuum solution as seed, then correct against a
// coarse simulation (drag makes real launches ~10-20 % hotter than vacuum).
// ---------------------------------------------------------------------------
function simulateFlight(p0, v0, spin, T) {
  const dt = 1 / 120;
  const p = { ...p0 }, v = { ...v0 };
  for (let t = 0; t < T; t += dt) {
    const s = vLen(v);
    let ax = 0, ay = -BALL.gravity, az = 0;
    if (s > 1e-4) {
      ax -= BALL.dragK * s * v.x; ay -= BALL.dragK * s * v.y; az -= BALL.dragK * s * v.z;
      const m = vScale(vCross(spin, v), BALL.magnusK);
      const mL = vLen(m);
      const k = mL > BALL.magnusMaxAccel ? BALL.magnusMaxAccel / mL : 1;
      ax += m.x * k; ay += m.y * k; az += m.z * k;
    }
    v.x += ax * dt; v.y += ay * dt; v.z += az * dt;
    p.x += v.x * dt; p.y += v.y * dt; p.z += v.z * dt;
  }
  return p;
}

// Build the spin vector for a given launch direction: topspin about the
// horizontal axis perpendicular to travel, side spin about vertical.
function spinFor(dir, spinTop, spinSide) {
  const flat = vNorm(v3(dir.x, 0, dir.z));
  const axis = vCross(v3(0, 1, 0), flat); // topspin axis
  return v3(axis.x * spinTop + 0, spinSide, axis.z * spinTop + 0);
}

export function solveLaunch(start, target, T, spinTop = 0, spinSide = 0) {
  const g = BALL.gravity;
  const delta = vSub(target, start);
  // vacuum seed: p(T) = p0 + v0 T - ½gT²ŷ
  let v0 = v3(delta.x / T, delta.y / T + 0.5 * g * T, delta.z / T);
  let spin = spinFor(v0, spinTop, spinSide);
  for (let i = 0; i < 5; i++) {
    const land = simulateFlight(start, v0, spin, T);
    const err = vSub(target, land);
    if (vLen(err) < 0.05) break;
    v0 = v3(v0.x + err.x / T, v0.y + err.y / T, v0.z + err.z / T);
    spin = spinFor(v0, spinTop, spinSide);
  }
  return { vel: v0, spin };
}

// ---------------------------------------------------------------------------
// Flight-time selection from the shot's REAL launch-speed budget.
// In vacuum |v0(T)|² = A/T² + B + C·T² with A = |Δp|², B = Δy·g, C = g²/4 —
// solving |v0| = speed for T² gives two arcs: the flat/fast root and the
// lofted root. loft ≤ 1 shots (drives, smashes) take the flat root, so the
// profile speed IS the launch speed; loft > 1 blends toward the high arc
// (lobs), still within the speed budget. If the target is unreachable at
// that speed, fall back to the minimum-speed arc.
// (Drag adds ~10 % on top via solveLaunch's correction — acceptable.)
// ---------------------------------------------------------------------------
function chooseFlightTime(start, target, speed, loft) {
  const g = BALL.gravity;
  const dx = target.x - start.x, dy = target.y - start.y, dz = target.z - start.z;
  const A = dx * dx + dy * dy + dz * dz;
  const B = dy * g;
  const C = g * g / 4;
  const cap2 = speed * speed;
  const disc = (cap2 - B) * (cap2 - B) - 4 * A * C;
  if (disc <= 0) return Math.pow(4 * A / (g * g), 0.25); // min-speed arc
  const s = Math.sqrt(disc);
  const Tflat = Math.sqrt(Math.max(0.03, ((cap2 - B) - s) / (2 * C)));
  const Tloft = Math.sqrt(((cap2 - B) + s) / (2 * C));
  if (loft <= 1) return Tflat;
  return Math.min(Tloft, Tflat * loft);
}

// ---------------------------------------------------------------------------
// Shot quality — 0..1 from the contact situation. Also names the worst factor
// so the UI can say "late", "off balance", "bad contact"…
// ---------------------------------------------------------------------------
export function computeShotQuality({ shot, timing, ballHeight, playerSpeed, facingError, stamina, statValue }) {
  const def = SHOTS[shot];

  // timing: 1 = centre of swing window, 0 = edge (controller supplies it)
  const fTiming = clamp(timing, 0, 1);

  // contact height vs the shot's window
  const [hMin, hIdeal, hMax] = def.contact;
  let fHeight;
  if (ballHeight <= hIdeal) {
    fHeight = clamp((ballHeight - hMin) / Math.max(0.05, hIdeal - hMin), 0, 1);
  } else {
    fHeight = clamp(1 - (ballHeight - hIdeal) / Math.max(0.05, hMax - hIdeal), 0, 1);
  }
  fHeight = 0.25 + 0.75 * fHeight; // never fully zero — you can dig ugly balls out

  // balance: swinging at full sprint costs control
  const fBalance = clamp(1 - (playerSpeed / MOVE.baseSpeed) * 0.55, 0.4, 1);

  // orientation: facing away from the target hurts (radians of error)
  const fFacing = clamp(1 - facingError / Math.PI * 0.9, 0.35, 1);

  // stamina: only bites when low
  const fStamina = stamina > 35 ? 1 : lerp(0.6, 1, stamina / 35);

  // skill: roster stat 0-100
  const fSkill = 0.55 + 0.45 * (statValue / 100);

  // weighted blend, then a multiplicative floor so that truly terrible
  // timing/contact can't be carried by good stats
  const quality = clamp(fTiming * 0.32 + fHeight * 0.24 + fBalance * 0.16 + fFacing * 0.12 + fStamina * 0.06 + fSkill * 0.10, 0, 1)
    * (0.55 + 0.45 * Math.min(fTiming, fHeight));

  // name the dominant problem for UI feedback
  const factors = [
    ['timing', fTiming], ['contact', fHeight], ['balance', fBalance], ['facing', fFacing],
  ];
  factors.sort((a, b) => a[1] - b[1]);
  const worst = factors[0];

  let feedback;
  if (quality > 0.82) feedback = 'perfect';
  else if (quality > 0.6) feedback = 'good';
  else if (worst[0] === 'timing') feedback = 'late';
  else if (worst[0] === 'balance') feedback = 'off balance';
  else if (worst[0] === 'facing') feedback = 'twisted';
  else feedback = 'bad contact';

  return { quality, feedback };
}

// ---------------------------------------------------------------------------
// executeShot — the single entry point used by both the human controller and
// the AI. Clamps the aim into the legal opponent half, picks speed/flight
// time from the shot profile, scatters the target by (1-quality) and solves
// the launch. Returns info for UI/rules.
//
//   hitterSide: +1 (team 0, z>0) or -1 — the ball must travel to -hitterSide.
//   power: 0..1 position within the shot's speed range.
//   errorScale: difficulty knob (AI) or 1 for the human.
// ---------------------------------------------------------------------------
export function executeShot(ballState, {
  shot, start, aim, hitterSide, quality = 0.75, power = 0.6, errorScale = 1.0,
}) {
  const def = SHOTS[shot];

  // --- clamp aim into the opponent half, off the walls --------------------
  const tz = -hitterSide;
  const target = v3(
    clamp(aim.x, -COURT.halfWidth + 0.35, COURT.halfWidth - 0.35),
    BALL.radius,
    clamp(Math.abs(aim.z), 0.9, COURT.halfLength - 0.25) * tz
  );

  // --- placement error: shrinks with quality, grows with shot risk --------
  // NOTE: the target is NOT re-clamped after the error — an overhit ball
  // genuinely sails long/wide into the glass (fault). That, plus the launch
  // angle noise below, is where unforced errors come from.
  const sigma = def.error * errorScale * lerp(1.8, 0.45, quality);
  target.x += randGauss(sigma);
  target.z += randGauss(sigma * 1.25);
  target.x = clamp(target.x, -COURT.halfWidth - 0.6, COURT.halfWidth + 0.6);

  // --- speed & flight time from the shot's real launch-speed budget --------
  const speed = lerp(def.speed[0], def.speed[1], clamp(power, 0, 1)) * lerp(0.85, 1.0, quality);
  let T = chooseFlightTime(start, target, speed, def.loft);

  // mishit: terrible contact turns into a scuffed ball
  const mishit = quality < 0.28 && Math.random() < 0.5;

  let launch = solveLaunch(start, target, T, def.spinTop, def.spinSide);

  // --- net clearance rescue: loft the arc if it would clip the net.
  // Good contact gets a real safety margin and up to 6 retries; poor contact
  // barely gets rescued — that is how balls genuinely die in the net.
  const margin = lerp(-0.06, 0.13, quality);
  const maxTries = mishit ? 0 : quality < 0.45 ? 1 : 8;
  for (let tries = 0; tries < maxTries; tries++) {
    const cross = netCrossing(start, launch.vel, launch.spin);
    if (cross === null || cross.y > netHeightAt(cross.x) + BALL.radius + margin) break;
    T *= 1.18;
    launch = solveLaunch(start, target, T, def.spinTop, def.spinSide);
  }

  // pathological geometry guard: never exceed the profile speed by >30 %
  if (vLen(launch.vel) > def.speed[1] * 1.3) {
    T *= 1.25;
    launch = solveLaunch(start, target, T, def.spinTop, def.spinSide);
  }

  // --- launch-direction noise: bad contact sprays the ball off the racket --
  const angNoise = (1 - quality) * errorScale * 0.05; // radians (σ)
  if (angNoise > 0.001 && !mishit) {
    const yaw = randGauss(angNoise), pitch = randGauss(angNoise * 0.8);
    const { x: vx, y: vy, z: vz } = launch.vel;
    const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
    launch.vel = v3(vx * cosY + vz * sinY, vy + vLen(launch.vel) * pitch, -vx * sinY + vz * cosY);
  }

  if (mishit) {
    launch.vel = vScale(launch.vel, rand(0.4, 0.7));
    launch.vel.y = Math.abs(launch.vel.y) * rand(0.7, 1.4) + 1;
    launch.spin = vScale(launch.spin, 0.3);
  }

  ballState.vel = launch.vel;
  ballState.spin = launch.spin;
  ballState.active = true;
  ballState.insideCage = true;

  return {
    shot, target, speed: vLen(launch.vel), mishit,
  };
}

// Coarse check of where/how high the ball crosses z=0 (the net plane).
// Returns {x, y} at the crossing or null if it never crosses. Uses the same
// Magnus clamp as the real integrator so the check flies the same ball.
function netCrossing(p0, v0, spin) {
  const dt = 1 / 120;
  const p = { ...p0 }, v = { ...v0 };
  for (let t = 0; t < 3; t += dt) {
    const prev = { x: p.x, y: p.y, z: p.z };
    const s = vLen(v);
    let ax = 0, ay = -BALL.gravity, az = 0;
    if (s > 1e-4) {
      ax -= BALL.dragK * s * v.x; ay -= BALL.dragK * s * v.y; az -= BALL.dragK * s * v.z;
      const m = vScale(vCross(spin, v), BALL.magnusK);
      const mL = vLen(m);
      const k = mL > BALL.magnusMaxAccel ? BALL.magnusMaxAccel / mL : 1;
      ax += m.x * k; ay += m.y * k; az += m.z * k;
    }
    v.x += ax * dt; v.y += ay * dt; v.z += az * dt;
    p.x += v.x * dt; p.y += v.y * dt; p.z += v.z * dt;
    if ((prev.z > 0) !== (p.z > 0)) {
      const f = prev.z / (prev.z - p.z);
      return { x: prev.x + (p.x - prev.x) * f, y: prev.y + (p.y - prev.y) * f };
    }
    if (p.y < 0) return null; // bounced before reaching the net
  }
  return null;
}
