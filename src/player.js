// ============================================================================
// player.js — Player entity shared by the human and all AI players:
//
//  * Locomotion with acceleration, ground friction, momentum, a turn-rate
//    limit and backpedal penalty — players lean into direction changes and
//    cannot glide or snap-turn.
//  * Stamina drains at sprint, regenerates at rest, and (with movement speed
//    at contact) degrades shot quality — bad positioning costs you twice.
//  * A swing state machine: prepare (wind-up) → active window (contact
//    possible, timing scored) → recover (control penalty). Whiffs hurt.
//  * A deliberately simple articulated model (capsule torso, limbs, racket)
//    with procedural poses per state — isolated in buildPlayerModel() so real
//    rigs can replace it without touching gameplay.
// ============================================================================

import * as THREE from 'three';
import { COURT, MOVE, HIT } from './constants.js';
import { SHOTS } from './shots.js';
import {
  v3, vLen, clamp, lerp, damp, yawOf, angleDelta, lenXZ,
} from './mathUtils.js';

let nextId = 0;

export class Player {
  /**
   * @param archetype roster entry
   * @param team 0 = z>0 (human side), 1 = z<0
   * @param slot 'left' | 'right' — the side of their own court they cover,
   *             from THEIR OWN perspective facing the net.
   */
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

    // active swing descriptor (null when not swinging)
    this.swing = null;
    this.moveIntent = v3(); // set each frame by controller / AI

    this.runPhase = 0;
    this.model = buildPlayerModel(archetype);
  }

  // --- derived attributes ---------------------------------------------------
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

  // shoulder height used as the shot origin
  shoulderHeight() { return this.archetype.height * 0.82; }

  // --- swing lifecycle --------------------------------------------------------
  /** Begin a swing. The sim loop calls tryContact() each physics step while
   *  the window is open; on success main.js executes the shot. */
  startSwing(shotKey, aim, power = 0.6) {
    if (this.swing && !this.swing.done) return false;
    const def = SHOTS[shotKey];
    const overhead = def.tags.includes('overhead');
    this.swing = {
      shot: shotKey, aim, power,
      elapsed: 0,
      windup: HIT.windup * (overhead ? 1.5 : 1),
      window: HIT.activeWindow,
      done: false,
      contact: null,
    };
    this.setState(overhead ? 'overhead' : (def.tags.includes('net') ? 'volley' : 'prepare'));
    return true;
  }

  cancelSwing() { this.swing = null; }

  /** Check whether the ball is contactable right now; returns contact info or
   *  null. Called by the sim loop during the active window. */
  tryContact(ballPos) {
    const sw = this.swing;
    if (!sw || sw.done) return null;
    if (sw.elapsed < sw.windup) return null;
    const def = SHOTS[sw.shot];

    // ball must be on our side of the net (no reaching over in padel)
    if (Math.sign(ballPos.z) !== this.teamSign && Math.abs(ballPos.z) > 0.05) return null;

    // reach: horizontal distance, generous height window around the shot's
    // contact band (you can dig low balls / stretch, at a quality cost)
    const dx = ballPos.x - this.pos.x, dz = ballPos.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    const overhead = def.tags.includes('overhead');
    const maxH = overhead ? this.overheadReach() : def.contact[2] + 0.4;
    const minH = Math.max(0.03, def.contact[0] - 0.25);
    if (dist > this.reach() || ballPos.y > maxH || ballPos.y < minH) return null;

    // timing score: 1 at the ideal moment (just after the window opens),
    // falling toward the edges of the active window
    const tIn = sw.elapsed - sw.windup;
    const tMid = sw.window * 0.4;
    const timing = clamp(1 - Math.abs(tIn - tMid) / (sw.window * 0.62), 0, 1);

    sw.done = true;
    sw.contact = {
      shot: sw.shot, aim: sw.aim, power: sw.power,
      timing,
      dist,
      ballHeight: ballPos.y,
      playerSpeed: vLen(this.vel),
      facingError: Math.abs(angleDelta(this.facing, Math.atan2(sw.aim.x - this.pos.x, sw.aim.z - this.pos.z))),
    };
    this.setState('swing');
    return sw.contact;
  }

  /** true while the swing window is open or winding up */
  isSwinging() { return !!this.swing && !this.swing.done; }
  inRecovery() { return this.state === 'recover' || this.state === 'swing'; }

  // --- per-frame update -------------------------------------------------------
  update(dt) {
    this.stateTime += dt;

    // ---- swing timeline
    if (this.swing) {
      this.swing.elapsed += dt;
      if (!this.swing.done && this.swing.elapsed > this.swing.windup + this.swing.window) {
        // whiffed — nothing was contacted in the window
        this.swing = null;
        this.setState('recover');
        this.stateTime = -(HIT.whiffRecover - HIT.recoverTime); // longer recovery
      } else if (this.swing.done && this.state === 'swing' && this.stateTime > 0.22) {
        this.swing = null;
        this.setState('recover');
      }
    }
    if (this.state === 'recover' && this.stateTime > HIT.recoverTime) this.setState('idle');

    // ---- locomotion: accelerate toward intent, friction decelerates.
    // Swinging/recovering players are heavy-footed (control penalty).
    const controlF = this.isSwinging() ? 0.35 : this.state === 'swing' ? 0.2 :
      this.state === 'recover' ? 0.55 : 1;
    const intentLen = lenXZ(this.moveIntent);
    if (intentLen > 0.01) {
      const ix = this.moveIntent.x / Math.max(1, intentLen);
      const iz = this.moveIntent.z / Math.max(1, intentLen);
      // backpedal: moving against facing is slower
      const moveYaw = Math.atan2(ix, iz);
      const against = Math.abs(angleDelta(this.facing, moveYaw)) > Math.PI * 0.6;
      const a = this.accel() * controlF * (against ? MOVE.backpedalFactor : 1);
      this.vel.x += ix * a * dt;
      this.vel.z += iz * a * dt;
    }
    // exponential ground friction — natural momentum + deceleration
    const fr = Math.exp(-MOVE.friction * dt * (intentLen > 0.01 ? 0.42 : 1));
    this.vel.x *= fr; this.vel.z *= fr;

    // clamp speed
    const sp = lenXZ(this.vel);
    const max = this.maxSpeed() * (intentLen > 0.01 ? clamp(intentLen, 0, 1) : 1) *
      (this.isSwinging() ? 0.5 : 1);
    if (sp > max) { this.vel.x *= max / sp; this.vel.z *= max / sp; }

    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

    // keep players inside their half of the cage (padel: you never cross the net)
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
    const drainScale = 1.6 - (this.stats.stamina / 100) * 1.1; // high stamina stat drains slower
    if (effort > 0.55) this.stamina -= MOVE.staminaDrainSprint * drainScale * effort * dt;
    else this.stamina += MOVE.staminaRegen * dt;
    this.stamina = clamp(this.stamina, 0, 100);

    // ---- run state & animation
    if (!this.swing && this.state !== 'recover' && this.state !== 'swing') {
      this.setState(sp > 0.6 ? 'run' : 'idle', true);
    }
    this.runPhase += sp * dt * 2.4;
    this.updateModel(dt);
  }

  setState(s, soft = false) {
    if (this.state === s) return;
    this.state = s;
    if (!soft) this.stateTime = 0;
  }

  // --- procedural posing ------------------------------------------------------
  updateModel(dt) {
    const m = this.model;
    m.group.position.set(this.pos.x, 0, this.pos.z);
    m.group.rotation.y = this.facing;

    // target pose angles per state { rArmX (swing fwd/back), rArmZ (raise),
    // lArmX, lArmZ, torsoLean, legsAmp }
    let pose;
    const t = this.stateTime;
    switch (this.state) {
      case 'run': pose = { rArmX: Math.sin(this.runPhase) * 0.5, rArmZ: 0.25, lArmX: -Math.sin(this.runPhase) * 0.5, lArmZ: -0.25, lean: 0.12, legs: 0.75 }; break;
      case 'prepare': pose = { rArmX: -1.15, rArmZ: 0.45, lArmX: 0.35, lArmZ: -0.3, lean: 0.1, legs: 0.3 }; break;
      case 'volley': pose = { rArmX: -0.55, rArmZ: 0.8, lArmX: 0.3, lArmZ: -0.35, lean: 0.06, legs: 0.25 }; break;
      case 'overhead': pose = { rArmX: -0.5, rArmZ: 2.75, lArmX: 0.6, lArmZ: -1.1, lean: -0.1, legs: 0.2 }; break;
      case 'swing': {
        const k = clamp(t / 0.22, 0, 1);
        const arc = Math.sin(k * Math.PI);
        pose = { rArmX: lerp(-1.1, 1.3, k), rArmZ: lerp(1.6, 0.3, k) * (1 - arc * 0.2), lArmX: 0.2, lArmZ: -0.5, lean: 0.18 * arc, legs: 0.2 };
        break;
      }
      case 'recover': pose = { rArmX: 0.5, rArmZ: 0.5, lArmX: 0.3, lArmZ: -0.5, lean: 0.05, legs: 0.3 }; break;
      default: pose = { rArmX: 0.12, rArmZ: 0.3, lArmX: -0.05, lArmZ: -0.3, lean: 0.04, legs: 0 };
    }

    const L = 14; // pose smoothing rate
    m.rArm.rotation.x = damp(m.rArm.rotation.x, pose.rArmX, L, dt);
    m.rArm.rotation.z = damp(m.rArm.rotation.z, pose.rArmZ, L, dt);
    m.lArm.rotation.x = damp(m.lArm.rotation.x, pose.lArmX, L, dt);
    m.lArm.rotation.z = damp(m.lArm.rotation.z, pose.lArmZ, L, dt);
    m.torso.rotation.x = damp(m.torso.rotation.x, pose.lean, L, dt);
    const legSwing = Math.sin(this.runPhase) * 0.65 * pose.legs;
    m.lLeg.rotation.x = damp(m.lLeg.rotation.x, legSwing, 18, dt);
    m.rLeg.rotation.x = damp(m.rLeg.rotation.x, -legSwing, 18, dt);
  }
}

// ---------------------------------------------------------------------------
// Model builder — swap this out for real rigs later. Height/build/kit come
// from the roster so all four players are visually distinct at a glance.
// ---------------------------------------------------------------------------
export function buildPlayerModel(archetype) {
  const { height, build, kit } = archetype;
  const group = new THREE.Group();
  const s = height / 1.8; // uniform scale reference

  const shirtMat = new THREE.MeshStandardMaterial({ color: kit.shirt, roughness: 0.8 });
  const shortsMat = new THREE.MeshStandardMaterial({ color: kit.shorts, roughness: 0.8 });
  const skinMat = new THREE.MeshStandardMaterial({ color: kit.skin, roughness: 0.7 });

  // torso (pivot at hips so lean looks natural)
  const torso = new THREE.Group();
  torso.position.y = 0.95 * s;
  const chest = new THREE.Mesh(new THREE.CapsuleGeometry(0.17 * build, 0.42 * s, 6, 12), shirtMat);
  chest.position.y = 0.33 * s;
  chest.castShadow = true;
  torso.add(chest);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.11 * s, 14, 12), skinMat);
  head.position.y = 0.72 * s;
  head.castShadow = true;
  torso.add(head);
  group.add(torso);

  // arms (pivot at shoulder). Racket on the right arm.
  const mkArm = (side) => {
    const arm = new THREE.Group();
    arm.position.set(side * 0.24 * build, 0.55 * s, 0);
    const limb = new THREE.Mesh(new THREE.CapsuleGeometry(0.045 * build, 0.5 * s, 4, 8), skinMat);
    limb.position.y = -0.28 * s;
    limb.castShadow = true;
    arm.add(limb);
    torso.add(arm);
    return arm;
  };
  const rArm = mkArm(1), lArm = mkArm(-1);

  // racket: handle + rounded head, child of the right arm
  const racket = new THREE.Group();
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.2), new THREE.MeshStandardMaterial({ color: 0x222222 }));
  handle.position.y = -0.62 * s;
  racket.add(handle);
  const headR = new THREE.Mesh(
    new THREE.CylinderGeometry(0.13, 0.13, 0.035, 18),
    new THREE.MeshStandardMaterial({ color: 0x101010, roughness: 0.6 })
  );
  headR.rotation.x = Math.PI / 2;
  headR.position.y = -0.78 * s;
  racket.add(headR);
  rArm.add(racket);

  // legs (pivot at hip)
  const mkLeg = (side) => {
    const leg = new THREE.Group();
    leg.position.set(side * 0.1 * build, 0.95 * s, 0);
    const limb = new THREE.Mesh(new THREE.CapsuleGeometry(0.06 * build, 0.72 * s, 4, 8), shortsMat);
    limb.position.y = -0.45 * s;
    limb.castShadow = true;
    leg.add(limb);
    group.add(leg);
    return leg;
  };
  const rLeg = mkLeg(1), lLeg = mkLeg(-1);

  // soft blob shadow for grounding
  const blob = new THREE.Mesh(
    new THREE.CircleGeometry(0.32 * build, 18),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false })
  );
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.008;
  group.add(blob);

  return { group, torso, rArm, lArm, rLeg, lLeg, racket };
}
