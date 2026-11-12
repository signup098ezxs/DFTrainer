// Lantern Client - every stacked item in the 1.14.7 catalog that has no other place in the panel. Licence: AGPL-3.0-only.
//
// The Inventory picker (tools\gear-1147.json) holds every piece of gear and every cosmetic; the Currencies page's own
// list (items.json) and the Cells page hold the main currencies and every +1/+2/+3 cell. What is left of the game's
// catalog (tools\catalog-1147.json, the same 5,798 entries as items.dauntlessforever.com for 1.14.7) is counted
// ("stack") items: behemoth parts, currencies and tokens, quest and rumour tokens, curiosities (charges), ores and the
// like. They are set with the same "set" action the Currencies page uses, so they work offline and while you play.
// Left out on purpose: one-of-a-kind ("instance") entries that are not in the picker. Those are the game's break and
// kill records (BREAK_*_BROKEN, _KILL, _BONUSBREAKROLL), loot bundles and cores, baits, flasks and a few contract
// tokens: the package's tools refuse them too, and a wrong one could break a save. So are cosmetics outside the picker.
'use strict';

const KINDS = ['Behemoth parts', 'Currencies', 'Tokens', 'Quest and rumour tokens', 'Curiosities', 'Other materials', 'Other cells'];
// do-not-use, test, debug and placeholder rows: hidden unless "Unnamed and test items" is on
const TEST = /~DNT~|\bDNT\b|DON'?T USE|DO NOT USE|(^|[\s_[])(TEST|DEBUG|WIP|TEMP)([\s_\]]|$)/i;

function kindOf(i) {
  const id = i.id;
  if (i.group === 'Cells') return 'Other cells';   // Repeater mods (CELL_DP_*) and the lantern tracking cell: not checked in game
  if (i.group === 'Curiosities') return 'Curiosities';
  if (id.startsWith('BREAK_')) return 'Behemoth parts';
  if (id.startsWith('CURRENCY_')) return 'Currencies';
  if (id.startsWith('TOKEN_')) return i.group === 'Currencies and tokens' ? 'Tokens' : 'Quest and rumour tokens';
  return 'Other materials';
}
// a name from the id, the way the package's picker guesses one (BREAK_BEAVER_HIDE -> "Break Beaver Hide")
const guess = (id) => id.toLowerCase().split('_').filter(Boolean).join(' ').replace(/[a-z]+/g, (w, at, s) => (at && /[a-z]/.test(s[at - 1]) ? w : w[0].toUpperCase() + w.slice(1)));

// full: catalog-1147.json items; names: Map id -> known name; skip: Set of ids shown elsewhere (picker, Currencies, Cells)
// -> { kinds, items: [[id, name, kind, unnamed 0|1, test 0|1]] } sorted by kind, then name
function build(full, names, skip) {
  const items = [];
  for (const i of full) {
    // cosmetics outside the picker are do-not-use and test rows (~DNT~ dyes, test emotes): unlocks, never counts
    if (!i || i.storage !== 'stack' || i.cosmetic || skip.has(i.id) || !/^[A-Z0-9_]{3,80}$/.test(i.id)) continue;
    const name = names.get(i.id), kind = kindOf(i);
    const test = TEST.test(i.id) || TEST.test(name || '') || kind === 'Other cells' ? 1 : 0;
    items.push([i.id, name || guess(i.id), kind, name ? 0 : 1, test]);
  }
  const at = new Map(KINDS.map((k, n) => [k, n]));
  items.sort((a, b) => at.get(a[2]) - at.get(b[2]) || a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
  return { kinds: KINDS.filter((k) => items.some((x) => x[2] === k)), items };
}

module.exports = { build, guess, kindOf, KINDS, TEST };
