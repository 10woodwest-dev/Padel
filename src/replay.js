// ============================================================================
// replay.js — broadcast-style instant replay of the last point.
//
// While the point is live, a ring buffer records ball + player states each
// frame — INCLUDING each player's swing phase and swing-arc parameters, so
// during playback the arms genuinely swing at the ball again. Playback
// re-drives the models at slow-mo (with an extra ramp near the finish) from
// one of several cinematic angles, rotating per replay. Space/R/Esc skips.
// ============================================================================

import { HIT } from './constants.js';
import { clamp, lerp } from './mathUtils.js';

const MAX_SAMPLES = 900;    // ~15-30 s of footage
const MAX_LEN = 6.0;        // replay at most the last N seconds of the point

export class ReplaySystem {
  constructor() {
    this.samples = [];
    this.players = [];
    this.ball = null;
    this.ballVisual = null;
    this.active = false;
    this.playhead = 0;
    this.angleIdx = 0;
    this._fake = { pos: { x: 0, y: 1, z: 0 }, vel: { x: 0, y: 0, z: 0 }, spin: { x: 0, y: 0, z: 0 }, active: true, insideCage: true };
  }

  bind(players, ball, ballVisual) {
    this.players = players;
    this.ball = ball;
    this.ballVisual = ballVisual;
    this.clear();
  }

  clear() {
    this.samples.length = 0;
    this.active = false;
  }

  /** call each frame while the point is live */
  record(dt) {
    const t = this.samples.length ? this.samples[this.samples.length - 1].t + dt : 0;
    this.samples.push({
      t,
      ball: { x: this.ball.pos.x, y: this.ball.pos.y, z: this.ball.pos.z },
      players: this.players.map((p) => {
        const ph = p.swingPhase();
        const sw = p.swing;
        return {
          x: p.pos.x, z: p.pos.z, f: p.facing,
          // swing snapshot so the arm re-swings during playback
          ph: sw ? ph : null,
          sh: sw ? sw.shot : null,
          az: sw ? sw.seekAz : 0, r: sw ? sw.seekR : 0,
          h: sw ? sw.seekH : 0, sd: sw ? sw.seekSide : 1,
          ov: sw ? sw.overhead : false,
        };
      }),
    });
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
  }

  hasFootage() {
    return this.samples.length > 20 &&
      this.samples[this.samples.length - 1].t - this.samples[0].t > 0.9;
  }

  start() {
    if (!this.hasFootage()) return false;
    const end = this.samples[this.samples.length - 1].t;
    this.playhead = Math.max(this.samples[0].t, end - MAX_LEN);
    this.active = true;
    this.angleIdx = (this.angleIdx + 1) % 3;
    for (const p of this.players) { p.cancelSwing(); p.setState('idle'); }
    return true;
  }

  stop() {
    this.active = false;
    // drop any ghost swings created during playback
    for (const p of this.players) { p.swing = null; p.setState('idle'); }
  }

  /** drive entities + camera; returns false when the replay has finished */
  update(dt, camera) {
    if (!this.active) return false;
    const end = this.samples[this.samples.length - 1].t;
    // slow-mo with an extra ramp over the final second (the finish lands
    // in dramatic super-slow-mo, very broadcast)
    const remain = end - this.playhead;
    const speed = remain < 1.0 ? lerp(0.35, 0.7, clamp(remain, 0, 1)) : 0.7;
    this.playhead += dt * speed;
    if (this.playhead >= end) { this.stop(); return false; }

    let lo = 0, hi = this.samples.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (this.samples[mid].t <= this.playhead) lo = mid; else hi = mid;
    }
    const a = this.samples[lo], b = this.samples[hi];
    const k = clamp((this.playhead - a.t) / Math.max(1e-4, b.t - a.t), 0, 1);
    const sampleDt = Math.max(1e-3, b.t - a.t);

    // ---- ball
    const f = this._fake;
    f.pos.x = lerp(a.ball.x, b.ball.x, k);
    f.pos.y = lerp(a.ball.y, b.ball.y, k);
    f.pos.z = lerp(a.ball.z, b.ball.z, k);
    this.ballVisual.update(f, dt);

    // ---- players: position, velocity for the legs, and GHOST SWINGS so the
    // arms replay their actual strokes
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      const pa = a.players[i], pb = b.players[i];
      p.pos.x = lerp(pa.x, pb.x, k);
      p.pos.z = lerp(pa.z, pb.z, k);
      p.vel.x = (pb.x - pa.x) / sampleDt;
      p.vel.z = (pb.z - pa.z) / sampleDt;
      p.facing = pa.f + (((pb.f - pa.f + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * k;
      const sp = Math.hypot(p.vel.x, p.vel.z);
      p.runPhase += sp * dt * 2.15;

      if (pa.ph !== null) {
        const ph = pb.ph !== null ? lerp(pa.ph, pb.ph, k) : pa.ph;
        this._applyGhostSwing(p, pa, ph);
      } else if (p.swing && p.swing.ghost) {
        p.swing = null;
        p.setState('idle');
      }
      p.updateModel(dt, f);
    }

    // ---- rotating cinematic angles
    switch (this.angleIdx) {
      case 0: // low side track
        camera.position.set(12.5, 3.4, clamp(f.pos.z * 0.35, -4, 4));
        camera.lookAt(f.pos.x * 0.6, Math.min(2.2, 0.6 + f.pos.y * 0.3), f.pos.z * 0.75);
        break;
      case 1: // corner crane
        camera.position.set(-10.5, 6.5, 12.5);
        camera.lookAt(f.pos.x * 0.5, 0.8 + f.pos.y * 0.2, f.pos.z * 0.5);
        break;
      default: // high behind, following the ball end
        camera.position.set(f.pos.x * 0.25, 6.8, Math.sign(f.pos.z || 1) * 14.5);
        camera.lookAt(f.pos.x * 0.5, 0.7, f.pos.z * 0.4);
    }
    return true;
  }

  /** reconstruct a visual-only swing on the player at the recorded phase */
  _applyGhostSwing(p, snap, ph) {
    if (!p.swing || !p.swing.ghost) {
      p.swing = {
        ghost: true, done: false,
        shot: snap.sh || 'drive', aim: { x: 0, y: 0, z: 0 }, power: 0.6,
        windup: HIT.windup, window: HIT.activeWindow,
        seekAz: snap.az, seekR: snap.r, seekH: snap.h, seekSide: snap.sd,
        overhead: snap.ov, frozen: true, contact: null, elapsed: 0,
      };
      p.setState(snap.ov ? 'overhead' : 'prepare');
    }
    const sw = p.swing;
    sw.seekAz = snap.az; sw.seekR = snap.r; sw.seekH = snap.h; sw.seekSide = snap.sd;
    // invert swingPhase(): p<0 → windup portion, else active window
    sw.elapsed = ph < 0
      ? sw.windup * (ph + 0.35) / 0.35
      : sw.windup + ph * sw.window;
    if (ph > 0.1 && p.state !== 'swing') p.setState('swing', true);
  }
}
