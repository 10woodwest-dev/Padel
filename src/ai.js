// ============================================================================
// ai.js — Doubles padel AI for the three non-human players.
//
// Architecture: one AIManager owns a small "team brain" per team plus
// per-player micro-state. Every frame:
//
//   1. PREDICT — simulate the live ball forward (drag, spin, glass/mesh
//      bounces included) and cache it; find each side's best interception.
//   2. ASSIGN — decide which team member takes the ball (the human's partner
//      yields any 50/50 ball to the human), the other covers.
//   3. FORMATION — attack (net) vs defence (back) with hysteresis; teams
//      advance behind lobs/deep balls and retreat when lobbed, exactly like
//      real doubles padel; the serving pair starts at net, returners back.
//   4. EXECUTE — movement intents toward interception/formation targets
//      (locomotion momentum lives in player.js), swings timed against the
//      predicted arrival, weighted tactical shot selection & aim into space.
//
// Difficulty scales reaction time, movement, consistency (error scale),
// aggression and tactical IQ (chance of picking the best option).
// ============================================================================

import { COURT, HIT, DIFFICULTY } from './constants.js';
import { predictTrajectory } from './ball.js';
import { SHOTS } from './shots.js';
import { v3, vCopy, clamp, lerp, rand, randGauss, distXZ } from './mathUtils.js';

export class AIManager {
  constructor(players, humanPlayer, match, referee, ball, difficultyKey = 'medium') {
    this.players = players;
    this.human = humanPlayer;
    this.match = match;
    this.referee = referee;
    this.ball = ball;
    this.setDifficulty(difficultyKey);

    // per-team shared state
    this.teams = [
      { state: 'defend', stateTimer: 0, taker: null, lastShotTag: null },
      { state: 'defend', stateTimer: 0, taker: null, lastShotTag: null },
    ];
    // per-player micro state
    this.micro = new Map();
    for (const p of players) {
      if (p.isHuman) continue;
      this.micro.set(p.id, { reactAt: 0, serveDelay: rand(1.0, 1.8), aimJitter: v3() });
    }

    this.predCache = { at: -1, result: null, eventCount: 0 };
    this.eventCounter = 0; // bumped by main.js on every ball event
    this.time = 0;
  }

  setDifficulty(key) {
    this.difficultyKey = key;
    this.diff = DIFFICULTY[key] || DIFFICULTY.medium;
    for (const p of this.players) {
      if (!p.isHuman) p.aiErrorScale = this.diff.errorScale;
    }
  }

  notifyBallEvent() { this.eventCounter++; }
  notifyTeamHit(team, shotKey) {
    this.teams[team].lastShotTag = SHOTS[shotKey]?.tags?.[0] || null;
    this.teams[team].lastShotKey = shotKey;
  }

  // --------------------------------------------------------------------------
  update(dt) {
    this.time += dt;
    const phase = this.match.state; // positioning | preServe | live | pointOver...

    const pred = this.getPrediction();
    for (const t of [0, 1]) this.updateTeamBrain(t, pred, dt);

    for (const p of this.players) {
      if (p.isHuman) continue;
      this.updatePlayer(p, dt, phase, pred);
    }
  }

  // Cached deterministic forward-sim of the live ball (~10 Hz + on events).
  getPrediction() {
    if (!this.ball.active) { this.predCache.result = null; return null; }
    const stale = this.time - this.predCache.at > 0.12 ||
      this.predCache.eventCount !== this.eventCounter;
    if (stale) {
      this.predCache.result = predictTrajectory(this.ball, { maxTime: 3.2, sampleEvery: 0.045 });
      this.predCache.at = this.time;
      this.predCache.eventCount = this.eventCounter;
    }
    return this.predCache.result;
  }

  // --------------------------------------------------------------------------
  // TEAM BRAIN: taker assignment + attack/defend formation with hysteresis.
  // --------------------------------------------------------------------------
  updateTeamBrain(team, pred, dt) {
    const brain = this.teams[team];
    brain.stateTimer += dt;
    const sign = team === 0 ? 1 : -1;
    const members = this.players.filter((p) => p.team === team);

    // ---- who takes the ball?
    const ballComing = this.ballTowardTeam(team, pred);
    if (ballComing && pred) {
      const picks = members.map((p) => ({ p, s: this.interceptFor(p, pred) }));
      picks.sort((a, b) => (a.s ? a.s.t : 99) - (b.s ? b.s.t : 99));
      let taker = picks[0].s ? picks[0].p : null;

      // the human's AI partner yields ambiguous balls to the human
      if (taker && !taker.isHuman && members.some((m) => m.isHuman)) {
        const hPick = picks.find((x) => x.p.isHuman);
        if (hPick?.s) {
          const humanSideBall = Math.sign(hPick.s.pos.x - 0.001) ===
            Math.sign(this.human.pos.x - 0.001);
          const closeCall = Math.abs(hPick.s.t - picks[0].s.t) < 0.5;
          if (humanSideBall || closeCall) taker = hPick.p;
        }
      }
      brain.taker = taker;
    } else {
      brain.taker = null;
    }

    // ---- formation transitions (min 0.7 s between switches)
    if (brain.stateTimer > 0.7 && pred) {
      // lobbed? ball will land (or already flies) deep behind our net line
      const landing = pred.events.find((e) => e.type === 'floor' && e.side === sign);
      const apexHigh = pred.samples.some((s) => s.pos.y > 3.0 && Math.sign(s.pos.z) === sign);
      const deepLanding = landing && Math.abs(landing.pos.z) > 6.3;

      if (apexHigh && deepLanding && brain.state !== 'defend') {
        brain.state = 'defend'; brain.stateTimer = 0;
      } else if (!this.ballTowardTeam(team, pred)) {
        // ball travelling away: press the net if our last shot earned it
        const pressing = ['lob', 'chiquita', 'topspin', 'bandeja', 'vibora', 'volley', 'blockVolley', 'smash']
          .includes(this.teams[team].lastShotKey);
        if (pressing && brain.state !== 'attack') { brain.state = 'attack'; brain.stateTimer = 0; }
      } else if (deepLanding && brain.state !== 'defend') {
        brain.state = 'defend'; brain.stateTimer = 0;
      }
    }
  }

  ballTowardTeam(team, pred) {
    if (!this.ball.active) return false;
    const sign = team === 0 ? 1 : -1;
    if (Math.sign(this.ball.pos.z) === sign) return true;              // already on our side
    return Math.sign(this.ball.vel.z) === sign && Math.abs(this.ball.vel.z) > 0.5; // heading over
  }

  // Earliest hittable point on the predicted path for player p.
  // Respects the serve-return bounce rule and each player's reach/speed.
  interceptFor(p, pred) {
    if (!pred) return null;
    const mustBounceFirst =
      this.referee.phase === 'serveFlight' && p.team !== this.referee.servingTeam;
    let bounced = false;
    let firstBounceT = -1;
    for (const e of pred.events) {
      if (e.type === 'floor' && e.side === p.teamSign) { firstBounceT = e.t; break; }
    }
    const micro = this.micro.get(p.id);
    const speed = p.maxSpeed() * this.diff.speed;

    let best = null;
    for (const s of pred.samples) {
      if (Math.sign(s.pos.z) !== p.teamSign) continue;              // our side only
      if (mustBounceFirst && (firstBounceT < 0 || s.t <= firstBounceT + 0.02)) continue;
      const h = s.pos.y;
      if (h < 0.15 || h > p.overheadReach() - 0.05) continue;
      const d = distXZ(p.pos, s.pos);
      const travelTime = Math.max(0, (d - p.reach() * 0.7) / Math.max(0.5, speed));
      if (travelTime > s.t - this.diff.reaction * 0.5) continue;    // can't make it
      // comfort: prefer waist-high contact, or high contact if it's a smashable ball
      const comfort =
        (h > 1.7 ? 0.75 + h * 0.1 : 1 - Math.abs(h - 0.85) * 0.35) - s.t * 0.22;
      if (!best || comfort > best.comfort) best = { pos: s.pos, vel: s.vel, t: s.t, comfort };
    }
    return best;
  }

  // --------------------------------------------------------------------------
  // PER-PLAYER: movement + swinging + serving.
  // --------------------------------------------------------------------------
  updatePlayer(p, dt, phase, pred) {
    const micro = this.micro.get(p.id);
    const brain = this.teams[p.team];
    const isTaker = brain.taker === p;

    // ---- serving duty
    if (phase === 'preServe') {
      p.moveIntent = v3();
      if (this.match.server === p && this.match.stateTime > micro.serveDelay) {
        this.match.requestServe(this.chooseServeAim(p));
        micro.serveDelay = rand(1.0, 1.8);
      }
      // face across the net toward the receiver's half
      p.targetFacing = Math.atan2(-p.pos.x * 0.5 - p.pos.x, -p.teamSign * 8 - p.pos.z);
      return;
    }
    if (phase !== 'live') { p.moveIntent = v3(); return; }

    // ---- pick a movement target
    let target;
    if (isTaker && pred) {
      const s = this.interceptFor(p, pred);
      if (s) {
        // stand slightly "behind" the contact along the ball's travel so the
        // ball arrives in front of the body, not through it
        const vdir = Math.hypot(s.vel.x, s.vel.z) > 0.3
          ? v3(s.vel.x, 0, s.vel.z) : v3(0, 0, p.teamSign);
        const vl = Math.hypot(vdir.x, vdir.z) || 1;
        target = v3(s.pos.x + (vdir.x / vl) * 0.5, 0, s.pos.z + (vdir.z / vl) * 0.5);
        micro.intercept = s;
      } else {
        target = this.formationTarget(p, brain);
        micro.intercept = null;
      }
    } else {
      target = this.formationTarget(p, brain);
      micro.intercept = null;
    }
    micro.moveTarget = target;

    // ---- movement intent with a small dead zone (prevents jitter-dancing)
    const dx = target.x - p.pos.x, dz = target.z - p.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.18) {
      const urgency = clamp(dist / 1.6, 0.35, 1) * this.diff.speed;
      p.moveIntent = v3((dx / dist) * urgency, 0, (dz / dist) * urgency);
    } else {
      p.moveIntent = v3();
    }

    // ---- facing: square to the ball when it's live on our radar
    if (this.ball.active) {
      p.targetFacing = Math.atan2(this.ball.pos.x - p.pos.x, this.ball.pos.z - p.pos.z);
    }

    // ---- swing timing: wind up so the active window brackets ball arrival
    if (isTaker && micro.intercept && !p.isSwinging() && !p.inRecovery()) {
      const eta = micro.intercept.t;
      const lead = HIT.windup + HIT.activeWindow * 0.4;
      const reactNoise = randGauss(this.diff.reaction * 0.25);
      if (eta <= lead + Math.abs(reactNoise)) {
        const { shot, aim, power } = this.chooseShot(p, micro.intercept);
        p.startSwing(shot, aim, power);
      }
    }
    // emergency late swing if the ball is suddenly on top of us
    if (isTaker && !p.isSwinging() && !p.inRecovery() && this.ball.active) {
      const d = distXZ(p.pos, this.ball.pos);
      const mustBounceFirst =
        this.referee.phase === 'serveFlight' && p.team !== this.referee.servingTeam;
      if (!mustBounceFirst && d < p.reach() * 0.85 &&
        this.ball.pos.y < p.overheadReach() && this.ball.pos.y > 0.1) {
        const fake = { pos: vCopy(this.ball.pos), vel: vCopy(this.ball.vel), t: 0 };
        const { shot, aim, power } = this.chooseShot(p, fake);
        p.startSwing(shot, aim, power);
      }
    }
  }

  // Doubles formation targets: attack = at the net, defend = back near the
  // glass; non-takers pinch toward the middle to cover the gap.
  formationTarget(p, brain) {
    const slotX = (p.slot === 'right' ? 1 : -1) * p.teamSign; // world-x sign of their half
    const atNet = brain.state === 'attack';
    let x = slotX * (atNet ? 1.9 : 2.15);
    let z = p.teamSign * (atNet ? 3.0 : 7.6);

    // cover: shift toward the ball's x a touch, more when defending
    if (this.ball.active) {
      x += clamp(this.ball.pos.x - x, -1.2, 1.2) * (atNet ? 0.25 : 0.4);
    }
    // if partner is the taker and got dragged wide, pinch to the middle
    if (brain.taker && brain.taker !== p && brain.taker.team === p.team) {
      if (Math.abs(brain.taker.pos.x) > 2.4) x *= 0.45;
    }
    return v3(clamp(x, -4.4, 4.4), 0, z);
  }

  // --------------------------------------------------------------------------
  // SHOT SELECTION — weighted by situation, stats, aggression and IQ.
  // --------------------------------------------------------------------------
  chooseShot(p, intercept) {
    const h = intercept.pos.y;
    const zAbs = Math.abs(intercept.pos.z);
    const nearNet = zAbs < 4.2;
    const deep = zAbs > 6.6;
    const opps = this.players.filter((o) => o.team !== p.team);
    const oppAtNet = opps.every((o) => Math.abs(o.pos.z) < 5.0);
    const overheadOk = h > 1.55;
    const lowBall = h < 0.55;
    const ballFast = Math.hypot(intercept.vel.x, intercept.vel.z) > 14;
    // moving toward our back wall = we're digging a rebound
    const towardBack = Math.sign(intercept.vel.z) === p.teamSign && Math.abs(intercept.vel.z) > 1.5;

    const pressure = (deep ? 0.9 : 0) + (oppAtNet ? 0.6 : 0) + (lowBall ? 0.35 : 0);
    const agg = this.diff.aggression * (0.6 + p.stats.aggression / 160);
    const st = (k) => p.stats[k] / 100;

    const cand = [];
    const add = (shot, w) => { if (w > 0.01) cand.push({ shot, w }); };

    if (!overheadOk) {
      add('drive', (nearNet ? 0.4 : 1.0) * (0.7 + st('consistency') * 0.5) * agg);
      add('topspin', (nearNet ? 0.5 : 1.25) * (0.7 + st('consistency') * 0.5));
      add('lob', (0.35 + pressure * 1.25) * (0.6 + st('lob') * 0.8) * (oppAtNet ? 1.25 : 0.7));
      add('volley', nearNet && !deep ? 1.5 * (0.6 + st('volley') * 0.7) * agg : 0);
      add('blockVolley', nearNet && ballFast ? 1.2 * (0.6 + st('volley') * 0.6) : 0);
      add('chiquita', !nearNet && !deep && oppAtNet && h < 1.0 ? 1.15 * (0.6 + st('defence') * 0.6) : 0);
      add('wallDefence', deep && towardBack ? 1.8 * (0.6 + st('defence') * 0.7) : 0);
    } else {
      add('bandeja', 1.45 * (0.6 + st('bandeja') * 0.7));
      add('vibora', (h < 2.15 ? 1.2 : 0.7) * (0.5 + st('vibora') * 0.9) * agg);
      add('smash', (nearNet && h > 2.0 ? 2.1 : 0.35) * (0.4 + st('smash') * 0.9) * agg);
      add('lob', 0.25 * (0.6 + st('lob') * 0.6)); // rare defensive overhead lob
    }
    if (!cand.length) add('drive', 1);

    // IQ: best choice with probability iq, otherwise sample the top three
    cand.sort((a, b) => b.w - a.w);
    let pick;
    if (rand() < this.diff.iq) pick = cand[0];
    else {
      const top = cand.slice(0, 3);
      const sum = top.reduce((s, c) => s + c.w, 0);
      let r = rand(0, sum);
      pick = top.find((c) => (r -= c.w) <= 0) || top[0];
    }

    const aim = this.chooseAim(pick.shot, p, opps);
    const power = clamp(0.45 + pressure * 0.1 + agg * 0.2 + rand(-0.1, 0.15), 0.25, 1);
    return { shot: pick.shot, aim, power };
  }

  // Aim into space: candidate targets scored by distance from the defenders,
  // biased by what each shot wants (lobs deep, chiquitas short, smashes at
  // the glass corners...). IQ noise keeps it human.
  chooseAim(shot, p, opps) {
    const oz = -p.teamSign; // opponent z sign
    const def = SHOTS[shot];

    let candidates;
    switch (shot) {
      case 'lob':
        // over the more net-committed opponent, deep
        candidates = [
          v3(2.9, 0, oz * 8.4), v3(-2.9, 0, oz * 8.4), v3(0, 0, oz * 8.7),
        ];
        break;
      case 'smash':
        candidates = [
          v3(3.6, 0, oz * 6.4), v3(-3.6, 0, oz * 6.4),   // corner glass kick-outs
          v3(rand(-2, 2), 0, oz * 4.4),                  // through the middle body line
        ];
        break;
      case 'vibora':
        candidates = [v3(3.9, 0, oz * 5.6), v3(-3.9, 0, oz * 5.6), v3(2.5, 0, oz * 6.8)];
        break;
      case 'bandeja':
        candidates = [v3(2.6, 0, oz * 7.4), v3(-2.6, 0, oz * 7.4), v3(0.5, 0, oz * 7.8)];
        break;
      case 'chiquita':
      case 'blockVolley':
        // at the feet of whichever opponent is closest to the net
        candidates = opps.map((o) => v3(o.pos.x * 0.8, 0, oz * clamp(Math.abs(o.pos.z) - 0.6, 1.6, 3.4)));
        candidates.push(v3(0, 0, oz * 2.2));
        break;
      default:
        candidates = [
          v3(3.4, 0, oz * 8.0), v3(-3.4, 0, oz * 8.0), v3(0, 0, oz * 8.3),   // deep
          v3(3.9, 0, oz * 4.6), v3(-3.9, 0, oz * 4.6),                       // angles
        ];
        // at the net player's feet if they're camping
        for (const o of opps) {
          if (Math.abs(o.pos.z) < 4.5) candidates.push(v3(o.pos.x, 0, oz * (Math.abs(o.pos.z) + 1.0)));
        }
    }

    // score = distance from nearest opponent (play into space)
    let best = candidates[0], bestScore = -1;
    for (const c of candidates) {
      let dMin = 99;
      for (const o of opps) dMin = Math.min(dMin, distXZ(c, o.pos));
      const score = dMin + rand(0, 1.6) * (1 - this.diff.iq); // noise for lower IQ
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return vCopy(best);
  }

  chooseServeAim(p) {
    const oz = -p.teamSign;
    const sideSign = (this.match.serveSide === 'right' ? 1 : -1) * p.teamSign;
    const boxSign = -sideSign; // diagonal box x-sign (world)
    const options = [
      v3(boxSign * 4.1, 0, oz * 6.1),   // wide toward the side glass
      v3(boxSign * 0.8, 0, oz * 6.3),   // down the T
      v3(boxSign * 2.4, 0, oz * 5.2),   // at the body
    ];
    return options[Math.floor(rand(0, this.diff.iq > 0.8 ? 2.99 : 1.99))];
  }
}
