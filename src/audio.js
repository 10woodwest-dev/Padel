// ============================================================================
// audio.js — tiny synthesized sound set (no assets): racket pops, floor
// bounces, glass clacks, mesh rattles, net thuds. WebAudio is created lazily
// on the first user gesture (browser autoplay policy).
// ============================================================================

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
  }

  /** call from a user-gesture handler (e.g. the Play button) */
  init() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      // shared noise buffer
      const len = this.ctx.sampleRate * 0.2;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    } catch { this.enabled = false; }
  }

  /** kind: hit | bounce | glass | mesh | net | let ; intensity 0..1 */
  play(kind, intensity = 0.6) {
    if (!this.ctx || !this.enabled) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const t = this.ctx.currentTime;
    const i = Math.min(1, Math.max(0.15, intensity));

    // profiles: [filterFreq, filterQ, gain, decay, tonalFreq?]
    const P = {
      hit: [1500 + i * 1800, 1.2, 0.9 * i, 0.06],
      bounce: [420 + i * 300, 1.5, 0.5 * i, 0.08],
      glass: [2400, 3.5, 0.55 * i, 0.09, 900],
      mesh: [900, 0.8, 0.5 * i, 0.16],
      net: [260, 1.2, 0.45 * i, 0.1],
      let: [1900, 4, 0.35, 0.05, 1400],
      step: [180 + i * 120, 0.9, 0.12 * i, 0.05],
      crowd: [520, 0.5, 0.28 * i, 1.1],
      game: [1200, 5, 0.4, 0.35, 660],
    }[kind] || [800, 1, 0.4, 0.08];

    const [freq, q, gain, decay, tone] = P;

    // filtered noise burst (crowd swells get a slow attack)
    const attack = kind === 'crowd' ? 0.22 : 0.004;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.value = freq;
    filt.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, gain), t + attack);
    g.gain.exponentialRampToValueAtTime(0.001, t + attack + decay);
    src.connect(filt).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + attack + decay + 0.05);

    // optional tonal ping (glass/net-cord)
    if (tone) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(tone, t);
      osc.frequency.exponentialRampToValueAtTime(tone * 0.6, t + decay);
      const og = this.ctx.createGain();
      og.gain.setValueAtTime(gain * 0.4, t);
      og.gain.exponentialRampToValueAtTime(0.001, t + decay * 1.4);
      osc.connect(og).connect(this.master);
      osc.start(t);
      osc.stop(t + decay * 1.5);
    }
  }
}
