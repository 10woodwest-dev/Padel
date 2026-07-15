// ============================================================================
// scoring.js — Tennis-style padel scoring: 0/15/30/40, deuce & advantage
// (or golden point when enabled), games, sets with a tie-break at 6-6.
// Pure logic, no rendering; match.js drives it and ui.js displays it.
// ============================================================================

import { RULES } from './constants.js';

const POINT_LABELS = ['0', '15', '30', '40'];

export class Scoring {
  constructor({ goldenPoint = RULES.goldenPointDefault, setsToWin = RULES.setsToWin } = {}) {
    this.goldenPoint = goldenPoint;
    this.setsToWin = setsToWin;
    this.reset();
  }

  reset() {
    this.points = [0, 0];   // raw points within the current game (0,1,2,3=40,4+=adv track)
    this.games = [0, 0];    // games in the current set
    this.sets = [0, 0];
    this.setHistory = [];   // finished sets as [gamesA, gamesB]
    this.inTieBreak = false;
    this.tbPoints = [0, 0];
    this.matchWinner = null;
  }

  /** Award a point to `team`; returns {gameWon, setWon, matchWon} flags. */
  addPoint(team) {
    if (this.matchWinner !== null) return {};
    if (this.inTieBreak) return this.addTieBreakPoint(team);

    const other = 1 - team;
    this.points[team]++;

    const p = this.points[team], q = this.points[other];
    let gameWon = false;

    if (this.goldenPoint) {
      // deuce (40-40) → next point wins
      if (p >= 4 && p > q) gameWon = true;
      else if (p === 4 && q === 4) gameWon = true; // can't happen, safety
    } else {
      // advantage scoring: win by 2 from 40-40
      if (p >= 4 && p - q >= 2) gameWon = true;
    }

    if (gameWon) return this.winGame(team);
    return {};
  }

  addTieBreakPoint(team) {
    this.tbPoints[team]++;
    const p = this.tbPoints[team], q = this.tbPoints[1 - team];
    if (p >= 7 && p - q >= 2) {
      this.inTieBreak = false;
      this.tbPoints = [0, 0];
      this.games[team]++;
      return this.winSet(team);
    }
    // expose the running point count so match.js can rotate the serve
    // (server changes after the 1st point, then every 2 points)
    return { tieBreakPoint: true, tieBreakPointsPlayed: p + q };
  }

  winGame(team) {
    this.points = [0, 0];
    this.games[team]++;
    const g = this.games[team], h = this.games[1 - team];
    if (g >= RULES.gamesPerSet && g - h >= 2) return this.winSet(team);
    if (g === RULES.tieBreakAt && h === RULES.tieBreakAt) {
      this.inTieBreak = true;
      return { gameWon: true, tieBreak: true };
    }
    return { gameWon: true };
  }

  winSet(team) {
    this.sets[team]++;
    this.setHistory.push([...this.games]);
    this.games = [0, 0];
    if (this.sets[team] >= this.setsToWin) {
      this.matchWinner = team;
      return { gameWon: true, setWon: true, matchWon: true };
    }
    return { gameWon: true, setWon: true };
  }

  /** e.g. "40 - AD" from team 0's perspective; tie-break shows raw points */
  pointsLabel() {
    if (this.inTieBreak) return `${this.tbPoints[0]} - ${this.tbPoints[1]}`;
    const [a, b] = this.points;
    if (a >= 3 && b >= 3) {
      if (a === b) return 'DEUCE';
      return a > b ? 'AD - 40' : '40 - AD';
    }
    return `${POINT_LABELS[Math.min(a, 3)]} - ${POINT_LABELS[Math.min(b, 3)]}`;
  }

  /** true when the next point decides the game under golden-point rules */
  isGoldenPointNow() {
    return this.goldenPoint && this.points[0] >= 3 && this.points[1] >= 3;
  }

  /** broadcast context: {team, label} for GAME/SET/MATCH POINT, or null */
  situation() {
    if (this.matchWinner !== null) return null;
    if (this.isGoldenPointNow()) return { team: -1, label: 'GOLDEN POINT' };
    const gamePointFor = (t) => {
      if (this.inTieBreak) {
        const p = this.tbPoints[t], q = this.tbPoints[1 - t];
        return p >= 6 && p > q;
      }
      const p = this.points[t], q = this.points[1 - t];
      return p >= 3 && p - q >= 1;
    };
    for (const t of [0, 1]) {
      if (!gamePointFor(t)) continue;
      const g = this.games[t], h = this.games[1 - t];
      const winsSet = this.inTieBreak || (g + 1 >= RULES.gamesPerSet && g + 1 - h >= 2);
      if (winsSet) {
        return { team: t, label: this.sets[t] + 1 >= this.setsToWin ? 'MATCH POINT' : 'SET POINT' };
      }
      return { team: t, label: 'GAME POINT' };
    }
    return null;
  }
}
