// Lantern Client - which behemoth is this, and what is its element. One place for every behemoth name the overlay
// shows. Licence: AGPL-3.0-only.
//
// In order of trust:
//   1. the game's own name for that behemoth (ArchonBehemoth BehemothFullName, read by the game mod from 6.4): what the
//      game itself calls it, variants included (an Escalation variant, a training dummy...);
//   2. the game's kill tokens (TOKEN_KILL_COUNT_<SPECIES>_<VARIANT> "Kill Token: Rogue Embermane" in the 1.14.7
//      catalog), for the classes whose name is <species>_<alpha|beta|normal>. One correction: the tokens call Boreus by
//      its codename, "Host" (its gear is "...of Boreus", its hide "Boreus Hide"), so "Host" becomes "Boreus" there;
//   3. a class with something else after the species (an elemental Escalation variant such as mcbeaver_frost, a
//      Heroic class, sq_ice_rock...): its species' own name from the kill tokens. The variant's full name is not
//      guessed: until the game gives it, the base name is shown and the class is logged once as unresolved;
//   4. a species that is not known at all: "Behemoth", logged once. A raw class name is never shown.
'use strict';

// the species codes the game uses in its class names (and the code its kill tokens use, where they differ)
const SPECIES_ALIAS = { MCBEAVER: 'BEAVER' };
// the kill tokens' name for a species, corrected where the token holds a codename
const TOKEN_FIX = { HOST: [/\bHost\b/g, 'Boreus'] };
// element by species (variants keep it unless their class says otherwise); weak-to pairs as in Dauntless
const SPECIES_ELEMENT = {
  BEAVER: 'Neutral', BULLSEYE: 'Neutral', MOONFACE: 'Neutral', PAPER: 'Terra', ROCK: 'Terra', SCISSORS: 'Terra',
  LERAWR: 'Blaze', LAVAROLLER: 'Blaze', SALLY: 'Blaze', HOST: 'Frost', MCROLLIN: 'Frost', SNOWFLAKE: 'Frost',
  FULGAR: 'Shock', ELECTROQUILL: 'Shock', SHOCKMANE: 'Shock', CROWBEAR: 'Umbral', SHADOWCAT: 'Umbral',
  BUGBEAR: 'Radiant', SALT: 'Radiant',
};
const WEAK_TO = { Blaze: 'Frost', Frost: 'Blaze', Shock: 'Terra', Terra: 'Shock', Radiant: 'Umbral', Umbral: 'Radiant' };
// an element named in a class (mcbeaver_frost, fulgar_umbral, sq_ice_rock)
const CLASS_ELEMENT = { frost: 'Frost', ice: 'Frost', blaze: 'Blaze', fire: 'Blaze', shock: 'Shock', terra: 'Terra', radiant: 'Radiant', umbral: 'Umbral' };
const VARIANTS = new Set(['alpha', 'beta', 'normal']);
// words in a class that change nothing about which behemoth it is (snowflake_normal_new: the remade Skraev)
const IGNORED = new Set(['new']);
const PREFIXES = new Set(['sq', 'bp', 'ctor', 'tp']);

// "sq_ice_rock_bp_C" -> { species: 'ROCK', variant: 'NORMAL', extras: ['ice'], element: 'Frost' }
function parseClass(cls) {
  const words = String(cls || '').toLowerCase().replace(/_c$/, '').replace(/_bp$/, '').split('_').filter(Boolean);
  while (words.length && PREFIXES.has(words[0])) words.shift();
  let species = null, at = -1;
  for (let i = 0; i < words.length; i++) {
    const w = words[i].toUpperCase();
    if (SPECIES_ELEMENT[SPECIES_ALIAS[w] || w]) { species = SPECIES_ALIAS[w] || w; at = i; break; }
  }
  const rest = species ? words.filter((_, i) => i !== at) : words;
  let variant = 'NORMAL';
  const extras = [];
  for (const w of rest) {
    if (VARIANTS.has(w)) variant = w.toUpperCase();
    else if (!IGNORED.has(w)) extras.push(w);
  }
  const element = extras.map((w) => CLASS_ELEMENT[w]).find(Boolean) || null;
  // a word that is neither an element nor "heroic" (sq_sally_terrogg): a variant whose element is not known from here
  const unknownExtra = extras.some((w) => !CLASS_ELEMENT[w] && w !== 'heroic' && w !== 'dummy');
  return { species, variant, extras, element, unknownExtra, dummy: words[0] === 'dummy' };
}

// a name the game gave that is really a name (not empty, not "None", not an internal id)
function gameNameOk(n) {
  const s = String(n || '').trim();
  return s && s !== 'None' && !/_bp_c$|_c$/i.test(s) && !/^[a-z0-9_]+$|^[A-Z0-9_]+$/.test(s) ? s : null;
}

const logged = new Set();
// name: { tokens: Map<'LERAWR_BETA', 'Rogue Embermane'> } from the game catalog; log: where unresolved classes go
function resolveBehemoth(cls, { gameName, tokens, log } = {}) {
  const pc = parseClass(cls);
  // the element: named in the class, else the species' own, but not guessed for a variant the class does not explain
  const elementOf = () => pc.element || (pc.species && !pc.unknownExtra && SPECIES_ELEMENT[pc.species]) || '';
  const out = (name, source) => {
    const element = elementOf();
    return { name, source, element, weak: WEAK_TO[element] || '' };
  };
  const fixed = (n) => { const f = pc.species && TOKEN_FIX[pc.species]; return f ? n.replace(f[0], f[1]) : n; };
  const once = (why) => { const k = cls + why; if (log && !logged.has(k)) { logged.add(k); log(`behemoth name: ${cls}: ${why}`); } };

  const g = gameNameOk(gameName);
  if (g) return out(fixed(g), 'game');
  const tok = (v) => tokens && pc.species ? tokens.get(pc.species + '_' + v) : null;
  if (pc.species && pc.extras.length === 0) {
    const n = tok(pc.variant);
    if (n) return out(fixed(n), 'token');
  }
  if (pc.dummy) { once('training dummy without a name from the game'); return out('Training dummy', 'dummy'); }
  if (pc.species) {
    const base = tok('NORMAL');
    if (base) {
      once(`no verified name for this variant (${pc.extras.join(', ') || pc.variant.toLowerCase()}); its species' name is shown`);
      return out(fixed(base), 'species');
    }
  }
  once('unknown behemoth');
  return out('Behemoth', 'unknown');
}

module.exports = { resolveBehemoth, parseClass, SPECIES_ELEMENT, WEAK_TO };
