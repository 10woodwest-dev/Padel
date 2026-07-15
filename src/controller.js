// ============================================================================
// controller.js — Human player controller.
//
// Bindings (also on the start screen / pause menu):
//   WASD           move (with momentum — see player.js)
//   Mouse          aim (reticle on the opponent court); arrow keys nudge aim
//   Space / LMB    standard shot (context: drive / topspin / volley /
//                  wall return / bandeja when overhead)
//   Shift + shot   lob / high defensive shot
//   F / RMB        attacking shot — smash when the ball is overhead,
//                  flat drive otherwise
//   E              bandeja / víbora overhead (auto-picks by ball height)
//   Q              chiquita (soft low ball) / block volley at the net
//   R              restart point        C  camera toggle
//   Esc            pause                F3 debug overlay
//
// Design: pressing a shot key STARTS a swing (wind-up → active window).
// Quality comes from when you press relative to the ball's arrival — plus
// position, balance, orientation and stats (computed centrally in main.js).
// ============================================================================

import * as THREE from 'three';
import { COURT, HIT } from './constants.js';
import { v3, clamp } from './mathUtils.js';

export class HumanController {
  constructor(player, input, camera) {
    this.player = player;
    this.input = input;
    this.camera = camera;
    this.aim = v3(0, 0, -7 * player.teamSign); // aim marker on opponent court
    this._ray = new THREE.Raycaster();
    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._hit = new THREE.Vector3();
    this._usingMouse = true;
  }

  /**
   * @param ctx {ball, phase, isServer, serveSide, ballIncoming, lastGlassOwnSide}
   * Returns actions consumed by main.js: {serve:boolean}
   */
  update(dt, ctx) {
    const inp = this.input, p = this.player;
    const actions = {};

    // ---- movement intent (WASD in world axes: W = toward the net) ----------
    const ix = (inp.held('KeyD') ? 1 : 0) - (inp.held('KeyA') ? 1 : 0);
    const iz = (inp.held('KeyS') ? 1 : 0) - (inp.held('KeyW') ? 1 : 0); // W → -z... flipped below by team
    p.moveIntent = v3(ix, 0, iz * p.teamSign);

    // during the serve, the server is held behind the service line in the
    // correct half (rules: both feet behind the line, correct side)
    if (ctx.phase === 'preServe' && ctx.isServer) {
      const sideSign = ctx.serveSide === 'right' ? 1 : -1; // team-0 right = +x
      const xLo = sideSign > 0 ? 0.4 : -(COURT.halfWidth - 0.3);
      const xHi = sideSign > 0 ? COURT.halfWidth - 0.3 : -0.4;
      p.pos.x = clamp(p.pos.x, xLo, xHi);
      p.pos.z = clamp(p.pos.z, (COURT.serviceLineZ + 0.25) * p.teamSign, (COURT.halfLength - 0.4) * p.teamSign);
    }

    // ---- aiming -------------------------------------------------------------
    this.updateAim(dt, ctx);

    // ---- facing: square up to the ball when it's coming, else face the net
    const ball = ctx.ball;
    if (ball.active && ctx.ballIncoming) {
      p.targetFacing = Math.atan2(ball.pos.x - p.pos.x, ball.pos.z - p.pos.z);
    } else {
      p.targetFacing = Math.atan2(this.aim.x - p.pos.x, this.aim.z - p.pos.z);
    }

    // ---- shot keys ----------------------------------------------------------
    const shotPressed = inp.wasPressed('Space') || inp.mouseWasPressed(0);
    const attackPressed = inp.wasPressed('KeyF') || inp.mouseWasPressed(2);
    const overheadPressed = inp.wasPressed('KeyE');
    const softPressed = inp.wasPressed('KeyQ');
    const lobHeld = inp.held('ShiftLeft') || inp.held('ShiftRight');

    if (ctx.phase === 'preServe' && ctx.isServer) {
      if (shotPressed) actions.serve = true;   // main.js runs the bounce→hit serve
      return actions;
    }

    if (p.isSwinging()) return actions; // one swing at a time

    let shot = null;
    if (shotPressed) shot = lobHeld ? 'lob' : this.contextualStandard(ctx);
    else if (attackPressed) shot = this.overheadPossible(ctx) ? 'smash' : 'drive';
    else if (overheadPressed) shot = this.pickOverhead(ctx);
    else if (softPressed) shot = this.nearNet() ? 'blockVolley' : 'chiquita';

    if (shot) {
      const power = this.autoPower(shot);
      p.startSwing(shot, { ...this.aim }, power);
    }
    return actions;
  }

  // Standard shot context: overhead ball → bandeja; at the net → volley;
  // ball just came off our glass and we're deep → wall return; else topspin.
  contextualStandard(ctx) {
    const p = this.player, ball = ctx.ball;
    if (this.overheadPossible(ctx)) return 'bandeja';
    if (this.nearNet()) return 'volley';
    if (ctx.lastGlassOwnSide && Math.abs(p.pos.z) > COURT.serviceLineZ - 0.5) return 'wallDefence';
    return 'topspin';
  }

  pickOverhead(ctx) {
    if (!this.overheadPossible(ctx)) return this.nearNet() ? 'volley' : 'topspin';
    // víbora when taking the ball a touch lower / more aggressive archetype
    const h = ctx.ball.pos.y;
    const vib = this.player.stats.vibora >= this.player.stats.bandeja;
    return (h < 2.05 && vib) ? 'vibora' : 'bandeja';
  }

  overheadPossible(ctx) {
    const ball = ctx.ball;
    if (!ball.active) return false;
    // ball is (or will shortly be) above shoulder height near the player
    const dx = ball.pos.x - this.player.pos.x, dz = ball.pos.z - this.player.pos.z;
    const near = Math.hypot(dx, dz) < 3.2;
    return near && ball.pos.y > 1.55;
  }

  nearNet() {
    return Math.abs(this.player.pos.z) < HIT.volleyMaxDistFromNet;
  }

  // Power auto-scales with how deep you aim: full-court targets get more gas.
  autoPower(shot) {
    const p = this.player;
    const dist = Math.hypot(this.aim.x - p.pos.x, this.aim.z - p.pos.z);
    return clamp((dist - 4) / 12, 0.25, 1);
  }

  // ---- aim marker: mouse raycast onto the ground plane, arrows as fallback --
  updateAim(dt, ctx) {
    const inp = this.input;
    const usedArrows = inp.held('ArrowUp') || inp.held('ArrowDown') || inp.held('ArrowLeft') || inp.held('ArrowRight');
    if (usedArrows) this._usingMouse = false;
    if (performance.now() - inp.mouseMovedAt < 400) this._usingMouse = true;

    if (this._usingMouse) {
      this._ray.setFromCamera(new THREE.Vector2(inp.mouse.x, inp.mouse.y), this.camera);
      if (this._ray.ray.intersectPlane(this._plane, this._hit)) {
        this.aim.x = this._hit.x;
        this.aim.z = this._hit.z;
      }
    } else {
      const sp = 7 * dt;
      this.aim.x += ((inp.held('ArrowRight') ? 1 : 0) - (inp.held('ArrowLeft') ? 1 : 0)) * sp;
      this.aim.z += ((inp.held('ArrowDown') ? 1 : 0) - (inp.held('ArrowUp') ? 1 : 0)) * sp * this.player.teamSign;
    }

    // clamp to the opponent half; during our serve clamp to the diagonal box
    const oppSign = -this.player.teamSign;
    if (ctx.phase === 'preServe' && ctx.isServer) {
      // diagonal = opposite x sign to the serving side (see ARCHITECTURE.md)
      const sideSign = ctx.serveSide === 'right' ? 1 : -1;   // server half (team-0 view)
      const boxSign = -sideSign;                              // receiver box x sign
      this.aim.x = boxSign > 0 ? clamp(this.aim.x, 0.5, COURT.halfWidth - 0.5)
        : clamp(this.aim.x, -COURT.halfWidth + 0.5, -0.5);
      const zAbs = clamp(Math.abs(this.aim.z), 1.2, COURT.serviceLineZ - 0.4);
      this.aim.z = zAbs * oppSign;
    } else {
      this.aim.x = clamp(this.aim.x, -COURT.halfWidth + 0.3, COURT.halfWidth - 0.3);
      const zAbs = clamp(Math.abs(this.aim.z), 1.0, COURT.halfLength - 0.4);
      this.aim.z = zAbs * oppSign;
    }
  }
}
