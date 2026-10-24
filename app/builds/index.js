// Lantern Client - Meta Build Creator: the entry point the panel uses. Licence: AGPL-3.0-only.
//
// options() lists what the player can choose from; generate() makes a build in a worker thread (the search takes about
// a second and must not hold up the panel or the overlay) and keeps the last results, so asking again is instant.
'use strict';
const path = require('path');
const { Worker } = require('worker_threads');
const { kb } = require('./data.js');
const { GOALS } = require('./goals.js');

function options() {
  const K = kb();
  const weapons = {};
  for (const t of K.weaponTypes) {
    weapons[t] = K.weapons.filter((w) => w.type === t && !w.event).map((w) => ({ name: w.name, element: w.element, behemoth: w.behemoth, exotic: w.exotic, legendary: !!w.bond }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  return {
    game: K.about.game, dataVersion: K.about.dataVersion, note: K.about.note, sources: K.about.sources.filter((s) => s.url),
    metaBuilds: K.metaBuilds.length,
    goals: Object.entries(GOALS).map(([id, g]) => ({ id, label: g.label, blurb: g.blurb })),
    weaponTypes: K.weaponTypes, weapons,
    omnicells: K.omnicells.map((o) => ({ name: o.name, passive: o.passive, active: o.active })),
    behemoths: Object.entries(K.behemoths).map(([name, element]) => ({ name, element })).sort((a, b) => a.name.localeCompare(b.name)),
    elements: ['Blaze', 'Frost', 'Shock', 'Terra', 'Radiant', 'Umbral', 'Neutral'],
    universal: 'One build for every behemoth: no element favoured, and armour whose weaknesses are spread out so no single element hits every piece.',
  };
}

// a request -> a clean context (anything unknown is dropped)
function context(req) {
  const K = kb();
  const goals = [...new Set((Array.isArray(req.goals) ? req.goals : []).filter((g) => GOALS[g]))].slice(0, 6);
  if (!goals.length) return { error: 'Pick at least one goal.' };
  if (!K.weaponTypes.includes(req.weaponType)) return { error: 'Pick a weapon type.' };
  const weapon = req.weapon && K.weapons.some((w) => w.name === req.weapon && w.type === req.weaponType) ? req.weapon : null;
  const elements = ['Blaze', 'Frost', 'Shock', 'Terra', 'Radiant', 'Umbral', 'Neutral'];
  // Universal: one build for every behemoth (no element favoured, armour weaknesses spread)
  const universal = req.target === 'Universal';
  const target = universal ? null : elements.includes(req.target) ? req.target : (K.behemoths[req.target] || null);
  return {
    weaponType: req.weaponType, weapon, goals, target, universal,
    content: ['hunts', 'escalation', 'trials'].includes(req.content) ? req.content : 'hunts',
    risk: req.risk === 'safe' ? 'safe' : 'any',
    omnicell: K.omnicells.some((o) => o.name === req.omnicell) ? req.omnicell : 'auto',
    avoid: (Array.isArray(req.avoid) ? req.avoid : []).map(String).slice(0, 30),
    ownedOnly: !!req.ownedOnly,
  };
}

const cache = new Map();   // request -> result (the last 30)
let worker = null, seq = 0;
const waiting = new Map();
function getWorker() {
  if (worker) return worker;
  worker = new Worker(path.join(__dirname, 'worker.js'));
  worker.unref();
  worker.on('message', (m) => { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m.result); } });
  const fail = (e) => { for (const w of waiting.values()) w({ error: 'The build maker stopped: ' + (e && e.message || e) }); waiting.clear(); worker = null; };
  worker.on('error', fail);
  worker.on('exit', (c) => { if (waiting.size) fail('exit ' + c); worker = null; });
  return worker;
}

// owned: { gear: [ids], cells: { id: count } } or null
function generate(req, owned) {
  const ctx = context(req || {});
  if (ctx.error) return Promise.resolve({ ok: false, error: ctx.error });
  if (ctx.ownedOnly && !owned) return Promise.resolve({ ok: false, error: 'Your save could not be read, so Lantern cannot tell what you own. Turn off "Only gear I own".' });
  const key = JSON.stringify([ctx, ctx.ownedOnly ? owned : null]);
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  const id = ++seq;
  return new Promise((resolve) => {
    const t = setTimeout(() => { waiting.delete(id); resolve({ ok: false, error: 'Making the build took too long.' }); }, 30000);
    waiting.set(id, (result) => {
      clearTimeout(t);
      if (result && result.ok) { cache.set(key, result); while (cache.size > 30) cache.delete(cache.keys().next().value); }
      resolve(result);
    });
    getWorker().postMessage({ id, ctx, owned: ctx.ownedOnly ? owned : null });
  });
}

module.exports = { options, generate, context };
