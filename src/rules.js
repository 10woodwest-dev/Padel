// ============================================================================
// rules.js — The referee. An event-driven state machine fed by ball physics
// events + racket hits, encoding real padel law:
//
// SERVE (phase 'serveFlight'):
//  * must bounce in the DIAGONAL service box (between net and service line,
//    opposite x-sign to the serving half)     → else FAULT
//  * bouncing on the server's own side, or touching the server's own wall,
//    or hitting receiver glass/mesh BEFORE the box bounce → FAULT
//  * net body → FAULT; net cord + valid box bounce → LET (replay the serve)
//  * after a valid box bounce the ball may hit GLASS (still a good serve)
//    but touching the METALLIC MESH before the return → FAULT
//  * the returner must let it bounce: volleying the serve loses the point
//  * two serves; double fault loses the point
//
// RALLY (phase 'rally'), per "leg" (the interval between two hits):
//  * after you hit, the ball may rebound off YOUR OWN GLASS on its way over,
//    but touching your own mesh loses the point
//  * it must bounce on the opponents' FLOOR before touching their glass/mesh
//    — a direct wall/fence hit loses the point
//  * once it has bounced on their floor, wall & fence rebounds are live
//  * second floor bounce on their side wins you the point
//  * ball into the net body, or bouncing back on your own floor → you lose
//  * ball flying OUT of the cage after a legal bounce stays PLAYABLE — the
//    defenders may chase it through the side doors and hit it back; the
//    point goes to the hitter the moment it touches the ground outside.
//    An exit without bouncing is simply out (hitter loses).
//  * ball touching a player's body → that player's team loses the point
// ============================================================================

import { COURT } from './constants.js';

export class Referee {
  /**
   * callbacks: {
   *   onPointOver({winner, reason, message}),
   *   onServeFault({message, double}),  // referee handles 1st/2nd internally
   *   onLet({message}),
   *   onMessage(text)                    // transient info ("second serve")
   * }
   */
  constructor(callbacks) {
    this.cb = callbacks;
    this.phase = 'idle'; // idle | preServe | serveFlight | rally | over
    this.reset();
  }

  reset() {
    this.servingTeam = 0;
    this.serveSide = 'right';
    this.serveNumber = 1;
    this.legHitTeam = null;   // team that struck the current leg
    this.legBounced = false;  // has it bounced on the receiving floor yet?
    this.netTouched = false;  // cord clip during serve flight (potential let)
    this.serveReturnPending = false; // between valid serve bounce and return
    this.outPlay = false;     // ball legally left the cage, still playable
  }

  // --- lifecycle driven by match.js ----------------------------------------
  beginServe(team, side, number, receiverId = null) {
    this.phase = 'preServe';
    this.servingTeam = team;
    this.serveSide = side;
    this.serveNumber = number;
    this.receiverId = receiverId; // only this player may return the serve
    this.netTouched = false;
    this.legBounced = false;
    this.serveReturnPending = false;
    this.legHitTeam = team;
  }

  serveStruck() {
    this.phase = 'serveFlight';
    this.netTouched = false;
  }

  /** any racket contact after the serve strike */
  rallyHit(player) {
    // ignore swings at a dead ball (point already decided / not started) —
    // without this a hit during the point-over banner would re-open the
    // rally and let the same point be scored twice
    if (this.phase !== 'serveFlight' && this.phase !== 'rally') return;
    if (this.phase === 'serveFlight') {
      // returner (or partner) volleyed the serve before the bounce — illegal
      if (player.team !== this.servingTeam) {
        return this.pointOver(this.servingTeam, 'serve-volley',
          'Return before the bounce — serve must bounce first');
      }
      // the serving team playing its own serve before the box bounce is a
      // double strike — they lose the point (and it must never morph into a
      // rally leg that skips the service-box check)
      return this.pointOver(1 - this.servingTeam, 'serve-touch',
        'Serving team touched the serve');
    }
    // only the diagonal receiver may return the serve
    if (this.serveReturnPending && player.team !== this.servingTeam
      && this.receiverId != null && player.id !== this.receiverId) {
      return this.pointOver(this.servingTeam, 'wrong-returner',
        'Wrong player returned the serve');
    }
    // one hit per side: the same team striking twice before the ball reaches
    // the opponents' floor loses the point. (If the ball already bounced over
    // there and rebounded back over the net, the hitter may legally play it
    // again — it becomes a fresh leg.)
    if (this.phase === 'rally' && player.team === this.legHitTeam && !this.legBounced) {
      return this.pointOver(1 - player.team, 'double-hit', 'Double hit — same team twice');
    }
    this.phase = 'rally';
    this.legHitTeam = player.team;
    this.legBounced = false;
    this.serveReturnPending = false;
    this.outPlay = false; // a return from outside starts a fresh leg
  }

  /** ball touched a player's body (not a racket contact) */
  bodyTouch(player) {
    if (this.phase !== 'rally' && this.phase !== 'serveFlight') return;
    // a serve that hits the server or their partner on the fly is a service
    // FAULT (second serve), not an outright loss of the point
    if (this.phase === 'serveFlight' && player.team === this.servingTeam) {
      return this.serveFault("Serve touched the server's side");
    }
    this.pointOver(1 - player.team, 'body', 'Ball touched the player — point lost');
  }

  // --- physics events --------------------------------------------------------
  ballEvent(ev) {
    if (this.phase === 'serveFlight') return this.serveEvent(ev);
    if (this.phase === 'rally') return this.rallyEvent(ev);
  }

  // .......................................................... serve flight ..
  serveEvent(ev) {
    const receiverSide = this.servingTeam === 0 ? -1 : 1; // z-sign of receiver half

    switch (ev.type) {
      case 'netband':
        this.netTouched = true;
        return;
      case 'net':
        return this.serveFault('Serve into the net');
      case 'out':
        return this.serveFault('Serve out of the court');
      case 'glass':
      case 'mesh':
        // any wall before the box bounce is a fault (own or receiver side)
        return this.serveFault(ev.side === receiverSide
          ? 'Serve hit the wall before bouncing'
          : 'Serve touched own wall');
      case 'floor': {
        if (ev.side !== receiverSide) return this.serveFault('Serve did not cross');
        if (!this.serveBoxValid(ev.pos)) return this.serveFault('Serve missed the box');
        if (this.netTouched) {
          this.phase = 'preServe';
          return this.cb.onLet({ message: 'LET — net cord, replay serve' });
        }
        // valid serve! rally begins; returner must still respect the
        // mesh-after-bounce rule until the return is struck
        this.phase = 'rally';
        this.legHitTeam = this.servingTeam;
        this.legBounced = true;
        this.serveReturnPending = true;
        return;
      }
    }
  }

  // Diagonal box check: opposite x-sign to the serving half, between net and
  // service line. (Ball on the line counts as IN, hence small epsilon.)
  serveBoxValid(pos) {
    const eps = 0.05;
    if (Math.abs(pos.z) > COURT.serviceLineZ + eps) return false;
    if (Math.abs(pos.z) < 0.02) return false;
    // team-0 serving from 'right' means server half x>0 → target box x<0 on
    // the receiver side; mirrored for team 1 (their right is x<0).
    const serverHalfSign = (this.servingTeam === 0 ? 1 : -1) * (this.serveSide === 'right' ? 1 : -1);
    const boxSign = -serverHalfSign;
    return boxSign > 0 ? pos.x > -eps : pos.x < eps;
  }

  serveFault(message) {
    if (this.serveNumber === 1) {
      this.phase = 'preServe';
      this.cb.onServeFault({ message: `FAULT — ${message}. Second serve`, double: false });
    } else {
      this.phase = 'over';
      this.cb.onServeFault({ message: `DOUBLE FAULT — ${message}`, double: true });
    }
  }

  // ................................................................. rally ..
  rallyEvent(ev) {
    const hitter = this.legHitTeam;
    const defenderSide = hitter === 0 ? -1 : 1;   // z-sign of the half the ball must land in
    const onDefenderSide = ev.side === defenderSide;

    const hitterSideSign = hitter === 0 ? 1 : -1;

    switch (ev.type) {
      case 'netband':
        return; // let-cord, play on

      case 'net':
        // only fatal when the hitter's shot died before ever crossing.
        // A ball that already bounced over there and dribbles back into the
        // net stays live — the second-bounce logic will decide the point.
        if (!this.legBounced && ev.side === hitterSideSign) {
          return this.pointOver(1 - hitter, 'net', 'Into the net');
        }
        return;

      case 'floor': {
        // out-of-court play: once the ball has legally exited, ANY ground
        // contact outside the cage ends the point for the hitter
        if (this.outPlay && !ev.inCourt) {
          return this.pointOver(hitter, 'out-landed', 'Ball landed outside — winner!');
        }
        if (onDefenderSide) {
          if (!this.legBounced) {
            this.legBounced = true;   // good ball — in
            return;
          }
          // second bounce before a return — point over
          return this.pointOver(hitter, 'double-bounce', 'Double bounce — winner');
        }
        // floor on the hitter's own side:
        if (this.legBounced) {
          // ball bounced on the defenders' floor, rebounded off glass BACK
          // over the net and landed — the defenders failed to return it
          return this.pointOver(hitter, 'returned-over', 'Ball came back over — winner');
        }
        // their own shot never made it over (net dribble, mishit)
        return this.pointOver(1 - hitter, 'own-side', 'Ball landed on own side');
      }

      case 'glass':
      case 'mesh': {
        if (onDefenderSide) {
          if (this.legBounced) {
            // after the serve's box-bounce, mesh before the return is a fault
            if (ev.type === 'mesh' && this.serveReturnPending) {
              return this.serveFault('Serve touched the fence after the bounce');
            }
            return; // live rebound — wall play continues
          }
          // direct into the defenders' wall/fence without bouncing
          return this.pointOver(1 - hitter, 'direct-wall',
            ev.type === 'mesh' ? 'Direct into the fence — out' : 'Direct onto the glass — out');
        }
        // hitter's own side:
        if (this.legBounced) {
          // rebounded back over the net onto the hitter's walls — defenders
          // already failed to keep it in front of them
          return this.pointOver(hitter, 'returned-over', 'Ball came back over — winner');
        }
        // glass is a legal assist on the way over; mesh is not
        if (ev.type === 'mesh') {
          return this.pointOver(1 - hitter, 'own-mesh', 'Ball touched own fence');
        }
        return; // own glass — legal ("contra pared")
      }

      case 'out': {
        if (this.legBounced) {
          // a SERVE leaving the cage after its box bounce is a fault under
          // current FIP rules (the "golden serve" ace was abolished)
          if (this.serveReturnPending) {
            return this.serveFault('Serve left the court after the bounce');
          }
          // legally left the cage (por tres / por cuatro) — still PLAYABLE:
          // defenders may sprint out through the doors and return it before
          // it touches the ground outside
          this.outPlay = true;
          this.cb.onMessage?.('Ball out — chase it through the door!');
          return;
        }
        return this.pointOver(1 - hitter, 'out', 'Out');
      }
    }
  }

  pointOver(winner, reason, message) {
    if (this.phase === 'over') return;
    this.phase = 'over';
    this.cb.onPointOver({ winner, reason, message });
  }
}
