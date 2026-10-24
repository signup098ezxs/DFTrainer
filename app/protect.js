// Lantern Client - what "Remove items" must never take away. Licence: AGPL-3.0-only.
//
// Anything a character is using: its loadouts (weapons, armour, lantern, and the transmogs, dyes, parts and cells
// written inside them), its character data (emote wheel, banner, title, flare and other picks) and anything another
// kept item refers to (a dye or skin stored on a weapon). Matching is by whole id token, so ids nested inside escaped
// JSON strings count too.
//
// Failsafe: everything a new 1.14.7 character starts with is always kept, in use or not, so "remove everything"
// still leaves a character that can spawn and dress (the backend's default loadout and persistent picks in
// backend\recorder-1147.js, and the starting inventory of a new character), plus anything whose id marks it as
// starter or default kit (BEGINNER, STARTER, TRAINING, _DEFAULT, _BASIC).
'use strict';
const STARTER = [
  // default loadout: weapon, armour, lantern, flask, glider
  'WP_EB_TRAINING', 'WP_EB_BEGINNER', 'PART_EB_SPECIAL_DEFAULT', 'AR_UNEQUIPPED_HELM', 'AR_BEGINNER_CHEST', 'AR_BEGINNER_ARMS',
  'AR_BEGINNER_LEGS', 'LT_BASIC', 'FL_HEALING_DEFAULT', 'GD_FRAME_STARTER_BASE',
  // default banner, flare, emotes, title, dyes and emojis
  'BN_BEGINNER_00', 'BNC_MESH_BEGINNER_00', 'BNC_FABRIC_BEGINNER_00', 'BNC_SIGIL_BEGINNER_00', 'BNC_VFX_BEGINNER_00',
  'BNC_ANIMATION_BEGINNER_00', 'QI_BASIC_FLARE_DURABLE', 'EM_INTRO_BEGINNER_01', 'EM_END_BEGINNER_01', 'EM_PLAYER_BEGINNER_01',
  'EM_PLAYER_BEGINNER_02', 'EM_PLAYER_BEGINNER_03', 'EM_PLAYER_BEGINNER_04', 'EM_INTRO_GENERIC_001', 'EM_INTRO_GENERIC_002',
  'EM_INTRO_GENERIC_003', 'TITLE_BLANK', 'DYE_GREEN04_DURABLE', 'DYE_BROWN07_DURABLE', 'EJ_SYSTEM_TYPING', 'EJ_PLAYER_BOSUN_JOY',
  'EJ_PLAYER_KAT_PRAY', 'EJ_PLAYER_MOYRA_MUSCLE', 'EJ_PLAYER_GREGARIO_QUESTION', 'EJ_PLAYER_MIDDLEMAN_HMM',
  'EJ_PLAYER_PRIYANI_WINK', 'EJ_PLAYER_ZAI_ANGRY', 'EJ_PLAYER_ZAI_SWEAT',
];
const STARTER_SET = new Set(STARTER);
const isStarter = (id) => STARTER_SET.has(id) || /BEGINNER|STARTER|TRAINING|_DEFAULT(_|$)|_BASIC(_|$)/.test(String(id || ''));

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

module.exports = { protectedIds, isStarter, STARTER };
