// Lantern Client - Meta Build Creator: the researched data, loaded once and indexed. Licence: AGPL-3.0-only.
//
// kb-1147.json is made by tools/builds-kb.py from the community Dauntless Builder data (pre-Awakening, Dauntless
// 1.14.6; 1.14.7 changed no gear numbers) and the community "Dauntless Meta Builds" spreadsheet, each item checked
// against the game's own 1.14.7 catalog. Nothing here is looked up on the internet while the app runs.
'use strict';
const fs = require('fs');
const path = require('path');

let KB = null;
function kb() {
  if (KB) return KB;
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'kb-1147.json'), 'utf8'));
  const usable = (x) => x.exists === 'yes' || x.exists === 'inferred';
  const weapons = raw.weapons.filter(usable);
  const armours = raw.armours.filter((a) => usable(a) && (a.cells.length || Object.keys(a.perks).length));
  const bySlot = { Head: [], Torso: [], Arms: [], Legs: [] };
  for (const a of armours) bySlot[a.type] && bySlot[a.type].push(a);
  // for "only gear I own": every piece the player may own (Recruit's included), and an empty slot when they own none
  // (the game's own default loadout has no helm: AR_UNEQUIPPED_HELM)
  const ownedBySlot = { Head: [], Torso: [], Arms: [], Legs: [] };
  for (const a of raw.armours) if (usable(a) && a.id && ownedBySlot[a.type]) ownedBySlot[a.type].push(a);
  const unequipped = {};
  for (const [slot, code] of [['Head', 'HELM'], ['Torso', 'CHEST'], ['Arms', 'ARMS'], ['Legs', 'LEGS']]) {
    unequipped[slot] = { name: `Nothing (${slot === 'Torso' ? 'chest' : slot.toLowerCase()} slot empty)`, type: slot, behemoth: null, element: null, weakness: null,
      cells: [], perks: {}, effects: [], exotic: false, exists: 'yes', id: 'AR_UNEQUIPPED_' + code, empty: true };
  }
  // every cell slot type -> the strongest variant of each cell that fits it (the +3 one), and Prismatic takes any
  const cellsBySlot = {};
  const cellVariant = {};   // "+3 Rage Cell" -> { cell, perk, value, id, exists }
  const bestCells = [];
  for (const [name, c] of Object.entries(raw.cells)) {
    let best = null;
    for (const [vname, v] of Object.entries(c.variants)) {
      cellVariant[vname] = { cell: name, slot: c.slot, ...v, name: vname };
      if (usable(v) && (!best || v.value > best.value)) best = { ...cellVariant[vname] };
    }
    if (best) { bestCells.push(best); (cellsBySlot[c.slot] = cellsBySlot[c.slot] || []).push(best); }
  }
  cellsBySlot.Prismatic = bestCells;
  // behemoths and their elements (an armour set's element is its behemoth's)
  const behemoths = {};
  for (const a of raw.armours) if (a.behemoth && a.element && !behemoths[a.behemoth]) behemoths[a.behemoth] = a.element;
  for (const b of ['Gnasher', 'Quillshot', 'Shrike']) if (!behemoths[b]) behemoths[b] = 'Neutral';
  const weakTo = {};
  for (const a of raw.armours) if (a.element && a.weakness) weakTo[a.element] = a.weakness;
  KB = {
    raw, about: raw.about, perks: raw.perks, weapons, armours, bySlot, ownedBySlot, unequipped, cellsBySlot, cellVariant,
    lanterns: raw.lanterns.filter((l) => usable(l) && l.name !== "Recruit's Lantern"),
    omnicells: raw.omnicells.filter(usable), parts: raw.parts, metaBuilds: raw.metaBuilds,
    weaponByName: Object.fromEntries(raw.weapons.map((w) => [w.name, w])),
    armourByName: Object.fromEntries([...raw.armours, ...Object.values(unequipped)].map((a) => [a.name, a])),
    lanternByName: Object.fromEntries(raw.lanterns.map((l) => [l.name, l])),
    omnicellByName: Object.fromEntries(raw.omnicells.map((o) => [o.name, o])),
    behemoths, weakTo, weaponTypes: [...new Set(weapons.map((w) => w.type))].sort(),
  };
  return KB;
}

// the perk's effect at a level (1-6; above 6 the +6 effect: the game stops there)
function perkEffect(name, level) {
  const p = kb().perks[name];
  if (!p || level < 1) return '';
  return sentences(p.effects[String(Math.min(6, level))] || p.description || '');
}
// the data runs some perks' two effects together ("+30% part damage After dodging..."): a full stop between them
const STARTERS = 'After|On|While|When|Every|If|Immune|Prevents|Gain|Increases|Stacks|Enter|Ranged|Half|Interrupting|Your|Else|Once|Losing';
function sentences(t) { return String(t).replace(new RegExp(`([a-z0-9%)])\\s+(${STARTERS})\\b`, 'g'), '$1. $2'); }

module.exports = { kb, perkEffect };
