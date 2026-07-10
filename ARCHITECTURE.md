# Padel Prototype — Architecture

## Stack decision

The repo was empty, so the simplest reliable browser-playable stack was chosen:

- **Three.js** (rendering) + **Vite** (dev server / bundling), vanilla ES modules, no framework.
- **Custom ball physics** instead of a generic physics engine. A padel ball is a single sphere
  interacting with axis-aligned planes (floor, glass, mesh, net). Hand-rolling this gives exact
  control over the things that make padel feel like padel — glass vs. mesh restitution, spin
  coupling on bounces, serve legality, trajectory prediction for AI — and avoids fighting a
  rigid-body engine's contact solver for gameplay feel.
- Runs locally with `npm install && npm run dev`.

## Coordinate system

- `x`: across the court width, `[-5, +5]` m. `y`: up. `z`: along the court length, `[-10, +10]` m.
- Net plane at `z = 0`. **Team 0 (human + AI partner) plays the `z > 0` half**; camera sits behind
  them at `+z` looking toward `-z`. Team 1 (AI opponents) plays `z < 0`.
- "Right/deuce court" is defined from each player's own perspective. Team 0 faces `-z`, so its
  right half is `x > 0`; Team 1 faces `+z`, so its right half is `x < 0`. A diagonal serve
  therefore goes from one sign of `x` to the opposite sign.

## Modules (`src/`)

| Module          | Responsibility |
|-----------------|----------------|
| `constants.js`  | Court dimensions (FIP-regulation), physics constants, all gameplay tunables |
| `mathUtils.js`  | Vector helpers, damping, RNG |
| `court.js`      | Court geometry & materials: floor, lines, net, back/side glass, mesh fence, posts, lights, environment |
| `ball.js`       | Ball state + integrator (gravity, quadratic drag, Magnus), collision vs. floor/glass/mesh/net with per-surface restitution & spin coupling, event emission, reusable trajectory simulation for AI/debug |
| `shots.js`      | Shot table (drive, topspin drive, lob, volley, block volley, bandeja, víbora, smash, wall defence, chiquita) with contact-height prefs, speed/arc/spin profiles, error model, AI weights; ballistic solver (iterative, drag-aware) that turns "target + shot type + quality" into a launch velocity |
| `roster.js`     | Editable player archetypes with 14 stats each |
| `player.js`     | Player entity: locomotion (acceleration/momentum/turn-rate), stamina & balance, pose state machine (idle/run/prepare/swing/overhead/volley/recover), simple articulated 3D model |
| `input.js`      | Keyboard/mouse capture |
| `controller.js` | Human controller: WASD intent, mouse/arrow aiming, swing timing & shot selection, serve flow |
| `ai.js`         | AI controllers: doubles positioning (attack/defence formations), interception prediction via trajectory sim, weighted shot selection, difficulty knobs (reaction, speed, consistency, aggression, IQ) |
| `rules.js`      | Rally referee: serve legality (underarm, diagonal box, let, fence-after-bounce fault), rally legality (must bounce on opponent floor before their glass/mesh, own glass OK, own mesh fault), second-bounce detection, point outcomes |
| `scoring.js`    | Tennis scoring: 15/30/40/deuce/advantage, games, sets, tie-break, optional golden point |
| `match.js`      | Game modes (free rally / match), serve rotation & side alternation, point reset flow |
| `cameraRig.js`  | Smoothed third-person follow camera + broadcast camera toggle |
| `ui.js`         | Start screen, HUD (score, serve indicator, messages, shot feedback), pause menu, settings |
| `debugView.js`  | Trajectory line, collision markers, ball/AI state readouts |
| `main.js`       | Bootstrap, fixed-timestep game loop, module wiring |

## Physics model (summary)

- Semi-implicit Euler at 240 Hz fixed timestep (accumulator), rendering at display rate.
- Drag: `a = -kd·|v|·v`, `kd ≈ 0.020 m⁻¹` (terminal velocity ≈ 22 m/s, tennis-ball-like).
- Magnus: `a = S·(ω × v)` with clamped magnitude — topspin dips, slice floats.
- Bounce: impulse-based sphere bounce with Coulomb-limited friction impulse that exchanges
  spin and tangential velocity (topspin kicks forward and climbs off back glass; slice dies).
- Surfaces: floor COR ≈ 0.75; glass COR ≈ 0.82 (clean, predictable); mesh COR ≈ 0.35 with a
  randomly jittered normal (deadened, unpredictable); net absorbs nearly everything.

## Rules model (summary)

The referee is an event-driven state machine fed by ball events (`floor`, `glass`, `mesh`,
`net`, `out`, `hit`). Per hit it tracks whose shot the ball is, whether it has bounced on the
receiving floor yet, and applies padel law:

- Serve: underarm after a self-bounce, from the right (deuce) side first, alternating; must
  bounce in the diagonal box; may hit glass after the bounce but **not mesh** (fault); net cord
  + valid box = let; two serves, double fault loses the point; returner must let it bounce.
- Rally: after your hit the ball may touch **your own glass** on the way over, never your own
  mesh; it must bounce on the opponent's floor before touching their glass/mesh; after that
  bounce, wall/fence rebounds stay live; second floor bounce ends the point; a ball that flies
  out of the cage without bouncing is out, one that exits after a legal bounce wins the point.

## Assumptions made (documented, not asked)

- One set, advantage scoring by default; golden point + tie-break exist as settings.
- Serve is simplified to a single key press (bounce → underarm strike happen automatically,
  legality still enforced); serve position is auto-placed behind the service line.
- Player-body contact does NOT end the point (rule disabled for playability;
  re-enable hook in `main.js`).
- No doubles "double hit" or foot-fault enforcement; no out-of-court play after legal exit.
- Simple articulated capsule/box player models with procedural posing stand in for real
  animation; the model builder is isolated in `player.js` for easy replacement.
