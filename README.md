# Padel Prototype

A playable 3D **doubles padel** game prototype for the browser — enclosed court with
glass and mesh rebounds, real padel rules and scoring, tactical doubles AI, and a
full shot repertoire (drives, lobs, volleys, bandeja, víbora, smash, chiquita,
wall defence).

Built with **Three.js + Vite** (vanilla ES modules) and a custom, padel-tuned
physics layer. See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the module map and
the assumptions made.

## Run it

```bash
npm install
npm run dev
```

Open the printed URL (default `http://localhost:5173`). Pick a mode, difficulty
and player on the start screen and press **Play**.

## Controls

| Input | Action |
|---|---|
| **W A S D** | Move (momentum-based — you accelerate, brake and turn, no gliding) |
| **Mouse** (or arrow keys) | Aim reticle on the opponent court |
| **Space / Left click** | Standard shot — context-aware: topspin drive, volley at the net, bandeja on high balls, wall return off your glass. Also starts the serve. |
| **Shift + shot** | Lob / high defensive shot |
| **F / Right click** | Attacking shot — smash when the ball is overhead, flat drive otherwise |
| **E** | Bandeja / víbora overhead (auto-picks by contact height & player style) |
| **Q** | Chiquita (soft dipping ball) / block volley at the net |
| **R** | Restart point |
| **C** | Camera: follow ↔ broadcast |
| **F3** | Physics/AI debug overlay (trajectory, collision markers, state readout) |
| **Esc** | Pause menu (difficulty, toggles, controls) |

Tips: aim **deep** for more power (power auto-scales with aim distance); swing
timing, contact height, balance and body orientation all feed shot quality —
the HUD tells you *late / off balance / bad contact / good / perfect*.

## What's implemented

- **Court**: regulation 20×10 m cage — 3 m back glass + 1 m mesh above, stepped
  side glass (3 m/2 m) at the corners, side mesh with DOOR openings beside the
  net posts (run out through them to return a ball that legally exits the
  cage), sagging net (0.88 m centre / 0.92 m posts), service boxes 6.95 m from
  the net.
- **Ball physics**: 240 Hz fixed-step integration, quadratic drag, Magnus lift,
  impulse bounces with spin↔velocity exchange (topspin kicks and climbs off
  glass, slice dies), per-surface response (clean glass, dead & jittery mesh,
  absorbing net), swept collisions (no tunneling on smashes).
- **Rules**: underarm serve after a bounce, diagonal box, two serves, lets,
  fence-after-bounce serve fault, returner must let it bounce, own-glass legal /
  own-mesh fault, bounce-before-opponent-wall, live wall rebounds, second-bounce
  point end, ball-out-of-cage rules. (The body-touch rule is intentionally
  disabled for playability; the hook for it remains in `main.js`.)
- **Scoring**: 15/30/40, deuce/advantage (golden point optional), games, one
  set with tie-break (including tie-break serve rotation), doubles serve
  rotation with side alternation.
- **Shots**: flat drive, topspin drive, lob, volley, block volley, bandeja,
  víbora, smash, wall defence, chiquita — each with contact-height window,
  speed range, spin/arc profile and error model; a drag-aware ballistic solver
  places every shot.
- **AI (3 players)**: interception via trajectory prediction, doubles
  formations (serving pair takes the net, lobbed pair retreats), weighted
  tactical shot selection (lobs under pressure, smashes on short high balls,
  plays into space), difficulty presets (reaction / speed / consistency /
  aggression / IQ).
- **Modes & UX**: match mode, free-rally mode, start screen, pause menu, score
  HUD with serve indicator, fault/let/point messages, shot-quality feedback,
  stamina bar, landing marker, debug overlay.
- **Presentation**: daylight/evening lighting presets (pause menu), broadcast
  instant replay after every point (Space to skip), floating player name tags,
  synthesized audio (racket/bounce/glass/mesh/net, footsteps, crowd reactions,
  game-won stings), camera impact shake on smashes.

## Roster

Four editable archetypes in [`src/roster.js`](src/roster.js) (fictional names,
style-inspired): a power left-side smasher, a creative left-side attacker, a
defensive right-side controller and an athletic all-court player — 14 stats
each (speed, acceleration, reach, reaction, volley, lob, smash, bandeja,
víbora, defence, consistency, aggression, stamina, court IQ).

## Remaining improvements (priority order)

1. **Feel tuning** — more playtesting of swing windows, AI error rates and
   ball pace; controller "assist" options (auto-position for overheads).
2. **Serve variety** — manual toss timing, slice/flat serve selection, and a
   visible serve meter instead of the automated bounce-strike.
3. **Out-of-court depth** — outside returns currently re-enter through “transparent” walls; model exterior wall collisions so outside players must clear the cage or aim through the door.
4. **Animation** — replace procedural posing with skinned rigs & real swing
   animations (model builder is isolated in `player.js` for this).
5. **Match structure** — best-of-three sets, changing ends, per-set stats,
   golden-point reception-side choice for the receiving pair.
6. **Audio** — ball impacts (racket/glass/mesh differ), crowd, score calls.
7. **Multiplayer / local co-op**, gamepad support, mobile touch controls.
8. **Replay & highlights** — the deterministic trajectory sim makes point
   replays cheap to record.
