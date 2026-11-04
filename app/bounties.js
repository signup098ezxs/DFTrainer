// Lantern Client - the Bounties tab: what each bounty asks and pays, and a bounty of your choice in a slot instead of
// the game's random draft. Licence: AGPL-3.0-only.
//
// The game's bounty table is only inside its compressed paks, so this file holds what could be learned without it:
//   ids       seen in the package, saves and request logs (base:tiers, B bronze, S silver, G gold)
//   names     the game's text, Objectives_Generic::Objective_<base>; its descriptions have no key tying them to a bounty,
//             so DESCRIPTIONS is written from the ids in the wording of the game's objective texts
//   GOALS     progress at the moment of 187 real claims, damage rounded down to the thousand; "~" = worked out from the
//             base's or a like base's other tiers (they go 2:3:4), not seen. Bases not listed have no known goal
//   REWARDS   the grants the game made at those claims (POST /progression/.../season<N>/<xp>, ExperienceTrack_Weapon_<equipped>,
//             CURRENCY_PJM_WEAPON); the same for every bounty of a tier. Near max level the weapon gets only what it can take.
'use strict';

const TIERS = { B: 'Bronze', S: 'Silver', G: 'Gold' };
const SLOTS = 4;   // max_slots in the game's bounty tuning
const WEAPONS = { AS: 'Aether Strikers', Axe: 'Axe', Chain: 'Chain Blades', Chainblades: 'Chain Blades', DP: 'Ostian Repeaters', Hammer: 'War Hammer', Pike: 'War Pike', Sword: 'Sword' };
const REWARDS = { Bronze: { pass: 25, weapon: 250, merits: 15 }, Silver: { pass: 45, weapon: 450, merits: 25 }, Gold: { pass: 70, weapon: 700, merits: 40 } };
const LIST = `
  ASInterrupts:BGS AxeInterrupts:BGS BreakAllPartsKill:BGS DPInterrupts:BGS GatherCommon:BS GatherDamage:BGS
  GatherDefense:BS GatherHealing:BS GatherPylon:BS GatherSpecial:BS GatherSpeed:BS GatherWeapon:BS
  Gatherables:BGS GrenadeDamage:BGS GrenadeInterrupt:BS GrenadeInterrupts:G HammerBlastInterrupts:BGS
  HuntsASTwo:BGS HuntsAxeTwo:BGS HuntsChainbladesTwo:BGS HuntsDPTwo:BGS HuntsHammerTwo:BGS HuntsPikeTwo:BGS
  HuntsSwordTwo:BGS InterruptEnraged:BGS Interrupts:BGS KillASChain:BGS KillAxePike:BGS
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
const BY_ID = new Map(LIST.map((b) => [b.id, b]));

// bronze silver gold; - unknown
const GOALS = {
  BreakAllPartsKill: '- 2 -', DPInterrupts: '- 3 -', Interrupts: '- 12 -', KillTerraShock: '- 9 -', PartsEnraged: '- 6 -',
  HuntsASTwo: '~8 12 16', HuntsAxeTwo: '~8 12 ~16', HuntsChainbladesTwo: '8 12 16', HuntsDPTwo: '8 ~12 ~16', HuntsHammerTwo: '~8 ~12 ~16', HuntsPikeTwo: '~8 ~12 16', HuntsSwordTwo: '~8 12 16',
  KillASChain: '3 ~4 6', KillAxePike: '3 4 ~6', KillChainPike: '3 4 6', KillHammerDP: '~3 4 ~6', KillSwordAxe: '~3 4 ~6', KillRage: '3 4 ~6',
  KillShockWeapon: '4 6 ~8', KillUmbralWeapon: '2 3 4',
  PartDamageEnraged: '~15000 22000 ~30000', PartDamageReduce: '60000 90000 120000',
  StaggerDamageEnraged: '~15000 22000 30000', StaggerDamageReduce: '~40000 60000 80000', StaggerEnraged: '~1 2 3',
  WoundDamageEnraged: '15000 ~22000 ~30000', WoundDamageReduce: '40000 60000 ~80000',
  PerfectDodges: '~15 22 30', PhysicalDodges: '~10 15 20',
};
const DESCRIPTIONS = {
  BreakAllPartsKill: 'Break all parts on Behemoths before killing them.',
  DPInterrupts: 'Interrupt Behemoths with Ostian Repeaters.',
  GatherCommon: 'Collect common gatherables.', GatherDamage: 'Collect damage gatherables.', GatherDefense: 'Collect defence gatherables.',
  GatherHealing: 'Collect healing gatherables.', GatherPylon: 'Collect pylon gatherables.', GatherSpecial: 'Collect special gatherables.',
  GatherSpeed: 'Collect speed gatherables.', GatherWeapon: 'Collect weapon gatherables.', Gatherables: 'Collect gatherable reagents.',
  GrenadeDamage: 'Deal damage to Behemoths using grenades.', GrenadeInterrupt: 'Interrupt Behemoths with grenades.', GrenadeInterrupts: 'Interrupt Behemoths with grenades.',
  HammerBlastInterrupts: 'Interrupt Behemoths with War Hammer blasts.', PikeBlastInterrupts: 'Interrupt Behemoths with War Pike blasts.',
  InterruptEnraged: 'Interrupt Behemoths while they are enraged.', Interrupts: 'Interrupt Behemoths.',
  KillRage: 'Slay Behemoths while they are enraged.', KillRadiant: 'Slay radiant Behemoths.', KillUmbral: 'Slay umbral Behemoths.',
  KillRadiantNeutral: 'Slay radiant Behemoths with a neutral weapon.', KillRadiantWeapon: 'Slay Behemoths with a radiant weapon.',
  KillUmbralNeutral: 'Slay umbral Behemoths with a neutral weapon.', KillUmbralWeapon: 'Slay Behemoths with an umbral weapon.',
  KillNeutralWeapon: 'Slay Behemoths with a neutral weapon.', KillBlazeWeapon: 'Slay Behemoths with a blaze weapon.', KillFrostWeapon: 'Slay Behemoths with a frost weapon.',
  KillShockWeapon: 'Slay Behemoths with a shock weapon.', KillTerraWeapon: 'Slay Behemoths with a terra weapon.',
  KillBlazeFrost: 'Slay blaze or frost Behemoths.', KillFrostShock: 'Slay frost or shock Behemoths.', KillShockBlaze: 'Slay shock or blaze Behemoths.', KillTerraShock: 'Slay terra or shock Behemoths.',
  LanternDamage: 'Deal damage to Behemoths using a Lantern.',
  PartDamageEnraged: 'Deal part damage to Behemoths while they are enraged.', PartDamageReduce: 'Deal part damage to Behemoths.', PartsEnraged: 'Break parts from Behemoths while they are enraged.',
  PerfectDodges: 'Dodge through attacks at the last moment (perfect dodges).', PhysicalDodges: 'Dodge through physical attacks.', ProjectileDodges: 'Dodge through projectile attacks (beams do not count).',
  StaggerDamageEnraged: 'Deal stagger damage to Behemoths while they are enraged.', StaggerDamageReduce: 'Deal stagger damage to Behemoths.', StaggerEnraged: 'Stagger Behemoths while they are enraged.',
  WoundDamageEnraged: 'Deal wound damage to Behemoths while they are enraged.', WoundDamageReduce: 'Deal wound damage to Behemoths.', WoundEnraged: 'Wound Behemoths while they are enraged.',
};
// the game's objective for these has another name than the bounty; the only ids the game itself was seen sending
const OBJECTIVES = { HuntsDPTwo: 'Bounty_Bronze_HuntsRepeatersTwo', KillUmbral: 'Bounty_BronzeHuntUmbral' };

const spaced = (base) => base.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
function description(base) {
  if (DESCRIPTIONS[base]) return DESCRIPTIONS[base];
  let m = /^Hunts(.+)Two$/.exec(base);
  if (m) return `Complete hunts (${WEAPONS[m[1]] || m[1]} counts as 2).`;
  m = /^(AS|Axe|Sword)Interrupts$/.exec(base);
  if (m) return `Interrupt Behemoths with ${m[1] === 'AS' ? 'Aether Strikers' : m[1] === 'Axe' ? 'an Axe' : 'a Sword'}.`;
  m = /^Kill(AS|Axe|Chain|DP|Hammer|Pike|Sword)(AS|Axe|Chain|DP|Hammer|Pike|Sword)$/.exec(base);
  if (m) return `Slay Behemoths using ${WEAPONS[m[1]]} or ${WEAPONS[m[2]]}.`;
  return spaced(base) + '.';
}
function goalOf(base, tier) {
  const g = GOALS[base] && GOALS[base].split(' ')[['Bronze', 'Silver', 'Gold'].indexOf(tier)];
  if (!g || g === '-') return { goal: null, approx: false };
  return { goal: Number(g.replace('~', '')), approx: g[0] === '~' };
}
// a bounty as the tab shows it; ids from a save that the list doesn't know still get a name
function describe(id, text) {
  const m = /^Bounty_([A-Za-z]+)_(.+)$/.exec(id) || [], base = (BY_ID.get(id) || {}).base || m[2] || id, tier = m[1] || 'Bronze';
  return { id, tier, name: (text && (text.get(`Objectives_Generic::Objective_${base}`) || text.get(`Objectives_Generic::Objective_${base.replace(/s$/, '')}`))) || spaced(base), desc: description(base), ...goalOf(base, tier) };
}
const catalog = (text) => LIST.map((b) => describe(b.id, text));
// what a claim pays under the game rules (backend\game-rules1147.js: settings, its scale and the 100x cap)
function rewards(settings) {
  const s = settings || {}, n = (k) => (Number.isFinite(s[k]) ? s[k] : 1), scale = (v, f) => (f === 1 ? v : Math.max(1, Math.round(v * f)));
  const rate = (k) => Math.min(100, n('universal_xp') * n(k));
  return Object.fromEntries(Object.entries(REWARDS).map(([t, r]) => [t, { pass: scale(r.pass, rate('pass_xp')), weapon: scale(r.weapon, rate('weapon_xp')), merits: scale(r.merits, n('weapon_merits')) }]));
}
// the normal bounties in a player's slots (dailies and season challenges share the list and the slot numbers)
function slotsOf(player) {
  const list = (player && player.bounties && player.bounties.bounties) || [];
  return list.filter((b) => b && /^Bounty_/i.test(b.bounty_id) && !b.claimed).map((b) => ({ slot: b.slot_index, id: b.bounty_id, progress: (b.objectives && b.objectives[0] && b.objectives[0].progress) || 0 }));
}
// why this pick can't be made, or null
function invalid(player, id, slot) {
  if (!BY_ID.has(id)) return 'Unknown bounty.';
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOTS) return 'Unknown bounty slot.';
  const same = slotsOf(player).find((b) => b.id === id);
  if (same && same.slot !== slot) return `You already have that bounty in slot ${same.slot + 1}.`;
  if (same) return 'That bounty is already in that slot.';
  return null;
}
// the record the game itself POSTs for a drafted bounty
function record(id, slot, now = Date.now()) {
  const objective = OBJECTIVES[BY_ID.get(id).base] || id;
  return { bounty_id: id, premium_bounty: false, slot_index: slot, objectives: [{ objective_id: objective, progress: 0 }], drafted_timestamp: new Date(now).toISOString(), update_version: 0, claimed: false };
}

module.exports = { catalog, describe, rewards, slotsOf, invalid, record, SLOTS };
