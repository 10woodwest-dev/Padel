// ============================================================================
// fx.js — lightweight visual feedback that sells the physicality:
//  * racket swing trails (fading ribbons following the racket head)
//  * impact bursts (expanding rings at contact / wall hits)
// Everything is pooled; zero allocation during play.
// ============================================================================

import * as THREE from 'three';

// ---------------------------------------------------------------------------
export class RacketTrail {
  constructor(scene, color = 0xffffff) {
    this.n = 14;
    this.pts = new Float32Array(this.n * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pts, 3));
    this.line = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color, transparent: true, opacity: 0.0, depthWrite: false,
    }));
    this.line.frustumCulled = false;
    scene.add(this.line);
    this.active = false;
  }

  update(player, dt) {
    const swinging = player.swing != null || player.state === 'swing';
    if (swinging) {
      // shift ring buffer, push current racket head
      for (let i = this.n - 1; i > 0; i--) {
        this.pts[i * 3] = this.pts[(i - 1) * 3];
        this.pts[i * 3 + 1] = this.pts[(i - 1) * 3 + 1];
        this.pts[i * 3 + 2] = this.pts[(i - 1) * 3 + 2];
      }
      const jump = Math.hypot(
        player.racketWorld.x - this.pts[3],
        player.racketWorld.y - this.pts[4],
        player.racketWorld.z - this.pts[5]
      ) > 1.2; // discontinuity (new swing far from the old one) — restart trail
      this.pts[0] = player.racketWorld.x;
      this.pts[1] = player.racketWorld.y;
      this.pts[2] = player.racketWorld.z;
      if (!this.active || jump) {
        // fresh swing: collapse the whole trail to the current point
        for (let i = 1; i < this.n; i++) {
          this.pts[i * 3] = this.pts[0]; this.pts[i * 3 + 1] = this.pts[1]; this.pts[i * 3 + 2] = this.pts[2];
        }
        this.active = true;
      }
      this.line.geometry.attributes.position.needsUpdate = true;
      const speed = player.racketVel.length();
      this.line.material.opacity = Math.min(0.55, speed * 0.045);
    } else {
      this.active = false;
      this.line.material.opacity = Math.max(0, this.line.material.opacity - dt * 4);
    }
  }
}

// ---------------------------------------------------------------------------
export class ImpactBursts {
  constructor(scene) {
    this.pool = [];
    for (let i = 0; i < 10; i++) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.7, 1.0, 20),
        new THREE.MeshBasicMaterial({
          color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
        })
      );
      ring.visible = false;
      scene.add(ring);
      this.pool.push({ ring, t: 1, dur: 0.25, size: 0.3 });
    }
    this.idx = 0;
  }

  /** normal: THREE.Vector3-ish facing of the burst plane */
  spawn(pos, normal, color = 0xffffff, size = 0.28) {
    const b = this.pool[this.idx++ % this.pool.length];
    b.t = 0;
    b.size = size;
    b.ring.visible = true;
    b.ring.material.color.setHex(color);
    b.ring.position.set(pos.x, pos.y, pos.z);
    const n = new THREE.Vector3(normal.x, normal.y, normal.z);
    if (n.lengthSq() < 1e-5) n.set(0, 1, 0);
    b.ring.lookAt(b.ring.position.clone().add(n));
  }

  update(dt) {
    for (const b of this.pool) {
      if (!b.ring.visible) continue;
      b.t += dt;
      const k = b.t / b.dur;
      if (k >= 1) { b.ring.visible = false; continue; }
      const sc = b.size * (0.4 + k * 1.6);
      b.ring.scale.setScalar(sc);
      b.ring.material.opacity = 0.5 * (1 - k);
    }
  }
}
