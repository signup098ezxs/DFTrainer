// Lantern Client - Meta Build Creator: turns a picked loadout into what the page shows. Licence: AGPL-3.0-only.
//
// Every sentence here is made from the data: perk effects at the level the build reaches, item effects, part, lantern
// and Omnicell texts (all from kb-1147.json). Nothing is added that the data does not say: no damage numbers are
// worked out (the game's damage formula is not in the data), and no combo strings are given.
'use strict';
const { kb, perkEffect } = require('./data.js');
const { GOALS, RISKY, PAIRS, OMNICELLS } = require('./goals.js');
const { perkTotals, ARMOUR_SLOTS } = require('./rules.js');
const { perkWeights, metaFrequency, CURVE } = require('./optimize.js');

const SLOT_LABEL = { head: 'Head', torso: 'Chest', arms: 'Arms', legs: 'Legs' };
const KIND_LABEL = { specials: 'Special', mods: 'Mod', chambers: 'Chamber', grips: 'Grip' };
const BUILDER = 'https://reforged.dauntless-builder.com/b/';

function cellInfo(name, slot) {
  if (!name) return { slot, name: null };
  const v = kb().cellVariant[name];
  return { slot, name, perk: v.perk, value: v.value, id: v.id, exists: v.exists };
}

function goalCoverage(ctx, totals) {
  const out = [];
  for (const g of ctx.goals) {
    if (g === 'elemental') continue;
    const ws = Object.entries(GOALS[g].perks).filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]);
    const ideal = ws.slice(0, 3).reduce((s, [, w]) => s + w, 0) || 1;
    let got = 0;
    for (const [p, w] of ws) got += w * CURVE[Math.min(6, (totals[p] || {}).level || 0)];
    out.push({ id: g, label: GOALS[g].label, pct: Math.round(Math.min(1, got / ideal) * 100) });
  }
  return out;
}

function closestMeta(b) {
  const K = kb();
  const keys = ['weapon', 'head', 'torso', 'arms', 'legs', 'lantern', 'omnicell'];
  let best = null;
  for (const m of K.metaBuilds) {
    if ((K.weaponByName[m.build.weapon] || {}).type !== b.weaponType) continue;
    const shared = keys.filter((k) => m.build[k] && m.build[k] === b[k]).length;
    if (!best || shared > best.shared || (shared === best.shared && (m.tier || 9) < (best.m.tier || 9))) best = { m, shared };
  }
  if (!best) return null;
  const m = best.m;
  return { title: m.title, category: m.category, subcategory: m.subcategory, tier: m.tier, vsElement: m.vsElement, shared: best.shared, of: keys.length,
    url: BUILDER + m.buildId, info: m.subcategoryInfo || m.categoryInfo || '' };
}

function describe(ctx, result, owned) {
  const K = kb(), b = result.build;
  const w = K.weaponByName[b.weapon], bond = b.bond && K.weaponByName[b.bond];
  const totals = perkTotals(b), W = perkWeights(ctx);
  const target = ctx.target && ctx.target !== 'Neutral' ? ctx.target : null;
  const weak = target ? K.weakTo[target] : null;
  const goalNames = ctx.goals.map((g) => GOALS[g].label);
  // Universal: how the armour's weaknesses are spread
  const weakSpread = {};
  for (const [k] of ARMOUR_SLOTS) { const a = K.armourByName[b[k]]; if (a && a.weakness) weakSpread[a.weakness] = (weakSpread[a.weakness] || 0) + 1; }
  // ---- perks, best for the goals first
  const perks = Object.entries(totals).map(([name, t]) => {
    const p = K.perks[name] || {};
    const goals = ctx.goals.filter((g) => (GOALS[g].perks[name] || 0) > 0).map((g) => GOALS[g].short);
    return { name, level: t.level, counts: Math.min(6, t.level), wasted: Math.max(0, t.level - 6), type: p.type, effect: perkEffect(name, t.level),
      goals, weight: W[name] || 0, sources: t.sources, risky: RISKY[name] || null };
  }).sort((a, c) => (c.weight * CURVE[c.counts]) - (a.weight * CURVE[a.counts]) || c.level - a.level);
  const key = perks.filter((p) => p.weight > 0).slice(0, 4);
  // ---- name: weapon element, weapon type, what it is for
  const typeName = { Repeater: 'Repeaters' }[w.type] || w.type;
  const role = ctx.goals.length > 1 ? `${GOALS[ctx.goals[0]].short} / ${GOALS[ctx.goals[1]].short}` : GOALS[ctx.goals[0]].short;
  const name = `${w.element ? w.element + ' ' : ''}${typeName} ${role}`;
  // ---- the pieces
  const weapon = {
    name: w.name, gameName: w.gameName, type: w.type, element: w.element, behemoth: w.behemoth, exotic: w.exotic, exists: w.exists, id: w.id,
    perks: w.perks, effects: w.effects,
    cells: b.weaponCells.map((c, i) => cellInfo(c, w.cells[i])),
    parts: Object.entries(b.parts).map(([kind, n]) => ({ kind: KIND_LABEL[kind] || kind, name: n, effect: ((K.parts[w.type][kind] || []).find((p) => p.name === n) || {}).effect || '' })),
    bond: bond ? { name: bond.name, element: bond.element, perks: bond.perks, effects: bond.effects, exists: bond.exists, id: bond.id } : null,
  };
  const armour = ARMOUR_SLOTS.map(([k]) => {
    const a = K.armourByName[b[k]];
    return { slot: SLOT_LABEL[k], name: a.name, gameName: a.gameName, behemoth: a.behemoth, element: a.element, weakness: a.weakness, exotic: a.exotic,
      perks: a.perks, effects: a.effects, cell: cellInfo(b.cells[k], a.cells[0]), exists: a.exists, id: a.id, empty: !!a.empty };
  });
  const l = K.lanternByName[b.lantern], o = K.omnicellByName[b.omnicell];
  const lantern = { name: l.name, hold: l.hold, instant: l.instant, cell: cellInfo(b.lanternCell, l.cells[0]), exists: l.exists, id: l.id };
  const oGoals = Object.entries((OMNICELLS[o.name] || {}).goals || {}).filter(([g]) => ctx.goals.includes(g)).map(([g]) => GOALS[g].label.toLowerCase());
  const omnicell = { name: o.name, passive: o.passive, active: o.active, id: o.id, exists: o.exists, chosen: ctx.omnicell && ctx.omnicell !== 'auto',
    why: ctx.omnicell && ctx.omnicell !== 'auto' ? 'Your pick.' : oGoals.length ? `Its own abilities serve ${oGoals.join(' and ')}.` : 'The best fit for these goals among the Omnicells.' };
  // ---- explanation
  const coverage = goalCoverage(ctx, totals);
  const strengths = [], weaknesses = [], synergies = [];
  for (const p of key) strengths.push(`${p.name} +${p.counts}: ${p.effect}`);
  if (target && weak) {
    if (w.element === weak) strengths.push(`${w.element} weapon: ${target} behemoths are weak to ${weak}.`);
    else if (w.element === target) weaknesses.push(`Your weapon is ${w.element}, the same element as the target.`);
    const resist = armour.filter((a) => a.element === target).length, weakP = armour.filter((a) => a.weakness === target).length;
    if (resist) strengths.push(`${resist} armour piece${resist > 1 ? 's are' : ' is'} ${target}, the target's own element.`);
    if (weakP) weaknesses.push(`${weakP} armour piece${weakP > 1 ? 's are' : ' is'} weak to ${target}.`);
  }
  if (ctx.universal) {
    const spread = Object.entries(weakSpread).sort((a, c) => c[1] - a[1]);
    const most = spread.length ? spread[0][1] : 0;
    if (most <= 1) strengths.push(`Universal: no two armour pieces share a weakness${spread.length ? ` (${spread.map(([e]) => e).join(', ')})` : ''}, so no single element hits every piece.`);
    else weaknesses.push(`Universal: ${most} armour pieces are weak to ${spread[0][0]}; the gear that fits your goals best made a fully spread set cost too much.`);
    if (w.element) synergies.push(`Your ${w.element} weapon does extra damage to ${Object.keys(K.weakTo).filter((e) => K.weakTo[e] === w.element).join(' and ')} behemoths; against the rest it hits normally.`);
  }
  for (const c of coverage) if (c.pct < 35) weaknesses.push(`${c.label} is only lightly covered (${c.pct}%): the gear that fits the other goals left little room for it.`);
  const surv = ['Tough', 'Evasion', 'Nine Lives', 'Water', 'Fortress', 'Parasitic', 'Aegis'].filter((n) => (totals[n] || {}).level >= 3);
  if (!ctx.goals.includes('survival') && !surv.length) weaknesses.push('Little defence: no survival perk at +3 or more. Dodge well, or swap a cell for Tough or Evasion.');
  for (const p of perks) if (p.risky) weaknesses.push(`${p.name} ${p.risky}.`);
  for (const p of perks) if (p.wasted) weaknesses.push(`${p.name} reaches +${p.level}; only +6 counts, so ${p.wasted} point${p.wasted > 1 ? 's are' : ' is'} unused.`);
  for (const pr of PAIRS) if ((totals[pr.a] || {}).level >= 3 && (totals[pr.b] || {}).level >= 3) (pr.v > 0 ? synergies : weaknesses).push(`${pr.a} and ${pr.b}: ${pr.why}.`);
  const poss = (n) => (/s$/.test(n) ? n + "'" : n + "'s");
  if (bond) synergies.push(`${w.name} is a legendary weapon: bonded with ${bond.name}, it takes ${poss(bond.name)} perks and effects.`);
  const playstyle = `A ${o.name} ${typeName} build for ${goalNames.join(', ').replace(/, ([^,]*)$/, ' and $1').toLowerCase()}`
    + `${target ? ` against ${target} behemoths` : ctx.universal ? ', made to take into any hunt' : ''}. `
    + (key.length ? `It is built around ${key.map((p) => `${p.name} +${p.counts}`).join(', ').replace(/, ([^,]*)$/, ' and $1')}.` : '');
  // ---- how to use it: only what the build's own texts say
  const usage = [];
  const dodge = perks.filter((p) => p.counts && /dodg(e|ing) through/i.test(p.effect)).map((p) => p.name);
  if (dodge.length) usage.push({ title: 'Dodge through attacks', text: `Dodge into and through attacks rather than away: that triggers ${dodge.join(', ').replace(/, ([^,]*)$/, ' and $1')}.` });
  const has = (n, lvl = 1) => ((totals[n] || {}).level || 0) >= lvl;
  if (has('Overpower')) usage.push({ title: 'Punish staggers', text: `Save your strongest attacks for when the behemoth is staggered: ${perkEffect('Overpower', totals.Overpower.level)}` });
  if (has('Predator')) usage.push({ title: 'Stay untouched', text: `${perkEffect('Predator', totals.Predator.level)} Play patiently between hits.` });
  if (has('Recycle')) usage.push({ title: 'Stay on one part', text: perkEffect('Recycle', totals.Recycle.level) });
  if (has('Berserker')) usage.push({ title: 'Keep the pressure on', text: perkEffect('Berserker', totals.Berserker.level) });
  if (has('Tenacious')) usage.push({ title: 'Stay healthy', text: perkEffect('Tenacious', totals.Tenacious.level) });
  if (has('Adrenaline')) usage.push({ title: 'Spend stamina', text: perkEffect('Adrenaline', totals.Adrenaline.level) });
  if (has('Ragehunter') || has('Pacifier')) usage.push({ title: 'Enraged phases', text: ['Ragehunter', 'Pacifier'].filter((n) => has(n)).map((n) => perkEffect(n, totals[n].level)).join(' ') });
  if (has('Savagery') && (has('Acidic') || has('Barbed'))) usage.push({ title: 'Wound, then hit', text: `Wound a part first, then focus it: ${perkEffect('Savagery', totals.Savagery.level)}` });
  // the kit: what each piece does when you use it (kind "kit", shown apart from the play tips)
  for (const p of weapon.parts) if (p.effect) usage.push({ kind: 'kit', title: `${p.kind}: ${p.name}`, text: p.effect });
  for (const e of [...(w.effects || []), ...((bond && bond.effects) || [])]) usage.push({ kind: 'kit', title: /^Legendary Ability/.test(e) ? 'Legendary ability' : 'Weapon effect', text: e.replace(/^Legendary Ability:\s*/, '') });
  usage.push({ kind: 'kit', title: `Omnicell: ${o.name}`, text: o.active });
  if (l.hold) usage.push({ kind: 'kit', title: `Lantern: ${l.name}`, text: `Hold: ${l.hold}${l.instant ? ` Tap: ${l.instant}` : ''}` });
  if (target && weak && w.element === weak) usage.push({ title: 'Pick your hunts', text: `This build is set up for ${target} behemoths. Against other elements, a weapon of the element they are weak to does better.` });
  // ---- confidence, sources, assumptions
  const meta = closestMeta(b);
  const inferred = [w, bond, ...armour.map((a) => K.armourByName[a.name])].filter((x) => x && x.exists === 'inferred').map((x) => x.name);
  const reasons = [];
  let level = 'High';
  if (meta && meta.shared >= 5) reasons.push(`It shares ${meta.shared} of ${meta.of} main pieces with a community meta build ("${meta.title}", ${meta.category}).`);
  else { level = 'Medium'; reasons.push(meta ? `It is Lantern's own fit for your goals: the closest community meta build shares ${meta.shared} of ${meta.of} main pieces.` : 'No community meta build uses this weapon type.'); }
  if (inferred.length) { if (level === 'High') level = 'Medium'; reasons.push(`${inferred.join(', ')} ${inferred.length > 1 ? 'are' : 'is'} in your 1.14.7 game files without an English name; Lantern matched ${inferred.length > 1 ? 'them' : 'it'} by elimination.`); }
  const avg = coverage.length ? coverage.reduce((s, c) => s + c.pct, 0) / coverage.length : 100;
  if (avg < 35) { level = 'Low'; reasons.push('The goals are only lightly covered by the gear available.'); }
  reasons.push('Perk values, slot types and item effects are the community-maintained Dauntless 1.14.6 data (1.14.7 changed none of them). How much each perk serves a goal is Lantern\'s own judgement.');
  const empties = armour.filter((a) => a.empty).map((a) => a.slot.toLowerCase());
  if (empties.length) weaknesses.push(`You own no ${empties.join(' or ')} armour Lantern has data for, so that slot is left empty. Any armour there adds its perk and a cell slot.`);
  const notes = [
    'All gear is assumed fully upgraded and power-surged, with +3 cells (the values shown).' + (owned ? ' Only gear and cells you own were used.' : ''),
    'No damage numbers are worked out: the game\'s damage formula is not in Lantern\'s data.',
    'Lantern keeps to one Exotic: no community build uses two, and it could not confirm the game allows it.',
    'Weapon combo strings are not in Lantern\'s verified data; "How to play it" only uses what the gear\'s own texts say.',
  ];
  const sources = (K.about.sources || []).filter((s) => s.url).map((s) => ({ title: s.title, url: s.url }));
  if (bond) sources.push({ title: 'Official Dauntless Wiki: Bond', url: 'https://dauntless.fandom.com/wiki/Bond' });
  if (meta) sources.unshift({ title: `Closest community build: ${meta.title} (${meta.category}${meta.tier ? `, tier ${meta.tier}` : ''})`, url: meta.url });
  // ---- what the player is missing (for "Give me what I'm missing")
  const missing = { gear: [], cells: [] };
  if (owned) {
    for (const x of [weapon, weapon.bond, ...armour, lantern].filter(Boolean)) if (x.id && !x.empty && !owned.gear.has(x.id)) missing.gear.push({ id: x.id, name: x.name });
    if (omnicell.id && !owned.gear.has(omnicell.id)) missing.gear.push({ id: omnicell.id, name: omnicell.name });
    for (const c of [...weapon.cells, ...armour.map((a) => a.cell), lantern.cell]) if (c && c.id && !(owned.cells.get(c.id) > 0)) missing.cells.push({ id: c.id, name: c.name });
    const seen = new Set(); missing.cells = missing.cells.filter((c) => !seen.has(c.id) && seen.add(c.id));
  }
  return {
    name, subtitle: `${w.name}${bond ? ` + ${bond.name}` : ''} · ${o.name}${target ? ` · vs ${target}` : ctx.universal ? ' · Universal' : ''}`,
    weapon, armour, lantern, omnicell, perks, goals: coverage,
    explanation: { playstyle, strengths, weaknesses, synergies },
    usage, notes, sources, meta,
    confidence: { level, reasons },
    check: { checks: result.check.checks, warnings: result.check.warnings },
    missing,
  };
}

module.exports = { describe };
