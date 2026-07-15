// ============================================================================
// ball.js — Ball physics. This is the core of "feels like padel":
//
//  * Semi-implicit Euler at 240 Hz with quadratic air drag and Magnus lift
//    (topspin dips, slice floats, síde-spin curls).
//  * Swept plane collision (segment tests) so 40 m/s smashes never tunnel
//    through glass.
//  * Impulse-based bounce with Coulomb-limited friction that exchanges spin
//    and tangential velocity — this is what makes topspin CLIMB off the back
//    glass and slice DIE off the floor, exactly like real padel.
//  * Per-surface response: floor (grippy turf), glass (clean & springy),
//    metallic mesh (dead + randomly jittered normal), net (absorbs).
//  * Emits semantic events (floor/glass/mesh/net/out) consumed by rules.js.
//  * The same stepper runs cloned states for AI interception prediction and
//    the debug trajectory view (with randomness disabled so predictions are
//    deterministic).
// ============================================================================

import * as THREE from 'three';
import { BALL, COURT, NET, DOOR } from './constants.js';
import {
  v3, vAdd, vScale, vCross, vDot, vLen, vCopy, clamp, rand,
} from './mathUtils.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
export function createBallState() {
  return {
    pos: v3(0, 1, 5),
    vel: v3(),
    spin: v3(),        // angular velocity, rad/s
    insideCage: true,  // once the ball flies out over a wall it stops hitting walls
    active: false,     // physics paused (held for serve etc.)
  };
}

export function resetBall(state, pos, vel = v3(), spin = v3()) {
  state.pos = vCopy(pos);
  state.vel = vCopy(vel);
  state.spin = vCopy(spin);
  state.insideCage = true;
  state.active = true;
}

// ---------------------------------------------------------------------------
// Wall profile helpers — the cage as analytic surfaces.
// Returns the wall top height at a given position along each wall, split into
// the glass/mesh bands, mirroring the visual layout in court.js.
// ---------------------------------------------------------------------------

// Back walls (z = ±10): glass 0–3 m, mesh 3–4 m.
function backWallBand(y) {
  if (y <= COURT.backGlassHeight) return 'glass';
  if (y <= COURT.backTotalHeight) return 'mesh';
  return null; // above the cage
}

// Side walls (x = ±5): profile depends on distance from the back wall.
//  |z| in [8,10]: glass to 3, mesh 3–4;  |z| in [6,8]: glass to 2, mesh 2–3;
//  |z| in [0,6]: mesh to 3 — except the DOOR openings beside the net posts.
function sideWallBand(y, z) {
  const az = Math.abs(z);
  if (az >= DOOR.zMin && az <= DOOR.zMax && y <= DOOR.height) return null; // open doorway
  const fromBack = COURT.halfLength - Math.abs(z);
  if (fromBack <= COURT.sideGlassHighLength) {
    if (y <= COURT.sideGlassHighHeight) return 'glass';
    if (y <= COURT.sideCornerMeshHeight) return 'mesh';
    return null;
  }
  if (fromBack <= COURT.sideGlassHighLength + COURT.sideGlassLowLength) {
    if (y <= COURT.sideGlassLowHeight) return 'glass';
    if (y <= COURT.sideMeshHeight) return 'mesh';
    return null;
  }
  return y <= COURT.sideMeshHeight ? 'mesh' : null;
}

export function netHeightAt(x) {
  const t = clamp(Math.abs(x) / COURT.halfWidth, 0, 1);
  return NET.heightCenter + (NET.heightPosts - NET.heightCenter) * t * t;
}

// ---------------------------------------------------------------------------
// Integration step. Returns a list of events:
//   { type: 'floor'|'glass'|'mesh'|'net'|'netband'|'out',
//     pos: {x,y,z}, side: +1|-1 (which half of the court), wall?: 'back'|'side' }
// `deterministic` disables mesh jitter (used by prediction).
// ---------------------------------------------------------------------------
export function stepBall(state, dt, events = [], deterministic = false) {
  if (!state.active) return events;

  const { pos, vel, spin } = state;
  const prev = vCopy(pos);

  // --- forces: gravity, quadratic drag, Magnus lift -----------------------
  const speed = vLen(vel);
  const accel = v3(0, -BALL.gravity, 0);
  if (speed > 1e-4) {
    // drag  a = -kd |v| v
    accel.x -= BALL.dragK * speed * vel.x;
    accel.y -= BALL.dragK * speed * vel.y;
    accel.z -= BALL.dragK * speed * vel.z;
    // Magnus  a = S (ω × v), clamped so extreme spins stay sane
    const m = vScale(vCross(spin, vel), BALL.magnusK);
    const mLen = vLen(m);
    const k = mLen > BALL.magnusMaxAccel ? BALL.magnusMaxAccel / mLen : 1;
    accel.x += m.x * k; accel.y += m.y * k; accel.z += m.z * k;
  }

  // semi-implicit Euler: velocity first, then position
  vel.x += accel.x * dt; vel.y += accel.y * dt; vel.z += accel.z * dt;
  pos.x += vel.x * dt; pos.y += vel.y * dt; pos.z += vel.z * dt;

  // spin decays slowly in the air
  const decay = Math.exp(-dt / BALL.spinDecayTau);
  spin.x *= decay; spin.y *= decay; spin.z *= decay;

  // --- collisions ----------------------------------------------------------
  collideNet(state, prev, events, deterministic);
  collideFloor(state, events, deterministic);
  if (state.insideCage) {
    collideWalls(state, prev, events, deterministic);
  } else if (
    // a ball played back from OUTSIDE re-arms the cage once it is clearly
    // inside the court volume again (below wall height)
    Math.abs(pos.x) < COURT.halfWidth - 0.15 &&
    Math.abs(pos.z) < COURT.halfLength - 0.15 &&
    pos.y < COURT.backTotalHeight - 0.1
  ) {
    state.insideCage = true;
  }

  return events;
}

// ---------------------------------------------------------------------------
// Impulse bounce for a sphere on a plane with normal n:
//  * normal: v_n' = -e·v_n
//  * tangential: friction impulse (capped by Coulomb μ·j_n) drives the contact
//    point toward zero slip. Solid sphere ⇒ stopping impulse = (2/7)·m·|slip|.
//    The same impulse torques the ball, exchanging spin and velocity — this
//    yields topspin kick, slice check and glass climb "for free".
// ---------------------------------------------------------------------------
function bounce(state, n, surface, jitter = 0) {
  const { vel, spin } = state;

  // always reflect against the TRUE surface normal (jittering the normal
  // before the separating test could turn a real contact into a "miss",
  // leaving the ball dragging along the fence)
  const vn = vDot(vel, n);
  if (vn >= 0) return; // already separating

  const e = surface.restitution;
  // normal impulse
  vel.x -= (1 + e) * vn * n.x;
  vel.y -= (1 + e) * vn * n.y;
  vel.z -= (1 + e) * vn * n.z;

  // contact-point slip u = tangential( v + ω × (-r n) )
  const cp = vAdd(vel, vCross(spin, vScale(n, -BALL.radius)));
  const cpN = vDot(cp, n);
  const u = v3(cp.x - cpN * n.x, cp.y - cpN * n.y, cp.z - cpN * n.z);
  const uLen = vLen(u);
  if (uLen > 1e-4) {
    const jStop = (2 / 7) * uLen;                      // per unit mass
    const jMax = surface.friction * (1 + e) * Math.abs(vn);
    const j = Math.min(jStop, jMax);
    const d = vScale(u, -1 / uLen);
    vel.x += j * d.x; vel.y += j * d.y; vel.z += j * d.z;
    // Δω = -(5 j / 2 r) (n × d)   (per unit mass, I = 2/5 r²)
    const dw = vScale(vCross(n, d), -(5 * j) / (2 * BALL.radius));
    spin.x += dw.x; spin.y += dw.y; spin.z += dw.z;
  }

  // metallic mesh: deaden AND scramble the OUTGOING velocity (random tilt),
  // then guarantee the ball still separates from the wall
  if (jitter > 0) {
    const sp = vLen(vel);
    vel.x += rand(-jitter, jitter) * sp * 0.5;
    vel.y += rand(-jitter, jitter) * sp * 0.35;
    vel.z += rand(-jitter, jitter) * sp * 0.5;
    const sepMin = Math.max(0.25, -vn * e * 0.4);
    const out = vDot(vel, n);
    if (out < sepMin) {
      vel.x += (sepMin - out) * n.x;
      vel.y += (sepMin - out) * n.y;
      vel.z += (sepMin - out) * n.z;
    }
  }

  // impacts always scrub a little spin
  spin.x *= 0.96; spin.y *= 0.96; spin.z *= 0.96;
  clampSpin(spin);
}

function clampSpin(spin) {
  const s = vLen(spin);
  if (s > BALL.maxSpin) {
    const k = BALL.maxSpin / s;
    spin.x *= k; spin.y *= k; spin.z *= k;
  }
}

// ---------------------------------------------------------------------------
function collideFloor(state, events, deterministic) {
  const { pos, vel } = state;
  if (pos.y - BALL.radius > 0 || vel.y >= 0) return;
  pos.y = BALL.radius;
  const side = pos.z >= 0 ? 1 : -1;
  const inCourt =
    Math.abs(pos.x) <= COURT.halfWidth + 0.01 && Math.abs(pos.z) <= COURT.halfLength + 0.01;
  bounce(state, v3(0, 1, 0), BALL.surfaces.floor, 0);
  events.push({
    type: 'floor', pos: vCopy(pos), side,
    inCourt: state.insideCage && inCourt,
  });
  // rolling resistance once the ball is basically done
  if (Math.abs(vel.y) < 0.6) {
    vel.x *= 0.985; vel.z *= 0.985;
    if (vel.y < 0.35) vel.y = Math.max(vel.y, 0);
  }
}

// ---------------------------------------------------------------------------
// Cage walls, swept: compare previous/current distance to each plane so fast
// balls can't tunnel. If the crossing point is ABOVE the local wall band the
// ball has left the cage → 'out'.
// ---------------------------------------------------------------------------
function collideWalls(state, prev, events, deterministic) {
  const { pos } = state;
  const r = BALL.radius;

  // back walls z = ±10, inward normals ∓z
  for (const s of [1, -1]) {
    const plane = s * COURT.halfLength;
    const dPrev = s * (plane - prev.z);  // distance inside along inward dir
    const dNow = s * (plane - pos.z);
    if (dPrev > r && dNow <= r) {
      // interpolate crossing height
      const t = (dPrev - r) / (dPrev - dNow);
      const yHit = prev.y + (pos.y - prev.y) * t;
      const band = backWallBand(yHit);
      if (!band) { markOut(state, events); return; }
      pos.z = plane - s * r;
      const n = v3(0, 0, -s);
      const surf = BALL.surfaces[band];
      bounce(state, n, surf, deterministic ? 0 : (surf.normalJitter || 0));
      events.push({ type: band, pos: vCopy(pos), side: s, wall: 'back' });
    }
  }

  // side walls x = ±5, inward normals ∓x
  for (const s of [1, -1]) {
    const plane = s * COURT.halfWidth;
    const dPrev = s * (plane - prev.x);
    const dNow = s * (plane - pos.x);
    if (dPrev > r && dNow <= r) {
      const t = (dPrev - r) / (dPrev - dNow);
      const yHit = prev.y + (pos.y - prev.y) * t;
      const zHit = prev.z + (pos.z - prev.z) * t;
      const band = sideWallBand(yHit, zHit);
      if (!band) { markOut(state, events); return; }
      pos.x = plane - s * r;
      const n = v3(-s, 0, 0);
      const surf = BALL.surfaces[band];
      bounce(state, n, surf, deterministic ? 0 : (surf.normalJitter || 0));
      events.push({ type: band, pos: vCopy(pos), side: zHit >= 0 ? 1 : -1, wall: 'side' });
    }
  }
}

function markOut(state, events) {
  if (!state.insideCage) return;
  state.insideCage = false;
  events.push({ type: 'out', pos: vCopy(state.pos), side: state.pos.z >= 0 ? 1 : -1 });
}

// ---------------------------------------------------------------------------
// Net — segment test against the z = 0 plane below the (sagging) cord height.
// Body hit: ball dies into the net and drops on the incoming side.
// Band clip: deflected, play continues (rules decide legality by what happens
// next, exactly like a real let-cord).
// ---------------------------------------------------------------------------
function collideNet(state, prev, events, deterministic) {
  const { pos, vel } = state;
  if (prev.z === pos.z) return;
  if ((prev.z > 0) === (pos.z > 0)) return;             // didn't cross z=0
  const t = prev.z / (prev.z - pos.z);                  // crossing parameter
  const xC = prev.x + (pos.x - prev.x) * t;
  const yC = prev.y + (pos.y - prev.y) * t;
  if (Math.abs(xC) > COURT.halfWidth + 0.06) return;    // outside posts (can't happen in cage)
  const h = netHeightAt(xC);
  const fromSide = prev.z > 0 ? 1 : -1;

  if (yC + BALL.radius < h - NET.bandThickness) {
    // --- net body: absorb almost everything, ball drops back on hitter side
    pos.x = xC; pos.y = yC; pos.z = fromSide * 0.045;
    vel.x *= BALL.netAbsorb;
    vel.y = Math.min(vel.y, 0) * 0.3;
    vel.z = fromSide * Math.abs(vel.z) * BALL.netAbsorb; // rebound to incoming side
    state.spin = vScale(state.spin, 0.3);
    events.push({ type: 'net', pos: v3(xC, yC, 0), side: fromSide });
  } else if (yC - BALL.radius < h + NET.bandThickness) {
    // --- cord clip: lose speed, randomly kick up/forward; keeps flying
    pos.x = xC; pos.y = h + BALL.radius + 0.01; pos.z = (pos.z >= 0 ? 1 : -1) * 0.03;
    const kickUp = deterministic ? 0.5 : rand(0.2, 1.2);
    vel.x *= BALL.netBandDeflect;
    vel.z *= BALL.netBandDeflect * (deterministic ? 1 : rand(0.7, 1.05));
    vel.y = Math.abs(vel.y) * 0.25 + kickUp;
    events.push({ type: 'netband', pos: v3(xC, yC, 0), side: fromSide });
  }
}

// ---------------------------------------------------------------------------
// Trajectory prediction — clones a light state and steps it deterministically.
// Used by AI interception, the serve/landing marker and the debug overlay.
// Returns { samples: [{pos, vel, t}], events: [{...ev, t}] }.
// ---------------------------------------------------------------------------
export function predictTrajectory(from, { maxTime = 3.5, sampleEvery = 0.03, stopOnFloor = 0 } = {}) {
  const sim = {
    pos: vCopy(from.pos), vel: vCopy(from.vel), spin: vCopy(from.spin),
    insideCage: from.insideCage, active: true,
  };
  const dt = 1 / 240;
  const samples = [];
  const events = [];
  let floorHits = 0;
  let nextSample = 0;
  for (let t = 0; t < maxTime; t += dt) {
    const evs = [];
    stepBall(sim, dt, evs, true);
    for (const e of evs) {
      events.push({ ...e, t });
      if (e.type === 'floor') {
        floorHits++;
        if (stopOnFloor && floorHits >= stopOnFloor) {
          samples.push({ pos: vCopy(sim.pos), vel: vCopy(sim.vel), t });
          return { samples, events };
        }
      }
    }
    if (t >= nextSample) {
      samples.push({ pos: vCopy(sim.pos), vel: vCopy(sim.vel), t });
      nextSample += sampleEvery;
    }
    if (vLen(sim.vel) < 0.4 && sim.pos.y < 0.06) break; // dead ball
  }
  return { samples, events };
}

// ---------------------------------------------------------------------------
// Visuals — bright ball, soft blob shadow (readability!), landing marker ring
// and a short motion trail.
// ---------------------------------------------------------------------------
export class BallVisual {
  constructor(scene) {
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(BALL.radius * 1.35, 20, 16), // slightly oversized for readability
      new THREE.MeshStandardMaterial({ color: 0xd8f24b, emissive: 0x6a7a12, emissiveIntensity: 0.55, roughness: 0.55 })
    );
    this.mesh.castShadow = true;
    scene.add(this.mesh);

    this.blob = new THREE.Mesh(
      new THREE.CircleGeometry(0.09, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false })
    );
    this.blob.rotation.x = -Math.PI / 2;
    scene.add(this.blob);

    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(0.10, 0.16, 24),
      new THREE.MeshBasicMaterial({ color: 0xd8f24b, transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide })
    );
    this.marker.rotation.x = -Math.PI / 2;
    this.marker.visible = false;
    scene.add(this.marker);

    // trail
    this.trailN = 22;
    this.trailPts = new Float32Array(this.trailN * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.trailPts, 3));
    this.trail = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xd8f24b, transparent: true, opacity: 0.35 }));
    this.trail.frustumCulled = false;
    scene.add(this.trail);
    this._trailTick = 0;
  }

  update(state, dt) {
    const p = state.pos;
    this.mesh.position.set(p.x, p.y, p.z);
    // blob shadow: fades and shrinks with height
    this.blob.position.set(p.x, 0.005, p.z);
    const h = clamp(p.y, 0, 6);
    this.blob.scale.setScalar(clamp(1 + h * 0.22, 1, 2.3));
    this.blob.material.opacity = clamp(0.4 - h * 0.045, 0.08, 0.4);

    // trail ring-buffer (updated every other frame to stay subtle).
    // A large jump means the ball was teleported (point reset) — clear the
    // trail instead of drawing a streak across the court.
    const hx = this.trailPts[0], hy = this.trailPts[1], hz = this.trailPts[2];
    if (Math.hypot(p.x - hx, p.y - hy, p.z - hz) > 2.5) {
      for (let i = 0; i < this.trailN; i++) {
        this.trailPts[i * 3] = p.x; this.trailPts[i * 3 + 1] = p.y; this.trailPts[i * 3 + 2] = p.z;
      }
      this.trail.geometry.attributes.position.needsUpdate = true;
    }
    this._trailTick++;
    if (this._trailTick % 2 === 0) {
      for (let i = this.trailN - 1; i > 0; i--) {
        this.trailPts[i * 3] = this.trailPts[(i - 1) * 3];
        this.trailPts[i * 3 + 1] = this.trailPts[(i - 1) * 3 + 1];
        this.trailPts[i * 3 + 2] = this.trailPts[(i - 1) * 3 + 2];
      }
      this.trailPts[0] = p.x; this.trailPts[1] = p.y; this.trailPts[2] = p.z;
      this.trail.geometry.attributes.position.needsUpdate = true;
    }
  }

  // Landing marker: show predicted next floor contact while the ball is high
  // (essential for judging lobs/smashes from a chase camera).
  showLanding(state) {
    if (!state.active || state.pos.y < 0.8) { this.marker.visible = false; return; }
    const { events } = predictTrajectory(state, { maxTime: 3, stopOnFloor: 1 });
    const floor = events.find((e) => e.type === 'floor');
    if (floor) {
      this.marker.position.set(floor.pos.x, 0.006, floor.pos.z);
      this.marker.visible = true;
    } else {
      this.marker.visible = false;
    }
  }
}
