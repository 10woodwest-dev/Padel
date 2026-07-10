// ============================================================================
// match.js — Match orchestration: game modes, serve rotation, the automated
// underarm serve sequence, point reset flow, and the glue between referee,
// scoring and UI.
//
// Point lifecycle:
//   positioning → preServe → live (serveFlight/rally in the referee)
//   → pointOver banner → positioning …
//
// Serve rotation (doubles): one server per game, rotating through all four
// players (T0-A, T1-A, T0-B, T1-B). Within a game the serve side alternates
// right → left starting from the right. The receiver is the opponent whose
// slot matches the box (deuce serve → deuce returner).
// ============================================================================

import { COURT } from './constants.js';
import { v3, vCopy, rand } from './mathUtils.js';
import { resetBall } from './ball.js';
import { executeShot, computeShotQuality } from './shots.js';

export class Match {
  /**
   * @param players array of 4 Player objects (2 per team)
   * @param ball ball physics state
   * @param referee Referee
   * @param scoring Scoring
   * @param cb {onMessage(text, kind), onScore(), onPhase(state), onShotFeedback(text)}
   */
  constructor(players, ball, referee, scoring, cb) {
    this.players = players;
    this.ball = ball;
    this.referee = referee;
    this.scoring = scoring;
    this.cb = cb;

    this.mode = 'match'; // 'match' | 'rally'
    this.state = 'idle';
    this.stateTime = 0;

    // serve rotation: player indices into this.players
    this.serveOrder = this.buildServeOrder();
    this.serveOrderIdx = 0;
    this.serveSide = 'right';
    this.serveNumber = 1;

    this.serveStage = null; // null | 'drop' | 'struck'
    this.serveBounced = false;
  }

  buildServeOrder() {
    const t0 = this.players.filter((p) => p.team === 0);
    const t1 = this.players.filter((p) => p.team === 1);
    return [t0[0], t1[0], t0[1], t1[1]].map((p) => this.players.indexOf(p));
  }

  get server() { return this.players[this.serveOrder[this.serveOrderIdx % 4]]; }

  get receiver() {
    // diagonal returner: the receiving-team player covering the serve-side slot
    const recvTeam = 1 - this.server.team;
    return this.players.find((p) => p.team === recvTeam && p.slot === this.serveSide)
      || this.players.find((p) => p.team === recvTeam);
  }

  // --------------------------------------------------------------------------
  begin(mode) {
    this.mode = mode;
    this.scoring.reset();
    this.serveOrderIdx = 0;
    this.serveSide = 'right';
    this.serveNumber = 1;
    this.startPoint();
    this.cb.onScore();
  }

  startPoint() {
    this.state = 'positioning';
    this.stateTime = 0;
    this.serveStage = null;
    this.serveBounced = false;
    this.ball.active = false;
    this.assignStartPositions();
    this.cb.onPhase(this.state);
  }

  /** restart the current point (R key) — no score change. If the previous
   *  point was already decided (banner showing), advance to the next point
   *  instead so the pending serve-rotation/side change isn't discarded. */
  restartPoint() {
    if (this.state === 'matchOver') return;
    if (this.state === 'pointOver') {
      this.nextPoint();
    } else {
      this.serveNumber = 1;
      this.startPoint();
      this.cb.onMessage('Point restarted', 'info');
    }
  }

  // Classic doubles positions. Serving team: server deep behind the line,
  // partner already at the net on the other half. Receiving team: returner
  // deep in the diagonal box corner, partner guarding the middle.
  assignStartPositions() {
    const srv = this.server;
    const sSign = srv.teamSign;
    const sideSign = (this.serveSide === 'right' ? 1 : -1) * sSign; // world x of serving half
    srv.pos = v3(sideSign * 2.6, 0, sSign * (COURT.serviceLineZ + 1.6));
    srv.vel = v3();

    const partner = this.players.find((p) => p.team === srv.team && p !== srv);
    partner.pos = v3(-sideSign * 2.2, 0, sSign * 2.6);
    partner.vel = v3();

    const recv = this.receiver;
    const rSign = recv.teamSign;
    recv.pos = v3(-sideSign * 2.7, 0, rSign * (COURT.serviceLineZ + 1.9));
    recv.vel = v3();

    const recvPartner = this.players.find((p) => p.team === recv.team && p !== recv);
    recvPartner.pos = v3(sideSign * 1.8, 0, rSign * 4.6);
    recvPartner.vel = v3();

    // park the ball in the server's hand
    this.ball.pos = v3(srv.pos.x + 0.3 * Math.sign(srv.pos.x || 1), 0.9, srv.pos.z);
    this.ball.vel = v3(); this.ball.spin = v3();
    this.ball.active = false;
  }

  // --------------------------------------------------------------------------
  update(dt) {
    this.stateTime += dt;

    switch (this.state) {
      case 'positioning':
        if (this.stateTime > 0.9) {
          this.state = 'preServe';
          this.stateTime = 0;
          this.referee.beginServe(this.server.team, this.serveSide, this.serveNumber, this.receiver.id);
          this.cb.onPhase(this.state);
          const label = this.serveNumber === 2 ? 'Second serve' :
            (this.scoring.isGoldenPointNow() ? 'GOLDEN POINT' : null);
          if (label) this.cb.onMessage(label, 'info');
        }
        break;

      case 'preServe':
        // ball stays in hand until the serve starts
        if (!this.serveStage) {
          this.ball.pos.x = this.server.pos.x + 0.35 * Math.sin(this.server.facing + 0.5);
          this.ball.pos.y = 0.9;
          this.ball.pos.z = this.server.pos.z + 0.35 * Math.cos(this.server.facing + 0.5);
        }
        this.updateServeSequence(dt);
        break;

      case 'pointOver':
        if (this.stateTime > 2.0) this.nextPoint();
        break;
    }
  }

  // --- the underarm serve: drop → bounce → strike below the waist ----------
  /** called by human controller (Space) or AI; aim must be inside the box */
  requestServe(aim) {
    if (this.state !== 'preServe' || this.serveStage) return;
    this.serveStage = 'drop';
    this.serveDropTime = 0;
    this.serveAim = vCopy(aim);
    this.serveBounced = false;
    // release the ball from the hand — real padel: bounce it, hit it underarm
    resetBall(this.ball, this.ball.pos, v3(0, -0.4, 0), v3());
  }

  /** ball events during the drop are watched to time the underarm strike.
   *  Only a bounce at the server's feet counts — if someone whacked the drop
   *  ball across the court, a far-away bounce must not arm the serve. */
  onBallEvent(ev) {
    if (this.state === 'preServe' && this.serveStage === 'drop' && ev.type === 'floor') {
      const srv = this.server;
      if (Math.hypot(ev.pos.x - srv.pos.x, ev.pos.z - srv.pos.z) < 1.5) {
        this.serveBounced = true;
      }
    }
  }

  updateServeSequence(dt) {
    if (this.serveStage !== 'drop') return;
    this.serveDropTime = (this.serveDropTime || 0) + dt;
    // if the drop ball was knocked away from the server (interference),
    // re-park it and restart the drop instead of serving from mid-court
    {
      const srv = this.server;
      if (Math.hypot(this.ball.pos.x - srv.pos.x, this.ball.pos.z - srv.pos.z) > 1.6) {
        this.serveStage = null;
        this.serveBounced = false;
        this.ball.active = false;
        this.ball.pos = v3(srv.pos.x + 0.3, 0.9, srv.pos.z);
        this.ball.vel = v3(); this.ball.spin = v3();
        return;
      }
    }
    if (!this.serveBounced && this.serveDropTime < 2) return;
    const ball = this.ball;
    // strike near the apex of the bounce (must be below the waist — it is,
    // the bounce apex from a hand drop is ~0.45 m). The 2 s timeout is a
    // safety net so a degenerate drop can never soft-lock the serve.
    if ((ball.vel.y <= 0.25 && ball.pos.y > 0.2) || this.serveDropTime >= 2) {
      this.serveDropTime = 0;
      const srv = this.server;
      const q = computeShotQuality({
        shot: 'serve',
        timing: 0.85,               // automated toss → consistent contact
        ballHeight: ball.pos.y,
        playerSpeed: 0,
        facingError: 0,
        stamina: srv.stamina,
        statValue: srv.stats.consistency,
      });
      srv.startSwing('serve', this.serveAim, 0.6);
      if (srv.swing) { srv.swing.done = true; srv.setState('swing'); } // visual only
      executeShot(ball, {
        shot: 'serve',
        start: vCopy(ball.pos),
        aim: this.serveAim,
        hitterSide: srv.teamSign,
        quality: q.quality,
        power: rand(0.45, 0.75),
        errorScale: srv.isHuman ? 0.9 : 1.0,
      });
      this.serveStage = 'struck';
      this.state = 'live';
      this.stateTime = 0;
      this.referee.serveStruck();
      this.cb.onServeStruck?.(srv);
      this.cb.onPhase(this.state);
    }
  }

  // --- outcomes coming back from the referee (wired in main.js) -------------
  handlePointOver({ winner, message }) {
    this.state = 'pointOver';
    this.stateTime = 0;
    this.cb.onPhase(this.state);
    this.cb.onMessage(message, winner === 0 ? 'good' : 'bad');

    if (this.mode === 'match') {
      const res = this.scoring.addPoint(winner);
      this.cb.onScore();
      this.pendingAdvance = {
        gameWon: !!res.gameWon, matchWon: !!res.matchWon, tieBreak: !!res.tieBreak,
        tieBreakPoint: !!res.tieBreakPoint, tieBreakPointsPlayed: res.tieBreakPointsPlayed || 0,
      };
      if (res.matchWon) {
        this.state = 'matchOver';
        this.cb.onPhase(this.state);
        this.cb.onMessage(`MATCH — ${winner === 0 ? 'Your team' : 'Opponents'} win!`, winner === 0 ? 'good' : 'bad');
      } else if (res.setWon) {
        this.cb.onMessage('Set won!', winner === 0 ? 'good' : 'bad');
      } else if (res.tieBreak) {
        this.cb.onMessage('Tie-break!', 'info');
      }
    } else {
      this.pendingAdvance = { gameWon: false };
    }
  }

  handleServeFault({ message, double }) {
    this.cb.onMessage(message, 'bad');
    if (double) {
      // double fault = point to the receiving team
      this.handlePointOver({ winner: 1 - this.server.team, message });
    } else {
      this.serveNumber = 2;
      this.serveStage = null;
      this.state = 'positioning';
      this.stateTime = 0.6; // shorter reset before the second serve
      // everyone walks back to legal serve positions — otherwise the second
      // serve is struck from wherever the first rally left the players
      // (including the wrong half of the court)
      this.assignStartPositions();
    }
  }

  handleLet({ message }) {
    this.cb.onMessage(message, 'info');
    // replay the same serve (same serve number)
    this.serveStage = null;
    this.state = 'positioning';
    this.stateTime = 0.6;
    this.assignStartPositions();
  }

  nextPoint() {
    // advance serve side / game rotation
    if (this.mode === 'match') {
      if (this.pendingAdvance?.gameWon) {
        this.serveOrderIdx++;
        this.serveSide = 'right';
      } else if (this.pendingAdvance?.tieBreakPoint) {
        // tie-break rotation: server changes after the 1st point and then
        // every 2 points; sides follow the point parity (right on even)
        const played = this.pendingAdvance.tieBreakPointsPlayed;
        if (played % 2 === 1) this.serveOrderIdx++;
        this.serveSide = played % 2 === 0 ? 'right' : 'left';
      } else {
        this.serveSide = this.serveSide === 'right' ? 'left' : 'right';
      }
    } else {
      // free rally: alternate the serving team every point for variety
      this.serveOrderIdx++;
      this.serveSide = rand() < 0.5 ? 'right' : 'left';
    }
    this.serveNumber = 1;
    this.startPoint();
  }
}
