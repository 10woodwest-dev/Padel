// ============================================================================
// player.js — Player entity shared by the human and all AI players.
//
//  * Locomotion: exponential approach to a desired velocity (real momentum,
//    attainable top speed, turn-rate limit, backpedal penalty, stamina).
//  * Swing system with a PHYSICAL RACKET: every swing drives the racket head
//    along a ball-seeking arc through space (backswing → contact → follow-
//    through). Contact happens where the racket actually is; the racket's
//    velocity at that instant feeds the exit-velocity blend in main.js.
//  * Rigged procedural model: pelvis/torso/head plus two-bone IK arms
//    (shoulder-elbow) and cycling legs with knees. The racket arm follows
//    the swing path exactly, the torso coils and unwinds, the head tracks
//    the ball. All body dimensions/kit come from the roster so players are
//    visually distinct. Swap buildPlayerModel() for real rigs later.
// ============================================================================

import * as THREE from 'three';
import { COURT, MOVE, HIT, RACKET } from './constants.js';
import { SHOTS } from './shots.js';
import {
  v3, vLen, clamp, lerp, damp, angleDelta, lenXZ,
} from './mathUtils.js';

let nextId = 0;

// scratch objects (avoid per-frame allocation)
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

export class Player {
  constructor(archetype, team, slot, isHuman = false) {
    this.id = nextId++;
    this.archetype = archetype;
    this.stats = archetype.stats;
    this.team = team;
    this.teamSign = team === 0 ? 1 : -1;
    this.slot = slot;
    this.isHuman = isHuman;

    this.pos = v3(0, 0, this.teamSign * 7);
    this.vel = v3();
    this.facing = team === 0 ? Math.PI : 0; // yaw: face the net
    this.targetFacing = this.facing;

    this.stamina = 100;

    // state machine: idle | run | prepare | swing | overhead | volley | recover
    this.state = 'idle';
    this.stateTime = 0;

    this.swing = null;       // active swing descriptor
    this.moveIntent = v3();  // set each frame by controller / AI

    this.runPhase = 0;
    this.idleTime = Math.random() * 10;

    // racket head world position/velocity, updated every frame by the pose
    // engine — this is what the ball physically collides with
    this.racketWorld = new THREE.Vector3();
    this.racketVel = new THREE.Vector3();
    this._racketPrev = new THREE.Vector3();
    this._racketInit = false;

    this.model = buildPlayerModel(archetype);
  }

  // --- derived attributes ----------------------------------------------------
  maxSpeed() {
    const statF = MOVE.minSpeedFactor + (1 - MOVE.minSpeedFactor) * this.stats.speed / 100;
    const stamF = this.stamina < MOVE.staminaLowThreshold
      ? lerp(MOVE.staminaMinFactor, 1, this.stamina / MOVE.staminaLowThreshold)
      : 1;
    const aiF = this.isHuman ? 1 : MOVE.aiSpeedFactor;
    return MOVE.baseSpeed * statF * stamF * aiF;
  }

  accel() {
    const statF = MOVE.minAccelFactor + (1 - MOVE.minAccelFactor) * this.stats.acceleration / 100;
    return MOVE.baseAccel * statF;
  }

  reach() {
    return HIT.reachMin + (HIT.reachBase - HIT.reachMin) * this.stats.reach / 100
      + (this.archetype.height - 1.8) * 0.25;
  }

  overheadReach() {
    return this.archetype.height * 1.12 + HIT.overheadReachBonus + (this.stats.reach / 100) * 0.25;
  }

  shoulderHeight() { return this.archetype.height * 0.82; }

  contactRadius() { return this.isHuman ? RACKET.contactRadius : RACKET.contactRadiusAI; }

  // --- swing lifecycle ---------------------------------------------------------
  /** Begin a swing: the racket will travel a ball-seeking arc; the sim loop
   *  calls tryContact() each physics step while the window is open. */
  startSwing(shotKey, aim, power = 0.6) {
    // one swing at a time, and no re-arming during follow-through/recovery —
    // otherwise mashing the button lets you hit your own outgoing ball
    if (this.swing || this.inRecovery()) return false;
    const def = SHOTS[shotKey];
    const overhead = def.tags.includes('overhead');
    this.swing = {
      shot: shotKey, aim, power,
      elapsed: 0,
      windup: HIT.windup * (overhead ? 1.5 : 1),
      window: HIT.activeWindow,
      done: false,
      contact: null,
      overhead,
      // ball-seek parameters, refreshed each frame until contact
      seekAz: this.facing, seekR: 0.9, seekH: def.contact[1], seekSide: 1,
      frozen: false,
    };
    this.setState(overhead ? 'overhead' : (def.tags.includes('net') ? 'volley' : 'prepare'));
    return true;
  }

  cancelSwing() { this.swing = null; }

  /** advance the swing clock — called every PHYSICS SUBSTEP by main.js so
   *  contact timing is frame-rate independent (the rendered arm follows the
   *  same analytic path, one frame behind at most) */
  advanceSwing(dt) {
    if (this.swing) this.swing.elapsed += dt;
  }

  /** Racket-based contact test against the ANALYTIC racket-head position on
   *  the swing arc at the current substep phase. The sweep must actually be
   *  passing through the ball: contact only happens mid-swing, where the
   *  racket demonstrably is, and the racket's path velocity feeds the
   *  physical exit blend. Returns contact info or null. */
  tryContact(ballPos, ballVel = null) {
    const sw = this.swing;
    if (!sw || sw.done) return null;
    if (sw.elapsed < sw.windup) return null;
    const def = SHOTS[sw.shot];

    // ball must be on our side of the net (no reaching over in padel)
    if (Math.sign(ballPos.z) !== this.teamSign && Math.abs(ballPos.z) > 0.05) return null;

    // legality/height window per shot (you can dig low balls, at a cost)
    const maxH = sw.overhead ? this.overheadReach() : def.contact[2] + 0.4;
    const minH = Math.max(0.03, def.contact[0] - 0.25);
    if (ballPos.y > maxH || ballPos.y < minH) return null;

    // contact only lands while the sweep is passing through the zone
    const p = (sw.elapsed - sw.windup) / sw.window;
    if (p < 0.08 || p > 1.0) return null;

    // analytic racket head at this instant, seeking the LIVE ball (matches
    // updateSwingSeek's clamps, evaluated at substep precision)
    const seek = this._liveSeek(ballPos, def, sw);
    const rp = this._pathPoint(p, seek, sw);
    const dx = ballPos.x - rp.x, dy = ballPos.y - rp.y, dz = ballPos.z - rp.z;
    const offDist = Math.hypot(dx, dy, dz);
    const radius = this.contactRadius();
    if (offDist > radius) return null;

    // racket velocity from the path derivative (m/s)
    const rp2 = this._pathPoint(p + 0.04, seek, sw);
    const dtP = 0.04 * sw.window;
    const racketVel = {
      x: (rp2.x - rp.x) / dtP, y: (rp2.y - rp.y) / dtP, z: (rp2.z - rp.z) / dtP,
    };

    // timing quality: centre-of-racket contact + sweet part of the sweep
    const distQ = clamp(1 - offDist / radius, 0, 1);
    const windowQ = clamp(1 - Math.abs(p - 0.45) / 0.55, 0, 1);
    const timing = clamp(0.3 + 0.5 * distQ + 0.2 * windowQ, 0, 1);

    sw.done = true;
    sw.frozen = true;
    const bodyDist = Math.hypot(ballPos.x - this.pos.x, ballPos.z - this.pos.z);
    sw.contact = {
      shot: sw.shot, aim: sw.aim, power: sw.power,
      timing,
      dist: bodyDist,
      ballHeight: ballPos.y,
      playerSpeed: vLen(this.vel),
      facingError: Math.abs(angleDelta(this.facing, Math.atan2(sw.aim.x - this.pos.x, sw.aim.z - this.pos.z))),
      // physical-contact data for the exit-velocity blend
      ballVel: ballVel ? { ...ballVel } : v3(),
      racketVel,
      offset: { x: dx / Math.max(0.01, offDist), y: dy / Math.max(0.01, offDist), z: dz / Math.max(0.01, offDist) },
      offCentre: offDist / radius,
    };
    this.setState('swing');
    return sw.contact;
  }

  /** seek clamps for the contact test, computed from the live ball */
  _liveSeek(ballPos, def, sw) {
    const dx = ballPos.x - this.pos.x, dz = ballPos.z - this.pos.z;
    const az = Math.atan2(dx, dz);
    const d = Math.hypot(dx, dz);
    return {
      az,
      r: clamp(d, 0.45, this.reach()),
      h: clamp(ballPos.y, Math.max(0.15, def.contact[0] - 0.2),
        sw.overhead ? this.overheadReach() - 0.1 : def.contact[2] + 0.35),
      side: angleDelta(this.facing, az) >= 0 ? 1 : -1,
    };
  }

  /** swing-arc point for arbitrary seek params (plain object out) */
  _pathPoint(p, seek, sw) {
    const s = seek.side;
    const pc = clamp(p, -0.35, 1.45);
    let az, r, h;
    if (sw.overhead) {
      az = seek.az + (pc - 0.45) * 0.7 * s;
      r = seek.r * lerp(0.55, 1.0, clamp(pc + 0.3, 0, 1));
      h = seek.h + (0.45 - pc) * 1.15;
    } else {
      az = seek.az + (0.45 - pc) * 2.2 * s;
      r = seek.r * lerp(0.7, 1.0, Math.sin(clamp(pc, 0, 1) * Math.PI) * 0.55 + 0.45);
      const shotDef = SHOTS[sw.shot];
      const rise = shotDef.spinTop >= 0 ? 0.55 : -0.3;
      h = seek.h + (pc - 0.45) * rise;
    }
    return {
      x: this.pos.x + Math.sin(az) * r,
      y: clamp(h, 0.1, 3.4),
      z: this.pos.z + Math.cos(az) * r,
    };
  }

  isSwinging() { return !!this.swing && !this.swing.done; }
  inRecovery() { return this.state === 'recover' || this.state === 'swing'; }

  // --- per-frame update ---------------------------------------------------------
  /** @param ball live ball state (for racket seeking + head tracking); optional */
  update(dt, ball = null) {
    this.stateTime += dt;

    // ---- swing timeline (elapsed is advanced per PHYSICS SUBSTEP by
    // advanceSwing(); here we only handle the state transitions)
    if (this.swing) {
      if (!this.swing.done && this.swing.elapsed > this.swing.windup + this.swing.window) {
        this.swing = null;               // whiffed
        this.setState('recover');
        this.stateTime = -(HIT.whiffRecover - HIT.recoverTime);
      } else if (this.swing.done && this.state === 'swing' && this.stateTime > 0.25) {
        this.swing = null;
        this.setState('recover');
      }
    }
    if (this.state === 'recover' && this.stateTime > HIT.recoverTime) this.setState('idle');

    // ---- locomotion: exponential approach toward the desired velocity
    const controlF = this.isSwinging() ? 0.35 : this.state === 'swing' ? 0.2 :
      this.state === 'recover' ? 0.55 : 1;
    const intentLen = lenXZ(this.moveIntent);
    if (intentLen > 0.01) {
      const ix = this.moveIntent.x / Math.max(1, intentLen);
      const iz = this.moveIntent.z / Math.max(1, intentLen);
      const moveYaw = Math.atan2(ix, iz);
      const against = Math.abs(angleDelta(this.facing, moveYaw)) > Math.PI * 0.6;
      const speedCap = this.maxSpeed() * clamp(intentLen, 0, 1) *
        (against ? MOVE.backpedalFactor : 1) * (this.isSwinging() ? 0.5 : 1);
      const k = 1 - Math.exp(-(this.accel() / Math.max(1, this.maxSpeed())) * controlF * dt);
      this.vel.x += (ix * speedCap - this.vel.x) * k;
      this.vel.z += (iz * speedCap - this.vel.z) * k;
    } else {
      const fr = Math.exp(-MOVE.friction * dt);
      this.vel.x *= fr; this.vel.z *= fr;
    }

    const sp = lenXZ(this.vel);
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

    // stay inside our half of the cage (padel: you never cross the net)
    this.pos.x = clamp(this.pos.x, -COURT.halfWidth + 0.3, COURT.halfWidth - 0.3);
    const zNear = 0.35, zFar = COURT.halfLength - 0.3;
    if (this.teamSign > 0) this.pos.z = clamp(this.pos.z, zNear, zFar);
    else this.pos.z = clamp(this.pos.z, -zFar, -zNear);

    // ---- facing slews toward target at a limited rate (no snap turns)
    const turn = MOVE.turnRate * (sp > 3 ? 0.7 : 1) * dt;
    const dYaw = angleDelta(this.facing, this.targetFacing);
    this.facing += clamp(dYaw, -turn, turn);

    // ---- stamina
    const effort = sp / Math.max(0.1, this.maxSpeed());
    const drainScale = 1.6 - (this.stats.stamina / 100) * 1.1;
    if (effort > 0.55) this.stamina -= MOVE.staminaDrainSprint * drainScale * effort * dt;
    else this.stamina += MOVE.staminaRegen * dt;
    this.stamina = clamp(this.stamina, 0, 100);

    // ---- animation state
    if (!this.swing && this.state !== 'recover' && this.state !== 'swing') {
      this.setState(sp > 0.6 ? 'run' : 'idle', true);
    }
    this.runPhase += sp * dt * 2.15;
    this.idleTime += dt;

    this.updateSwingSeek(ball);
    this.updateModel(dt, ball);
    this.updateRacketTracking(dt);
  }

  setState(s, soft = false) {
    if (this.state === s) return;
    this.state = s;
    if (!soft) this.stateTime = 0;
  }

  // ---------------------------------------------------------------------------
  // Swing path — a ball-seeking arc for the racket head, in world space.
  // The arc sweeps from a backswing point, through the (continuously updated)
  // predicted contact point, into a follow-through. Until contact the seek
  // parameters track the live ball, like a real player adjusting late.
  // ---------------------------------------------------------------------------
  updateSwingSeek(ball) {
    const sw = this.swing;
    if (!sw || sw.frozen) return;
    const def = SHOTS[sw.shot];
    if (ball && ball.active) {
      const dx = ball.pos.x - this.pos.x, dz = ball.pos.z - this.pos.z;
      const az = Math.atan2(dx, dz);
      const d = Math.hypot(dx, dz);
      sw.seekAz = az;
      sw.seekR = clamp(d, 0.45, this.reach());
      sw.seekH = clamp(ball.pos.y, Math.max(0.15, def.contact[0] - 0.2),
        sw.overhead ? this.overheadReach() - 0.1 : def.contact[2] + 0.35);
      // swing from the side the ball is on: ball right of facing → sweep R→L
      const side = angleDelta(this.facing, az);
      sw.seekSide = side >= 0 ? 1 : -1;
    } else {
      sw.seekAz = this.facing;
      sw.seekR = 0.9;
      sw.seekH = def.contact[1];
    }
  }

  /** Racket-head world position along the swing arc.
   *  p < 0 → backswing hold; p ∈ [0,1] → active sweep; p > 1 → follow-through. */
  swingPathPoint(p, out) {
    const sw = this.swing;
    const s = sw.seekSide;
    const pc = clamp(p, -0.35, 1.45);
    let az, r, h;
    if (sw.overhead) {
      // overhead: racket travels high-behind → up-over → down-through
      az = sw.seekAz + (pc - 0.45) * 0.7 * s;
      r = sw.seekR * lerp(0.55, 1.0, clamp(pc + 0.3, 0, 1));
      h = sw.seekH + (0.45 - pc) * 1.15;
    } else {
      // groundstroke/volley: horizontal arc through the contact azimuth
      az = sw.seekAz + (0.45 - pc) * 2.2 * s;
      r = sw.seekR * lerp(0.7, 1.0, Math.sin(clamp(pc, 0, 1) * Math.PI) * 0.55 + 0.45);
      const shotDef = SHOTS[sw.shot];
      const rise = shotDef.spinTop >= 0 ? 0.55 : -0.3; // topspin brushes up, slice cuts down
      h = sw.seekH + (pc - 0.45) * rise;
    }
    out.set(
      this.pos.x + Math.sin(az) * r,
      clamp(h, 0.1, 3.4),
      this.pos.z + Math.cos(az) * r
    );
    return out;
  }

  /** current phase of the active window, for the pose engine */
  swingPhase() {
    const sw = this.swing;
    if (!sw) return null;
    if (sw.elapsed < sw.windup) return -0.35 + 0.35 * (sw.elapsed / sw.windup);
    return (sw.elapsed - sw.windup) / sw.window;
  }

  updateRacketTracking(dt) {
    if (!this._racketInit) {
      this._racketPrev.copy(this.racketWorld);
      this._racketInit = true;
    }
    if (dt > 1e-5) {
      this.racketVel.copy(this.racketWorld).sub(this._racketPrev).divideScalar(dt);
      // cap insane spikes from teleports/resets
      const rv = this.racketVel.length();
      if (rv > 30) this.racketVel.multiplyScalar(30 / rv);
    }
    this._racketPrev.copy(this.racketWorld);
  }

  // ---------------------------------------------------------------------------
  // Pose engine — drives the rig every frame.
  // ---------------------------------------------------------------------------
  updateModel(dt, ball) {
    const m = this.model;
    const g = m.group;
    g.position.set(this.pos.x, 0, this.pos.z);
    g.rotation.y = this.facing;

    const sp = lenXZ(this.vel);
    const runAmt = clamp(sp / 4.5, 0, 1);
    const phase = this.runPhase;
    const L = 1 - Math.exp(-14 * dt); // pose smoothing

    // ---- pelvis: bob with the run cycle, breathe at rest, crouch when ready
    const bob = Math.abs(Math.cos(phase)) * 0.045 * runAmt;
    const breathe = Math.sin(this.idleTime * 1.9) * 0.008 * (1 - runAmt);
    const ready = this.state === 'idle' ? 0.035 : 0;
    m.pelvis.position.y = lerp(m.pelvis.position.y, m.hipH - bob - ready + breathe, L);

    // lean into movement (world velocity → local)
    const cos = Math.cos(-this.facing), sin = Math.sin(-this.facing);
    const lvx = this.vel.x * cos - this.vel.z * sin;
    const lvz = this.vel.x * sin + this.vel.z * cos;
    m.pelvis.rotation.x = damp(m.pelvis.rotation.x, clamp(lvz * -0.045, -0.22, 0.22) + (this.state === 'idle' ? 0.06 : 0.1), 10, dt);
    m.pelvis.rotation.z = damp(m.pelvis.rotation.z, clamp(lvx * 0.05, -0.18, 0.18), 10, dt);

    // ---- torso coil during swings, gentle counter-sway otherwise
    let torsoYaw = Math.sin(phase) * 0.09 * runAmt;
    let torsoPitch = 0.05 + runAmt * 0.08;
    const p = this.swingPhase();
    if (this.swing && p !== null) {
      const s = this.swing.seekSide;
      const coil = p < 0 ? 1 : clamp(1 - p * 1.6, -0.6, 1);
      torsoYaw = 0.55 * coil * s * (this.swing.overhead ? 0.5 : 1);
      if (this.swing.overhead) torsoPitch = p < 0.45 ? -0.12 : 0.18;
    } else if (this.state === 'swing' || this.state === 'recover') {
      torsoYaw = damp(m.torso.rotation.y, 0, 6, dt);
    }
    m.torso.rotation.y = damp(m.torso.rotation.y, torsoYaw, 12, dt);
    m.torso.rotation.x = damp(m.torso.rotation.x, torsoPitch, 10, dt);

    // ---- head tracks the ball (clamped) — a small thing that adds a lot of life
    if (ball && ball.active) {
      _v1.set(ball.pos.x, ball.pos.y, ball.pos.z);
      m.head.parent.worldToLocal(_v1);
      _v1.sub(m.head.position);
      const yaw = clamp(Math.atan2(_v1.x, _v1.z), -1.0, 1.0);
      const pitch = clamp(-Math.atan2(_v1.y, Math.hypot(_v1.x, _v1.z)), -0.6, 0.5);
      m.head.rotation.y = damp(m.head.rotation.y, yaw, 8, dt);
      m.head.rotation.x = damp(m.head.rotation.x, pitch, 8, dt);
    } else {
      m.head.rotation.y = damp(m.head.rotation.y, 0, 6, dt);
      m.head.rotation.x = damp(m.head.rotation.x, 0, 6, dt);
    }

    // ---- legs: run cycle with knees; ready = athletic bend
    const kneeReady = this.state === 'idle' ? 0.55 : 0.35;
    const hipSwing = Math.sin(phase) * 0.62 * runAmt;
    const kneeR = Math.max(0, -Math.sin(phase + 0.6)) * 1.15 * runAmt + kneeReady * (1 - runAmt);
    const kneeL = Math.max(0, Math.sin(phase + 0.6 + Math.PI) * -1) * 1.15 * runAmt + kneeReady * (1 - runAmt);
    m.hipR.rotation.x = damp(m.hipR.rotation.x, hipSwing - kneeReady * 0.4 * (1 - runAmt), 16, dt);
    m.hipL.rotation.x = damp(m.hipL.rotation.x, -hipSwing - kneeReady * 0.4 * (1 - runAmt), 16, dt);
    m.kneeR.rotation.x = damp(m.kneeR.rotation.x, kneeR, 16, dt);
    m.kneeL.rotation.x = damp(m.kneeL.rotation.x, kneeL, 16, dt);
    // feet roughly parallel to ground
    m.footR.rotation.x = damp(m.footR.rotation.x, -(m.hipR.rotation.x + m.kneeR.rotation.x) * 0.8, 16, dt);
    m.footL.rotation.x = damp(m.footL.rotation.x, -(m.hipL.rotation.x + m.kneeL.rotation.x) * 0.8, 16, dt);

    // ---- racket arm: IK to the swing path (or a ready/pump position)
    g.updateMatrixWorld(true);
    if (this.swing && p !== null) {
      this.swingPathPoint(p, _v1);
    } else if (this.state === 'recover') {
      // ease back toward ready hold
      readyRacketTarget(this, _v1);
    } else if (runAmt > 0.25) {
      // pumping arm while running, racket kept up-ish
      const pump = Math.sin(phase) * 0.22 * runAmt;
      readyRacketTarget(this, _v1);
      _v1.y += pump * 0.4;
    } else {
      readyRacketTarget(this, _v1);
      _v1.y += Math.sin(this.idleTime * 1.9) * 0.015; // breathing
    }
    solveArmIK(m.shoulderR, m.elbowR, m.armRLenU, m.armRLenF, _v1, 1);

    // racket head world position = end of the forearm chain
    m.racketTip.getWorldPosition(this.racketWorld);

    // ---- left arm: counterbalance
    if (this.swing && p !== null && !this.swing.overhead) {
      const s = this.swing.seekSide;
      _v2.set(this.pos.x - Math.sin(this.facing + 0.9 * s) * 0.55,
        m.hipH + 0.45 + (p > 0 ? p * 0.2 : 0),
        this.pos.z - Math.cos(this.facing + 0.9 * s) * 0.55);
    } else if (this.swing && p !== null && this.swing.overhead) {
      // off arm points up at the ball during overheads
      _v2.set(this.pos.x + Math.sin(this.facing) * 0.5, m.hipH + 1.05 - clamp(p, 0, 1) * 0.5,
        this.pos.z + Math.cos(this.facing) * 0.5);
    } else {
      const pump = runAmt > 0.25 ? -Math.sin(phase) * 0.22 * runAmt : 0;
      _v2.set(this.pos.x + Math.sin(this.facing - 0.5) * 0.42, m.hipH + 0.32 + pump * 0.4,
        this.pos.z + Math.cos(this.facing - 0.5) * 0.42);
    }
    solveArmIK(m.shoulderL, m.elbowL, m.armLLenU, m.armLLenF, _v2, -1);
  }
}

// ---------------------------------------------------------------------------
// Ready-position racket target: held in front at waist-chest height.
// ---------------------------------------------------------------------------
function readyRacketTarget(player, out) {
  const az = player.facing + 0.38;
  out.set(
    player.pos.x + Math.sin(az) * 0.55,
    player.model.hipH + 0.42,
    player.pos.z + Math.cos(az) * 0.55
  );
}

// ---------------------------------------------------------------------------
// Two-bone analytic IK (shoulder + elbow hinge) in world space.
//   shoulder: THREE.Group (pivot at the shoulder joint)
//   elbow:    THREE.Group child at (0,-Lu,0) — hinge about local X
//   target:   world-space position for the END of the chain (racket tip / hand)
//   sideSign: +1 right arm, -1 left (pole vector mirroring)
// ---------------------------------------------------------------------------
function solveArmIK(shoulder, elbow, Lu, Lf, targetWorld, sideSign) {
  const parent = shoulder.parent;
  // target in shoulder-parent local space
  _v3.copy(targetWorld);
  parent.worldToLocal(_v3);
  _v3.sub(shoulder.position);

  let d = _v3.length();
  d = clamp(d, Math.abs(Lu - Lf) + 0.02, Lu + Lf - 0.01);
  _v4.copy(_v3).normalize();

  // elbow bend from the law of cosines
  const cosE = clamp((Lu * Lu + Lf * Lf - d * d) / (2 * Lu * Lf), -1, 1);
  const bend = Math.PI - Math.acos(cosE);
  // shoulder lift toward the pole side
  const cosB = clamp((Lu * Lu + d * d - Lf * Lf) / (2 * Lu * d), -1, 1);
  const beta = Math.acos(cosB);

  // pole: the upper arm droops TOWARD this direction — mostly straight down
  // (elbow hangs by the body), slightly out to the arm's side and back.
  // A sideways pole here reads as a scarecrow T-pose.
  _v1.set(sideSign * 0.3, -1, -0.2).normalize();
  _v2.crossVectors(_v4, _v1);
  if (_v2.lengthSq() < 1e-6) _v2.set(sideSign, 0, 0);
  _v2.normalize();

  // upper-arm direction: target dir rotated by beta about the pole axis
  _q1.setFromAxisAngle(_v2, beta);
  _v1.copy(_v4).applyQuaternion(_q1); // upper arm dir (local)

  // orient the shoulder: rest pose points the arm along -Y
  _q1.setFromUnitVectors(_v2.set(0, -1, 0), _v1);
  // twist so the elbow hinge (local X) matches the bend plane:
  // desired hinge axis = normal of the (target, upperArm) plane
  _v2.crossVectors(_v3, _v1).normalize();
  if (_v2.lengthSq() > 1e-6) {
    _v4.set(1, 0, 0).applyQuaternion(_q1); // current hinge axis
    const twist = signedAngleAround(_v4, _v2, _v1);
    _q2.setFromAxisAngle(_v1, twist);
    _q1.premultiply(_q2);
  }
  shoulder.quaternion.slerp(_q1, 0.55); // slight smoothing keeps it organic
  elbow.rotation.x += (bend - elbow.rotation.x) * 0.6;
}

function signedAngleAround(from, to, axis) {
  const cross = _v3.crossVectors(from, to);
  const angle = Math.atan2(cross.dot(axis), from.dot(to));
  return angle;
}

// ---------------------------------------------------------------------------
// Model builder — a rigged procedural humanoid. Distinct heights, builds and
// kits per archetype. Replace with skinned rigs later; the pose engine only
// needs the named joints returned here.
// ---------------------------------------------------------------------------
export function buildPlayerModel(archetype) {
  const { height, build, kit } = archetype;
  const s = height / 1.8;
  const w = build;

  const shirt = new THREE.MeshStandardMaterial({ color: kit.shirt, roughness: 0.75 });
  const shirtDark = new THREE.MeshStandardMaterial({ color: new THREE.Color(kit.shirt).multiplyScalar(0.75), roughness: 0.8 });
  const shorts = new THREE.MeshStandardMaterial({ color: kit.shorts, roughness: 0.8 });
  const skin = new THREE.MeshStandardMaterial({ color: kit.skin, roughness: 0.65 });
  const shoe = new THREE.MeshStandardMaterial({ color: 0xf2f3f5, roughness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 0.55 });

  const group = new THREE.Group();
  const hipH = 0.96 * s;

  // ---- pelvis (root joint) & torso
  const pelvis = new THREE.Group();
  pelvis.position.y = hipH;
  group.add(pelvis);

  const pelvisMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.145 * w, 0.1 * s, 6, 12), shorts);
  pelvisMesh.position.y = 0.03 * s;
  pelvisMesh.castShadow = true;
  pelvis.add(pelvisMesh);

  const torso = new THREE.Group();
  torso.position.y = 0.12 * s;
  pelvis.add(torso);

  const chest = new THREE.Mesh(new THREE.CapsuleGeometry(0.155 * w, 0.34 * s, 6, 14), shirt);
  chest.position.y = 0.28 * s;
  chest.scale.set(1.15, 1, 0.82); // broader than deep — reads human
  chest.castShadow = true;
  torso.add(chest);

  // ---- head + neck + headband
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.045 * w, 0.055 * w, 0.07 * s, 8), skin);
  neck.position.y = 0.52 * s;
  torso.add(neck);
  const head = new THREE.Group();
  head.position.y = 0.62 * s;
  torso.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.105 * s, 16, 12), skin);
  skull.scale.set(0.92, 1.05, 0.98);
  skull.castShadow = true;
  head.add(skull);
  const band = new THREE.Mesh(
    new THREE.TorusGeometry(0.095 * s, 0.018 * s, 8, 18),
    new THREE.MeshStandardMaterial({ color: kit.accent ?? kit.shirt, roughness: 0.7 })
  );
  band.rotation.x = Math.PI / 2 - 0.25;
  band.position.y = 0.035 * s;
  head.add(band);
  const hair = new THREE.Mesh(
    new THREE.SphereGeometry(0.107 * s, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.45),
    new THREE.MeshStandardMaterial({ color: kit.hair ?? 0x2a2019, roughness: 0.9 })
  );
  hair.position.y = 0.012 * s;
  head.add(hair);

  // ---- arms (two-bone: shoulder group → elbow group). The racket is a rigid
  // extension of the RIGHT forearm; the IK treats forearm+racket as one bone.
  const armULen = 0.30 * s;
  const armFLenL = 0.27 * s;         // left hand
  const armFLenR = 0.27 * s + 0.29;  // right forearm + racket to head centre (racket size is constant)

  const mkArm = (side, forearmLen, withRacket) => {
    const shoulderG = new THREE.Group();
    shoulderG.position.set(side * 0.21 * w, 0.46 * s, 0);
    torso.add(shoulderG);
    const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.048 * w, armULen * 0.8, 4, 8), shirtDark);
    upper.position.y = -armULen / 2;
    upper.castShadow = true;
    shoulderG.add(upper);
    const elbowG = new THREE.Group();
    elbowG.position.y = -armULen;
    shoulderG.add(elbowG);
    const fLen = withRacket ? 0.27 * s : forearmLen;
    const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.04 * w, fLen * 0.8, 4, 8), skin);
    fore.position.y = -fLen / 2;
    fore.castShadow = true;
    elbowG.add(fore);
    const wrist = new THREE.Mesh(new THREE.SphereGeometry(0.045 * w, 8, 6), skin);
    wrist.position.y = -fLen;
    elbowG.add(wrist);
    return { shoulderG, elbowG, fLen };
  };

  const R = mkArm(1, armFLenR, true);
  const L = mkArm(-1, armFLenL, false);

  // racket on the right wrist
  const racket = new THREE.Group();
  racket.position.y = -R.fLen;
  racket.rotation.y = 0.45; // slight supination so the face reads from behind
  R.elbowG.add(racket);
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.02, 0.16, 8), dark);
  grip.position.y = -0.08;
  racket.add(grip);
  const face = new THREE.Group();
  face.position.y = -0.16 - 0.13;
  racket.add(face);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.125, 0.021, 8, 20), dark);
  rim.rotation.y = Math.PI / 2;
  rim.castShadow = true;
  face.add(rim);
  const faceMesh = new THREE.Mesh(
    new THREE.CircleGeometry(0.115, 20),
    new THREE.MeshStandardMaterial({
      color: kit.accent ?? 0x777777, roughness: 0.9, side: THREE.DoubleSide,
      transparent: true, opacity: 0.85,
    })
  );
  faceMesh.rotation.y = Math.PI / 2;
  face.add(faceMesh);
  // the IK end effector — the centre of the racket head
  const racketTip = new THREE.Object3D();
  racketTip.position.copy(face.position);
  racket.add(racketTip);

  // ---- legs: hip group → knee group → foot
  const thighLen = 0.42 * s, shinLen = 0.4 * s;
  const mkLeg = (side) => {
    const hipG = new THREE.Group();
    hipG.position.set(side * 0.095 * w, -0.02 * s, 0);
    pelvis.add(hipG);
    const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.065 * w, thighLen * 0.75, 4, 8), shorts);
    thigh.position.y = -thighLen / 2;
    thigh.castShadow = true;
    hipG.add(thigh);
    const kneeG = new THREE.Group();
    kneeG.position.y = -thighLen;
    hipG.add(kneeG);
    const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.05 * w, shinLen * 0.75, 4, 8), skin);
    shin.position.y = -shinLen / 2;
    shin.castShadow = true;
    kneeG.add(shin);
    const sock = new THREE.Mesh(new THREE.CylinderGeometry(0.052 * w, 0.055 * w, 0.1 * s, 8), shoe);
    sock.position.y = -shinLen + 0.07 * s;
    kneeG.add(sock);
    const footG = new THREE.Group();
    footG.position.y = -shinLen;
    kneeG.add(footG);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.085 * w, 0.055 * s, 0.21 * s), shoe);
    foot.position.set(0, -0.028 * s, 0.055 * s);
    foot.castShadow = true;
    footG.add(foot);
    return { hipG, kneeG, footG };
  };
  const legR = mkLeg(1), legL = mkLeg(-1);

  // soft blob shadow for grounding
  const blob = new THREE.Mesh(
    new THREE.CircleGeometry(0.34 * w, 18),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false })
  );
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.008;
  group.add(blob);

  return {
    group, hipH,
    pelvis, torso, head,
    shoulderR: R.shoulderG, elbowR: R.elbowG, armRLenU: armULen, armRLenF: armFLenR,
    shoulderL: L.shoulderG, elbowL: L.elbowG, armLLenU: armULen, armLLenF: armFLenL,
    hipR: legR.hipG, kneeR: legR.kneeG, footR: legR.footG,
    hipL: legL.hipG, kneeL: legL.kneeG, footL: legL.footG,
    racket, racketTip,
  };
}
