// Lantern Client - Meta Build Creator: is a loadout one the game lets you equip? Licence: AGPL-3.0-only.
//
// The rules, and where each comes from:
//   - one weapon of the chosen type, one helm, chest, arms and legs piece, one lantern, one Omnicell (the loadout);
//   - a cell goes only in a slot of its own type; a Prismatic slot takes any cell (Dauntless Builder's slot rules);
//   - perks count up to +6; more is wasted (Dauntless Builder warns above +6);
//   - legendary (bond) weapons bond with another weapon of the same type and element, never an Exotic, and take its
//     perks and effects (Official Dauntless Wiki, "Bond"; Dauntless Builder's bond check);
//   - weapon parts: Repeaters take a chamber, a grip and a mod; the others a special and a mod; some Exotics have their
//     own special (Dauntless Builder's part slots);
//   - at most one Exotic: none of the 500+ community meta builds uses two, and Lantern could not confirm the game
//     allows it, so it keeps to one (a precaution, said in the build's notes).
'use strict';
const { kb } = require('./data.js');

const ARMOUR_SLOTS = [['head', 'Head'], ['torso', 'Torso'], ['arms', 'Arms'], ['legs', 'Legs']];

function partKinds(type) {
  const p = kb().parts[type] || {};
  return Object.keys(p);   // e.g. ['chambers', 'grips', 'mods'] or ['mods', 'specials']
}

// perks of a build: { name: { level, sources: [..] } }
function perkTotals(b) {
  const K = kb(), out = {};
  const add = (perks, from) => { for (const [n, v] of Object.entries(perks || {})) { const e = out[n] || (out[n] = { level: 0, sources: [] }); e.level += v; e.sources.push({ from, value: v }); } };
  const w = K.weaponByName[b.weapon];
  if (w) add(w.perks, w.name);
  const bond = b.bond && K.weaponByName[b.bond];
  if (bond) add(bond.perks, bond.name + ' (bond)');
  for (const [k] of ARMOUR_SLOTS) { const a = K.armourByName[b[k]]; if (a) add(a.perks, a.name); }
  for (const c of [...(b.weaponCells || []), ...ARMOUR_SLOTS.map(([k]) => (b.cells || {})[k]), b.lanternCell]) {
    const v = c && K.cellVariant[c];
    if (v) add({ [v.perk]: v.value }, v.name);
  }
  return out;
}

function validate(b) {
  const K = kb(), errors = [], warnings = [], checks = [];
  const w = K.weaponByName[b.weapon];
  if (!w) errors.push('No weapon.');
  else if (b.weaponType && w.type !== b.weaponType) errors.push(`${w.name} is not ${b.weaponType}.`);
  checks.push('One weapon of your chosen type');
  for (const [k, slot] of ARMOUR_SLOTS) {
    const a = K.armourByName[b[k]];
    if (!a) errors.push(`No ${slot.toLowerCase()} armour.`);
    else if (a.empty) continue;
    else if (a.type !== slot) errors.push(`${a.name} is not a ${slot.toLowerCase()} piece.`);
  }
  checks.push('One helm, chest, arms and legs piece');
  // cells
  const fits = (slotType, variant) => {
    if (!variant) return true;
    const v = K.cellVariant[variant];
    return !!v && (slotType === 'Prismatic' || v.slot === slotType);
  };
  if (w) {
    if ((b.weaponCells || []).length > w.cells.length) errors.push(`${w.name} has ${w.cells.length} cell slot(s).`);
    (b.weaponCells || []).forEach((c, i) => { if (!fits(w.cells[i], c)) errors.push(`${c} does not fit ${w.name}'s ${w.cells[i]} slot.`); });
  }
  for (const [k] of ARMOUR_SLOTS) {
    const a = K.armourByName[b[k]], c = (b.cells || {})[k];
    if (a && c && !a.cells.length) errors.push(`${a.name} has no cell slot.`);
    else if (a && c && !fits(a.cells[0], c)) errors.push(`${c} does not fit ${a.name}'s ${a.cells[0]} slot.`);
  }
  const l = K.lanternByName[b.lantern];
  if (!l) errors.push('No lantern.');
  else if (b.lanternCell && (!l.cells.length || !fits(l.cells[0], b.lanternCell))) errors.push(`${b.lanternCell} does not fit ${l.name}.`);
  checks.push('Every cell in a slot of its own type (Prismatic takes any)');
  // exotics
  const exotics = [w, ...ARMOUR_SLOTS.map(([k]) => K.armourByName[b[k]])].filter((x) => x && x.exotic);
  if (exotics.length > 1) errors.push(`More than one Exotic (${exotics.map((x) => x.name).join(', ')}).`);
  checks.push('At most one Exotic');
  // bond
  if (b.bond) {
    const bw = K.weaponByName[b.bond];
    if (!w || !w.bond) errors.push(`${w ? w.name : 'This weapon'} cannot bond.`);
    else if (!bw) errors.push('Unknown bond weapon.');
    else {
      if (bw.type !== w.type) errors.push(`${bw.name} is not ${w.type}.`);
      if (bw.element !== w.bond) errors.push(`${w.name} bonds only with ${w.bond} weapons.`);
      if (bw.exotic) errors.push('Exotics cannot be bonded.');
      if (bw.bond) errors.push('A legendary weapon cannot be bonded.');
    }
    checks.push('Bond: same type and element, no Exotic');
  }
  // parts
  if (w) {
    const kinds = partKinds(w.type), parts = b.parts || {};
    for (const [kind, name] of Object.entries(parts)) {
      if (!name) continue;
      if (!kinds.includes(kind)) errors.push(`${w.type} has no ${kind.replace(/s$/, '')} slot.`);
      else if (!K.parts[w.type][kind].some((p) => p.name === name)) errors.push(`${name} is not a ${w.type} ${kind.replace(/s$/, '')}.`);
      if (kind === 'specials' && w.restrictSpecials) errors.push(`${w.name} has its own special.`);
    }
    checks.push(`${w.type} parts in their own slots`);
  }
  if (!K.omnicellByName[b.omnicell]) errors.push('No Omnicell.');
  // perk cap
  for (const [n, p] of Object.entries(perkTotals(b))) if (p.level > 6) warnings.push(`${n} reaches +${p.level}: only +6 counts.`);
  checks.push('Perks count up to +6');
  // in the game
  const notNamed = [w, b.bond && K.weaponByName[b.bond], ...ARMOUR_SLOTS.map(([k]) => K.armourByName[b[k]])].filter((x) => x && x.exists === 'inferred');
  checks.push('Every item is in Dauntless 1.14.7');
  return { ok: !errors.length, errors, warnings, checks, inferred: notNamed.map((x) => x.name) };
}

module.exports = { validate, perkTotals, partKinds, ARMOUR_SLOTS };
