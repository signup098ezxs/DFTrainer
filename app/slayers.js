// Lantern Client - the Slayers Club (the game's internal "VIP" system, still in the 1.14.7 client).
// Licence: AGPL-3.0-only.
//
// The club is two entitlements on your player in the save (data\state.json, players.<you>.entitlements):
//   ent_boost_vip                    the club itself (buff icon, perks). duration is in hours from activatedDate; 0 made
//                                    the in-game timer run negative, so 438000 h (50 years, fits int32 seconds)
//   escalation_xp_boost_entitlement  the escalation perk (the Elite Hunt Pass granted both); duration 0 = permanent
// Switched on and off with the SlayersClub mod on Dauntless Forever's Mods page (server.js keeps the save in step).
// Every other entitlement is left exactly as it is.
'use strict';
const ENTS = [{ name: 'ent_boost_vip', duration: 438000 }, { name: 'escalation_xp_boost_entitlement', duration: 0 }];
const NAMES = new Set(ENTS.map((w) => w.name));

// the form the backend itself writes (recorder-1147.js, POST /entitlementv2)
const entry = (w) => ({ activatedDate: w.duration ? new Date().toISOString().slice(0, 19) : null, duration: w.duration, name: w.name });
const good = (e, w) => !!e && e.name === w.name && Number(e.duration) === w.duration && (!w.duration || Number.isFinite(Date.parse(e.activatedDate)));
const list = (pl) => (pl && Array.isArray(pl.entitlements) ? pl.entitlements : []);

// is the club fully on for this player?
function has(pl) { return ENTS.every((w) => list(pl).some((e) => good(e, w))); }
// the entitlements still missing (or wrong, e.g. ent_boost_vip with duration 0)
function missing(pl) { return ENTS.filter((w) => !list(pl).some((e) => good(e, w))); }
// is any of it there at all?
function any(pl) { return list(pl).some((e) => e && NAMES.has(e.name)); }

// put the club in (on) or take it out (off). A correct entry is kept as it is (its activatedDate too), so applying twice
// changes nothing; duplicates and wrong ones are replaced. Returns true if the list changed.
function apply(pl, on) {
  const before = list(pl), kept = [], seen = new Set();
  for (const e of before) {
    if (!e || !NAMES.has(e.name)) { kept.push(e); continue; }
    if (!on) continue;
    const w = ENTS.find((x) => x.name === e.name);
    if (!seen.has(e.name) && good(e, w)) { seen.add(e.name); kept.push(e); }
  }
  if (on) for (const w of ENTS) if (!seen.has(w.name)) kept.push(entry(w));
  if (JSON.stringify(kept) === JSON.stringify(before)) return false;
  pl.entitlements = kept;
  return true;
}

module.exports = { ENTS, has, missing, any, apply };
