// Lantern Client - gifts with the game closed, for what the package's tools\items.js cannot do. Licence: AGPL-3.0-only.
//
// The 1.6.2 package's items.js adds gear at level 0 only (list, set, addgear, removegear, addcosmetic). Giving gear at
// max level and "Max all my gear" are done here instead, on the save itself, the same way items.js changes it:
//   - only your own characters (the ids come from items.js list), only while the game's backend is not running
//   - the save is backed up first, next to items.js's own backups (backup\inventory, the last 10 kept)
//   - item shapes come from live.js's plan(), the same shapes the game itself and the live path use
//
//   node offline.js <package folder> <job JSON> <your character ids JSON>
//   -> {"ok":true,"added":[...],"already":[...],"raised":[...],"unknown":[...]}
'use strict';
const fs = require('fs'), net = require('net'), path = require('path');
const { plan, catalogs } = require('./live.js');

const out = (o) => { process.stdout.write(JSON.stringify(o)); };
const fail = (error) => { out({ ok: false, error }); process.exit(0); };
const KEEP_BACKUPS = 10;

function backendUp() {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: 61000 });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(800, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}
function backup(pkg, db) {
  const dir = path.join(pkg, 'backup', 'inventory');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  fs.copyFileSync(db, path.join(dir, `undaunted.db.${stamp}`));
  const old = fs.readdirSync(dir).filter((f) => f.startsWith('undaunted.db.')).sort();
  for (const f of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
}
const levelOf = (i) => { try { return Number(JSON.parse(i.itemData || '{}').CurrentLevel) || 0; } catch { return 0; } };
// an owned piece of gear at its top level: same itemData shape as new max-level gear, and a new update version
function raise(i, top) {
  return { ...i, itemData: JSON.stringify({ ...(() => { try { return JSON.parse(i.itemData || '{}'); } catch { return {}; } })(), CurrentLevel: top, CurrentXP: 0 }), updateVersion: (Number(i.updateVersion) || 0) + 1 };
}

(async () => {
  const [pkg, jobText, charsText] = process.argv.slice(2);
  if (!pkg || !jobText) fail('Usage: node offline.js <package> <job JSON> <character ids JSON>');
  const DB = path.join(pkg, 'data', 'undaunted.db');
  if (!fs.existsSync(DB)) fail('No save yet. Press Play once and make a character first.');
  let Database;
  try { Database = require(path.join(pkg, 'backend', 'metagame', 'node_modules', 'better-sqlite3')); } catch { fail('The server files are not set up yet. Run Set up in the Dauntless Forever launcher first.'); }
  let job, mine;
  try { job = JSON.parse(jobText); mine = new Set(JSON.parse(charsText || '[]')); } catch { fail('Bad request.'); }
  if (await backendUp()) fail('Dauntless is still running. Close the game (and the launcher\'s server window), then try again.');

  const cat = catalogs(pkg);
  const top = (id) => { const p = cat.levels[id]; return p && Number.isInteger(p.surged) ? p.surged : null; };
  const result = { ok: true, added: [], already: [], raised: [], unknown: [] };
  const writes = [];
  const db = new Database(DB, { fileMustExist: true });
  try {
    const rows = db.prepare('select characterId, instancedItems, stackedItems from inventories').all()
      .filter((r) => mine.has(r.characterId) && (job.character === '*' || r.characterId === job.character));
    if (!rows.length) fail('Character not found.');
    for (const r of rows) {
      let inst = JSON.parse(r.instancedItems || '[]'), stacks = JSON.parse(r.stackedItems || '[]'), changed = false;
      const push = (k, id) => { if (!result[k].includes(id)) result[k].push(id); };
      if (job.action === 'surgeall') {
        inst = inst.map((i) => {
          const t = i && top(i.catalogId);
          if (t === null || t === undefined || levelOf(i) >= t) return i;
          changed = true; push('raised', i.catalogId); return raise(i, t);
        });
      } else {
        const pl = plan(job, { instanced: inst, stacked: stacks }, cat);
        inst = inst.concat(pl.addInstanced);
        for (const a of pl.addStacked) {
          const s = stacks.find((x) => x && x.catalogId === a.catalogId);
          if (s) s.quantity = (Number(s.quantity) || 0) + a.quantity; else stacks.push({ catalogId: a.catalogId, quantity: a.quantity });
        }
        if (pl.addInstanced.length || pl.addStacked.length) changed = true;
        pl.added.forEach((id) => push('added', id)); pl.unknown.forEach((id) => push('unknown', id));
        // owned gear asked for at max level: already yours; raised if it is below its top level
        for (const id of pl.already) push('already', id);
        for (const id of pl.ownedForMax) {
          const t = top(id); let did = false;
          inst = inst.map((i) => { if (i && i.catalogId === id && t !== null && levelOf(i) < t) { did = true; return raise(i, t); } return i; });
          if (did) { changed = true; push('raised', id); } else push('already', id);
        }
      }
      if (changed) writes.push([JSON.stringify(inst), JSON.stringify(stacks), r.characterId]);
    }
  } finally { try { db.close(); } catch {} }
  if (writes.length) {
    backup(pkg, DB);
    const w = new Database(DB, { fileMustExist: true });
    try { const u = w.prepare('update inventories set instancedItems=?, stackedItems=? where characterId=?'); w.transaction(() => { for (const x of writes) u.run(...x); })(); } finally { w.close(); }
  }
  out(result);
})().catch((e) => fail(String(e && e.message || e)));
