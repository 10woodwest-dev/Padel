// ============================================================================
// debugView.js — physics/AI debug overlay (F3):
//  * predicted ball trajectory polyline (deterministic sim)
//  * recent collision markers, colour-coded by surface
//  * AI movement targets
//  * text readout: ball speed/spin/height, referee phase, team brains
// ============================================================================

import * as THREE from 'three';
import { predictTrajectory } from './ball.js';
import { vLen } from './mathUtils.js';

const EVENT_COLORS = {
  floor: 0x69f0ae, glass: 0x40c4ff, mesh: 0xffab40, net: 0xff5252, netband: 0xffff8d, out: 0xff4081,
};

export class DebugView {
  constructor(scene, ui) {
    this.scene = scene;
    this.ui = ui;
    this.enabled = false;
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);

    // trajectory line
    this.trajN = 120;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.trajN * 3), 3));
    this.trajLine = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x7df2c8, transparent: true, opacity: 0.8 }));
    this.trajLine.frustumCulled = false;
    this.group.add(this.trajLine);

    // collision markers (ring buffer of small spheres)
    this.markers = [];
    this.markerIdx = 0;
    for (let i = 0; i < 24; i++) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.05, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xffffff })
      );
      m.visible = false;
      this.markers.push(m);
      this.group.add(m);
    }

    // AI target markers
    this.aiTargets = [];
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(
        new THREE.ConeGeometry(0.1, 0.25, 8),
        new THREE.MeshBasicMaterial({ color: 0xff80ab, wireframe: true })
      );
      m.visible = false;
      this.aiTargets.push(m);
      this.group.add(m);
    }
    this._tick = 0;
  }

  toggle() {
    this.enabled = !this.enabled;
    this.group.visible = this.enabled;
    this.ui.setDebugVisible(this.enabled);
    return this.enabled;
  }

  addEvent(ev) {
    if (!this.enabled) return;
    const m = this.markers[this.markerIdx++ % this.markers.length];
    m.position.set(ev.pos.x, Math.max(0.05, ev.pos.y), ev.pos.z);
    m.material.color.setHex(EVENT_COLORS[ev.type] ?? 0xffffff);
    m.visible = true;
  }

  clearEvents() {
    for (const m of this.markers) m.visible = false;
  }

  update(ball, referee, ai, match) {
    if (!this.enabled) return;
    this._tick++;

    // trajectory (refresh ~15 Hz)
    if (this._tick % 4 === 0) {
      const attr = this.trajLine.geometry.attributes.position;
      if (ball.active) {
        const { samples } = predictTrajectory(ball, { maxTime: 3.0, sampleEvery: 0.03 });
        for (let i = 0; i < this.trajN; i++) {
          const s = samples[Math.min(i, samples.length - 1)] || { pos: ball.pos };
          attr.setXYZ(i, s.pos.x, s.pos.y, s.pos.z);
        }
        this.trajLine.visible = true;
        attr.needsUpdate = true;
      } else {
        this.trajLine.visible = false;
      }
    }

    // AI move targets
    let i = 0;
    for (const p of ai.players) {
      const micro = ai.micro.get(p.id);
      const t = micro?.moveTarget;
      const m = this.aiTargets[i++];
      if (t && !p.isHuman) {
        m.position.set(t.x, 0.15, t.z);
        m.visible = true;
      } else m.visible = false;
    }

    // text readout
    const spd = vLen(ball.vel);
    const spin = vLen(ball.spin);
    this.ui.setDebugText(
      `ball  v=${spd.toFixed(1)} m/s  spin=${spin.toFixed(0)} rad/s  h=${ball.pos.y.toFixed(2)} m\n` +
      `pos   x=${ball.pos.x.toFixed(2)} z=${ball.pos.z.toFixed(2)}  cage=${ball.insideCage ? 'in' : 'OUT'}\n` +
      `ref   ${referee.phase}  leg=${referee.legHitTeam}  bounced=${referee.legBounced}\n` +
      `match ${match.state}  serve#${match.serveNumber} ${match.serveSide}\n` +
      `T0    ${ai.teams[0].state}  taker=${ai.teams[0].taker?.archetype.id ?? '-'}\n` +
      `T1    ${ai.teams[1].state}  taker=${ai.teams[1].taker?.archetype.id ?? '-'}`
    );
  }
}
