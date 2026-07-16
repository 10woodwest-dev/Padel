// ============================================================================
// ui.js — DOM overlay: start screen (mode / difficulty / archetype / rules
// options + controls), score HUD with serve indicator, message banner,
// shot-quality feedback, stamina bar, pause menu with live toggles.
// ============================================================================

import { ROSTER } from './roster.js';

const CONTROLS_HTML = `
  <div class="controls-grid">
    <div><b>W A S D</b> move</div>
    <div><b>Mouse / arrows</b> aim reticle</div>
    <div><b>Space / LMB</b> standard shot & serve</div>
    <div><b>Shift + shot</b> lob (defensive, high)</div>
    <div><b>F / RMB</b> attack — smash overhead</div>
    <div><b>E</b> bandeja / víbora overhead</div>
    <div><b>Q</b> chiquita / block volley</div>
    <div><b>R</b> restart point</div>
    <div><b>C</b> camera (follow / broadcast)</div>
    <div><b>F3</b> physics debug overlay</div>
    <div><b>Esc</b> pause</div>
    <div><b>Tip</b> aim deep = more power</div>
  </div>`;

export class UI {
  constructor(root) {
    this.root = root;
    this.buildHUD();
    this.msgTimer = null;
    this.fbTimer = null;
  }

  buildHUD() {
    this.root.innerHTML = `
      <div class="hud-score" style="display:none">
        <div class="teams"><span class="team-name t0"></span><span class="team-name t1"></span></div>
        <div class="points">0 - 0</div>
        <div class="games"></div>
        <div class="serve-info"></div>
        <div class="situation" style="display:none"></div>
      </div>
      <div class="hud-next"></div>
      <div class="hud-message"></div>
      <div class="hud-feedback"></div>
      <div class="hud-stamina" style="display:none"><div class="fill"></div></div>
      <div class="hud-hints" style="display:none">
        <b>Space</b> shot &nbsp;·&nbsp; <b>Shift</b> lob &nbsp;·&nbsp; <b>F</b> smash &nbsp;·&nbsp; <b>E</b> bandeja<br/>
        <b>Q</b> chiquita &nbsp;·&nbsp; <b>R</b> restart &nbsp;·&nbsp; <b>C</b> camera &nbsp;·&nbsp; <b>Esc</b> pause
      </div>
      <div class="hud-debug" style="display:none"></div>
      <div class="hud-replay" style="display:none">REPLAY &nbsp;·&nbsp; Space to skip</div>
      <div class="hud-stat"></div>
      <div class="serve-meter" style="display:none">
        <div class="sm-sweet"></div>
        <div class="sm-ball"></div>
        <div class="sm-label">release at the top</div>
      </div>
      <canvas class="hud-minimap" width="132" height="228"></canvas>
      <div class="lb-top"></div>
      <div class="lb-bottom"></div>
    `;
    this.elScore = this.root.querySelector('.hud-score');
    this.elMsg = this.root.querySelector('.hud-message');
    this.elFb = this.root.querySelector('.hud-feedback');
    this.elStam = this.root.querySelector('.hud-stamina');
    this.elHints = this.root.querySelector('.hud-hints');
    this.elDebug = this.root.querySelector('.hud-debug');
    this.elReplay = this.root.querySelector('.hud-replay');
    this.elStat = this.root.querySelector('.hud-stat');
    this.statTimer = null;
  }

  setReplayBadge(v) {
    this.elReplay.style.display = v ? '' : 'none';
    // cinematic letterbox bars during replays (HUD shifts below the bar)
    this.root.querySelector('.lb-top').classList.toggle('show', v);
    this.root.querySelector('.lb-bottom').classList.toggle('show', v);
    this.root.classList.toggle('cinema', v);
  }

  /** small broadcast stat line ("Serve · 64 km/h", "9-shot rally") */
  showStat(text, ms = 2200) {
    this.elStat.textContent = text;
    this.elStat.classList.add('show');
    clearTimeout(this.statTimer);
    this.statTimer = setTimeout(() => this.elStat.classList.remove('show'), ms);
  }

  setHUDVisible(v) {
    this.elScore.style.display = v ? '' : 'none';
    this.elStam.style.display = v ? '' : 'none';
    this.elHints.style.display = v ? '' : 'none';
    this.root.querySelector('.hud-minimap').style.display = v ? '' : 'none';
    if (!v) { this.setServeMeter(null); this.setNextShot(null); }
  }

  // ---------- score ----------
  updateScore({ scoring, match, names, targets = null }) {
    this.root.querySelector('.team-name.t0').textContent = names[0];
    this.root.querySelector('.team-name.t1').textContent = names[1];
    this.root.querySelector('.team-name.t0').classList.toggle('serving', match.server.team === 0);
    this.root.querySelector('.team-name.t1').classList.toggle('serving', match.server.team === 1);

    const sit = this.root.querySelector('.situation');
    if (match.mode === 'rally') {
      this.root.querySelector('.points').textContent =
        targets != null ? `FREE RALLY · Targets ${targets}` : 'FREE RALLY';
      this.root.querySelector('.games').textContent = 'Hit the glowing rings for points';
      sit.style.display = 'none';
    } else {
      this.root.querySelector('.points').textContent = scoring.pointsLabel();
      const sets = scoring.setHistory.map((s) => `${s[0]}-${s[1]}`).join('  ');
      this.root.querySelector('.games').textContent =
        `Games ${scoring.games[0]} - ${scoring.games[1]}${sets ? '   Sets ' + sets : ''}${scoring.inTieBreak ? '  ·  TIE-BREAK' : ''}`;
      const s = scoring.situation();
      sit.style.display = s ? '' : 'none';
      if (s) sit.textContent = `★ ${s.label}${s.team >= 0 ? ' — ' + names[s.team] : ''}`;
    }
    this.updateServeInfo(match);
  }

  /** serve-timing meter: hNorm = ball height / 0.9, null hides */
  setServeMeter(hNorm) {
    const el = this.root.querySelector('.serve-meter');
    if (hNorm === null) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.querySelector('.sm-ball').style.bottom = `${hNorm * 100}%`;
  }

  /** top-down radar: court, players, ball */
  drawMinimap(players, ball, humanTeamSign) {
    const c = this.root.querySelector('.hud-minimap');
    const g = c.getContext('2d');
    const W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    // world → map: x∈[-6.5,6.5] → [0,W], z∈[-11,11] → [0,H] (human side bottom)
    const mx = (x) => (x + 6.5) / 13 * W;
    const mz = (z) => (z * humanTeamSign + 11) / 22 * H;
    // court + boxes
    g.fillStyle = 'rgba(10,16,24,0.55)';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(220,235,245,0.75)';
    g.lineWidth = 1;
    g.strokeRect(mx(-5), mz(-10), mx(5) - mx(-5), mz(10) - mz(-10));
    g.beginPath();
    g.moveTo(mx(-5), mz(0)); g.lineTo(mx(5), mz(0)); // net
    g.moveTo(mx(-5), mz(-6.95)); g.lineTo(mx(5), mz(-6.95));
    g.moveTo(mx(-5), mz(6.95)); g.lineTo(mx(5), mz(6.95));
    g.moveTo(mx(0), mz(-6.95)); g.lineTo(mx(0), mz(6.95));
    g.stroke();
    // players
    for (const p of players) {
      g.fillStyle = p.isHuman ? '#eaff6e' : (p.team === 0 ? '#9fd86e' : '#f0876e');
      g.beginPath();
      g.arc(mx(p.pos.x), mz(p.pos.z), p.isHuman ? 4 : 3.2, 0, Math.PI * 2);
      g.fill();
    }
    // ball (ring grows with height)
    if (ball.active) {
      g.strokeStyle = '#ffe94d';
      g.lineWidth = 1.6;
      g.beginPath();
      g.arc(mx(ball.pos.x), mz(ball.pos.z), 2.4 + Math.min(3, ball.pos.y * 0.7), 0, Math.PI * 2);
      g.stroke();
    }
  }

  /** contextual "what Space will hit" hint */
  setNextShot(label) {
    const el = this.root.querySelector('.hud-next');
    if (this._nextShot === label) return;
    this._nextShot = label;
    el.textContent = label ? `Space → ${label}` : '';
  }

  updateServeInfo(match) {
    const el = this.root.querySelector('.serve-info');
    const srv = match.server;
    el.textContent = `Serve: ${srv.archetype.name.split(' ')[0]}${srv.isHuman ? ' (you)' : ''} · ${match.serveSide} side · ${match.serveNumber === 2 ? '2nd serve' : '1st serve'}`;
  }

  // ---------- transient text ----------
  showMessage(text, kind = 'info', ms = 1700) {
    this.elMsg.textContent = text;
    this.elMsg.className = `hud-message show ${kind}`;
    clearTimeout(this.msgTimer);
    this.msgTimer = setTimeout(() => this.elMsg.classList.remove('show'), ms);
  }

  showShotFeedback(text, quality) {
    const cls = quality > 0.82 ? 'q-perfect' : quality > 0.6 ? 'q-good' : 'q-poor';
    this.elFb.textContent = text;
    this.elFb.className = `hud-feedback show ${cls}`;
    clearTimeout(this.fbTimer);
    this.fbTimer = setTimeout(() => this.elFb.classList.remove('show'), 900);
  }

  updateStamina(v) {
    const fill = this.elStam.querySelector('.fill');
    fill.style.width = `${v}%`;
    fill.classList.toggle('low', v < 30);
  }

  setDebugText(text) {
    this.elDebug.textContent = text;
  }
  setDebugVisible(v) { this.elDebug.style.display = v ? '' : 'none'; }

  // ---------- start screen ----------
  showStartScreen(defaults, onStart) {
    const ov = document.createElement('div');
    ov.className = 'overlay';
    const sel = {
      mode: defaults.mode, difficulty: defaults.difficulty,
      golden: defaults.golden, humanId: defaults.humanId,
      sets: defaults.sets ?? '1',
    };
    ov.innerHTML = `
      <div class="panel">
        <h1>PADEL <span>PROTOTYPE</span></h1>
        <div class="subtitle">Enclosed court · glass rebounds · real doubles rules</div>

        <h2>Game mode</h2>
        <div class="option-row" data-k="mode">
          <button data-v="match">Match</button>
          <button data-v="rally">Free rally (target practice)</button>
        </div>

        <h2>Match length</h2>
        <div class="option-row" data-k="sets">
          <button data-v="1">One set</button>
          <button data-v="3">Best of 3</button>
        </div>

        <h2>AI difficulty</h2>
        <div class="option-row" data-k="difficulty">
          <button data-v="easy">Easy</button>
          <button data-v="medium">Medium</button>
          <button data-v="hard">Hard</button>
        </div>

        <h2>Deciding point</h2>
        <div class="option-row" data-k="golden">
          <button data-v="false">Advantage (real deuce)</button>
          <button data-v="true">Golden point</button>
        </div>

        <h2>Your player</h2>
        <div class="roster-cards"></div>

        <h2>Controls</h2>
        ${CONTROLS_HTML}

        <button class="big-btn">Play</button>
      </div>`;

    // option rows
    for (const row of ov.querySelectorAll('.option-row')) {
      const k = row.dataset.k;
      for (const btn of row.querySelectorAll('button')) {
        if (String(sel[k]) === btn.dataset.v) btn.classList.add('selected');
        btn.addEventListener('click', () => {
          row.querySelectorAll('button').forEach((b) => b.classList.remove('selected'));
          btn.classList.add('selected');
          sel[k] = k === 'golden' ? btn.dataset.v === 'true' : btn.dataset.v;
        });
      }
    }
    // roster cards
    const cards = ov.querySelector('.roster-cards');
    for (const r of ROSTER) {
      const card = document.createElement('div');
      card.className = 'roster-card' + (r.id === sel.humanId ? ' selected' : '');
      card.innerHTML = `
        <div class="rname">${r.name}</div>
        <div class="rarch">${r.archetype}</div>
        <div class="rstat"><span>Speed</span><span>${r.stats.speed}</span></div>
        <div class="rstat"><span>Smash</span><span>${r.stats.smash}</span></div>
        <div class="rstat"><span>Defence</span><span>${r.stats.defence}</span></div>
        <div class="rstat"><span>Consistency</span><span>${r.stats.consistency}</span></div>`;
      card.addEventListener('click', () => {
        cards.querySelectorAll('.roster-card').forEach((c) => c.classList.remove('selected'));
        card.classList.add('selected');
        sel.humanId = r.id;
      });
      cards.appendChild(card);
    }

    ov.querySelector('.big-btn').addEventListener('click', () => {
      ov.remove();
      onStart(sel);
    });
    this.root.appendChild(ov);
  }

  // ---------- pause menu ----------
  showPauseMenu(state, handlers) {
    this.hidePauseMenu();
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.dataset.pause = '1';
    ov.innerHTML = `
      <div class="panel">
        <h1>PAUSED</h1>
        <div class="subtitle">Esc to resume</div>

        <h2>AI difficulty</h2>
        <div class="option-row" data-k="difficulty">
          <button data-v="easy">Easy</button>
          <button data-v="medium">Medium</button>
          <button data-v="hard">Hard</button>
        </div>

        <h2>Toggles</h2>
        <div class="option-row">
          <button data-t="debug">Debug overlay: ${state.debug ? 'ON' : 'OFF'}</button>
          <button data-t="camera">Camera: ${state.camera}</button>
          <button data-t="golden">Deciding point: ${state.golden ? 'golden' : 'advantage'}</button>
          <button data-t="light">Lighting: ${state.lighting}</button>
          <button data-t="replays">Replays: ${state.replays}</button>
        </div>

        <h2>Controls</h2>
        ${CONTROLS_HTML}

        <button class="big-btn" data-a="resume">Resume</button>
        <button class="menu-btn" data-a="restart">Restart match</button>
        <button class="menu-btn" data-a="menu">Back to start screen</button>
      </div>`;

    for (const btn of ov.querySelectorAll('[data-k="difficulty"] button')) {
      if (btn.dataset.v === state.difficulty) btn.classList.add('selected');
      btn.addEventListener('click', () => {
        ov.querySelectorAll('[data-k="difficulty"] button').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
        handlers.onDifficulty(btn.dataset.v);
      });
    }
    ov.querySelector('[data-t="debug"]').addEventListener('click', (e) => {
      const on = handlers.onToggleDebug();
      e.target.textContent = `Debug overlay: ${on ? 'ON' : 'OFF'}`;
    });
    ov.querySelector('[data-t="camera"]').addEventListener('click', (e) => {
      e.target.textContent = `Camera: ${handlers.onToggleCamera()}`;
    });
    ov.querySelector('[data-t="golden"]').addEventListener('click', (e) => {
      e.target.textContent = `Deciding point: ${handlers.onToggleGolden() ? 'golden' : 'advantage'}`;
    });
    ov.querySelector('[data-t="light"]').addEventListener('click', (e) => {
      e.target.textContent = `Lighting: ${handlers.onToggleLighting()}`;
    });
    ov.querySelector('[data-t="replays"]').addEventListener('click', (e) => {
      e.target.textContent = `Replays: ${handlers.onCycleReplays()}`;
    });
    ov.querySelector('[data-a="resume"]').addEventListener('click', handlers.onResume);
    ov.querySelector('[data-a="restart"]').addEventListener('click', handlers.onRestart);
    ov.querySelector('[data-a="menu"]').addEventListener('click', handlers.onMenu);
    this.root.appendChild(ov);
  }

  hidePauseMenu() {
    this.root.querySelector('[data-pause]')?.remove();
  }

  // ---------- post-match stats ----------
  showMatchStats({ names, winner, stats }, handlers) {
    this.hideMatchStats();
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.dataset.stats = '1';
    const row = (label, a, b) => `
      <tr><td class="sv">${a}</td><td class="sl">${label}</td><td class="sv">${b}</td></tr>`;
    ov.innerHTML = `
      <div class="panel stats-panel">
        <h1>MATCH <span>${winner === 0 ? names[0] : names[1]}</span></h1>
        <div class="subtitle">win the match</div>
        <table class="stats-table">
          <tr class="head"><td>${names[0]}</td><td></td><td>${names[1]}</td></tr>
          ${row('Aces', stats.aces[0], stats.aces[1])}
          ${row('Double faults', stats.doubleFaults[0], stats.doubleFaults[1])}
          ${row('Winners', stats.winners[0], stats.winners[1])}
          ${row('Unforced errors', stats.errors[0], stats.errors[1])}
          ${row('Fastest serve', stats.fastestServe[0] ? Math.round(stats.fastestServe[0] * 3.6) + ' km/h' : '—',
    stats.fastestServe[1] ? Math.round(stats.fastestServe[1] * 3.6) + ' km/h' : '—')}
          <tr><td class="sv" colspan="3">Longest rally: ${stats.longestRally} shots</td></tr>
        </table>
        <button class="big-btn">Rematch</button>
        <button class="menu-btn">Back to start screen</button>
      </div>`;
    ov.querySelector('.big-btn').addEventListener('click', () => { ov.remove(); handlers.onRematch(); });
    ov.querySelector('.menu-btn').addEventListener('click', () => { ov.remove(); handlers.onMenu(); });
    this.root.appendChild(ov);
  }

  hideMatchStats() {
    this.root.querySelector('[data-stats]')?.remove();
  }
}
