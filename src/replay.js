// ============================================================================
// replay.js — broadcast-style instant replay of the last point.
//
// While the point is live, a ring buffer records ball + player states each
// frame. When the point ends (match mode), playback re-drives the player
// models and ball visual through the recorded motion at 70 % speed from a
// cinematic side camera. Space/R/Esc skips. Zero allocations during play
// (samples are recycled beyond the cap).
// ============================================================================

import { clamp, lerp } from './mathUtils.js';

const MAX_SAMPLES = 900;    // ~15-30 s of footage
const SPEED = 0.7;          // slow-mo factor
const MAX_LEN = 6.0;        // replay at most the last N seconds of the point

export class ReplaySystem {
  constructor() {
    this.samples = [];
    this.players = [];
    this.ball = null;
    this.ballVisual = null;
    this.active = false;
    this.playhead = 0;
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
      players: this.players.map((p) => ({ x: p.pos.x, z: p.pos.z, f: p.facing })),
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
    // neutral poses for the re-drive
    for (const p of this.players) { p.cancelSwing(); p.setState('idle'); }
    return true;
  }

  stop() { this.active = false; }

  /** drive entities + camera; returns false when the replay has finished */
  update(dt, camera) {
    if (!this.active) return false;
    this.playhead += dt * SPEED;
    const end = this.samples[this.samples.length - 1].t;
    if (this.playhead >= end) { this.active = false; return false; }

    // locate the surrounding samples (linear scan from a moving hint is
    // unnecessary at ≤900 entries — binary search keeps it tidy)
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

    // ---- players: position + derived velocity so legs animate
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
      p.updateModel(dt, f);
    }

    // ---- cinematic side camera, gently tracking the ball
    camera.position.set(12.5, 4.2, clamp(f.pos.z * 0.35, -4, 4));
    camera.lookAt(f.pos.x * 0.6, Math.min(2.2, 0.6 + f.pos.y * 0.3), f.pos.z * 0.75);
    return true;
  }
}
