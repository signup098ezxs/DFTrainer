// Lantern Client - live gifts while the game runs. Licence: AGPL-3.0-only.
//
// While Dauntless runs, its backend (127.0.0.1:61000) owns the save. Writing the save from outside could make one of
// the backend's own transactions fail with "database is locked" (a reward the game was saving at that moment). So the
// trainer does what the game does instead: it logs in with your own player key (data\player.key, the same exchange the
// game makes at start-up) and sends POST /inventory transactions. The backend applies them on its own connection, in
// its own transaction, with its own checks: nothing can collide.
//
// Item shapes follow tools\items.js exactly (new gear: instanceId = the item id, updateVersion 0; max level: itemData
// {CurrentLevel: top, CurrentXP: 0} with updateVersion 1; cosmetics as unlock stacks or one-of-a-kind items per
// tools\cosmetics-162.json). Lowering an amount is sent on its own, never in a transaction that adds gear, so the Free
// crafting rule (which keeps what a crafting transaction spends) can't swallow it.
'use strict';
const fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto');

const PORT = 61000;
function call(method, url, body, token) {
  return new Promise((resolve) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: url, timeout: 15000,
      headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } },
    (res) => {
      let s = ''; res.on('data', (c) => { s += c; });
      res.on('end', () => { let j = null; try { j = s ? JSON.parse(s) : null; } catch {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (data) req.write(data);
    req.end();
  });
}

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return d; } };
function catalogs(pkg) {
  const gear = readJson(path.join(pkg, 'tools', 'gear-162.json'), []);
  const cos = readJson(path.join(pkg, 'tools', 'cosmetics-162.json'), {});
  const levels = readJson(path.join(pkg, 'tools', 'import-gear-levels162.json'), {});
  return { gearIds: new Set(gear.map((g) => g[0])), gear, stacked: new Set(cos.stacked || []), instanced: new Set(cos.instanced || []), levels };
}

let session = null;   // { token, account, at, pkg }
async function login(pkg) {
  if (session && session.pkg === pkg && Date.now() - session.at < 12 * 3600 * 1000) return session;
  const key = (() => { try { return fs.readFileSync(path.join(pkg, 'data', 'player.key'), 'utf8').trim(); } catch { return ''; } })();
  if (!key.startsWith('UUK_')) throw new Error('Your player key (data\\player.key) is missing. Run Set up in the launcher.');
  const r = await call('POST', '/account/api/oauth/token', { grant_type: 'exchange_code', exchange_code: key });
  if (r.status !== 200 || !r.json || !r.json.access_token) throw new Error(`The game's server did not accept the login (${r.status || r.error}).`);
  session = { token: r.json.access_token, account: r.json.account_id, at: Date.now(), pkg };
  return session;
}

// The trainer's own inventory reads show up in the backend log like the game's; the log follower skips these.
const ownReads = new Map();
function takeOwnRead(characterId) {
  const n = ownReads.get(characterId) || 0;
  if (n > 0) { ownReads.set(characterId, n - 1); return true; }
  return false;
}
async function inventory(s, characterId) {
  ownReads.set(characterId, (ownReads.get(characterId) || 0) + 1);
  const r = await call('GET', `/inventory/${encodeURIComponent(s.account)}/${encodeURIComponent(characterId)}`, null, s.token);
  if (r.status !== 200 || !r.json) { takeOwnRead(characterId); throw new Error(`Could not read the inventory from the game's server (${r.status || r.error}).`); }
  return { stacked: r.json.stackedItems || [], instanced: r.json.instancedItems || [] };
}
async function transaction(s, characterId, parts) {
  const body = {
    characterId, transactionId: 'dftrainer-' + crypto.randomUUID(),
    addInstancedItems: parts.addInstanced || [], addStackedItems: parts.addStacked || [],
    removeInstancedItems: [], removeStackedItems: parts.removeStacked || [], saveInstancedItems: [],
  };
  const r = await call('POST', '/inventory', body, s.token);
  if (r.status !== 200) {
    const why = { 403: 'that character is not yours', 400: 'the game refused an item', 409: 'the item changed in game at the same moment, try again', 500: 'the game\'s server could not save it' }[r.status];
    throw new Error(`The game's server said no (${r.status || r.error}${why ? ': ' + why : ''}).`);
  }
}

// What to send for one character. Returns { addInstanced, addStacked, removeStacked, added, already, unknown, ownedForMax }
function plan(job, inv, cat) {
  const out = { addInstanced: [], addStacked: [], removeStacked: [], added: [], already: [], unknown: [], ownedForMax: [] };
  const held = (id) => inv.stacked.find((x) => x && x.catalogId === id);
  const ids = new Set(inv.instanced.map((i) => i && i.instanceId));
  const newInstanceId = (id) => (ids.has(id) ? crypto.randomUUID() : id);
  const topLevel = (id) => { const p = cat.levels[id]; return p && Number.isInteger(p.surged) ? p.surged : null; };
  const unlock = (id) => {   // a cosmetic: unlock stack or one-of-a-kind item
    if (cat.instanced.has(id)) {
      if (inv.instanced.some((i) => i && i.catalogId === id)) return out.already.push(id);
      const iid = newInstanceId(id); ids.add(iid);
      out.addInstanced.push({ catalogId: id, instanceId: iid, itemData: null, updateVersion: 0 });
      return out.added.push(id);
    }
    if (/^TY_/.test(id) && (held(id) || {}).quantity > 0) return out.already.push(id);   // charges are counted, never cut to 1
    if ((held(id) || {}).quantity > 0) return out.already.push(id);
    out.addStacked.push({ catalogId: id, quantity: 1 });
    out.added.push(id);
  };

  if (job.action === 'atleast') {   // top each stack up to the count; more than that is left as it is
    for (const [id, want] of Object.entries(job.counts)) {
      const have = Number((held(id) || {}).quantity) || 0;
      if (want > have) { out.addStacked.push({ catalogId: id, quantity: want - have }); out.added.push(id); } else out.already.push(id);
    }
    return out;
  }
  if (job.action === 'set') {
    for (const [id, want] of Object.entries(job.counts)) {
      const have = Number((held(id) || {}).quantity) || 0;
      if (want > have) out.addStacked.push({ catalogId: id, quantity: want - have });
      else if (want < have) out.removeStacked.push({ catalogId: id, quantity: have - want });
      else { out.already.push(id); continue; }
      out.added.push(id);
    }
    return out;
  }
  let list = job.list;
  if (job.action === 'addcosmetic' && list === 'all') {
    const pick = new Set(cat.gear.filter((g) => g[2] !== 'Curiosities (charges)').map((g) => g[0]));
    list = [...cat.stacked, ...cat.instanced].filter((id) => pick.has(id) && !/^TY_/.test(id));
  }
  for (const id of list) {
    if (job.action === 'addcosmetic') {
      if (!cat.stacked.has(id) && !cat.instanced.has(id)) { out.unknown.push(id); continue; }
      unlock(id); continue;
    }
    // addgear / addgearmax
    if (!cat.gearIds.has(id)) { out.unknown.push(id); continue; }
    if (cat.stacked.has(id)) { unlock(id); continue; }
    const mineNow = inv.instanced.filter((i) => i && i.catalogId === id);
    if (mineNow.length) {
      // yours already: only something to do if it was asked for at max level and is below it
      const levelOf = (i) => { try { return Number(JSON.parse(i.itemData || '{}').CurrentLevel) || 0; } catch { return 0; } };
      const t = topLevel(id);
      if (job.action === 'addgearmax' && t !== null && mineNow.some((i) => levelOf(i) < t)) out.ownedForMax.push(id); else out.already.push(id);
      continue;
    }
    const iid = newInstanceId(id); ids.add(iid);
    const top = job.action === 'addgearmax' ? topLevel(id) : null;
    out.addInstanced.push(top !== null
      ? { catalogId: id, instanceId: iid, itemData: JSON.stringify({ CurrentLevel: top, CurrentXP: 0 }), updateVersion: 1 }
      : { catalogId: id, instanceId: iid, updateVersion: 0 });
    out.added.push(id);
  }
  return out;
}

// job: { action, character, list|counts }; characters: your character ids (for "*")
async function give(pkg, job, characters) {
  const cat = catalogs(pkg);
  const s = await login(pkg);
  const targets = job.character === '*' ? characters : [job.character];
  if (!targets.length) throw new Error('No characters yet.');
  const result = { added: [], already: [], unknown: [], ownedForMax: [], perCharacter: {} };
  for (const c of targets) {
    const inv = await inventory(s, c);
    const pl = plan(job, inv, cat);
    // adds in chunks (a 2,000-cosmetic unlock is one big transaction otherwise), removals on their own
    const chunk = 400;
    for (let i = 0; i < Math.max(pl.addInstanced.length, pl.addStacked.length); i += chunk) {
      await transaction(s, c, { addInstanced: pl.addInstanced.slice(i, i + chunk), addStacked: pl.addStacked.slice(i, i + chunk) });
    }
    if (pl.removeStacked.length) await transaction(s, c, { removeStacked: pl.removeStacked });
    result.perCharacter[c] = pl.added.length;
    for (const k of ['added', 'already', 'unknown', 'ownedForMax']) for (const id of pl[k]) if (!result[k].includes(id)) result[k].push(id);
  }
  return result;
}

module.exports = { give, takeOwnRead, plan, catalogs, _reset: () => { session = null; } };
