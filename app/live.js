// Lantern Client - gifts while Dauntless 1.14.7 runs. Licence: AGPL-3.0-only.
//
// The 1.14.7 package's local backend (backend\recorder-1147.js) keeps the save (data\state.json) in memory while the
// game runs, so the save file is never touched from outside then. Gifts go to the backend as the game's own inventory
// transaction (POST /inventory on its "dauntless" port, 63005), which it validates and saves at once. A request from
// this PC with no sign-in token is the host's own player (the backend's "last player"), like the game's servers.
//
// Item shapes are the backend's and the package's tools\items.js's: gear and one-of-a-kind cosmetics are an instanced
// item (the item id doubles as the instance id, updateVersion 1); unlocks and everything counted (currencies, cells,
// materials) are a stack. Which is which comes from tools\gear-1147.json and tools\catalog-1147.json.
'use strict';
const fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto');

const HOST = '127.0.0.1', PORT = 63005;
const GEAR_KINDS = new Set(['Weapons', 'Armour', 'Lanterns', 'Weapon parts', 'Omnicells']);

function call(method, urlPath, body) {
  return new Promise((resolve) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: HOST, port: PORT, method, path: urlPath, timeout: 15000,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, (res) => {
      let s = ''; res.setEncoding('utf8');
      res.on('data', (c) => { s += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(s); } catch {} resolve({ status: res.statusCode, json, text: s }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (data) req.write(data);
    req.end();
  });
}

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return d; } };
let CAT = null, CAT_KEY = '';
function catalogs(pkg) {
  const files = ['gear-1147.json', 'catalog-1147.json'].map((f) => path.join(pkg, 'tools', f));
  const key = pkg + files.map((f) => { try { const st = fs.statSync(f); return st.size + ':' + st.mtimeMs; } catch { return '-'; } }).join('|');
  if (CAT && CAT_KEY === key) return CAT;
  const storage = new Map();
  for (const i of readJson(files[1], {}).items || []) storage.set(i.id, i.storage === 'instance' ? 'i' : 's');
  const picker = (readJson(files[0], {}).items || []);
  for (const g of picker) storage.set(g[0], g[3] === 'i' ? 'i' : 's');   // the picker's word wins (it is what items.js uses)
  CAT = { storage, picker: new Set(picker.map((g) => g[0])), cosmetics: picker.filter((g) => !GEAR_KINDS.has(g[2])).map((g) => g[0]) };
  CAT_KEY = key;
  return CAT;
}

async function inventory(characterId) {
  const r = await call('GET', `/inventory/lantern/${encodeURIComponent(characterId)}`);
  if (r.status !== 200 || !r.json) throw new Error(`Could not read the inventory from the game's backend (${r.status || r.error}).`);
  return { stacked: r.json.stackedItems || [], instanced: r.json.instancedItems || [] };
}
async function transaction(characterId, parts) {
  const body = {
    characterId, transactionId: 'lantern-' + crypto.randomUUID(),
    addInstancedItems: parts.addInstanced || [], addStackedItems: parts.addStacked || [],
    removeInstancedItems: [], removeStackedItems: parts.removeStacked || [], saveInstancedItems: [],
  };
  const r = await call('POST', '/inventory', body);
  if (r.status !== 200) {
    const why = (r.json && (r.json.message || r.json.error)) || { 400: 'the game refused an item', 409: 'the item changed in game at the same moment, try again', 500: 'the backend could not save it' }[r.status];
    throw new Error(`The game's backend said no (${r.status || r.error}${why ? ': ' + why : ''}).`);
  }
}

// What to send for one character. Returns { addInstanced, addStacked, removeStacked, added, already, unknown }
function plan(job, inv, cat) {
  const out = { addInstanced: [], addStacked: [], removeStacked: [], added: [], already: [], unknown: [] };
  const held = (id) => inv.stacked.find((x) => x && x.catalogId === id);
  const ids = new Set(inv.instanced.map((i) => i && i.instanceId));
  const counts = job.counts || {};
  if (job.action === 'atleast') {   // top each stack up to the count; more than that is left as it is
    for (const [id, want] of Object.entries(counts)) {
      const have = Number((held(id) || {}).quantity) || 0;
      if (want > have) { out.addStacked.push({ catalogId: id, quantity: want - have }); out.added.push(id); } else out.already.push(id);
    }
    return out;
  }
  if (job.action === 'set') {
    for (const [id, want] of Object.entries(counts)) {
      const have = Number((held(id) || {}).quantity) || 0;
      if (want > have) out.addStacked.push({ catalogId: id, quantity: want - have });
      else if (want < have) out.removeStacked.push({ catalogId: id, quantity: have - want });
      else { out.already.push(id); continue; }
      out.added.push(id);
    }
    return out;
  }
  // addgear / addcosmetic: anything in the picker
  const list = job.list === 'all' ? cat.cosmetics : (Array.isArray(job.list) ? job.list : []);
  for (const id of list) {
    if (!cat.picker.has(id)) { out.unknown.push(id); continue; }
    if (cat.storage.get(id) === 'i') {
      if (inv.instanced.some((i) => i && i.catalogId === id)) { out.already.push(id); continue; }
      const iid = ids.has(id) ? crypto.randomUUID() : id; ids.add(iid);
      out.addInstanced.push({ catalogId: id, instanceId: iid, updateVersion: 1 });
      out.added.push(id);
    } else {
      if ((Number((held(id) || {}).quantity) || 0) > 0) { out.already.push(id); continue; }
      out.addStacked.push({ catalogId: id, quantity: 1 });
      out.added.push(id);
    }
  }
  return out;
}

// job: { action, character, list|counts }; characters: your character ids (for "*")
async function give(pkg, job, characters) {
  const cat = catalogs(pkg);
  const targets = job.character === '*' ? characters : [job.character];
  if (!targets.length) throw new Error('No characters yet.');
  const result = { added: [], already: [], unknown: [], perCharacter: {} };
  for (const c of targets) {
    const inv = await inventory(c);
    const pl = plan(job, inv, cat);
    const chunk = 400;   // a 2,000-cosmetic unlock in several transactions
    for (let i = 0; i < Math.max(pl.addInstanced.length, pl.addStacked.length); i += chunk) {
      await transaction(c, { addInstanced: pl.addInstanced.slice(i, i + chunk), addStacked: pl.addStacked.slice(i, i + chunk) });
    }
    if (pl.removeStacked.length) await transaction(c, { removeStacked: pl.removeStacked });
    result.perCharacter[c] = pl.added.length;
    for (const k of ['added', 'already', 'unknown']) for (const id of pl[k]) if (!result[k].includes(id)) result[k].push(id);
  }
  return result;
}

module.exports = { give, plan, catalogs };
