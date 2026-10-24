// Lantern Client - Meta Build Creator: picks the loadout. Licence: AGPL-3.0-only.
//
// A build's score is how well its perks (up to +6 each), its weapon's element, its armour's elements, its lantern,
// Omnicell and unique effects serve the player's goals in their order (goals.js), plus a small bonus for pieces the
// community meta builds use with that weapon type. The search starts from the closest community meta builds and from
// a fresh pick, then changes one piece at a time (refitting the cells each time) while the score improves. Every
// result is checked by rules.js before it is shown.
'use strict';
const { kb } = require('./data.js');
const { GOALS, PRIORITY, RISKY, SITUATIONAL, IMMUNITY, PAIRS, OMNICELLS, LANTERNS, EFFECT_WORDS } = require('./goals.js');
const { validate, perkTotals, ARMOUR_SLOTS } = require('./rules.js');

const CURVE = [0, 0.22, 0.4, 0.56, 0.7, 0.82, 1];
const ESCALATION = { 'Pack Hunter': 0.6, Aetherhunter: 0.6, 'Pack Walker': 0.4, 'Pack Caller': 0.2, Deconstruction: 0.2 };

function prio(ctx, goal) { const i = ctx.goals.indexOf(goal); return i < 0 ? 0 : (PRIORITY[i] || 0.2); }

// perk -> how much the player's goals value it
function perkWeights(ctx) {
  const W = {};
  ctx.goals.forEach((g, i) => { for (const [p, w] of Object.entries(GOALS[g].perks)) W[p] = (W[p] || 0) + (PRIORITY[i] || 0.2) * w; });
  for (const p of Object.keys(SITUATIONAL)) W[p] = ctx.content === 'escalation' ? (W[p] || 0) + ESCALATION[p] : 0;
  if (ctx.target && IMMUNITY[ctx.target]) W[IMMUNITY[ctx.target]] = (W[IMMUNITY[ctx.target]] || 0) + (ctx.goals.includes('survival') ? 0.35 : 0.2);
  if (ctx.risk === 'safe') for (const p of Object.keys(RISKY)) W[p] = -1;
  return W;
}

// community use: how often each item appears in the meta builds for this weapon type (0..1)
function metaFrequency(type) {
  const K = kb(), n = {}, builds = K.metaBuilds.filter((m) => (K.weaponByName[m.build.weapon] || {}).type === type);
  for (const m of builds) {
    for (const x of [m.build.weapon, m.build.head, m.build.torso, m.build.arms, m.build.legs, m.build.lantern, m.build.omnicell, ...m.build.parts]) if (x) n[x] = (n[x] || 0) + 1;
    for (const c of [...m.build.weaponCells, m.build.headCell, m.build.torsoCell, m.build.armsCell, m.build.legsCell, m.build.lanternCell]) {
      const v = c && K.cellVariant[c];
      if (v) n['cell:' + v.cell] = (n['cell:' + v.cell] || 0) + 1;
    }
  }
  const max = Math.max(1, ...Object.values(n));
  for (const k of Object.keys(n)) n[k] /= max;
  return { freq: n, builds };
}

function effectGoals(text) {
  for (const [re, g] of EFFECT_WORDS) if (re.test(text)) return g;
  return null;
}

function makeScorer(ctx) {
  const K = kb(), W = perkWeights(ctx), { freq } = metaFrequency(ctx.weaponType);
  const weak = ctx.target && ctx.target !== 'Neutral' ? K.weakTo[ctx.target] : null;
  const eW = ctx.goals.includes('elemental') ? Math.max(0.6, prio(ctx, 'elemental') * 1.4) : 0.5;
  const aW = ctx.goals.includes('elemental') || ctx.goals.includes('survival') ? 0.14 : 0.06;
  const avoid = new Set(ctx.avoid || []);
  const staticCache = new Map();
  // what an item adds by itself (element, unique effects, community use, "show me something else")
  function itemStatic(x, kind) {
    if (!x) return 0;
    const key = kind + ':' + x.name;
    if (staticCache.has(key)) return staticCache.get(key);
    let s = 0;
    if (kind === 'weapon' && ctx.target && ctx.target !== 'Neutral') {
      if (weak && x.element === weak) s += 0.9 * eW;
      else if (x.element && x.element === ctx.target) s -= 0.3 * eW;
    }
    if (kind === 'armour' && ctx.target && ctx.target !== 'Neutral') {
      if (x.element === ctx.target) s += aW;
      if (x.weakness === ctx.target) s -= aW;
    }
    for (const e of x.effects || []) { const g = effectGoals(e); if (g) s += 0.12 * prio(ctx, g); }
    if (kind !== 'bond') s += 0.1 * (freq[x.name] || 0);
    if (avoid.has(x.name)) s -= 0.35;
    if (x.exists === 'inferred') s -= 0.01;   // all else equal, an item the game files name
    staticCache.set(key, s);
    return s;
  }
  function lanternScore(l) {
    if (!l) return 0;
    let s = 0;
    for (const [g, v] of Object.entries((LANTERNS[l.name] || {}).goals || {})) s += 0.4 * prio(ctx, g) * v;
    const el = /(\w+) damage/i.exec(l.hold || '');
    if (weak && el && el[1] === weak) s += 0.15 * eW;
    s += 0.05 * (freq[l.name] || 0);
    if (avoid.has(l.name)) s -= 0.2;
    return s;
  }
  // perk levels without building objects: each item's perks are looked up once
  const perkList = new Map();
  const perksOf = (key, perks) => { let l = perkList.get(key); if (!l) { l = Object.entries(perks || {}); perkList.set(key, l); } return l; };
  const lv = new Map();
  const addAll = (l) => { for (const [p, v] of l) lv.set(p, (lv.get(p) || 0) + v); };
  function score(b) {
    lv.clear();
    const w = K.weaponByName[b.weapon];
    if (w) addAll(perksOf('w:' + w.name, w.perks));
    const bw = b.bond && K.weaponByName[b.bond];
    if (bw) addAll(perksOf('w:' + bw.name, bw.perks));
    for (const [k] of ARMOUR_SLOTS) { const a = K.armourByName[b[k]]; if (a) addAll(perksOf('a:' + a.name, a.perks)); }
    let tie = 0;   // among cells that serve no goal, the ones the community uses with this weapon type
    const cell = (c) => { const v = c && K.cellVariant[c]; if (v) { lv.set(v.perk, (lv.get(v.perk) || 0) + v.value); tie += 0.002 * (freq['cell:' + v.cell] || 0); } };
    for (const c of b.weaponCells) cell(c);
    cell(b.cells.head); cell(b.cells.torso); cell(b.cells.arms); cell(b.cells.legs); cell(b.lanternCell);
    let s = 0;
    for (const [p, level] of lv) {
      const wt = W[p] || 0;
      if (!wt) continue;
      s += wt * CURVE[Math.min(6, level)];
      if (level > 6 && wt > 0) s -= 0.05 * (level - 6);
    }
    s += tie;
    for (const pr of PAIRS) if ((lv.get(pr.a) || 0) >= 3 && (lv.get(pr.b) || 0) >= 3 && (W[pr.a] > 0 || W[pr.b] > 0)) s += pr.v;
    s += itemStatic(K.weaponByName[b.weapon], 'weapon') + itemStatic(b.bond && K.weaponByName[b.bond], 'bond');
    for (const [k] of ARMOUR_SLOTS) s += itemStatic(K.armourByName[b[k]], 'armour');
    s += lanternScore(K.lanternByName[b.lantern]);
    return s;
  }
  return { score, W };
}

// ---- what may be used (all of the game's gear, or only what the player owns)
function candidates(ctx) {
  const K = kb();
  const own = ctx.owned;
  const ok = (x) => !own || (x.id && own.gear.has(x.id));
  let weapons = K.weapons.filter((w) => w.type === ctx.weaponType && ok(w) && !w.event);
  if (ctx.weapon) weapons = weapons.filter((w) => w.name === ctx.weapon);
  const armour = {};
  for (const [k, slot] of ARMOUR_SLOTS) {
    armour[k] = own ? K.ownedBySlot[slot].filter(ok) : K.bySlot[slot];
    if (own && !armour[k].length) armour[k] = [K.unequipped[slot]];
  }
  const lanterns = K.lanterns.filter(ok);
  // cells: the strongest variant of each cell (owned only: the strongest one owned)
  const cellsBySlot = {};
  for (const [slot, list] of Object.entries(K.cellsBySlot)) {
    cellsBySlot[slot] = list.map((best) => {
      if (!own) return best;
      const vs = Object.values(K.raw.cells[best.cell].variants).filter((v) => v.id && (own.cells.get(v.id) || 0) > 0).sort((a, b) => b.value - a.value);
      return vs.length ? K.cellVariant[Object.keys(K.raw.cells[best.cell].variants).find((n) => K.raw.cells[best.cell].variants[n] === vs[0])] : null;
    }).filter(Boolean);
  }
  if (ctx.risk === 'safe') for (const s of Object.keys(cellsBySlot)) cellsBySlot[s] = cellsBySlot[s].filter((c) => !RISKY[c.perk]);
  return { weapons, armour, lanterns, cellsBySlot, own };
}
function bondOptions(w, cand) {
  if (!w || !w.bond) return [null];
  const K = kb(), own = cand.own;
  return K.weapons.filter((x) => x.type === w.type && x.element === w.bond && !x.exotic && !x.bond && !x.event && (!own || (x.id && own.gear.has(x.id))));
}

// ---- cells: fill every slot, then try every other cell in each slot until nothing improves
function cellSlots(b) {
  const K = kb(), out = [];
  const w = K.weaponByName[b.weapon];
  (w ? w.cells : []).forEach((t, i) => out.push({ t, get: () => b.weaponCells[i], set: (v) => { b.weaponCells[i] = v; } }));
  for (const [k] of ARMOUR_SLOTS) {
    const a = K.armourByName[b[k]];
    if (a && a.cells.length) out.push({ t: a.cells[0], get: () => b.cells[k], set: (v) => { b.cells[k] = v; } });
    else b.cells[k] = null;
  }
  const l = K.lanternByName[b.lantern];
  if (l && l.cells.length) out.push({ t: l.cells[0], get: () => b.lanternCell, set: (v) => { b.lanternCell = v; } });
  else b.lanternCell = null;
  return out;
}
function fitCells(b, scorer, cand, keep, quick) {
  const K = kb();
  const w = K.weaponByName[b.weapon];
  b.weaponCells = (b.weaponCells || []).slice(0, w ? w.cells.length : 0);
  while (w && b.weaponCells.length < w.cells.length) b.weaponCells.push(null);
  const slots = cellSlots(b);
  for (const s of slots) {
    const c = s.get(), v = c && K.cellVariant[c];
    if (!keep || (c && !(v && (s.t === 'Prismatic' || v.slot === s.t) && (cand.cellsBySlot[s.t] || []).some((x) => x.name === c)))) s.set(null);
  }
  // greedy: the single best addition each round
  for (let round = 0; round < slots.length; round++) {
    let best = null;
    for (const s of slots) {
      if (s.get()) continue;
      for (const c of cand.cellsBySlot[s.t] || []) {
        s.set(c.name);
        const v = scorer.score(b);
        if (!best || v > best.v) best = { s, c: c.name, v };
        s.set(null);
      }
    }
    if (!best) break;
    best.s.set(best.c);
  }
  // swaps
  let cur = scorer.score(b);
  if (quick) return cur;
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const s of slots) {
      const was = s.get();
      for (const c of cand.cellsBySlot[s.t] || []) {
        if (c.name === was) continue;
        s.set(c.name);
        const v = scorer.score(b);
        if (v > cur + 1e-9) { cur = v; changed = true; } else s.set(was);
        if (s.get() !== was) break;
      }
    }
    if (!changed) break;
  }
  return cur;
}

function blank(ctx) {
  return { weaponType: ctx.weaponType, weapon: null, bond: null, weaponCells: [], parts: {}, head: null, torso: null, arms: null, legs: null,
    cells: { head: null, torso: null, arms: null, legs: null }, lantern: null, lanternCell: null, omnicell: ctx.omnicellPick };
}
const clone = (b) => ({ ...b, weaponCells: [...b.weaponCells], parts: { ...b.parts }, cells: { ...b.cells } });

// one piece at a time: try every option for it (refitting its cell), keep the best, refit all cells, repeat
function improve(b, ctx, scorer, cand) {
  let cur = fitCells(b, scorer, cand, true);
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    const tryList = (key, list, kind) => {
      let best = { v: cur, x: b[key] };
      for (const x of list) {
        const name = x ? x.name : null;
        if (name === b[key]) continue;
        const t = clone(b);
        t[key] = name;
        if (key === 'weapon') { t.bond = null; t.weaponCells = []; const bo = bondOptions(x, cand)[0]; t.bond = bo ? bo.name : null; }
        if (ARMOUR_SLOTS.some(([k]) => k === key)) t.cells[key] = null;
        if (key === 'lantern') t.lanternCell = null;
        const v = fitCells(t, scorer, cand, true, true);   // its own cell only; all cells are refitted once a piece is kept
        if (v > best.v + 1e-9) best = { v, x: name, t };
      }
      if (best.t) { Object.assign(b, best.t); cur = fitCells(b, scorer, cand, true); changed = true; }
    };
    if (!ctx.weapon) tryList('weapon', cand.weapons);
    const w = kb().weaponByName[b.weapon];
    if (w && w.bond) tryList('bond', bondOptions(w, cand));
    for (const [k] of ARMOUR_SLOTS) tryList(k, cand.armour[k].filter((a) => !(a.exotic && exoticElsewhere(b, k))));
    tryList('lantern', cand.lanterns);
    if (!changed) break;
  }
  return cur;
}
function exoticElsewhere(b, exceptKey) {
  const K = kb();
  const w = K.weaponByName[b.weapon];
  if (w && w.exotic && exceptKey !== 'weapon') return true;
  return ARMOUR_SLOTS.some(([k]) => k !== exceptKey && (K.armourByName[b[k]] || {}).exotic);
}

// the Omnicell: the player's pick, or the one whose own abilities serve their goals most
function pickOmnicell(ctx) {
  const K = kb();
  if (ctx.omnicell && ctx.omnicell !== 'auto') return ctx.omnicell;
  const { freq } = metaFrequency(ctx.weaponType);
  // only gear I own: an Omnicell they own; owning none, the best one anyway (listed as missing)
  const ownsSome = !!ctx.owned && K.omnicells.some((o) => o.id && ctx.owned.gear.has(o.id));
  let best = null;
  for (const o of K.omnicells) {
    const a = OMNICELLS[o.name] || { goals: {} };
    if (ctx.risk === 'safe' && a.risk) continue;
    if (ctx.owned && ownsSome && !(o.id && ctx.owned.gear.has(o.id))) continue;
    let s = 0;
    for (const [g, v] of Object.entries(a.goals)) s += prio(ctx, g) * v;
    s += 0.05 * (freq[o.name] || 0);
    if (!best || s > best.s) best = { o, s };
  }
  return best ? best.o.name : K.omnicells[0].name;
}

// weapon parts: the one whose effect serves the goals best, the community's favourite for this weapon type otherwise
function pickParts(b, ctx) {
  const K = kb(), w = K.weaponByName[b.weapon], out = {};
  if (!w) return out;
  const { freq } = metaFrequency(w.type);
  for (const [kind, list] of Object.entries(K.parts[w.type] || {})) {
    if (kind === 'specials' && w.restrictSpecials) continue;
    let best = null;
    for (const p of list) {
      let s = 0.3 * (freq[p.name] || 0);
      const g = effectGoals(p.effect || '');
      if (g) s += 0.4 * prio(ctx, g);
      if (/DONT USE|REMOVED/i.test(p.name)) s -= 10;
      if (!best || s > best.s) best = { p, s };
    }
    if (best) out[kind] = best.p.name;
  }
  return out;
}

function adaptMeta(m, ctx, cand) {
  const K = kb(), b = blank(ctx);
  const has = (list, name) => list.some((x) => x.name === name);
  b.weapon = has(cand.weapons, m.build.weapon) ? m.build.weapon : null;
  if (!b.weapon) return null;
  const w = K.weaponByName[b.weapon];
  b.bond = w.bond && m.build.bond && bondOptions(w, cand).some((x) => x.name === m.build.bond) ? m.build.bond : (bondOptions(w, cand)[0] || {}).name || null;
  for (const [k] of ARMOUR_SLOTS) b[k] = has(cand.armour[k], m.build[k]) ? m.build[k] : (cand.armour[k][0] || {}).name || null;
  b.lantern = has(cand.lanterns, m.build.lantern) ? m.build.lantern : (cand.lanterns[0] || {}).name || null;
  return b;
}

function optimise(ctx) {
  const K = kb();
  const cand = candidates(ctx);
  if (!cand.weapons.length) return { error: ctx.owned ? `You don't own a ${ctx.weaponType} that Lantern has data for.` : `No ${ctx.weaponType} found.` };
  if (!cand.lanterns.length) return { error: ctx.owned ? 'You don\'t own a lantern Lantern has data for (Recruit\'s and Utility lanterns have no ability data).' : 'No lantern found.' };
  ctx.omnicellPick = pickOmnicell(ctx);
  const scorer = makeScorer(ctx);
  const starts = [];
  // the community builds for this weapon type (the chosen Omnicell's first), best first under these goals
  const { builds } = metaFrequency(ctx.weaponType);
  const seeds = builds.map((m) => ({ m, b: adaptMeta(m, ctx, cand) })).filter((x) => x.b);
  for (const s of seeds) { fitCells(s.b, scorer, cand, false); s.v = scorer.score(s.b) + (s.m.build.omnicell === ctx.omnicellPick ? 0.05 : 0); }
  seeds.sort((a, b) => b.v - a.v);
  for (const s of seeds.slice(0, 3)) starts.push({ b: s.b, from: s.m });
  // a fresh start: the best weapon on its own, the best piece per slot on its own
  const fresh = blank(ctx);
  let bestW = null;
  for (const w of cand.weapons) { const t = blank(ctx); t.weapon = w.name; const bo = bondOptions(w, cand)[0]; t.bond = bo ? bo.name : null; t.head = (cand.armour.head[0] || {}).name; t.torso = (cand.armour.torso[0] || {}).name; t.arms = (cand.armour.arms[0] || {}).name; t.legs = (cand.armour.legs[0] || {}).name; t.lantern = cand.lanterns[0].name; const v = fitCells(t, scorer, cand, false); if (!bestW || v > bestW.v) bestW = { v, t }; }
  Object.assign(fresh, bestW.t);
  starts.push({ b: fresh, from: null });
  let best = null;
  for (const s of starts) {
    const v = improve(s.b, ctx, scorer, cand);
    if (!best || v > best.v) best = { v, b: s.b, from: s.from };
  }
  best.b.parts = pickParts(best.b, ctx);
  best.b.weaponCells = best.b.weaponCells.map((c) => c || null);
  const check = validate(best.b);
  if (!check.ok) return { error: 'Lantern could not make a build that passes the game\'s rules: ' + check.errors.join(' '), check };
  return { build: best.b, score: best.v, check, weights: scorer.W, seededFrom: best.from };
}

module.exports = { optimise, perkWeights, metaFrequency, prio, CURVE };
