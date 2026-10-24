// Lantern Client - what "Remove items" must never take away. Licence: AGPL-3.0-only.
//
// Anything a character is using: its loadouts (weapons, armour, lantern, and the transmogs, dyes, parts and cells
// written inside them), its character data (emote wheel, banner, title, flare and other picks) and anything another
// kept item refers to (a dye or skin stored on a weapon). Matching is by whole id token, so ids nested inside escaped
// JSON strings count too. The starter sword and lantern are always kept: the backend needs them to spawn you.
'use strict';
const STARTER = ['WP_EB_TRAINING', 'LT_BASIC'];

function protectedIds(player, charId) {
  const parts = [];
  const lo = player && player.loadouts && player.loadouts[charId];
  if (lo) parts.push(JSON.stringify(lo));
  if (player && player.loadoutSlots1147) parts.push(JSON.stringify(player.loadoutSlots1147[charId] || player.loadoutSlots1147));
  const ch = ((player && player.characters) || []).find((c) => c && c.id === charId);
  if (ch && ch.data) parts.push(typeof ch.data === 'string' ? ch.data : JSON.stringify(ch.data));
  const inv = player && player.inventory && player.inventory[charId];
  for (const i of (inv && inv.instancedItems) || []) {
    if (!i) continue;
    const { catalogId, instanceId, updateVersion, ...rest } = i;   // what the item carries, not its own id
    if (Object.keys(rest).length) parts.push(JSON.stringify(rest));
  }
  const ids = new Set(STARTER);
  for (const p of parts) for (const t of p.match(/[A-Za-z0-9_-]{3,}/g) || []) ids.add(t);
  return ids;
}

module.exports = { protectedIds, STARTER };
