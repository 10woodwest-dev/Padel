// ============================================================================
// input.js — raw keyboard/mouse capture with per-frame edge detection.
// Bindings live in controller.js; this module only tracks device state.
// ============================================================================

export class Input {
  constructor(canvas) {
    this.down = new Set();       // currently-held key codes
    this.pressed = new Set();    // keys that went down since last endFrame()
    this.mouse = { x: 0, y: 0 }; // NDC (-1..1)
    this.mouseDown = new Set();
    this.mousePressed = new Set();
    this.mouseMovedAt = 0;       // timestamp — lets arrow keys take over aim

    window.addEventListener('keydown', (e) => {
      // avoid page scroll on game keys
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => { this.down.clear(); this.mouseDown.clear(); });

    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      this.mouse.y = -((e.clientY - r.top) / r.height) * 2 + 1;
      this.mouseMovedAt = performance.now();
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.mouseDown.has(e.button)) this.mousePressed.add(e.button);
      this.mouseDown.add(e.button);
    });
    window.addEventListener('mouseup', (e) => this.mouseDown.delete(e.button));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // RMB = smash
  }

  held(code) { return this.down.has(code); }
  wasPressed(code) { return this.pressed.has(code); }
  mouseHeld(btn) { return this.mouseDown.has(btn); }
  mouseWasPressed(btn) { return this.mousePressed.has(btn); }

  /** call once per rendered frame, after all consumers have polled */
  endFrame() { this.pressed.clear(); this.mousePressed.clear(); }
}
