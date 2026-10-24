// Lantern Client - Meta Build Creator: what each goal values. Licence: AGPL-3.0-only.
//
// These weights are Lantern's own reading of each perk's in-game text (kb-1147.json), not numbers from the game: how
// directly a perk serves a goal (1 = it is what the goal is about, lower = it helps, negative = it works against it).
// The UI says so. Perks only count up to +6 (the game's cap), with the +6 tier worth a little more because most perks
// add a second effect there.
'use strict';

const GOALS = {
  crit: { label: 'Critical damage', short: 'Crit', blurb: 'Crit chance and crit damage on every hit.',
    perks: { Cunning: 1, Pulse: 0.9, Galvanized: 0.6, Impulse: 0.55, Inertia: 0.3 } },
  parts: { label: 'Part breaking', short: 'Part breaker', blurb: 'Break heads, tails and legs fast for more loot and openings.',
    perks: { Sharpened: 1, Bladestorm: 1, Recycle: 0.5, "Assassin's Frenzy": 0.4, Reuse: 0.25, Acidic: -0.8 } },
  stagger: { label: 'Stagger damage', short: 'Staggerer', blurb: 'Knock the behemoth down often, then punish it.',
    perks: { 'Knockout King': 1, 'Weighted Strikes': 1, Pacifier: 0.55, Stop: 0.5, Overpower: 0.35, Roll: 0.2 } },
  survival: { label: 'Survival', short: 'Survivor', blurb: 'More health, more dodge time, fewer knockouts.',
    perks: { Tough: 1, 'Nine Lives': 0.9, Evasion: 0.85, Water: 0.8, Fortress: 0.6, Parasitic: 0.6, Aegis: 0.5, Sturdy: 0.5,
      "Assassin's Vigour": 0.4, 'Stunning Vigour': 0.35, Vampiric: 0.35, Strategist: 0.3, Berserker: -0.8, Fire: -0.6 } },
  stamina: { label: 'Stamina efficiency', short: 'Tireless', blurb: 'Dodge and sprint more without running dry.',
    perks: { Conditioning: 1, Agility: 1, Nimble: 0.9, Endurance: 0.7, Roll: 0.5, Rushdown: 0.4 } },
  speed: { label: 'Attack speed', short: 'Swift', blurb: 'Faster swings and shots.',
    perks: { 'Evasive Fury': 1, "Assassin's Frenzy": 0.6, Fire: 0.6, Conduit: 0.5, Reuse: 0.4, Grace: 0.35, Reduce: -1 } },
  sustained: { label: 'Sustained damage', short: 'Relentless', blurb: 'High damage kept up for the whole hunt.',
    perks: { Berserker: 0.9, Tenacious: 0.8, Recycle: 0.8, Cunning: 0.6, Predator: 0.6, 'Evasive Fury': 0.5, Adrenaline: 0.45,
      Overpower: 0.45, Ragehunter: 0.45, Rage: 0.35, Energized: 0.3 } },
  burst: { label: 'Burst damage', short: 'Burst', blurb: 'Huge damage in short windows (staggers, openings).',
    perks: { Overpower: 1, Predator: 0.8, Reduce: 0.7, Ragehunter: 0.6, Cunning: 0.5, Adrenaline: 0.4, Rage: 0.3 } },
  elemental: { label: 'Elemental effectiveness', short: 'Elemental', blurb: 'The element your target is weak to, and armour that resists its element.',
    perks: {} },
  wound: { label: 'Wound damage', short: 'Wounder', blurb: 'Wound parts and hit wounded parts harder.',
    perks: { Acidic: 1, Barbed: 1, Savagery: 0.8, Merciless: 0.7, Tactician: 0.5, Vampiric: 0.2 } },
  team: { label: 'Team support', short: 'Support', blurb: 'Shields, heals and buffs for your party.',
    perks: { Guardian: 0.8, Strategist: 0.8, Conduit: 0.7, Mender: 0.7, Medic: 0.6, Tactician: 0.6, Reuse: 0.6, Cascade: 0.4, Swift: 0.3 } },
};
// how much each goal counts by its place in the player's order
const PRIORITY = [1, 0.7, 0.5, 0.38, 0.3, 0.25];

// perks with a real cost (less health, self-damage, slower attacks): left out when the player wants a safe build
const RISKY = { Berserker: 'lowers your max health', Fire: 'hurts you on every hit', Reduce: 'slows your attacks', Drop: 'caps how much stamina comes back' };
// perks that only pay off in some content
const SITUATIONAL = {
  'Pack Hunter': 'escalation', 'Pack Caller': 'escalation', 'Pack Walker': 'escalation', Aetherhunter: 'escalation',
  Deconstruction: 'escalation',
};
// immunities worth a little against a target of that element (their own text says what they stop)
const IMMUNITY = { Blaze: 'Fireproof', Frost: 'Warmth', Shock: 'Insulated' };

// pairs that help each other or clash (both perks at +3 or more)
const PAIRS = [
  { a: 'Tenacious', b: 'Tough', v: 0.15, why: 'Tenacious scales with current health, which Tough raises' },
  { a: 'Tenacious', b: 'Berserker', v: -0.3, why: 'Berserker lowers the max health that Tenacious feeds on' },
  { a: 'Galvanized', b: 'Aegis', v: 0.15, why: 'Galvanized turns shields into crit chance, and Aegis increases shields' },
  { a: 'Galvanized', b: 'Fortress', v: 0.1, why: 'Fortress keeps a shield up for Galvanized' },
  { a: 'Overpower', b: 'Knockout King', v: 0.15, why: 'more staggers means more time with Overpower active' },
  { a: 'Overpower', b: 'Weighted Strikes', v: 0.15, why: 'more staggers means more time with Overpower active' },
  { a: 'Predator', b: 'Evasion', v: 0.1, why: 'longer dodge invulnerability helps keep Predator from being lost' },
  { a: 'Savagery', b: 'Acidic', v: 0.15, why: 'Acidic wounds parts, Savagery hits wounded parts harder' },
  { a: 'Savagery', b: 'Barbed', v: 0.1, why: 'Barbed wounds parts, Savagery hits wounded parts harder' },
  { a: 'Adrenaline', b: 'Conditioning', v: -0.1, why: 'Adrenaline wants stamina missing, Conditioning refills it' },
];

// Omnicells: which goals each one's own passive and active serve (from their in-game text in kb-1147.json, and the
// community meta sheet's description of each); "risk" when the sheet calls it high-risk.
const OMNICELLS = {
  Discipline: { goals: { crit: 1, burst: 0.6, sustained: 0.3 }, risk: true },
  Revenant: { goals: { sustained: 1, burst: 0.7 }, risk: true },
  Tempest: { goals: { speed: 1, parts: 0.8, sustained: 0.5, stamina: 0.2 } },
  Bastion: { goals: { survival: 1, team: 0.4, burst: 0.3 } },
  Artificer: { goals: { team: 1, survival: 0.5, parts: 0.3 } },
  Iceborne: { goals: { survival: 0.9, sustained: 0.3 } },
};
// lanterns: what their hold ability does (their in-game text)
const LANTERNS = {
  "Shrike's Zeal": { goals: { speed: 0.9, team: 0.6, sustained: 0.3 } },
  "Skarn's Defiance": { goals: { survival: 0.8, team: 0.2, sustained: 0.3 } },
  "Koshai's Bloom": { goals: { survival: 0.6, burst: 0.4 } },
  "Embermane's Rapture": { goals: { burst: 0.7, elemental: 0.3, stagger: 0.2 } },
  "Pangar's Shine": { goals: { sustained: 0.5, elemental: 0.3 } },
  "Drask's Eye": { goals: { burst: 0.5, elemental: 0.3 } },
  'Broadsides Lantern': { goals: { burst: 0.7, stagger: 0.3 } },
};

// weapon and armour unique effects, read by what they mention
const EFFECT_WORDS = [
  [/part damage|break/i, 'parts'], [/stagger/i, 'stagger'], [/critical/i, 'crit'], [/wound/i, 'wound'], [/attack speed/i, 'speed'],
  [/stamina/i, 'stamina'], [/health|heal|shield|damage taken|lifesteal/i, 'survival'], [/allies|all slayers|nearby slayers/i, 'team'],
  [/damage/i, 'sustained'],
];

module.exports = { GOALS, PRIORITY, RISKY, SITUATIONAL, IMMUNITY, PAIRS, OMNICELLS, LANTERNS, EFFECT_WORDS };
