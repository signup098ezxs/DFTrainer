// Lantern Client panel - a separate companion for Dauntless Forever (Dauntless 1.6.2), single player.
// Licence: AGPL-3.0-only (it drives Dauntless Forever's AGPL tools and ships an AGPL mod). Keep this notice.
//
// A small local web server (127.0.0.1 only, no dependencies) behind the panel window:
//   - items: with the game closed, the package's own tools\items.js edits the save. While the game runs, live.js
//     sends the gift to the game's own backend as an inventory transaction (logged in with your player key, like the
//     game), so it is saved at once without ever touching the save from outside. Only raising gear you already own
//     waits for the game to close (the game saves weapon XP by item version).
//   - real time: the panel gets a live event stream (Server-Sent Events). Gifts are announced in game chat through
//     data\announce.txt (the backend says that file's text in chat every 2 s), and logs\metagame.log is followed so
//     the panel knows the moment the game loads your inventory again: "delivered".
//   - in-game switches: trainer-toggles.json in the DFTrainer UE4SS mod's folder (game + hidden servers read it).
//   - game rules: data\rules.txt, like the launcher's Game Rules page.
//
//   node server.js [--package "<...>\versions\1.6.2"] [--no-open] [--port 61777]
'use strict';
const fs = require('fs'), path = require('path'), http = require('http'), net = require('net'), crypto = require('crypto'), os = require('os');
const { execFile, spawn } = require('child_process');

const HERE = __dirname;
const UI_FILE = path.join(HERE, 'ui', 'index.html');
const MOD_SRC = path.join(HERE, 'mod', 'DFTrainer');
const LIVE = require('./live.js');
// Installed by the launcher, each version lives in its own folder (app\<version>): settings live one level up, in the
// install folder (DFT_ROOT), so updates keep them. Started by hand (node server.js), they stay next to this file.
const ROOT = process.env.DFT_ROOT || null;
const LAUNCHER = process.env.DFT_LAUNCHER && fs.existsSync(process.env.DFT_LAUNCHER) ? process.env.DFT_LAUNCHER : null;
const SETTINGS = path.join(ROOT || HERE, 'trainer-settings.json');
if (ROOT && !fs.existsSync(SETTINGS) && fs.existsSync(path.join(HERE, 'trainer-settings.json'))) {
  try { fs.copyFileSync(path.join(HERE, 'trainer-settings.json'), SETTINGS); } catch {}
}
const MOD_NAME = 'DFTrainer';
const BACKEND_PORT = 61000;
const IS_WIN = process.platform === 'win32';
const TOKEN = crypto.randomBytes(16).toString('hex');

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const NO_OPEN = argv.includes('--no-open');
let PORT = Number(arg('--port')) || 61777;

// ---------------------------------------------------------------- settings and paths
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return d; } };
let settings = readJson(SETTINGS, {});
const VERSION = process.env.DFT_VERSION || readJson(path.join(HERE, 'release.json'), {}).version || 'dev';
const saveSettings = () => { try { fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2)); } catch {} };
const RELEASE = readJson(path.join(HERE, 'release.json'), {});

// ---------------------------------------------------------------- license key (keys.js)
// Without a valid key only the key screen, appearance settings and updates work, and the game mod is told to stay off.
// keys.js, not license.js: Windows ignores case in file names, so asking for ./license without .js loaded LICENSE (the AGPL text)
const LIC = require('./keys.js')({
  dataDir: ROOT || HERE, repo: RELEASE.repo,
  onChange(s, was) {
    if (!was) return;   // the first check, at start: listen() syncs the mod once everything is loaded
    {
      if (!s.ok && was.ok) note('error', s.state === 'expired' ? 'Your key ran out' : s.state === 'revoked' ? 'Your key was revoked' : 'Key removed', 'Enter a new key to keep using Lantern Client.');
      else if (s.ok && !was.ok) note('ok', s.owner ? 'Owner tools unlocked' : `Welcome, ${s.name}`, s.owner ? '' : (s.expires ? `Your key runs until ${new Date(s.expires).toLocaleDateString()}.` : 'Your key never runs out.'));
    }
    try { const p = places(); if (p.pkg) writeToggles(p, settings.toggles || {}); } catch {}
    if (typeof tickState === 'function') setTimeout(() => tickState().catch(() => {}), 0);
  },
});
const OPEN_ROUTES = new Set(['GET /api/state', 'GET /api/prefs', 'POST /api/prefs', 'POST /api/update/check', 'POST /api/update/restart',
  'GET /api/license', 'POST /api/license', 'POST /api/license/remove', 'POST /api/owner/import']);

function isPackage(dir) { return !!dir && fs.existsSync(path.join(dir, 'tools', 'items.js')) && fs.existsSync(path.join(dir, 'tools', 'gear-162.json')); }
function findPackage() {
  const tries = [arg('--package'), process.env.DF_PACKAGE, settings.package];
  const la = process.env.LOCALAPPDATA;
  if (la) for (const root of ['DauntlessForever', 'DauntlessOffline']) tries.push(path.join(la, root, 'versions', '1.6.2'));
  return tries.find(isPackage) || null;
}
let placesCache = null, placesAt = 0;
function places() {
  if (placesCache && Date.now() - placesAt < 3000) return placesCache;
  placesCache = placesUncached(); placesAt = Date.now();
  return placesCache;
}
function placesUncached() {
  const pkg = findPackage();
  if (!pkg) return { pkg: null };
  const cfg = readJson(path.join(pkg, 'config.json'), {});
  const gameDir = cfg.GameDir || null;
  const ue = gameDir ? path.join(gameDir, 'Archon', 'Binaries', 'Win64', 'ue4ss') : null;
  return {
    pkg, gameDir, node: (cfg.Node && fs.existsSync(cfg.Node)) ? cfg.Node : process.execPath,
    ue4ssDll: ue && path.join(ue, 'UE4SS.dll'), modsDir: ue && path.join(ue, 'Mods'), modDir: ue && path.join(ue, 'Mods', MOD_NAME),
    dataDir: path.join(pkg, 'data'), metaLog: path.join(pkg, 'logs', 'metagame.log'),
  };
}

// ---------------------------------------------------------------- item names
// tools/gear-162.json names some items only after their id ("Ac Hp11B Engineer 00"). Better names come from, in order:
//   1. the player's own game files: names.js reads the game's catalog assets (once per game version, in the
//      background; it checks itself against the names already known and only fills in gaps when it agrees)
//   2. item-names-162.json, shipped with Lantern Client (names verified from the 1.14.7 catalog)
// An item that has no name anywhere is shown by its id and marked as unnamed.
const placeholderOf = (id) => id.split('_').slice(1).join(' ').toLowerCase();
const SHIPPED_NAMES = readJson(path.join(HERE, 'item-names-162.json'), {}).names || {};
const NAMES_CACHE = path.join(ROOT || HERE, 'item-names-game.json');
let gameNames = readJson(NAMES_CACHE, {}).names || {};
let CATALOG = null, CATALOG_KEY = '';
function catalog(p) {
  const key = p.pkg + '|' + Object.keys(gameNames).length;
  if (CATALOG && CATALOG_KEY === key) return CATALOG;
  const cos = readJson(path.join(p.pkg, 'tools', 'cosmetics-162.json'), {});
  const cosmetic = new Set([...(cos.stacked || []), ...(cos.instanced || [])]);
  const names = new Map();
  const gear = readJson(path.join(p.pkg, 'tools', 'gear-162.json'), []).map((g) => {
    const placeholder = g[1].toLowerCase() === placeholderOf(g[0]);
    const name = placeholder ? (gameNames[g[0]] || SHIPPED_NAMES[g[0]] || null) : g[1];
    names.set(g[0], name || g[0]);
    return [g[0], name || g[0], g[2], cosmetic.has(g[0]) ? 1 : 0, name ? 0 : 1];   // id, name, group, cosmetic, unnamed
  });
  for (const grp of readJson(path.join(p.pkg, 'items.json'), {}).groups || []) for (const i of grp.items || []) names.set(i.id, i.name);
  CATALOG = { gear, names }; CATALOG_KEY = key;
  return CATALOG;
}
function nameOf(p, id) { return catalog(p).names.get(id) || cellName(id) || id; }

// ---------------------------------------------------------------- cells
// Cells are stacked items (a count), CELL_<perk>_<UC|R|E> for +1, +2 and +3 (a few perks exist at one level only).
// The list comes from the package's tools\catalog162-ids.txt. CELL_DP_* are Repeater mods, not slottable cells.
const CELL_LEVEL = { UC: 1, R: 2, E: 3 };
function cellName(id) {
  const m = /^CELL_([A-Z0-9_]+)_(UC|R|E)$/.exec(id || '');
  if (!m) return null;
  const words = m[1].toLowerCase().split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return `+${CELL_LEVEL[m[2]]} ${words} cell`;
}
let CELLS = null, CELLS_KEY = '';
function cells(p) {
  const f = path.join(p.pkg, 'tools', 'catalog162-ids.txt');
  let st; try { st = fs.statSync(f); } catch { return []; }
  const key = f + st.size + st.mtimeMs;
  if (CELLS && CELLS_KEY === key) return CELLS;
  const out = [];
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const id = line.trim(), m = /^CELL_([A-Z0-9_]+)_(UC|R|E)$/.exec(id);
    if (m && !id.startsWith('CELL_DP_')) out.push([id, m[1], CELL_LEVEL[m[2]]]);
  }
  CELLS = out; CELLS_KEY = key;
  return out;
}

// read names from the game files when the game's paks changed (or never were read)
let namesRunning = false;
function paksKey(gameDir) {
  try {
    const d = path.join(gameDir, 'Archon', 'Content', 'Paks');
    return fs.readdirSync(d).filter((f) => /^Archon_\d+-WindowsClient\.pak$/i.test(f)).sort()
      .map((f) => { const st = fs.statSync(path.join(d, f)); return `${f}:${st.size}:${Math.round(st.mtimeMs)}`; }).join('|');
  } catch { return ''; }
}
function readGameNames() {
  const p = places();
  if (namesRunning || !p.pkg || !p.gameDir) return;
  const key = paksKey(p.gameDir);
  if (!key || readJson(NAMES_CACHE, {}).key === key) return;
  namesRunning = true;
  const known = {};
  for (const g of readJson(path.join(p.pkg, 'tools', 'gear-162.json'), [])) known[g[0]] = g[1].toLowerCase() === placeholderOf(g[0]) ? (SHIPPED_NAMES[g[0]] || null) : g[1];
  const tmp = path.join(require('os').tmpdir(), `dft-ids-${process.pid}.json`), out = NAMES_CACHE + '.new';
  fs.writeFileSync(tmp, JSON.stringify(known));
  execFile(process.execPath, [path.join(HERE, 'names.js'), p.gameDir, tmp, out], { timeout: 5 * 60 * 1000, windowsHide: true, maxBuffer: 1 << 20 }, (e, stdout) => {
    namesRunning = false;
    try { fs.unlinkSync(tmp); } catch {}
    let r = null; try { r = JSON.parse(String(stdout || '')); } catch {}
    const res = readJson(out, null);
    try { fs.unlinkSync(out); } catch {}
    if (!r || !r.ok || !res) return;   // nothing readable: keep what we have, try again next start
    gameNames = res.names || {};
    try { fs.writeFileSync(NAMES_CACHE, JSON.stringify({ key, at: Date.now(), checked: res.checked, agreed: res.agreed, assets: res.assets, names: gameNames })); } catch {}
    CATALOG = null;
    push('catalog', { names: Object.keys(gameNames).length });
    if (Object.keys(gameNames).length) note('mod', 'Item names updated', `${Object.keys(gameNames).length} names read from your game files.`);
  });
}
setTimeout(readGameNames, 4000);
setInterval(readGameNames, 10 * 60 * 1000);

const listNames = (p, ids, max = 2) => {
  const n = ids.map((i) => nameOf(p, i));
  return n.length <= max ? n.join(', ') : `${n.slice(0, max).join(', ')} and ${n.length - max} more`;
};

// ---------------------------------------------------------------- helpers
function backendUp() {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: BACKEND_PORT });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(600, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}
function runTool(p, script, args, { timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    execFile(p.node, [path.join(p.pkg, 'tools', script), ...args], { cwd: p.pkg, timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (e, out) => {
      const text = String(out || '').trim();
      try { resolve(JSON.parse(text)); }
      catch { resolve({ ok: false, error: e ? `${script} failed: ${e.message.split('\n')[0]}` : `${script} gave no answer.` }); }
    });
  });
}
// Lantern Client's own scripts that work on the save (offline.js), run like the package's tools: its Node.js, its folder
function runOwn(p, script, args, { timeout = 120000 } = {}) {
  return new Promise((resolve) => {
    execFile(p.node, [path.join(HERE, script), ...args], { cwd: p.pkg, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (e, out) => {
      const text = String(out || '').trim();
      try { resolve(JSON.parse(text)); }
      catch { resolve({ ok: false, error: e ? `${script} failed: ${e.message.split('\n')[0]}` : `${script} gave no answer.` }); }
    });
  });
}
function copyDir(from, to, skip = new Set()) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b, skip); else fs.copyFileSync(a, b);
  }
}
function modsMode(p) {
  const m = { on: false, servers: false };
  try {
    for (const l of fs.readFileSync(path.join(p.dataDir, 'mods.txt'), 'utf8').split(/\r?\n/)) {
      const t = l.trim().toLowerCase();
      if (t === 'mods=on') m.on = true;
      if (t === 'servers=on') m.servers = true;
    }
  } catch {}
  if (!m.on) m.servers = false;
  return m;
}
function modListed(p) {
  try { return new RegExp(`^\\s*${MOD_NAME}\\s*:\\s*1\\s*$`, 'm').test(fs.readFileSync(path.join(p.modsDir, 'mods.txt'), 'utf8')); } catch { return false; }
}

// ---------------------------------------------------------------- live feed (pushed to the panel)
const clients = new Set();
const feed = [];
let lastClientAt = Date.now(), everSeen = false;
function push(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) { try { c.write(msg); } catch {} }
}
function note(kind, title, text = '') {
  const n = { id: crypto.randomBytes(4).toString('hex'), at: Date.now(), kind, title, text };
  feed.unshift(n); feed.length = Math.min(feed.length, 60);
  push('note', n);
}

// in-game chat: data\announce.txt, one line at a time (the backend reads and deletes it every 2 s)
const announceQueue = [];
function announce(text) { announceQueue.push(String(text).replace(/\s+/g, ' ').slice(0, 280)); }
setInterval(() => {
  if (!announceQueue.length || !lastRunning) { if (!lastRunning) announceQueue.length = 0; return; }
  const p = places(); if (!p.pkg) return;
  const f = path.join(p.dataDir, 'announce.txt');
  if (fs.existsSync(f)) return;   // the backend has not said the last one yet (or the launcher's host mode is talking)
  try { fs.writeFileSync(f, announceQueue.shift()); } catch {}
}, 1000);

// ---------------------------------------------------------------- in-game switches
const TOGGLE_DEFAULTS = { godmode: false, stamina: false, damage: 1, speed: 1, refresh: false, refreshFn: '' };
// cheats are the owner's: anyone else's client keeps the mod locked (everything off, hotkeys ignored)
const isOwner = () => !!LIC.status().owner;
function readToggles(p) {
  const t = p.modDir ? readJson(path.join(p.modDir, 'trainer-toggles.json'), null) : null;
  if (!isOwner()) return { ...TOGGLE_DEFAULTS };
  const { locked, ...rest } = t || {};
  return { ...TOGGLE_DEFAULTS, ...(settings.toggles || {}), ...rest };
}
function writeToggles(p, t) {
  const clean = {
    godmode: !!t.godmode, stamina: !!t.stamina,
    damage: Math.min(1000, Math.max(1, Number(t.damage) || 1)),
    speed: Math.min(5, Math.max(0.5, Number(t.speed) || 1)),
    refresh: !!t.refresh, refreshFn: /^[A-Za-z_]\w{0,80}$/.test(String(t.refreshFn || '')) ? String(t.refreshFn) : '',
  };
  settings.toggles = clean; saveSettings();
  if (p.modDir && fs.existsSync(p.modDir)) {
    const f = path.join(p.modDir, 'trainer-toggles.json');
    // without a valid key the mod gets everything off and "locked" (its hotkeys do nothing either)
    const out = isOwner() ? { ...clean, locked: false } : { ...TOGGLE_DEFAULTS, locked: true };
    fs.writeFileSync(f + '.tmp', JSON.stringify({ ...out, by: 'panel', time: Math.floor(Date.now() / 1000) }));
    fs.renameSync(f + '.tmp', f);
  }
  return clean;
}
// heartbeats the mod writes from each process (game + hidden servers)
function modProcesses(p) {
  const dir = p.modDir && path.join(p.modDir, 'status');
  if (!dir || !fs.existsSync(dir)) return [];
  const now = Date.now() / 1000, live = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(dir, f);
    const s = readJson(full, null);
    if (s && now - s.time < 8) live.push(s);
    else { try { if (now - fs.statSync(full).mtimeMs / 1000 > 3600) fs.unlinkSync(full); } catch {} }
  }
  return live;
}
// ask the mod to try a live inventory refresh (experimental; only when switched on)
let refreshN = 0, refreshAt = 0;
function requestRefresh(p) {
  const t = readToggles(p);
  if (!t.refresh || !p.modDir || !fs.existsSync(p.modDir)) return;
  refreshN++; refreshAt = Date.now();
  try { fs.writeFileSync(path.join(p.modDir, 'refresh-request.json'), JSON.stringify({ n: refreshN, time: Math.floor(refreshAt / 1000) })); } catch {}
}

// ---------------------------------------------------------------- setup: UE4SS, the mod, modded mode + server mods
async function setup() {
  const p = places(), steps = [];
  if (!p.pkg) return { ok: false, error: 'Dauntless Forever 1.6.2 was not found. Set its folder first.' };
  if (!p.gameDir) return { ok: false, error: 'The game folder is not known yet. Run Set up in the launcher first.' };
  if (await backendUp()) return { ok: false, error: 'Close the game first (Stop in the launcher), then set up the trainer.' };
  if (!fs.existsSync(p.ue4ssDll)) {
    const r = await runTool(p, 'ue4ss.cjs', ['install'], { timeout: 300000 });
    if (!r.ok) return { ok: false, error: r.error || 'Could not install UE4SS.' };
    steps.push('Installed UE4SS (the mod loader).');
  }
  copyDir(MOD_SRC, p.modDir, new Set(['trainer-toggles.json', 'status', 'refresh-request.json']));
  fs.mkdirSync(path.join(p.modDir, 'status'), { recursive: true });
  writeToggles(p, readToggles(p));
  steps.push('Copied the Lantern Client mod.');
  for (const a of [['set', 'on'], ['set', 'servers-on'], ['mod', MOD_NAME, 'on']]) {
    const r = await runTool(p, 'ue4ss.cjs', a);
    if (!r.ok) return { ok: false, error: r.error || `ue4ss.cjs ${a.join(' ')} failed.`, steps };
  }
  steps.push('Turned on modded mode, server mods and the Lantern Client mod.');
  note('mod', 'Trainer set up', 'Press Play in the launcher.');
  return { ok: true, steps };
}

// ---------------------------------------------------------------- items
const ITEM_ACTIONS = new Set(['addgear', 'addgearmax', 'set', 'atleast', 'surgeall', 'addcosmetic']);   // atleast: top stacks up to a count, never lower
let queue = settings.queue || [];
const history = [];
const deliveries = [];   // gifts saved while the game ran, waiting for the game to load the inventory again
function itemArgs(job) {
  const who = String(job.character);
  if (job.action === 'surgeall') return ['surgeall', who];
  if (job.action === 'addcosmetic' && job.list === 'all') return ['addcosmetic', who, 'all'];
  return [job.action, who, JSON.stringify(job.action === 'set' ? job.counts : job.list)];
}
function validJob(b) {
  if (!ITEM_ACTIONS.has(b.action)) return 'Unknown action.';
  if (!/^[\w-]{1,64}$|^\*$/.test(String(b.character))) return 'Unknown character.';
  if (b.action === 'surgeall' || (b.action === 'addcosmetic' && b.list === 'all')) return null;
  if (b.action === 'set' || b.action === 'atleast') {
    const c = {};
    for (const [k, n] of Object.entries(b.counts || {})) if (/^[A-Z0-9_]{3,80}$/.test(k) && Number.isFinite(Number(n))) c[k] = Math.max(b.action === 'atleast' ? 1 : 0, Math.min(99999999, Math.floor(Number(n))));
    if (!Object.keys(c).length) return 'Nothing to change.';
    b.counts = c;
  } else {
    const l = (Array.isArray(b.list) ? b.list : []).map(String).filter((x) => /^[\w-]{1,80}$/.test(x)).slice(0, 2000);
    if (!l.length) return 'Pick something first.';
    b.list = l;
  }
  return null;
}
const describe = (j) => {
  if (j.label) return j.label;
  const n = j.action === 'set' || j.action === 'atleast' ? Object.keys(j.counts).length : Array.isArray(j.list) ? j.list.length : 0, s = n === 1 ? '' : 's';
  return { surgeall: 'Max all gear', set: `Set ${n} amount${s}`, atleast: `Top up ${n} item${s}`, addgear: `Give ${n} item${s}`, addgearmax: `Give ${n} item${s} at max level`,
    addcosmetic: j.list === 'all' ? 'Unlock all cosmetics' : `Unlock ${n} cosmetic${s}` }[j.action] || j.action;
};
function jobIds(job) { return job.action === 'set' || job.action === 'atleast' ? Object.keys(job.counts) : Array.isArray(job.list) ? job.list : []; }
function jobSummary(p, job) {
  if (job.action === 'surgeall') return 'All your gear raised to max level';
  if (job.action === 'addcosmetic' && job.list === 'all') return 'Every cosmetic unlocked';
  if (job.action === 'set') { const e = Object.entries(job.counts); const t = e.slice(0, 2).map(([k, v]) => `${nameOf(p, k)} ${Number(v).toLocaleString('en-US')}`).join(', '); return e.length > 2 ? `${t} and ${e.length - 2} more` : t; }
  return listNames(p, jobIds(job));
}
async function applyJob(p, job, live = false) {
  let r;
  if (live) {
    try {
      const mine = await runTool(p, 'items.js', ['list']);   // read-only: which characters are yours
      const res = await LIVE.give(p.pkg, job, ((mine && mine.characters) || []).map((c) => c.id));
      r = { ok: true, ...res };
    } catch (e) { r = { ok: false, error: e.message }; }
  } else if (job.action === 'addgearmax' || job.action === 'surgeall' || job.action === 'atleast') {
    // the package's items.js only adds gear at level 0 (it has no addgearmax or surgeall): offline.js does these
    const mine = await runTool(p, 'items.js', ['list']);
    r = mine && mine.ok ? await runOwn(p, 'offline.js', [p.pkg, JSON.stringify(job), JSON.stringify((mine.characters || []).map((c) => c.id))])
      : (mine || { ok: false, error: 'Could not read your characters.' });
  } else r = await runTool(p, 'items.js', itemArgs(job));
  history.unshift({ at: Date.now(), what: describe(job), ok: !!r.ok, live, error: r.ok ? undefined : r.error });
  history.length = Math.min(history.length, 40);
  return r;
}
function giftOutcome(p, job, r) {
  const ids = (k) => (Array.isArray(r[k]) ? r[k] : []);
  const added = ids('added'), raised = ids('raised'), already = ids('already'), unknown = ids('unknown');
  const o = { added: added.length, raised: raised.length };
  if (already.length) o.owned = listNames(p, already, 3);
  if (raised.length) o.raisedNames = listNames(p, raised, 3);   // gear you already owned, now at max level
  if (unknown.length) o.unknownNames = listNames(p, unknown, 3);
  o.nothingNew = !added.length && !raised.length && !r.queued;
  if (o.nothingNew && already.length) o.message = job.action === 'surgeall' ? 'All your gear is already at max level.'
    : job.action === 'atleast' ? `You already have ${Math.max(...Object.values(job.counts))} or more of ${already.length > 3 ? `all ${already.length} of those` : o.owned}.`
    : `You already own ${o.owned}.`;
  if (job.action === 'atleast') { o.topped = added.length; delete o.owned; }   // cells topped up: counts, not "already own"
  return o;
}
function enqueue(job) { queue.push(job); settings.queue = queue; saveSettings(); }

async function giveLive(p, job) {
  // raising gear you already own waits for the game to close; new gear goes in now
  if (job.action === 'surgeall') { enqueue(job); return { ok: true, queued: true, note: 'Raising owned gear waits until you close the game.' }; }
  const r = await applyJob(p, job, true);
  if (!r.ok) return r;
  let later = null;
  if (r.ownedForMax && r.ownedForMax.length) {
    const n = r.ownedForMax.length;
    later = { ...job, action: 'addgearmax', list: r.ownedForMax, label: `Raise ${n} owned item${n > 1 ? 's' : ''} to max level` };
  }
  const liveJob = r.added && r.added.length ? (job.action === 'set' || job.action === 'atleast' ? { ...job, counts: Object.fromEntries(r.added.map((i) => [i, job.counts[i]])) } : { ...job, list: r.added }) : null;
  if (liveJob) {
    const what = job.list === 'all' ? `${r.added.length} cosmetics unlocked` : jobSummary(p, liveJob);
    deliveries.push({ id: crypto.randomBytes(4).toString('hex'), at: Date.now(), character: liveJob.character, what, status: 'saved' });
    note('added', 'Added to your save', what);
    announce(`[Lantern] Added: ${what}. It shows up after your next loading screen.`);
    requestRefresh(p);
  }
  if (later) { enqueue(later); note('queued', 'Waiting for the game to close', later.label); }
  const o = giftOutcome(p, job, { added: r.added, already: r.already, unknown: r.unknown, queued: !!later });
  if (later) o.raiseLater = listNames(p, r.ownedForMax, 3);
  if (!liveJob && !later) return { ok: true, live: true, ...o };
  return { ok: true, live: !!liveJob, queued: !!later, ...o };
}

let draining = false;
async function drainQueue() {
  if (draining || !queue.length) return;
  draining = true;
  try {
    const p = places();
    if (!p.pkg || await backendUp()) return;
    while (queue.length) {
      const job = queue[0];
      const r = await applyJob(p, job);
      if (!r.ok && /still running|close the game/i.test(r.error || '')) break;   // started again meanwhile
      queue.shift(); settings.queue = queue; saveSettings();
      if (!r.ok) note('error', 'Could not apply', r.error || describe(job));
      else if (r.raised && r.raised.length) note('applied', 'Raised to max level', listNames(p, r.raised));
      else if (r.added && r.added.length) note('applied', 'Added to your save', listNames(p, r.added));
      else if (job.action === 'set' || job.list === 'all') note('applied', 'Added to your save', jobSummary(p, job));
      else if (r.already && r.already.length) note('ok', 'Already yours', `You already own ${listNames(p, r.already, 3)}.`);
    }
  } finally { draining = false; }
}
setInterval(() => { drainQueue().catch(() => {}); }, 2500);

// ---------------------------------------------------------------- following the backend log (logs\metagame.log)
// "UserId <u> requested inventory for CharacterId <c>" = the game (or its server) just loaded that inventory.
let logPos = -1, logFile = null, playingAs = null;
function followLog() {
  const p = places(); if (!p.pkg) return;
  if (logFile !== p.metaLog) { logFile = p.metaLog; logPos = -1; }
  let st; try { st = fs.statSync(logFile); } catch { return; }
  if (logPos < 0 || st.size < logPos) logPos = logPos < 0 ? st.size : 0;   // start at the end; a new run starts at 0
  if (st.size === logPos) return;
  const len = Math.min(st.size - logPos, 4 * 1024 * 1024);
  const buf = Buffer.alloc(len);
  let fd; try { fd = fs.openSync(logFile, 'r'); fs.readSync(fd, buf, 0, len, logPos); } catch { return; } finally { if (fd) try { fs.closeSync(fd); } catch {} }
  const text = buf.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  if (lastNl < 0) return;
  logPos += Buffer.byteLength(text.slice(0, lastNl + 1));
  for (const line of text.slice(0, lastNl).split('\n')) {
    let msg = line;
    try { msg = JSON.parse(line).msg || line; } catch { msg = line.replace(/\x1b\[[0-9;]*m/g, ''); }
    const m = /requested inventory for CharacterId (\S+)/.exec(msg);
    if (m && !LIVE.takeOwnRead(m[1])) inventoryLoaded(p, m[1]);
  }
}
function inventoryLoaded(p, characterId) {
  playingAs = characterId;
  const now = Date.now();
  const due = deliveries.filter((d) => d.status === 'saved' && (d.character === characterId || d.character === '*'));
  if (due.length) {
    for (const d of due) { d.status = 'delivered'; d.deliveredAt = now; }
    const what = due.map((d) => d.what).join('; ');
    note('delivered', 'Now in your game', what);
    announce(`[Lantern] Delivered: ${what.slice(0, 220)} - check your inventory.`);
  }
  // the experimental instant refresh: a load right after the mod called a function means that function works
  if (refreshAt && now - refreshAt < 6000) {
    const t = readToggles(p);
    const called = modProcesses(p).filter((s) => s.called && now / 1000 - s.calledAt < 6).map((s) => s.called)[0];
    if (t.refresh && called && t.refreshFn !== called) {
      writeToggles(p, { ...t, refreshFn: called });
      note('mod', 'Instant refresh found', `${called} makes the game load your inventory. Gifts now show up right away.`);
    }
    refreshAt = 0;
  }
  while (deliveries.length > 50) deliveries.shift();
}
setInterval(() => { try { followLog(); } catch {} }, 600);

// ---------------------------------------------------------------- game rules (data\rules.txt)
function rulesInfo(p) {
  const defs = (readJson(path.join(p.pkg, 'rules.json'), {}).rules || []).filter((r) => r.key !== 'host_rules');
  const picks = {};
  try {
    for (const l of fs.readFileSync(path.join(p.dataDir, 'rules.txt'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*([a-z_]+)\s*=\s*(\S+)\s*$/.exec(l); if (m) picks[m[1]] = m[2];
    }
  } catch {}
  for (const r of defs) if (picks[r.key] == null) picks[r.key] = r.default;
  return { defs, picks };
}
function writeRules(p, want) {
  const all = readJson(path.join(p.pkg, 'rules.json'), {}).rules || [];
  const { picks } = rulesInfo(p);
  for (const r of all) {
    const v = want[r.key];
    if (v != null && (r.choices || []).some((c) => c[0] === String(v))) picks[r.key] = String(v);
  }
  const lines = ['# Game Rules, written by the launcher (Game Rules page). Takes effect the next time you press Play.'];
  for (const r of all) if (picks[r.key] != null) lines.push(`${r.key}=${picks[r.key]}`);
  fs.mkdirSync(p.dataDir, { recursive: true });
  fs.writeFileSync(path.join(p.dataDir, 'rules.txt'), lines.join('\r\n') + '\r\n');
  return rulesInfo(p);
}

// ---------------------------------------------------------------- keeping the installed game mod current
// Set up copies the mod into the game once; after an update of Lantern Client the game would keep the old script.
// At start, and whenever the game closes, an installed mod that differs from this version's is replaced. With the game
// running, the new script is copied too but only loads at the next game start (the panel says so).
function modFiles(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) modFiles(f, base, out); else out.push(path.relative(base, f));
  }
  return out;
}
function syncMod(gameRunning) {
  try {
    const p = places();
    if (!p.modDir || !fs.existsSync(path.join(p.modDir, 'Scripts', 'main.lua'))) return false;   // not set up: Set up does it
    const stale = modFiles(MOD_SRC).filter((rel) => {
      const a = path.join(MOD_SRC, rel), b = path.join(p.modDir, rel);
      try { return !fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return true; }
    });
    if (!stale.length) return false;
    for (const rel of stale) { fs.mkdirSync(path.dirname(path.join(p.modDir, rel)), { recursive: true }); fs.copyFileSync(path.join(MOD_SRC, rel), path.join(p.modDir, rel)); }
    fs.mkdirSync(path.join(p.modDir, 'status'), { recursive: true });
    note('mod', 'Game mod updated', gameRunning ? 'Restart the game to use it.' : 'It loads the next time you press Play.');
    return true;
  } catch (e) { return false; }
}

// ---------------------------------------------------------------- state, watched for changes and pushed
let lastRunning = false, lastProcCount = 0, lastToggleText = '';
async function buildState() {
  const p = places();
  const license = LIC.status();
  const user = (() => { try { return process.env.USERNAME || os.userInfo().username; } catch { return ''; } })();
  if (!p.pkg) return { found: false, license, user, app: { version: VERSION, managed: !!LAUNCHER, update: updateReady, checking: updateChecking }, guess: process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'DauntlessForever', 'versions', '1.6.2') : '' };
  const running = await backendUp();
  const procs = modProcesses(p);
  return {
    found: true, license, user, pkg: p.pkg, gameDir: p.gameDir, running, playingAs,
    app: { version: VERSION, managed: !!LAUNCHER, update: updateReady, checking: updateChecking },
    ue4ss: !!(p.ue4ssDll && fs.existsSync(p.ue4ssDll)),
    modInstalled: !!(p.modDir && fs.existsSync(path.join(p.modDir, 'Scripts', 'main.lua'))),
    modOn: !!(p.modsDir && modListed(p)), mode: modsMode(p),
    toggles: readToggles(p), processes: procs.map(({ time, ...s }) => s),
    queue: queue.map((j) => ({ what: describe(j) })), history,
    deliveries: deliveries.filter((d) => d.status === 'saved').map((d) => ({ what: d.what, at: d.at })),
  };
}
let lastStateText = '';
async function tickState() {
  let s; try { s = await buildState(); } catch { return; }
  if (s.found) {
    if (s.running !== lastRunning) {
      note('game', s.running ? 'Game started' : 'Game closed', s.running ? 'Gifts go in live now.' : (queue.length ? 'Adding the gifts that were waiting...' : ''));
      if (!s.running) for (const d of deliveries) if (d.status === 'saved') d.status = 'closed';
      if (!s.running) syncMod(false);
    }
    const n = s.processes.length;
    if (n && !lastProcCount) note('mod', 'Mod connected', `${s.processes.filter((x) => x.role === 'game').length ? 'Game' : 'No game'} + ${s.processes.filter((x) => x.role === 'server').length} server(s)`);
    lastProcCount = n;
    lastRunning = s.running;
    // switches flipped in game with F5/F6
    const p = places();
    const raw = p.modDir ? readJson(path.join(p.modDir, 'trainer-toggles.json'), null) : null;
    const txt = JSON.stringify(raw);
    if (lastToggleText && txt !== lastToggleText && raw && raw.by === 'hotkey') {
      const old = JSON.parse(lastToggleText) || {};
      if (old.godmode !== raw.godmode) note('hotkey', `God mode ${raw.godmode ? 'on' : 'off'}`, 'Switched in game (F5)');
      if (old.stamina !== raw.stamina) note('hotkey', `Infinite stamina ${raw.stamina ? 'on' : 'off'}`, 'Switched in game (F6)');
    }
    lastToggleText = txt;
  }
  const text = JSON.stringify(s);
  if (text !== lastStateText) { lastStateText = text; push('state', s); }
}
let tickN = 0;
setInterval(() => { if (clients.size || ++tickN % 6 === 0) tickState().catch(() => {}); }, 700);   // with no window open: every ~4 s

// ---------------------------------------------------------------- updates (only when started by the Lantern Client launcher)
// The launcher does the work: "--stage" fetches the latest release from GitHub, checks its signature and checksums,
// unpacks it next to this version and makes it the one to start next time. This panel keeps running its own files; a
// restart (one click, or simply the next time Lantern Client opens) switches to the new version.
let updateReady = null, updateChecking = false, lastCheck = 0;
function stageUpdate(manual = false) {
  if (!LAUNCHER || updateChecking) return Promise.resolve({ ok: false, error: LAUNCHER ? 'Already checking.' : 'Updates come with the Lantern Client launcher.' });
  updateChecking = true; lastCheck = Date.now();
  return new Promise((resolve) => {
    execFile(LAUNCHER, ['--stage'], { timeout: 6 * 60 * 1000, windowsHide: true, env: { ...process.env } }, (e, out) => {
      updateChecking = false;
      let r; try { r = JSON.parse(String(out || '').trim()); } catch { r = { ok: false, error: e ? e.message.split('\n')[0] : 'No answer from the launcher.' }; }
      if (r.applied && r.to) {
        updateReady = { version: r.to, notes: r.notes || '' };
        note('update', `Lantern Client ${r.to} is ready`, r.notes ? `${r.notes} Restart to use it.` : 'Restart to use it.');
      } else if (manual) {
        if (r.error === 'no update channel set') note('error', 'No update channel yet', 'This build has no GitHub repository set for updates.');
        else if (r.error) note('error', r.available ? 'The update did not install' : 'Could not check for updates', r.error);
        else if (!updateReady) note('ok', 'You have the latest version', `Lantern Client ${VERSION}`);
      }
      if (r.launcherUpdated && !r.applied) note('update', 'Launcher updated', 'It is used the next time Lantern Client opens.');
      resolve(r);
    });
  });
}
if (LAUNCHER) {
  setTimeout(() => { stageUpdate().catch(() => {}); }, 20000);
  setInterval(() => { if (Date.now() - lastCheck > 3 * 3600 * 1000) stageUpdate().catch(() => {}); }, 10 * 60 * 1000);
}
// after an update (or a roll-back), say so once
if (ROOT) {
  const f = path.join(ROOT, 'update-note.json');
  const n = readJson(f, null);
  if (n) {
    try { fs.unlinkSync(f); } catch {}
    if (n.rolledBack) setTimeout(() => note('error', `Version ${n.rolledBack} did not start`, `Lantern Client went back to ${n.to}. That version will be skipped.`), 1500);
    else if (n.to === VERSION) setTimeout(() => note('update', `Updated to ${VERSION}`, n.notes || ''), 1500);
  }
}
// the launcher's single-instance check: which panel runs, at which address
function writeRunning(url) {
  if (!ROOT) return;
  try { fs.writeFileSync(path.join(ROOT, 'running.json'), JSON.stringify({ pid: process.pid, url, version: VERSION })); } catch {}
}
process.on('exit', () => {
  if (!ROOT) return;
  try { const r = readJson(path.join(ROOT, 'running.json'), {}); if (r.pid === process.pid) fs.unlinkSync(path.join(ROOT, 'running.json')); } catch {}
});
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));

// ---------------------------------------------------------------- HTTP
function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function body(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
  });
}

const routes = {
  'GET /api/state': async () => buildState(),
  'POST /api/package': async (b) => {
    const dir = String(b.package || '').trim();
    if (!isPackage(dir)) return { ok: false, error: 'That folder does not have tools\\items.js. Pick the ...\\versions\\1.6.2 folder.' };
    settings.package = dir; saveSettings(); placesCache = null;
    return { ok: true };
  },
  'GET /api/catalog': async () => {
    const p = places(); if (!p.pkg) return { ok: false };
    const groups = (readJson(path.join(p.pkg, 'items.json'), {}).groups || []);
    return { ok: true, gear: catalog(p).gear, groups, rules: rulesInfo(p), cells: cells(p).map(([id, perk, level]) => [id, perk, level, cellName(id)]) };
  },
  'GET /api/save': async () => {
    const p = places(); if (!p.pkg) return { ok: false, error: 'Package not found.' };
    const r = await runTool(p, 'items.js', ['list']);
    if (r && r.ok) delete r.gearCatalog;
    return r;
  },
  'GET /api/feed': async () => feed,
  'POST /api/setup': async () => isOwner() ? setup() : { ok: false, error: 'Cheats are for the owner.' },
  'POST /api/toggles': async (b) => {
    if (!isOwner()) return { ok: false, error: 'Cheats are for the owner.' };
    const p = places(); if (!p.pkg) return { ok: false, error: 'Package not found.' };
    const t = writeToggles(p, { ...readToggles(p), ...b });
    lastToggleText = JSON.stringify(readJson(path.join(p.modDir || '', 'trainer-toggles.json'), null));
    return { ok: true, toggles: t };
  },
  'POST /api/items': async (b) => {
    const p = places(); if (!p.pkg) return { ok: false, error: 'Package not found.' };
    const bad = validJob(b); if (bad) return { ok: false, error: bad };
    const job = { action: b.action, character: String(b.character), list: b.list, counts: b.counts, label: String(b.label || '').slice(0, 120) || undefined };
    if (await backendUp()) return giveLive(p, job);
    if (queue.length) { enqueue(job); return { ok: true, queued: true }; }
    const r = await applyJob(p, job);
    if (!r.ok) return r;
    if (job.action === 'set' || (job.action === 'addcosmetic' && job.list === 'all')) { note('applied', 'Added to your save', jobSummary(p, job)); return { ok: true }; }
    const o = giftOutcome(p, job, r);
    if (r.added && r.added.length) note('applied', 'Added to your save', listNames(p, r.added));
    if (r.raised && r.raised.length) note('applied', 'Raised to max level', listNames(p, r.raised));
    if (job.action === 'surgeall' && !o.raised) return { ok: true, nothingNew: true, message: 'All your gear is already at max level.' };
    return { ok: true, ...o };
  },
  'POST /api/queue/clear': async () => { queue = []; settings.queue = queue; saveSettings(); return { ok: true }; },
  'GET /api/prefs': async () => settings.prefs || {},
  'POST /api/prefs': async (b) => {
    const p = {}, ok = (k, test) => { if (b[k] !== undefined && test(b[k])) p[k] = b[k]; };
    ok('sfx', (v) => typeof v === 'boolean'); ok('intro', (v) => typeof v === 'boolean'); ok('onboarded', (v) => typeof v === 'boolean'); ok('welcome', (v) => typeof v === 'boolean');
    ok('vol', (v) => typeof v === 'number' && v >= 0 && v <= 1);
    ok('scale', (v) => [0.9, 1, 1.1, 1.25].includes(v));
    ok('fps', (v) => ['display', '60', '30', 'off'].includes(v));
    ok('font', (v) => ['aether', 'clean', 'scifi', 'tactical', 'rounded', 'mono'].includes(v));
    ok('theme', (v) => ['aether', 'ember', 'verdant', 'amethyst', 'crimson', 'gold'].includes(v));
    ok('win', (v) => ['auto', '1024x640', '1180x760', '1280x800', '1440x900'].includes(v));
    ok('winSize', (v) => Array.isArray(v) && v.length === 2 && v.every((n) => Number.isInteger(n) && n >= 600 && n <= 4000));
    settings.prefs = { ...(settings.prefs || {}), ...p }; saveSettings();
    return settings.prefs;
  },
  'POST /api/update/check': async () => stageUpdate(true),
  'POST /api/update/restart': async () => {
    if (!LAUNCHER) return { ok: false, error: 'Updates come with the Lantern Client launcher.' };
    // the launcher waits for this panel to exit, then starts the new version (gifts still waiting are kept)
    spawn(LAUNCHER, ['--after', String(process.pid)], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    setTimeout(() => process.exit(0), 400);
    return { ok: true };
  },
  'GET /api/license': async () => LIC.status(),
  'POST /api/license': async (b) => LIC.activate(b.key),
  'POST /api/license/remove': async () => LIC.remove(),
  'POST /api/owner/import': async (b) => LIC.importOwner(b.pem),
  'POST /api/owner/remove': async () => LIC.removeOwner(),
  'GET /api/owner/keys': async () => LIC.keys(),
  'POST /api/owner/generate': async (b) => LIC.generate(b),
  'POST /api/owner/revoke': async (b) => LIC.revoke(b),
  'POST /api/owner/refresh': async () => { LIC.fetchRevoked(); return { ok: true }; },

  'POST /api/rules': async (b) => {
    const p = places(); if (!p.pkg) return { ok: false, error: 'Package not found.' };
    return { ok: true, rules: writeRules(p, b || {}) };
  },
};

const server = http.createServer(async (req, res) => {
  try {
    // only this machine, and only our own page (blocks other websites and DNS rebinding)
    const host = String(req.headers.host || '');
    if (!new RegExp(`^(127\\.0\\.0\\.1|localhost):${PORT}$`).test(host)) return send(res, 403, { ok: false, error: 'Forbidden' });
    const url = new URL(req.url, `http://${host}`);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      if (url.searchParams.get('t') !== TOKEN) return send(res, 403, 'Open Lantern Client from its shortcut.', 'text/plain');
      return send(res, 200, fs.readFileSync(UI_FILE), 'text/html; charset=utf-8');
    }
    // the panel's own fonts (public, cached)
    const font = /^\/fonts\/(figtree|chakra-500|chakra-600|chakra-700|inter|orbitron|exo2|rajdhani-500|rajdhani-600|rajdhani-700|saira|nunito|jetbrainsmono)\.woff$/.exec(url.pathname);
    if (req.method === 'GET' && font) {
      res.writeHead(200, { 'Content-Type': 'font/woff', 'Cache-Control': 'public, max-age=31536000, immutable' });
      return res.end(fs.readFileSync(path.join(HERE, 'ui', 'fonts', font[1] + '.woff')));
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      // EventSource cannot send headers, so the token comes in the address here
      if (url.searchParams.get('t') !== TOKEN) return send(res, 403, { ok: false, error: 'Forbidden' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 1500\n\n');
      clients.add(res); everSeen = true; lastClientAt = Date.now();
      if (lastStateText) res.write(`event: state\ndata: ${lastStateText}\n\n`);
      const ka = setInterval(() => { try { res.write(': k\n\n'); } catch {} }, 15000);
      req.on('close', () => { clearInterval(ka); clients.delete(res); lastClientAt = Date.now(); });
      return;
    }
    const fn = routes[`${req.method} ${url.pathname}`];
    if (!fn) return send(res, 404, { ok: false, error: 'Not found' });
    if (req.headers['x-trainer-token'] !== TOKEN) return send(res, 403, { ok: false, error: 'Forbidden' });
    lastClientAt = Date.now(); everSeen = true;
    if (!OPEN_ROUTES.has(`${req.method} ${url.pathname}`) && !LIC.ok()) return send(res, 200, { ok: false, locked: true, error: 'Enter your Lantern key first.' });
    const b = req.method === 'POST' ? await body(req) : {};
    send(res, 200, await fn(b));
  } catch (e) {
    send(res, 500, { ok: false, error: String(e && e.message || e) });
  }
});

// quit by itself 3 minutes after the panel window is closed (never with gifts still waiting)
setInterval(() => {
  if (everSeen && !clients.size && Date.now() - lastClientAt > 180000 && !queue.length) process.exit(0);
}, 5000);

// Lantern Client.exe shows the panel in its own window. Started by hand (node server.js), it prints the address to open.
function openWindow(url) {
  if (NO_OPEN || LAUNCHER) return;
  console.log('Open ' + url);
}

function listen(tries = 0) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries < 10) { PORT += 1; listen(tries + 1); }
    else { console.error(e.message); process.exit(1); }
  });
  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${PORT}/?t=${TOKEN}`;
    console.log(`Lantern Client panel: ${url}`);
    console.log(`DF Trainer panel: ${url}`);   // older launchers (before the rename) look for this line
    writeRunning(url);
    try { const p = places(); if (p.pkg) writeToggles(p, LIC.ok() ? readToggles(p) : (settings.toggles || {})); } catch {}
    backendUp().then((up) => syncMod(up)).catch(() => {});
    tickState().catch(() => {});
    openWindow(url);
  });
}
listen();
