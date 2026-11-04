// Lantern Client - the bounty picker: puts a bounty of your choice in a slot instead of the game's random draft.
// Licence: AGPL-3.0-only.
//
// The game rolls drafts itself and POSTs the pick to the backend as a bounty in a slot; the catalog of bounties is only
// inside the game's compressed paks. So the ids here are the ones seen in the package and in real saves and request logs
// (base:tiers, B bronze, S silver, G gold). The names are the game's text, Objectives_Generic::Objective_<base>.
'use strict';

const TIERS = { B: 'Bronze', S: 'Silver', G: 'Gold' };
const SLOTS = 4;   // max_slots in the game's bounty tuning
const LIST = `
  ASInterrupts:BGS AxeInterrupts:BGS BreakAllPartsKill:BGS DPInterrupts:BGS GatherCommon:BS GatherDamage:BGS
  GatherDefense:BS GatherHealing:BS GatherPylon:BS GatherSpecial:BS GatherSpeed:BS GatherWeapon:BS
  Gatherables:BGS GrenadeDamage:BGS GrenadeInterrupt:BS GrenadeInterrupts:G HammerBlastInterrupts:BGS
  HuntsASTwo:BGS HuntsAxeTwo:BGS HuntsChainbladesTwo:BGS HuntsDPTwo:BGS HuntsHammerTwo:BGS HuntsPikeTwo:BGS
  HuntsRepeatersTwo:B HuntsSwordTwo:BGS InterruptEnraged:BGS Interrupts:BGS KillASChain:BGS KillAxePike:BGS
  KillBlazeFrost:BGS KillBlazeWeapon:BGS KillChainPike:BGS KillFrostShock:BGS KillFrostWeapon:BGS
  KillHammerDP:BGS KillNeutralWeapon:BGS KillRadiant:BGS KillRadiantNeutral:BGS KillRadiantWeapon:BGS
  KillRage:BGS KillShockBlaze:BGS KillShockWeapon:BGS KillSwordAxe:BGS KillTerraShock:BGS KillTerraWeapon:BGS
  KillUmbral:BGS KillUmbralNeutral:BGS KillUmbralWeapon:BGS LanternDamage:BGS PartDamageEnraged:BGS
  PartDamageReduce:BGS PartsEnraged:BGS PerfectDodges:BGS PhysicalDodges:BGS PikeBlastInterrupts:BGS
  ProjectileDodges:BGS StaggerDamageEnraged:BGS StaggerDamageReduce:BGS StaggerEnraged:BGS SwordInterrupts:BGS
  WoundDamageEnraged:BGS WoundDamageReduce:BGS WoundEnraged:BGS
`.trim().split(/\s+/).flatMap((e) => {
  const [base, tiers] = e.split(':');
  return [...tiers].map((t) => ({ id: `Bounty_${TIERS[t]}_${base}`, base, tier: TIERS[t] }));
});
const IDS = new Set(LIST.map((b) => b.id));

const spaced = (base) => base.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
// -> [{ id, tier, name, what }]: name is the game's, what says what the id does (the game text has no description)
function catalog(text) {
  return LIST.map((b) => ({ id: b.id, tier: b.tier, name: (text && text.get(`Objectives_Generic::Objective_${b.base}`)) || spaced(b.base), what: spaced(b.base) }));
}
// the normal bounties in a player's slots (dailies and season challenges share the list and the slot numbers)
function slotsOf(player) {
  const list = (player && player.bounties && player.bounties.bounties) || [];
  return list.filter((b) => b && /^Bounty_/i.test(b.bounty_id) && !b.claimed).map((b) => ({ slot: b.slot_index, id: b.bounty_id, progress: (b.objectives && b.objectives[0] && b.objectives[0].progress) || 0 }));
}
// why this pick can't be made, or null
function invalid(player, id, slot) {
  if (!IDS.has(id)) return 'Unknown bounty.';
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOTS) return 'Unknown bounty slot.';
  const same = slotsOf(player).find((b) => b.id === id);
  if (same && same.slot !== slot) return `You already have that bounty in slot ${same.slot + 1}.`;
  if (same) return 'That bounty is already in that slot.';
  return null;
}
// the record the game itself POSTs for a drafted bounty
function record(id, slot, now = Date.now()) {
  return { bounty_id: id, premium_bounty: false, slot_index: slot, objectives: [{ objective_id: id, progress: 0 }], drafted_timestamp: new Date(now).toISOString(), update_version: 0, claimed: false };
}

module.exports = { catalog, slotsOf, invalid, record, SLOTS };
