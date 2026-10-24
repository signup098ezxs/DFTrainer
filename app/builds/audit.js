// Lantern Client - Meta Build Creator: the pre-build check. Licence: AGPL-3.0-only.
//
// Every build is checked here before it is shown. A check that fails asks for a revision (the worker makes the build
// again with what the check found and checks it again); a build that still breaks a rule is never shown.
//   legality      every item and cell exists, every cell fits its slot, the game's equipment rules hold (rules.js)
//   perks         the perk levels, counted again on a separate path straight from the item data, match
//   weapon        the weapon is the type (and the weapon) asked for, its parts fill its own slots, a legendary is
//                 bonded, and its element suits the target
//   goals         a higher goal is not served clearly worse than a lower one
//   max           every perk that matters to the goals is at +6, or the reason it is not (what reaching +6 would cost)
//   meta          the community meta builds for this weapon, as published, scored under the same goals: none may beat it
//   search        how many loadouts were scored and how close the next best different build came
//   data          names and effects: what is unverified (unnamed in the game files, renamed in game, not in the catalog)
'use strict';
const { kb } = require('./data.js');
const { GOALS } = require('./goals.js');
const { validate, elementCoverage, perkTotals, partKinds, ARMOUR_SLOTS } = require('./rules.js');
const { bondOptions, metaAsIs, cellSlots, clone, CURVE } = require('./optimize.js');

// perk levels again, on a separate path: from the raw item data and the cell catalog (not the indexes the search uses)
function countPerks(b) {
  const K = kb(), raw = K.raw, out = {};
  const add = (perks) => { for (const [n, v] of Object.entries(perks || {})) out[n] = (out[n] || 0) + v; };
  const wByName = (n) => raw.weapons.find((w) => w.name === n);
  const aByName = (n) => raw.armours.find((a) => a.name === n);
  add((wByName(b.weapon) || {}).perks);
  if (b.bond) add((wByName(b.bond) || {}).perks);
  for (const [k] of ARMOUR_SLOTS) add((aByName(b[k]) || {}).perks);
  for (const c of [...b.weaponCells, b.cells.head, b.cells.torso, b.cells.arms, b.cells.legs, b.lanternCell]) {
    if (!c) continue;
    for (const cell of Object.values(raw.cells)) if (cell.variants[c]) add({ [cell.variants[c].perk]: cell.variants[c].value });
  }
  return out;
}

function coverage(ctx, totals, b) {
  const out = [];
  for (const g of ctx.goals) {
    if (g === 'elemental') { const pct = elementCoverage(ctx, b); if (pct != null) out.push({ id: g, label: GOALS[g].label, pct, el: true }); continue; }
    const ws = Object.entries(GOALS[g].perks).filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]);
    const ideal = ws.slice(0, 3).reduce((s, [, w]) => s + w, 0) || 1;
    let got = 0;
    for (const [p, w] of ws) got += w * CURVE[Math.min(6, totals[p] || 0)];
    out.push({ id: g, label: GOALS[g].label, pct: Math.round(Math.min(1, got / ideal) * 100) });
  }
  return out;
}

function audit(ctx, r) {
  const K = kb(), b = r.build, scorer = r.scorer, cand = r.cand;
  const checks = [], flags = [];
  let revise = null;
  const add = (id, label, status, detail) => checks.push({ id, label, status, detail });
  const ours = scorer.score(b);
  // ---- legality
  const v = validate(b);
  const missingCell = cellSlots(clone(b)).filter((s) => !s.get()).length;
  const unknown = [...b.weaponCells, b.cells.head, b.cells.torso, b.cells.arms, b.cells.legs, b.lanternCell].filter((c) => c && !K.cellVariant[c]);
  if (!v.ok || unknown.length) add('legality', 'Legal loadout', 'fail', [...v.errors, ...unknown.map((c) => `${c} is not a 1.14.7 cell.`)].join(' '));
  else add('legality', 'Legal loadout', 'pass', `${v.checks.length} equipment rules hold; every item and cell is in 1.14.7${missingCell ? `; ${missingCell} cell slot${missingCell > 1 ? 's are' : ' is'} left empty (no owned cell fits)` : ''}.`);
  // ---- perk calculation, twice
  const a1 = perkTotals(b), a2 = countPerks(b);
  const names = new Set([...Object.keys(a1), ...Object.keys(a2)]);
  const diff = [...names].filter((n) => ((a1[n] || {}).level || 0) !== (a2[n] || 0));
  const at6 = [...names].filter((n) => (a2[n] || 0) >= 6);
  if (diff.length) add('perks', 'Perk levels', 'fail', `The two counts disagree on ${diff.join(', ')}.`);
  else add('perks', 'Perk levels', 'pass', `Counted twice from the item data and they agree: ${names.size} perks, ${at6.length} at +6${at6.length ? ` (${at6.join(', ')})` : ''}.`);
  // ---- the weapon
  const w = K.weaponByName[b.weapon], wnotes = [];
  let wstatus = 'pass';
  if (w.type !== ctx.weaponType || (ctx.weapon && w.name !== ctx.weapon)) { wstatus = 'fail'; wnotes.push(`${w.name} is not the weapon asked for.`); }
  const kinds = partKinds(w.type).filter((k) => !(k === 'specials' && w.restrictSpecials));
  const emptyParts = kinds.filter((k) => !b.parts[k]);
  if (emptyParts.length) { wstatus = 'fail'; wnotes.push(`No ${emptyParts.join(', ')} chosen.`); }
  if (w.bond && !b.bond) {
    if (bondOptions(w, cand).length) { wstatus = 'fail'; wnotes.push(`${w.name} is legendary but has no bonded weapon.`); }
    else { wstatus = 'note'; wnotes.push(`${w.name} is legendary but you own no ${w.bond} ${w.type} to bond with it, so it is used unbonded (without a bonded weapon's perks).`); }
  }
  const weak = ctx.target && ctx.target !== 'Neutral' ? K.weakTo[ctx.target] : null;
  if (weak && w.element !== weak) {
    const choice = (cand.allWeapons || cand.weapons).some((x) => x.element === weak);
    if (ctx.goals.includes('elemental') && choice && !ctx.weapon && !r.elementTried) { wstatus = wstatus === 'fail' ? 'fail' : 'revise'; wnotes.push(`Elemental effectiveness is a goal but the weapon is ${w.element || 'neutral'}, not ${weak}.`); revise = revise || { element: weak, why: `use a ${weak} weapon for the elemental goal` }; }
    else wnotes.push(`Its element (${w.element || 'none'}) is not ${weak}, the one ${ctx.target} behemoths are weak to: ${ctx.weapon ? 'you picked this weapon' : choice ? 'its perks and effects outweigh the element bonus for your goals' : 'no weapon of that element is available'}.`);
  }
  const an = (t) => (/^[AEIOU]/.test(t) ? 'an ' : 'a ') + t;
  if (wstatus === 'pass' && !wnotes.length) wnotes.push(`${w.name} is ${an(w.type)}${w.element ? ` (${w.element})` : ''}${weak ? `, the element ${ctx.target} behemoths are weak to` : ''}; its ${kinds.length} part slot${kinds.length > 1 ? 's are' : ' is'} filled with ${w.type} parts${w.bond ? `, and it is bonded with ${b.bond}` : ''}.`);
  add('weapon', 'Weapon fit', wstatus === 'pass' && wnotes.length > 1 ? 'note' : wstatus, wnotes.join(' '));
  if (wstatus === 'fail') revise = revise || { hard: true };
  // ---- the goals in their order
  const cov = coverage(ctx, a2, b);
  const flip = [];
  for (let i = 0; i < cov.length; i++) for (let j = i + 1; j < cov.length; j++) if (!cov[i].el && !cov[j].el && cov[i].pct + 20 < cov[j].pct) flip.push(`${cov[j].label} (${cov[j].pct}%) is served better than ${cov[i].label} (${cov[i].pct}%)`);
  if (flip.length && (ctx.boost || 0) < 2) { add('goals', 'Goal order', 'revise', flip.join('; ') + '.'); revise = revise || { boost: (ctx.boost || 0) + 1, why: 'weigh your first goals more' }; }
  else add('goals', 'Goal order', flip.length ? 'note' : 'pass', flip.length ? `${flip.join('; ')}: the available gear serves it that way even with your first goals weighted more.` : cov.map((c) => `${c.label} ${c.pct}%`).join(', ') + (cov.length > 1 ? ', in the order you chose.' : '.'));
  // ---- relevant perks at +6, or why not
  const W = r.weights || scorer.W;
  const relevant = Object.entries(W).filter(([, x]) => x >= 0.25).map(([n]) => n);
  const gaps = [];
  for (const n of relevant) {
    const lvl = a2[n] || 0;
    if (lvl >= 6 || lvl === 0) continue;
    // what reaching +6 would take: the best single cell change that adds this perk (in any slot that takes its cell)
    const need = 6 - lvl;
    const fits = Object.values(K.raw.cells).filter((c) => c.variants && Object.values(c.variants).some((x) => x.perk === n)).map((c) => c.slot);
    let bestTry = null;
    const t = clone(b);
    for (const s of cellSlots(t)) {
      const was = s.get();
      if (was && (K.cellVariant[was] || {}).perk === n) continue;   // already gives this perk
      for (const c of cand.cellsBySlot[s.t] || []) {
        if (c.perk !== n || c.value < Math.min(3, need)) continue;
        s.set(c.name);
        const sc = scorer.score(t);
        if (!bestTry || sc > bestTry.sc) { bestTry = { sc, slot: s.t, replaced: was, cell: c.name, reaches: lvl + c.value }; bestTry.build = clone(t); }
        s.set(was);
      }
    }
    // the change scores higher: the search missed it, so the build is made again from the changed one
    if (bestTry && bestTry.sc > ours + 1e-6) revise = revise || { seeds: [bestTry.build], why: `${n} can reach +${bestTry.reaches} with a better cell` };
    const loss = bestTry ? Math.max(0, Math.round((ours - bestTry.sc) / Math.max(ours, 0.01) * 100)) : null;
    gaps.push({
      perk: n, level: lvl, weight: W[n],
      why: !bestTry ? (fits.length ? `None of this build's cell slots takes a ${[...new Set(fits)].join(' or ')} cell; reaching +6 would need different armour or weapon, which costs more elsewhere.` : 'No cell gives this perk; only gear does.')
        : bestTry.reaches < 6 ? `One more cell only brings it to +${bestTry.reaches}.`
        : `Reaching +6 means putting ${bestTry.cell} in a ${bestTry.slot} slot${bestTry.replaced ? ` instead of ${bestTry.replaced}` : ''}, which lowers the build's fit for your goals${loss ? ` by ${loss}%` : ' slightly'}${bestTry.replaced ? ` (${(K.cellVariant[bestTry.replaced] || {}).perk} does more for them)` : ''}.`,
    });
  }
  gaps.sort((x, y) => y.weight - x.weight);
  const wasted = [...names].filter((n) => (a2[n] || 0) > 6 && (W[n] || 0) > 0);
  const relAt6 = relevant.filter((n) => (a2[n] || 0) >= 6);
  const better = revise && /better cell/.test(revise.why || '');
  add('max', 'Perks at +6', better ? 'revise' : gaps.length || wasted.length ? 'note' : 'pass',
    `${relAt6.length} of the perks that matter to your goals are at +6${relAt6.length ? ` (${relAt6.join(', ')})` : ''}.` +
    (gaps.length ? ` Below +6: ${gaps.map((g) => `${g.perk} +${g.level}`).join(', ')} (reasons under Perks).` : '') +
    (wasted.length ? ` ${wasted.join(', ')} go${wasted.length > 1 ? '' : 'es'} past +6.` : ''));
  // ---- the community builds for this weapon, as published, under the same goals
  const allCand = { ...cand, weapons: cand.allWeapons || cand.weapons };   // every weapon, even after an element revision
  const metas = K.metaBuilds.map((m) => ({ m, b: metaAsIs(m, ctx, allCand) })).filter((x) => x.b);
  for (const x of metas) x.v = scorer.score(x.b);
  metas.sort((x, y) => y.v - x.v);
  const top = metas[0];
  if (!metas.length) add('meta', 'Against community builds', 'note', `No community meta build can be compared${ctx.owned ? ' with only your gear' : ctx.weapon ? ` for ${ctx.weapon}` : ''}.`);
  else if (top.v > ours + 1e-6) {
    add('meta', 'Against community builds', 'revise', `"${top.m.title}" (${top.m.category}) scores higher for your goals.`);
    revise = revise || { seeds: [top.b], seedFrom: top.m, why: `start from "${top.m.title}"` };
  } else {
    const pct = ours > 0 ? Math.round(top.v / ours * 100) : 100;
    add('meta', 'Against community builds', 'pass', `${metas.length} community build${metas.length > 1 ? 's' : ''} for ${ctx.weapon || ctx.weaponType} scored as published under your goals; the best ("${top.m.title}", ${top.m.category}${top.m.tier ? `, tier ${top.m.tier}` : ''}) reaches ${pct}% of this build's score.`);
  }
  // ---- how wide the search was
  const key = (x) => [x.weapon, x.head, x.torso, x.arms, x.legs].join('|');
  const distinct = (r.searches || []).filter((s) => key(s.b) !== key(b)).sort((x, y) => y.v - x.v);
  const same = (r.searches || []).filter((s) => key(s.b) === key(b)).length;
  add('search', 'Alternatives', 'pass', `${(r.evaluated || 0).toLocaleString('en-US')} loadouts scored from ${(r.searches || []).length} starting points; ${same} reached this build${distinct.length ? `, the best different one ("${distinct[0].b.weapon}" with ${distinct[0].b.head}…) scores ${Math.round((ours - distinct[0].v) / Math.max(ours, 0.01) * 100)}% lower` : ''}.`);
  // ---- the data behind it
  const items = [w, b.bond && K.weaponByName[b.bond], ...ARMOUR_SLOTS.map(([k]) => K.armourByName[b[k]])].filter(Boolean);
  for (const x of items) if (x.exists === 'inferred') flags.push(`${x.name}: in your 1.14.7 game files without an English name (matched by elimination).`);
  for (const x of items) if (x.gameName) flags.push(`${x.name} is called "${x.gameName}" in your game files.`);
  for (const c of [...b.weaponCells, b.cells.head, b.cells.torso, b.cells.arms, b.cells.legs, b.lanternCell]) if (c && (K.cellVariant[c] || {}).exists === 'inferred') flags.push(`${c}: in the game files without an English name.`);
  flags.push('Weapon part names are not in the game catalog, so they are checked against the community data only.');
  add('data', 'Names and effects', 'note', `Item data: Dauntless Builder, Dauntless ${K.about.dataVersion} (1.14.7 changed no gear). ${[...new Set(flags)].join(' ')}`);
  const failing = checks.filter((c) => c.status === 'fail' || c.status === 'revise');
  return { ok: !failing.length, hard: checks.some((c) => c.status === 'fail'), revise: failing.length ? revise : null, checks, gaps, ours, meta: top ? { title: top.m.title, category: top.m.category, tier: top.m.tier, score: top.v } : null };
}

module.exports = { audit, countPerks };
