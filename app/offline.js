// Lantern Client - changes to the 1.14.7 save with the game closed, for what the package's tools\items.js cannot do.
// Licence: AGPL-3.0-only.
//
// items.js (1.14.7) lists, sets counts, and adds gear and cosmetics. Two things are done here instead, on the save
// itself (data\state.json), the way items.js changes it:
//   atleast     top counted items (cells, materials) up to a number, never lowering one
//   maxweapons  every weapon type to level 20 (players.<you>.progress.tracks.ExperienceTrack_Weapon_<type>)
//   remove      take gear and cosmetic unlocks away (a big inventory makes the game stutter), never anything in use
//               (protect.js)
// Only your own characters (the ids come from items.js list), only while the local backend is not running (it keeps
// the save in memory and would write over the change), the save is backed up first (backup\inventory, the last 10
// kept, next to items.js's own backups), and it is written to a temporary file and read back before it replaces it.
//
//   node offline.js <package folder> <job JSON> <your character ids JSON>
//   node offline.js --args <file holding that list of three, as JSON>
//   -> {"ok":true,"added":[...],"already":[...],"raised":[...],"unknown":[...]}
'use strict';
const fs = require('fs'), net = require('net'), path = require('path');
const { plan, catalogs } = require('./live.js');
const { protectedIds, isStarter } = require('./protect.js');

const out = (o) => { process.stdout.write(JSON.stringify(o)); };
const fail = (error) => { out({ ok: false, error }); process.exit(0); };
const KEEP_BACKUPS = 10;
const WEAPON_TYPES = ['Axe', 'ChainBlades', 'Hammer', 'Repeaters', 'Spear', 'Strikers', 'Sword'];
const LEVEL20_XP = 27775;   // 1.14.7's weapon curve to level 20 (the package's slayer-copy.js)

function portUp(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(800, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}
function backup(pkg, file) {
  const dir = path.join(pkg, 'backup', 'inventory');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  fs.copyFileSync(file, path.join(dir, `state.json.${stamp}`));
  const old = fs.readdirSync(dir).filter((f) => f.startsWith('state.json.')).sort();
  for (const f of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
}
function writeState(file, state) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  JSON.parse(fs.readFileSync(tmp, 'utf8'));   // read back before it replaces the save
  fs.renameSync(tmp, file);
}

(async () => {
  let argv = process.argv.slice(2);
  if (argv[0] === '--args') { try { argv = JSON.parse(fs.readFileSync(argv[1], 'utf8')); } catch { fail('Bad request.'); } }   // long lists come in a file
  const [pkg, jobText, charsText] = argv;
  if (!pkg || !jobText) fail('Usage: node offline.js <package> <job JSON> <character ids JSON>');
  const STATE = path.join(pkg, 'data', 'state.json');
  if (!fs.existsSync(STATE)) fail('No save yet. Press Play once and make a character first.');
  let job, mine;
  try { job = JSON.parse(jobText); mine = new Set(JSON.parse(charsText || '[]')); } catch { fail('Bad request.'); }
  if (await portUp(63000)) fail('Dauntless is still running. Close the game (and the launcher\'s server window), then try again.');
  let state;
  try { state = JSON.parse(fs.readFileSync(STATE, 'utf8').replace(/^﻿/, '')); } catch { fail('The save file could not be read (data\\state.json).'); }

  // your player: the one whose characters items.js listed as yours
  const players = Object.values(state.players || {});
  const me = players.find((p) => (p.characters || []).some((c) => c && mine.has(c.id)));
  if (!me) fail('Character not found.');
  const targets = (me.characters || []).filter((c) => c && mine.has(c.id) && (job.character === '*' || c.id === job.character));
  if (!targets.length) fail('Character not found.');

  const result = { ok: true, added: [], already: [], raised: [], unknown: [], removed: [], kept: [], starter: [] };
  const push = (k, id) => { if (!result[k].includes(id)) result[k].push(id); };
  let changed = false;
  if (job.action === 'maxweapons') {
    me.progress = me.progress || { tracks: {}, objectives: {} };
    me.progress.tracks = me.progress.tracks || {};
    for (const w of WEAPON_TYPES) {
      const id = 'ExperienceTrack_Weapon_' + w;
      const t = me.progress.tracks[id] || { progress: 0 };
      if ((Number(t.progress) || 0) < LEVEL20_XP) { t.progress = LEVEL20_XP; me.progress.tracks[id] = t; changed = true; push('raised', w); }
      else push('already', w);
    }
  } else if (job.action === 'remove') {
    const cat = catalogs(pkg), want = new Set((job.list || []).filter((id) => cat.picker.has(id)));
    (job.list || []).filter((id) => !cat.picker.has(id)).forEach((id) => push('unknown', id));
    me.inventory = me.inventory || {};
    for (const c of targets) {
      const inv = me.inventory[c.id]; if (!inv) continue;
      const keep = protectedIds(me, c.id);
      const drop = (i) => {
        if (!i || !want.has(i.catalogId)) return false;
        if (isStarter(i.catalogId)) { push('starter', i.catalogId); return false; }   // failsafe: starting kit stays
        if (keep.has(i.catalogId) || (i.instanceId && keep.has(i.instanceId))) { push('kept', i.catalogId); return false; }
        push('removed', i.catalogId); changed = true; return true;
      };
      if (Array.isArray(inv.stackedItems)) inv.stackedItems = inv.stackedItems.filter((i) => !drop(i));
      if (Array.isArray(inv.instancedItems)) inv.instancedItems = inv.instancedItems.filter((i) => !drop(i));
    }
  } else {
    const cat = catalogs(pkg);
    me.inventory = me.inventory || {};
    for (const c of targets) {
      const inv = me.inventory[c.id] || (me.inventory[c.id] = { stackedItems: [], instancedItems: [] });
      if (!Array.isArray(inv.stackedItems)) inv.stackedItems = [];
      if (!Array.isArray(inv.instancedItems)) inv.instancedItems = [];
      const pl = plan(job, { stacked: inv.stackedItems, instanced: inv.instancedItems }, cat);
      inv.instancedItems.push(...pl.addInstanced);
      for (const a of pl.addStacked) {
        const s = inv.stackedItems.find((x) => x && x.catalogId === a.catalogId);
        if (s) s.quantity = (Number(s.quantity) || 0) + a.quantity; else inv.stackedItems.push({ catalogId: a.catalogId, quantity: a.quantity });
      }
      for (const r of pl.removeStacked) {
        const s = inv.stackedItems.find((x) => x && x.catalogId === r.catalogId);
        if (s) s.quantity = Math.max(0, (Number(s.quantity) || 0) - r.quantity);
      }
      if (pl.addInstanced.length || pl.addStacked.length || pl.removeStacked.length) changed = true;
      pl.added.forEach((id) => push('added', id)); pl.already.forEach((id) => push('already', id)); pl.unknown.forEach((id) => push('unknown', id));
    }
  }
  if (changed) { backup(pkg, STATE); writeState(STATE, state); }
  out(result);
})().catch((e) => fail(String(e && e.message || e)));
