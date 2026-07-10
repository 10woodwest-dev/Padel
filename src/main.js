// ============================================================================
// main.js — bootstrap + game loop.
//
// Loop structure (fixed-timestep physics, variable-rate rendering):
//   frame:
//     controllers (human + AI) set movement intents / start swings
//     players integrate locomotion & animation
//     physics: N substeps at 240 Hz
//       - ball integration & collisions → semantic events → referee/AI/debug
//       - swing contact tests (racket meets ball) → shot execution
//       - body-touch rule
//     match flow (serve staging, point reset), camera, HUD, debug
// ============================================================================

import * as THREE from 'three';
import { PHYSICS, COLORS } from './constants.js';
import { v3, vCopy } from './mathUtils.js';
import { buildCourt } from './court.js';
import { createBallState, stepBall, BallVisual } from './ball.js';
import { SHOTS, executeShot, computeShotQuality } from './shots.js';
import { ROSTER, getArchetype, DEFAULT_LINEUP } from './roster.js';
import { Player } from './player.js';
import { Input } from './input.js';
import { HumanController } from './controller.js';
import { AIManager } from './ai.js';
import { Referee } from './rules.js';
import { Scoring } from './scoring.js';
import { Match } from './match.js';
import { CameraRig } from './cameraRig.js';
import { UI } from './ui.js';
import { DebugView } from './debugView.js';

// ---------------------------------------------------------------------------
// Renderer / scene
// ---------------------------------------------------------------------------
const canvas = document.getElementById('game-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(COLORS.skyTop, 45, 110);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 300);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

buildCourt(scene);

// ---------------------------------------------------------------------------
// Game state (rebuilt on every "Play" from the start screen)
// ---------------------------------------------------------------------------
const input = new Input(canvas);
const ui = new UI(document.getElementById('ui-root'));

const G = {
  players: [], human: null, controller: null,
  ball: createBallState(), ballVisual: new BallVisual(scene),
  referee: null, scoring: null, match: null, ai: null,
  cameraRig: null, debug: null,
  running: false, paused: false,
  lastStrike: { playerId: -1, t: -99 },
  time: 0,
  settings: { mode: 'match', difficulty: 'medium', golden: false, humanId: DEFAULT_LINEUP.humanId },
  lastGlassOwnSideAt: -99,
};

G.debug = new DebugView(scene, ui);

// aim reticle (human aiming target)
const reticle = new THREE.Group();
{
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.14, 0.2, 24),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  const dot = new THREE.Mesh(
    new THREE.CircleGeometry(0.045, 12),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, depthWrite: false })
  );
  dot.rotation.x = -Math.PI / 2;
  reticle.add(ring, dot);
  reticle.position.y = 0.01;
  reticle.visible = false;
  scene.add(reticle);
}

// ---------------------------------------------------------------------------
// Line-up: the human's pick plus three AI players, sides assigned sensibly.
// ---------------------------------------------------------------------------
function buildLineup(humanId) {
  const rest = ROSTER.map((r) => r.id).filter((id) => id !== humanId);
  // prefer the default line-up roles where still available
  const pref = [DEFAULT_LINEUP.partnerId, ...DEFAULT_LINEUP.opponentIds].filter((id) => rest.includes(id));
  for (const id of rest) if (!pref.includes(id)) pref.push(id);
  return { humanId, partnerId: pref[0], opponentIds: [pref[1], pref[2]] };
}

function setupPlayers(humanId) {
  // clear previous
  for (const p of G.players) scene.remove(p.model.group);

  const lineup = buildLineup(humanId);
  const hArch = getArchetype(lineup.humanId);
  const pArch = getArchetype(lineup.partnerId);
  const o1 = getArchetype(lineup.opponentIds[0]);
  const o2 = getArchetype(lineup.opponentIds[1]);

  const hSlot = hArch.side === 'left' ? 'left' : 'right';
  const pSlot = hSlot === 'right' ? 'left' : 'right';
  const o1Slot = o1.side === 'left' ? 'left' : 'right';
  const o2Slot = o1Slot === 'right' ? 'left' : 'right';

  const human = new Player(hArch, 0, hSlot, true);
  const partner = new Player(pArch, 0, pSlot, false);
  const opp1 = new Player(o1, 1, o1Slot, false);
  const opp2 = new Player(o2, 1, o2Slot, false);

  G.players = [human, partner, opp1, opp2];
  G.human = human;
  for (const p of G.players) scene.add(p.model.group);
}

function teamNames() {
  const nick = (p) => p.archetype.name.match(/"([^"]+)"/)?.[1] ?? p.archetype.name.split(' ')[0];
  const t0 = G.players.filter((p) => p.team === 0);
  const t1 = G.players.filter((p) => p.team === 1);
  return [
    `${t0[0].isHuman ? 'YOU' : nick(t0[0])} & ${nick(t0[1])}`,
    `${nick(t1[0])} & ${nick(t1[1])}`,
  ];
}

// ---------------------------------------------------------------------------
// Session wiring
// ---------------------------------------------------------------------------
function startSession(settings) {
  G.settings = { ...G.settings, ...settings };
  setupPlayers(G.settings.humanId);

  G.scoring = new Scoring({ goldenPoint: G.settings.golden });
  G.referee = new Referee({
    onPointOver: (res) => G.match.handlePointOver(res),
    onServeFault: (res) => G.match.handleServeFault(res),
    onLet: (res) => G.match.handleLet(res),
    onMessage: (text) => ui.showMessage(text, 'info'),
  });
  G.match = new Match(G.players, G.ball, G.referee, G.scoring, {
    onMessage: (text, kind) => ui.showMessage(text, kind),
    onScore: () => ui.updateScore({ scoring: G.scoring, match: G.match, names: teamNames() }),
    onPhase: () => {
      ui.updateScore({ scoring: G.scoring, match: G.match, names: teamNames() });
      G.debug.clearEvents();
    },
    onShotFeedback: (t, q) => ui.showShotFeedback(t, q),
  });
  G.ai = new AIManager(G.players, G.human, G.match, G.referee, G.ball, G.settings.difficulty);
  G.cameraRig = new CameraRig(camera, G.human);
  G.controller = new HumanController(G.human, input, camera);

  G.match.begin(G.settings.mode);
  ui.setHUDVisible(true);
  G.running = true;
  G.paused = false;
}

function showMenu() {
  G.running = false;
  ui.setHUDVisible(false);
  ui.hidePauseMenu();
  ui.showStartScreen(G.settings, (sel) => startSession(sel));
}

// ---------------------------------------------------------------------------
// Contact resolution — racket meets ball (human and AI both land here).
// ---------------------------------------------------------------------------
function resolveContact(player, contact) {
  const def = SHOTS[contact.shot];
  const { quality, feedback } = computeShotQuality({
    shot: contact.shot,
    timing: contact.timing,
    ballHeight: contact.ballHeight,
    playerSpeed: contact.playerSpeed,
    facingError: contact.facingError,
    stamina: player.stamina,
    statValue: player.stats[def.stat] ?? 70,
  });

  // referee first: an illegal serve-volley ends the point even though the
  // swing physically connects
  G.referee.rallyHit(player);

  executeShot(G.ball, {
    shot: contact.shot,
    start: vCopy(G.ball.pos),
    aim: contact.aim,
    hitterSide: player.teamSign,
    quality,
    power: contact.power,
    errorScale: player.isHuman ? 1.0 : (player.aiErrorScale ?? 1.0),
  });

  G.ai.notifyTeamHit(player.team, contact.shot);
  G.lastStrike = { playerId: player.id, t: G.time };
  // swinging costs a little energy
  player.stamina = Math.max(0, player.stamina - 1.2);

  if (player.isHuman) {
    ui.showShotFeedback(`${def.label} — ${feedback}`, quality);
  }
}

// ---------------------------------------------------------------------------
// Ball events → referee / match / AI / debug (+ own-glass tracking for the
// controller's wall-defence context)
// ---------------------------------------------------------------------------
function handleBallEvents(events) {
  for (const ev of events) {
    G.debug.addEvent(ev);
    G.ai.notifyBallEvent();
    G.match.onBallEvent(ev);
    G.referee.ballEvent(ev);
    if (ev.type === 'glass' && ev.side === G.human.teamSign) {
      G.lastGlassOwnSideAt = G.time;
    }
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let physicsAccum = 0;
let lastT = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  if (!G.running) { renderer.render(scene, camera); input.endFrame(); return; }
  if (G.paused) { renderer.render(scene, camera); handleGlobalKeys(); input.endFrame(); return; }

  G.time += dt;

  // ---- controllers ---------------------------------------------------------
  const phase = G.match.state;
  const isServer = G.match.server === G.human;
  const ballIncoming = G.ball.active &&
    (Math.sign(G.ball.pos.z) === G.human.teamSign ||
      (Math.sign(G.ball.vel.z) === G.human.teamSign && Math.abs(G.ball.vel.z) > 0.5));

  const actions = G.controller.update(dt, {
    ball: G.ball,
    phase,
    isServer,
    serveSide: G.match.serveSide,
    ballIncoming,
    lastGlassOwnSide: G.time - G.lastGlassOwnSideAt < 1.6,
  });
  if (actions.serve) G.match.requestServe(G.controller.aim);

  G.ai.update(dt);

  // ---- players -------------------------------------------------------------
  for (const p of G.players) p.update(dt);

  // ---- physics substeps ----------------------------------------------------
  physicsAccum += dt;
  let steps = 0;
  while (physicsAccum >= PHYSICS.dt && steps < PHYSICS.maxSubSteps * 4) {
    physicsAccum -= PHYSICS.dt;
    steps++;
    if (!G.ball.active) continue;

    const events = [];
    stepBall(G.ball, PHYSICS.dt, events, false);
    if (events.length) handleBallEvents(events);

    // swing contact tests (racket meets ball) — only while the point is
    // actually being played; nobody may hijack a serve drop or a dead ball
    if (G.match.state === 'live') {
      for (const p of G.players) {
        if (!p.isSwinging()) continue;
        const contact = p.tryContact(G.ball.pos, G.ball.vel);
        if (contact) resolveContact(p, contact);
      }
    }

    // NOTE: real padel's body-touch rule (ball touching a player loses the
    // point) is intentionally DISABLED for playability — the ball passes
    // through players. Re-enable by calling G.referee.bodyTouch(p) here for
    // any player within HIT.bodyRadius of the ball.
  }

  // ---- match flow, camera, visuals ----------------------------------------
  G.match.update(dt);
  G.ballVisual.update(G.ball, dt);
  if ((frameCount & 7) === 0) G.ballVisual.showLanding(G.ball);
  G.cameraRig.update(dt, G.ball);

  // aim reticle: visible whenever the human can influence the next shot
  const showReticle = phase === 'live' || (phase === 'preServe' && isServer);
  reticle.visible = showReticle;
  if (showReticle) reticle.position.set(G.controller.aim.x, 0.012, G.controller.aim.z);

  ui.updateStamina(G.human.stamina);
  G.debug.update(G.ball, G.referee, G.ai, G.match);

  handleGlobalKeys();
  input.endFrame();
  renderer.render(scene, camera);
  frameCount++;
}
let frameCount = 0;

// ---------------------------------------------------------------------------
// Global keys: pause / restart / camera / debug
// ---------------------------------------------------------------------------
function handleGlobalKeys() {
  if (input.wasPressed('Escape')) {
    if (!G.paused) {
      G.paused = true;
      ui.showPauseMenu(
        {
          difficulty: G.settings.difficulty,
          debug: G.debug.enabled,
          camera: G.cameraRig.mode,
          golden: G.scoring.goldenPoint,
        },
        {
          onDifficulty: (d) => { G.settings.difficulty = d; G.ai.setDifficulty(d); },
          onToggleDebug: () => G.debug.toggle(),
          onToggleCamera: () => { G.cameraRig.toggle(); return G.cameraRig.mode; },
          onToggleGolden: () => { G.scoring.goldenPoint = !G.scoring.goldenPoint; G.settings.golden = G.scoring.goldenPoint; return G.scoring.goldenPoint; },
          onResume: () => { G.paused = false; ui.hidePauseMenu(); },
          onRestart: () => { G.paused = false; ui.hidePauseMenu(); G.match.begin(G.settings.mode); },
          onMenu: () => showMenu(),
        }
      );
    } else {
      G.paused = false;
      ui.hidePauseMenu();
    }
  }
  if (G.paused) return;
  if (input.wasPressed('KeyR')) G.match?.restartPoint();
  if (input.wasPressed('KeyC')) G.cameraRig?.toggle();
  if (input.wasPressed('F3')) G.debug.toggle();
}

// ---------------------------------------------------------------------------
showMenu();
requestAnimationFrame(frame);

// Debug/testing handle (used by the headless smoke tests; harmless in play).
window.__PADEL__ = G;
