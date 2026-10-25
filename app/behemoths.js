// Lantern Client - which behemoth is this, and what is its element. One place for every behemoth name the overlay
// shows. Licence: AGPL-3.0-only.
//
// In order of trust:
//   1. the name the running game shows for it (track field "da"/"dc"), if a game mod sends one. Mod 6.5-6.6 asked
//      ArchonBehemoth GetBehemothNameDataNative for it, which crashed hunt servers; from 6.7 nothing sends it;
//   2. the game's own row name for it (BehemothFullName, e.g. "beaver_alpha" for the mcbeaver_heroic class) and else
//      its class name, looked up in the game's kill tokens (TOKEN_KILL_COUNT_<CODE>_<VARIANT> "Kill Token: Ragetail");
//   3. variant names checked against two published sources each (VERIFIED, with the sources), for classes the kill
//      tokens do not cover;
//   4. the codename's name in the game's own item texts ("Torgadoro's Apex", "Thrax Hide", "Malkarion's Sight" ...:
//      a name used by 3+ of that codename's items), only for codenames with no kill token at all;
//   5. the species' name for a variant whose own name is not verified, logged once;
//   6. "Unidentified behemoth", logged once with its class and row name. A raw id is never shown.
// The kill tokens call Boreus by its codename, "Host" (its gear is "...of Boreus", its hide "Boreus Hide"): corrected.
'use strict';

const CODE_ALIAS = { MCBEAVER: 'BEAVER' };   // class word -> the codename the game's items use
const TOKEN_FIX = { HOST: [/\bHost\b/g, 'Boreus'] };
// element by codename (only where it is established); weak-to pairs as in Dauntless
const SPECIES_ELEMENT = {
  BEAVER: 'Neutral', BULLSEYE: 'Neutral', MOONFACE: 'Neutral', PAPER: 'Terra', ROCK: 'Terra', SCISSORS: 'Terra',
  LERAWR: 'Blaze', LAVAROLLER: 'Blaze', SALLY: 'Blaze', HOST: 'Frost', MCROLLIN: 'Frost', SNOWFLAKE: 'Frost',
  FULGAR: 'Shock', ELECTROQUILL: 'Shock', SHOCKMANE: 'Shock', CROWBEAR: 'Umbral', SHADOWCAT: 'Umbral',
  BUGBEAR: 'Radiant', SALT: 'Radiant',
};
const WEAK_TO = { Blaze: 'Frost', Frost: 'Blaze', Shock: 'Terra', Terra: 'Shock', Radiant: 'Umbral', Umbral: 'Radiant' };
const CLASS_ELEMENT = { frost: 'Frost', ice: 'Frost', blaze: 'Blaze', fire: 'Blaze', shock: 'Shock', terra: 'Terra', radiant: 'Radiant', umbral: 'Umbral' };
const VARIANTS = new Set(['alpha', 'beta', 'normal']);
const IGNORED = new Set(['new']);            // snowflake_normal_new: the remade Skraev, same behemoth
const PREFIXES = new Set(['sq', 'bp', 'ctor', 'tp', 'aq']);
// Escalation variants with no kill token. Each name is confirmed by two sources, and the class names the same thing.
//   Deepfrost Gnasher: Dauntless Wiki "Deepfrost Gnasher" (a Gnasher variant, Frost Escalation) / class mcbeaver_frost
//   Shadowtouched Drask: Dauntless Wiki island tables (Deepfrost Gnasher page) / class fulgar_umbral
//   Shadowtouched Koshai: TheSixthAxis, Dauntless 1.7.4 notes / class paper_umbral
//   Lightbound Boreus: Dauntless Wiki island tables / class host_radiant
//   Sporestruck Embermane, Sporestruck Charrogg: Two Average Gamers, "Terra Escalation: the Sporestruck behemoths" /
//     classes terramane_normal (Terra Embermane) and sq_sally_terrogg (Terra Charrogg)
const VERIFIED = {
  mcbeaver_frost: { name: 'Deepfrost Gnasher', element: 'Frost' },
  fulgar_umbral: { name: 'Shadowtouched Drask', element: 'Umbral' },
  paper_umbral: { name: 'Shadowtouched Koshai', element: 'Umbral' },
  host_radiant: { name: 'Lightbound Boreus', element: 'Radiant' },
  terramane_normal: { name: 'Sporestruck Embermane', element: 'Terra' },
  sally_terrogg: { name: 'Sporestruck Charrogg', element: 'Terra' },
};

// codename -> name, from the game's own item names: "Torgadoro's Apex" x7 -> ARMSTRONG: Torgadoro
function namesFromItems(items) {
  const counts = new Map();
  for (const it of items) {
    const id = String(it.id || ''), n = String(it.name || '');
    if (!n || n === id) continue;
    const m = /^(?:AR|WP_[A-Z]{2}|BREAK|PART_[A-Z]{2}_[A-Z]+)_([A-Z0-9]+)(?:_|$)/.exec(id);
    if (!m) continue;
    const code = m[1];
    const words = [...n.matchAll(/\b([A-Z][a-zü]{3,})'s\b/g), ...n.matchAll(/\bof ([A-Z][a-zü]{3,})\b/g), ...n.matchAll(/^([A-Z][a-zü]{3,}) (?:Hide|Leather|Scale|Chitin|Feather)$/g)].map((x) => x[1]);
    for (const w of new Set(words)) {
      const k = code + '|' + w;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  // behemoths only: a codename with breakable parts in the game's items (BREAK_ARMSTRONG_...). Gear sets such as
  // TRIALS ("Champion's ...") or SILVER ("Nikola's ...") have none, so they never name a behemoth
  const behemoth = new Set();
  for (const it of items) { const m = /^BREAK_([A-Z0-9]+)_/.exec(String(it.id || '')); if (m) behemoth.add(m[1]); }
  const best = new Map();
  for (const [k, c] of counts) {
    const [code, w] = k.split('|');
    if (!behemoth.has(code)) continue;
    if (c >= 3 && (!best.has(code) || c > best.get(code).c)) best.set(code, { w, c });
  }
  return new Map([...best].map(([code, v]) => [code, v.w]));
}

// "sq_ice_rock_bp_C" -> { code: 'ROCK', variant: 'NORMAL', extras: ['ice'], element: 'Frost', key: 'ice_rock' }
function parseClass(cls, known) {
  const words = String(cls || '').toLowerCase().replace(/_c$/, '').replace(/_bp$/, '').split('_').filter(Boolean);
  while (words.length > 1 && PREFIXES.has(words[0])) words.shift();
  const key = words.join('_');
  let code = null, at = -1;
  for (let i = 0; i < words.length; i++) {
    const w = words[i].toUpperCase(), c = CODE_ALIAS[w] || w;
    if (SPECIES_ELEMENT[c] || (known && known.has(c))) { code = c; at = i; break; }
  }
  let variant = 'NORMAL';
  const extras = [];
  words.forEach((w, i) => {
    if (i === at) return;
    if (VARIANTS.has(w)) variant = w.toUpperCase();
    else if (!IGNORED.has(w)) extras.push(w);
  });
  const element = extras.map((w) => CLASS_ELEMENT[w]).find(Boolean) || null;
  const unknownExtra = extras.some((w) => !CLASS_ELEMENT[w] && w !== 'heroic' && w !== 'dummy');
  return { code, variant, extras, element, unknownExtra, key, dummy: words[0] === 'dummy' };
}

// a name from the game that is a real name, not empty, "None" or an internal id
function textOk(n) {
  const s = String(n || '').trim();
  return s && s !== 'None' && !/_/.test(s) && !/^[a-z0-9]+$/.test(s) && !/^[A-Z0-9]+$/.test(s) ? s : null;
}

const logged = new Set();
// ctx: { gameRow, gameArch, gameClass, tokens: Map<'LERAWR_BETA','Rogue Embermane'>, codeNames: Map<'ARMSTRONG','Torgadoro'>, log }
function resolveBehemoth(cls, ctx = {}) {
  const { tokens, codeNames, log } = ctx;
  const tokenCodes = new Set(tokens ? [...tokens.keys()].map((k) => k.replace(/_(ALPHA|BETA|NORMAL)$/, '')) : []);
  const known = new Set([...tokenCodes, ...(codeNames ? codeNames.keys() : [])]);
  const pc = parseClass(cls, known);
  const row = ctx.gameRow ? parseClass(ctx.gameRow, known) : null;   // the game's own row name, read like a class
  const fix = (code, n) => { const f = code && TOKEN_FIX[code]; return f ? n.replace(f[0], f[1]) : n; };
  const once = (why) => { const k = cls + '|' + why; if (log && !logged.has(k)) { logged.add(k); log(`behemoth name: ${cls}${ctx.gameRow ? ` (game row ${ctx.gameRow})` : ''}: ${why}`); } };
  const elementOf = (p, extra) => extra || p.element || (p.code && !p.unknownExtra && SPECIES_ELEMENT[p.code]) || '';
  const out = (name, source, element) => ({ name, source, element: element || '', weak: WEAK_TO[element] || '' });
  const tok = (p) => (tokens && p && p.code && p.extras.length === 0 ? tokens.get(p.code + '_' + p.variant) : null);

  // 1. what the running game shows
  const arch = textOk(ctx.gameArch);
  if (arch) {
    const c = textOk(ctx.gameClass);
    const name = c && !CLASS_ELEMENT[c.toLowerCase()] && c !== 'Behemoth' && !arch.includes(c) ? `${c} ${arch}` : arch;
    return out(fix(pc.code, name), 'game', elementOf(pc, VERIFIED[pc.key] && VERIFIED[pc.key].element));
  }
  // 2. the game's row name, then the class, in the kill tokens
  for (const p of [row, pc]) {
    const t = tok(p);
    if (t) return out(fix(p.code, t), p === row ? 'game row' : 'token', elementOf(pc.extras.length ? pc : p));
  }
  // 3. verified variant names
  const v = VERIFIED[pc.key];
  if (v) return out(v.name, 'verified', v.element);
  // 4. the codename's name in the game's item texts (behemoths without a kill token)
  const code = (row && row.code) || pc.code;
  // (only for codenames with no kill token at all: for the others the item texts are gear-set words, "Inferno", "Stalker")
  if (code && !tokenCodes.has(code) && codeNames && codeNames.has(code) && pc.extras.length === 0) {
    return out(codeNames.get(code), 'items', elementOf(pc));
  }
  if (pc.dummy || (row && row.dummy)) { once('training dummy: no name from the game'); return out('Training dummy', 'dummy', ''); }
  // 5. the species' name for a variant that is not verified
  const base = code && ((tokens && tokens.get(code + '_NORMAL')) || (!tokenCodes.has(code) && codeNames && codeNames.get(code)));
  if (base) {
    once(`no verified name for this variant (${pc.extras.join(', ') || pc.variant.toLowerCase()}): its species' name is shown`);
    return out(fix(code, base), 'species', elementOf(pc));
  }
  // 6. not known
  once('unknown behemoth: no name from the game, its kill tokens, its items or a verified source');
  return out('Unidentified behemoth', 'unknown', elementOf(pc));
}

module.exports = { resolveBehemoth, parseClass, namesFromItems, VERIFIED, SPECIES_ELEMENT, WEAK_TO };
