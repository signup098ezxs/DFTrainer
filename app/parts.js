// Lantern Client - "Parts": the behemoth parts for the gear a character has equipped. Licence: AGPL-3.0-only.
//
// What is equipped: players.<you>.loadouts.<character>.loadouts[active_index] in the save (data\state.json): its
// weapon, helmet, chest, arms and legs. The lantern, flask and everything else are left out (armour and weapons only).
// Which behemoth a piece comes from: its codename, AR_<CODE>_<SLOT> or WP_<XX>_<CODE> (AR_CROWBEAR_HELM, WP_AC_THUNDERBIRD).
// A codename with no parts of its own falls back to its species (FULGAR_ALPHA -> FULGAR, BUGBEAR_EXOTIC -> BUGBEAR).
// Gear from no behemoth (exotics such as WP_DP_EXOTIC_BOMBS, event and trial sets) has no parts and is shown as such.
// The parts: the game's counted break items for that codename, BREAK_<CODE>_<PART> (BREAK_CROWBEAR_WING), including its
// rare and epic part (_RARE, _EPIC). Left out: parts of escalation variants (BREAK_FULGAR_UMBRAL_LEG,
// BREAK_BEAVER_BLAZE_LEG, BREAK_SALLY_TERROGG_LEG), the one-of-a-kind break records (..._BROKEN, ..._KILL, bundles),
// and every other material (ores, currencies, cells): parts only.
'use strict';

const MAX_EACH = 90;
const SLOTS = [['weapon', 'Weapon'], ['helmet', 'Head'], ['chest', 'Torso'], ['arms', 'Arms'], ['legs', 'Legs']];
const VARIANT_PART = /^(BLAZE|UMBRAL|FROST|TERROGG|SHOCK|TERRA|RADIANT)_/;

function codeOf(id) {
  const s = String(id || '');
  const m = /^AR_([A-Z0-9_]+?)_(HELM|CHEST|ARMS|LEGS)$/.exec(s) || /^WP_[A-Z]{2}_([A-Z0-9_]+)$/.exec(s);
  return m ? m[1] : null;
}

// every counted behemoth part in the catalog, by codename: Map CODE -> [ids]
// storage / groupOf: Maps id -> 's'|'i' and id -> group (the panel's catalog)
function partIndex(storage, groupOf) {
  const ids = [];
  for (const [id, st] of storage) if (st === 's' && /^BREAK_[A-Z0-9_]+$/.test(id) && (!groupOf || groupOf.get(id) === 'Consumables and materials')) ids.push(id);
  return ids;
}
function partsForCode(code, ids) {
  if (!code) return { code: null, parts: [] };
  const words = code.split('_');
  for (let n = words.length; n >= 1; n--) {
    const c = words.slice(0, n).join('_'), pre = `BREAK_${c}_`;
    const got = ids.filter((id) => id.startsWith(pre) && !VARIANT_PART.test(id.slice(pre.length)));
    if (got.length) return { code: c, parts: got.sort() };
  }
  return { code: null, parts: [] };
}

function activeLoadout(player, charId) {
  const lo = player && player.loadouts && player.loadouts[charId];
  const list = (lo && Array.isArray(lo.loadouts)) ? lo.loadouts : [];
  if (!list.length) return null;
  const i = Number.isInteger(lo.active_index) ? lo.active_index : 0;
  return list.find((l) => l && l.slot_index === i) || list[i] || list[0];
}

// -> { slots: [{ slot, label, id, code, parts: [ids] }], parts: [unique ids] } or null with no loadout
function equippedParts(player, charId, storage, groupOf) {
  const lo = activeLoadout(player, charId);
  if (!lo) return null;
  const ids = partIndex(storage, groupOf);
  const slots = [], all = new Set();
  for (const [k, label] of SLOTS) {
    const v = lo[k], id = v && typeof v === 'object' ? v.instance_id : v;
    if (!id) continue;
    const r = partsForCode(codeOf(id), ids);
    slots.push({ slot: k, label, id, code: r.code, parts: r.parts });
    r.parts.forEach((p) => all.add(p));
  }
  return { slots, parts: [...all] };
}

const clampAmount = (n) => Math.max(1, Math.min(MAX_EACH, Math.floor(Number(n)) || MAX_EACH));

module.exports = { equippedParts, partsForCode, partIndex, codeOf, clampAmount, MAX_EACH };
