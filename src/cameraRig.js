// ============================================================================
// cameraRig.js — Two cameras:
//
//  * follow — third-person chase cam behind the controlled player. It keeps a
//    FIXED yaw (always looking up-court) so glass rebounds and lobs never spin
//    the view; it slides laterally with the player, pulls back when play gets
//    deep, and blends its look-target between player and ball with the target
//    height clamped so lobs don't wrench the pitch.
//  * broadcast — elevated behind-court TV angle, framing the whole cage.
// ============================================================================

import * as THREE from 'three';
import { COURT } from './constants.js';
import { clamp, damp } from './mathUtils.js';

export class CameraRig {
  constructor(camera, player) {
    this.camera = camera;
    this.player = player;
    this.mode = 'follow'; // 'follow' | 'broadcast'
    this.pos = new THREE.Vector3(0, 4.4, COURT.halfLength + 4.5);
    this.look = new THREE.Vector3(0, 1, 0);
    camera.position.copy(this.pos);
  }

  toggle() {
    this.mode = this.mode === 'follow' ? 'broadcast' : 'follow';
  }

  /** brief impact shake (smashes, big hits) */
  addShake(mag) { this.shake = Math.max(this.shake || 0, mag); }

  update(dt, ball) {
    const p = this.player.pos;
    let targetPos, targetLook;

    if (this.mode === 'follow') {
      const sign = this.player.teamSign;
      // pull back a little when the player retreats deep or the ball is behind them
      const ballBehind = ball.active && sign * (ball.pos.z - p.z) > 0.5 ? 1.2 : 0;
      const depth = clamp(Math.abs(p.z) / COURT.halfLength, 0, 1);
      targetPos = new THREE.Vector3(
        p.x * 0.72,                                    // slide with the player, stay centred-ish
        4.1 + depth * 0.7,
        sign * (Math.abs(p.z) + 4.6 + depth * 1.2 + ballBehind)
      );
      // look mostly at mid-court ahead of the player, drawn toward the ball
      const lookX = ball.active ? p.x * 0.3 + ball.pos.x * 0.45 : p.x * 0.5;
      const lookZ = ball.active
        ? clamp(ball.pos.z * 0.55, -COURT.halfLength, COURT.halfLength) - sign * 1.5
        : -sign * 3;
      const lookY = ball.active ? clamp(ball.pos.y * 0.35 + 0.7, 0.7, 2.1) : 0.9; // lob-proof pitch
      targetLook = new THREE.Vector3(lookX, lookY, lookZ);
    } else {
      const sign = this.player.teamSign;
      targetPos = new THREE.Vector3(0, 7.6, sign * (COURT.halfLength + 7.5));
      targetLook = new THREE.Vector3(0, 0.4, -sign * 2.5);
    }

    // frame-rate independent smoothing; a touch snappier on look than position
    const lp = 1 - Math.exp(-4.2 * dt);
    const ll = 1 - Math.exp(-6.0 * dt);
    this.pos.lerp(targetPos, lp);
    this.look.lerp(targetLook, ll);
    this.camera.position.copy(this.pos);
    // impact shake: small decaying random offset
    if (this.shake > 0.002) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake;
      this.camera.position.y += (Math.random() - 0.5) * this.shake * 0.6;
      this.shake *= Math.exp(-9 * dt);
    }
    this.camera.lookAt(this.look);
  }
}
