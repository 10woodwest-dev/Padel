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
      </div>
      <div class="hud-message"></div>
      <div class="hud-feedback"></div>
      <div class="hud-stamina" style="display:none"><div class="fill"></div></div>
      <div class="hud-hints" style="display:none">
        <b>Space</b> shot &nbsp;·&nbsp; <b>Shift</b> lob &nbsp;·&nbsp; <b>F</b> smash &nbsp;·&nbsp; <b>E</b> bandeja<br/>
        <b>Q</b> chiquita &nbsp;·&nbsp; <b>R</b> restart &nbsp;·&nbsp; <b>C</b> camera &nbsp;·&nbsp; <b>Esc</b> pause
      </div>
      <div class="hud-debug" style="display:none"></div>
    `;
    this.elScore = this.root.querySelector('.hud-score');
    this.elMsg = this.root.querySelector('.hud-message');
    this.elFb = this.root.querySelector('.hud-feedback');
    this.elStam = this.root.querySelector('.hud-stamina');
    this.elHints = this.root.querySelector('.hud-hints');
    this.elDebug = this.root.querySelector('.hud-debug');
  }

  setHUDVisible(v) {
    this.elScore.style.display = v ? '' : 'none';
    this.elStam.style.display = v ? '' : 'none';
    this.elHints.style.display = v ? '' : 'none';
  }

  // ---------- score ----------
  updateScore({ scoring, match, names }) {
    this.root.querySelector('.team-name.t0').textContent = names[0];
    this.root.querySelector('.team-name.t1').textContent = names[1];
    this.root.querySelector('.team-name.t0').classList.toggle('serving', match.server.team === 0);
    this.root.querySelector('.team-name.t1').classList.toggle('serving', match.server.team === 1);

    if (match.mode === 'rally') {
      this.root.querySelector('.points').textContent = 'FREE RALLY';
      this.root.querySelector('.games').textContent = '';
    } else {
      this.root.querySelector('.points').textContent = scoring.pointsLabel();
      const sets = scoring.setHistory.map((s) => `${s[0]}-${s[1]}`).join('  ');
      this.root.querySelector('.games').textContent =
        `Games ${scoring.games[0]} - ${scoring.games[1]}${sets ? '   Sets ' + sets : ''}${scoring.inTieBreak ? '  ·  TIE-BREAK' : ''}`;
    }
    this.updateServeInfo(match);
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
    };
    ov.innerHTML = `
      <div class="panel">
        <h1>PADEL <span>PROTOTYPE</span></h1>
        <div class="subtitle">Enclosed court · glass rebounds · real doubles rules</div>

        <h2>Game mode</h2>
        <div class="option-row" data-k="mode">
          <button data-v="match">Match (1 set)</button>
          <button data-v="rally">Free rally</button>
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
    ov.querySelector('[data-a="resume"]').addEventListener('click', handlers.onResume);
    ov.querySelector('[data-a="restart"]').addEventListener('click', handlers.onRestart);
    ov.querySelector('[data-a="menu"]').addEventListener('click', handlers.onMenu);
    this.root.appendChild(ov);
  }

  hidePauseMenu() {
    this.root.querySelector('[data-pause]')?.remove();
  }
}
