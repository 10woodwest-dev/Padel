// ============================================================================
// roster.js — Editable player roster. Fictional names, archetypes inspired by
// real professional playing styles (no licensed likenesses). Add or edit
// entries freely; every stat is 0–100 and is consumed by player.js (movement,
// stamina), shots.js (quality) and ai.js (decision-making).
//
// Stat meanings:
//   speed        top running speed
//   acceleration how fast they reach it (and stop)
//   reach        effective racket reach (also helps overheads)
//   reaction     AI reaction delay reduction / human assist window
//   volley/lob/smash/bandeja/vibora/defence  shot-family skill
//   consistency  unforced-error resistance (drives, serve)
//   aggression   AI shot selection bias toward winners
//   stamina      how slowly fatigue accrues
//   courtIQ      AI tactical quality (shot choice, positioning discipline)
// ============================================================================

export const ROSTER = [
  {
    id: 'toro',
    name: 'Tono "El Toro" Vidal',
    archetype: 'Power left-side smasher',
    side: 'left',
    height: 1.94, build: 1.18,           // model scale factors
    kit: { shirt: 0xc0392b, shorts: 0x1b1b1f, skin: 0xc98d5f },
    stats: {
      speed: 68, acceleration: 66, reach: 92, reaction: 74,
      volley: 78, lob: 58, smash: 96, bandeja: 82, vibora: 74,
      defence: 60, consistency: 62, aggression: 92, stamina: 72, courtIQ: 70,
    },
  },
  {
    id: 'mago',
    name: 'Rafa "El Mago" Serrano',
    archetype: 'Creative left-side attacker',
    side: 'left',
    height: 1.76, build: 0.95,
    kit: { shirt: 0x8e44ad, shorts: 0xf0f0f0, skin: 0xa9764c },
    stats: {
      speed: 82, acceleration: 88, reach: 74, reaction: 90,
      volley: 90, lob: 72, smash: 76, bandeja: 80, vibora: 95,
      defence: 68, consistency: 66, aggression: 86, stamina: 78, courtIQ: 88,
    },
  },
  {
    id: 'muro',
    name: 'Dani "El Muro" Ortega',
    archetype: 'Defensive right-side controller',
    side: 'right',
    height: 1.80, build: 1.0,
    kit: { shirt: 0x2471a3, shorts: 0x17202a, skin: 0xe0b089 },
    stats: {
      speed: 74, acceleration: 72, reach: 78, reaction: 84,
      volley: 76, lob: 94, smash: 58, bandeja: 78, vibora: 60,
      defence: 96, consistency: 94, aggression: 45, stamina: 90, courtIQ: 92,
    },
  },
  {
    id: 'rayo',
    name: 'Leo "El Rayo" Fuentes',
    archetype: 'Athletic all-court player',
    side: 'right',
    height: 1.84, build: 1.02,
    kit: { shirt: 0x1e8449, shorts: 0xf4f6f7, skin: 0x8d5a3a },
    stats: {
      speed: 93, acceleration: 90, reach: 80, reaction: 86,
      volley: 82, lob: 76, smash: 74, bandeja: 76, vibora: 70,
      defence: 82, consistency: 78, aggression: 68, stamina: 94, courtIQ: 80,
    },
  },
];

export const getArchetype = (id) => ROSTER.find((r) => r.id === id) || ROSTER[0];

// Default match line-up: human plays "El Rayo" (right) with "El Toro" as
// partner, against "El Mago" & "El Muro". Swappable from the start screen.
export const DEFAULT_LINEUP = {
  humanId: 'rayo',
  partnerId: 'toro',
  opponentIds: ['mago', 'muro'],
};
