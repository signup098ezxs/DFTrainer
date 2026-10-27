// Lantern Client panel - a separate companion for Dauntless Forever (Dauntless 1.14.7), single player.
// Licence: AGPL-3.0-only (it drives Dauntless Forever's AGPL tools and ships an AGPL mod). Keep this notice.
//
// A small local web server (127.0.0.1 only, no dependencies) behind the panel window:
//   - items: with the game closed, the package's own tools\items.js (and offline.js, for cell top-ups and weapon
//     levels) edits the save, data\state.json. While the game runs, live.js sends the gift to the package's local
//     backend as an inventory transaction (the game's own kind), so it is saved at once without touching the save
//     file, which the backend holds in memory then. Weapon levels wait for the game to close.
//   - real time: the panel gets a live event stream (Server-Sent Events). Gifts are announced in game chat through
//     data\announce.txt (the backend says that file's text in chat every 2 s), and logs\requests.jsonl is followed so
//     the panel knows the moment the game loads your inventory again: "delivered".
//   - the game mod: trainer-toggles.json in the DFTrainer UE4SS mod's folder (game + hidden servers read it): the
//     behemoth overlay and the owner's experimental instant inventory refresh.
//   - game rules: data\rules.txt, like the launcher's Game Rules page.
//
//   node server.js [--package "<...>\versions\1.14.7"] [--no-open] [--port 61777]
'use strict';
const fs = require('fs'), path = require('path'), http = require('http'), net = require('net'), crypto = require('crypto'), os = require('os');
const { execFile, spawn } = require('child_process');

const HERE = __dirname;
const UI_FILE = path.join(HERE, 'ui', 'index.html');
const MOD_SRC = path.join(HERE, 'mod', 'DFTrainer');
const LIVE = require('./live.js');
const { protectedIds, isStarter } = require('./protect.js');
const BUILDS = require('./builds/index.js');
const GAMETEXT = require('./gametext.js');
// Installed by the launcher, each version lives in its own folder (app\<version>): settings live one level up, in the
// install folder (DFT_ROOT), so updates keep them. Started by hand (node server.js), they stay next to this file.
const ROOT = process.env.DFT_ROOT || null;
const LAUNCHER = process.env.DFT_LAUNCHER && fs.existsSync(process.env.DFT_LAUNCHER) ? process.env.DFT_LAUNCHER : null;
const SETTINGS = path.join(ROOT || HERE, 'trainer-settings.json');
if (ROOT && !fs.existsSync(SETTINGS) && fs.existsSync(path.join(HERE, 'trainer-settings.json'))) {
  try { fs.copyFileSync(path.join(HERE, 'trainer-settings.json'), SETTINGS); } catch {}
}
const MOD_NAME = 'DFTrainer';
// the game mod this panel ships (its main.lua says "local MOD_VERSION"): copies of the game started before an update
// keep running the old one (hunt servers stay up between hunts), so the panel says when that is the case
const MOD_VERSION = (() => { try { return (/local MOD_VERSION\s*=\s*"([^"]+)"/.exec(fs.readFileSync(path.join(__dirname, 'mod', 'DFTrainer', 'Scripts', 'main.lua'), 'utf8')) || [])[1] || ''; } catch { return ''; } })();
const GAME_BUILD = '1.14.7';
// the 1.14.7 package's local backend (backend\recorder-1147.js): one port per game service; inventory is "dauntless"
const BACKEND_PORT = 63005;
const IS_WIN = process.platform === 'win32';
const TOKEN = crypto.randomBytes(16).toString('hex');

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const NO_OPEN = argv.includes('--no-open');
let PORT = Number(arg('--port')) || 61777;

// ---------------------------------------------------------------- settings and paths
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return d; } };
let settings = readJson(SETTINGS, {});
// 3.8.4 removed Assist (part lock-on): its saved switches are dropped (written out with the next save)
delete settings.assist;
const VERSION = process.env.DFT_VERSION || readJson(path.join(HERE, 'release.json'), {}).version || 'dev';
// written to a temporary file and renamed: a crash or power cut mid-write never leaves a half file (which reads as
// empty settings and loses the gifts waiting in the queue)
const saveSettings = () => { try { const t = SETTINGS + '.tmp'; fs.writeFileSync(t, JSON.stringify(settings, null, 2)); fs.renameSync(t, SETTINGS); } catch {} };
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

function isPackage(dir) { return !!dir && fs.existsSync(path.join(dir, 'tools', 'items.js')) && fs.existsSync(path.join(dir, 'tools', 'gear-1147.json')); }
function findPackage() {
  const tries = [arg('--package'), process.env.DF_PACKAGE, settings.package];
  const la = process.env.LOCALAPPDATA;
  if (la) tries.push(path.join(la, 'DauntlessForever', 'versions', GAME_BUILD));
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
    dataDir: path.join(pkg, 'data'), requestLog: path.join(pkg, 'logs', 'requests.jsonl'),
  };
}

// ---------------------------------------------------------------- the 1.14.7 catalog
// tools\gear-1147.json is the package's Inventory picker: [id, name, type, storage] for everything that can be given
// (weapons, armour, lanterns, parts, omnicells and every kind of cosmetic). tools\catalog-1147.json is the game's whole
// catalog (id, name, group, storage) from the 1.14.7 game files: names for everything else (currencies, cells...).
const GEAR_KINDS = new Set(['Weapons', 'Armour', 'Lanterns', 'Weapon parts', 'Omnicells']);
let CATALOG = null, CATALOG_KEY = '';
function catalog(p) {
  const files = ['gear-1147.json', 'catalog-1147.json'].map((f) => path.join(p.pkg, 'tools', f));
  const key = files.map((f) => { try { const st = fs.statSync(f); return f + st.size + st.mtimeMs; } catch { return f; } }).join('|');
  if (CATALOG && CATALOG_KEY === key) return CATALOG;
  const names = new Map(), storage = new Map(), groupOf = new Map();
  const full = readJson(files[1], {}).items || [];
  const behemoths = new Map();   // TOKEN_KILL_COUNT_LERAWR_BETA "Kill Token: Rogue Embermane" -> LERAWR_BETA: Rogue Embermane
  // the game's own text names what the catalog leaves unnamed, before the picker's guess from the id (gametext.js)
  const text = GAMETEXT.englishText(p.pkg), fromText = new Set();
  for (const i of full) {
    if (i.name && i.name !== i.id) names.set(i.id, i.name);
    else { const t = GAMETEXT.displayName(text, i); if (t) { names.set(i.id, t.trim()); fromText.add(i.id); } }
    const k = /^TOKEN_KILL_COUNT_([A-Z0-9_]+)$/.exec(i.id || '');
    if (k && i.name) behemoths.set(k[1], i.name.replace(/^Kill Token:\s*/i, '').trim());
    storage.set(i.id, i.storage === 'instance' ? 'i' : 's');
    groupOf.set(i.id, i.group);
  }
  const picker = readJson(files[0], {});
  const gear = (picker.items || []).map((g) => {
    const named = fromText.has(g[0]) || (g[1] && g[1] !== g[0]);
    if (named && !fromText.has(g[0])) names.set(g[0], g[1]);
    storage.set(g[0], g[3] === 'i' ? 'i' : 's');
    // the picker files hunt arrivals (the animation as you land on a hunt, EM_INTRO_*) under Emotes: their own kind here
    const type = g[2] === 'Emotes' && /^EM_INTRO_/.test(g[0]) ? 'Hunt arrivals' : g[2];
    return [g[0], named ? names.get(g[0]) : g[0], type, GEAR_KINDS.has(g[2]) ? 0 : 1, named ? 0 : 1];   // id, name, type, cosmetic, unnamed
  });
  for (const grp of readJson(path.join(p.pkg, 'items.json'), {}).groups || []) for (const i of grp.items || []) names.set(i.id, i.name);
  // items.json calls it "Cell Dust"; in game it is Aetherdust (UI::Common.CellDust), the currency Timeweave crafting costs
  if (text.get('UI::Common.CellDust')) names.set(PARTS.AETHERDUST, text.get('UI::Common.CellDust'));
  // the game's crafting table (recipe per item: craft, then upgrades), for gear whose parts come from other behemoths
  const rules = readJson(path.join(p.pkg, 'backend', 'game-rules1147-data.json'), {});
  const recipes = { craftItems: rules.craftItems || {}, recipes: rules.recipes || {} };
  const types = (picker.types || []).flatMap((t) => (t === 'Emotes' ? ['Emotes', 'Hunt arrivals'] : [t]));
  // what live.js needs for a gift while you play, from this same catalog (no second copy of it)
  let live = null;   // built on the first gift while you play
  // ARMSTRONG -> Torgadoro, from the game's own item names; then (trusted more) MANTIS -> Sahvyt from its armour
  // descriptions in the game text, "forged from Sahvyt trophies" (3.9.26: Sahvyt, Frostwülf, Urska, Phaelanx, Alyra)
  const codeNames = new Map([...BEHEMOTHS.namesFromItems(full), ...BEHEMOTHS.namesFromTrophies(full, (i) => GAMETEXT.description(text, i))]);
  CATALOG = { gear, names, storage, groupOf, types, behemoths, codeNames, recipes,
    get live() { return live || (live = { storage, picker: new Set(gear.map((g) => g[0])), cosmetics: gear.filter((g) => g[3]).map((g) => g[0]) }); } };
  CATALOG_KEY = key;
  return CATALOG;
}
function equippedPartsOf(p, player, charId) {
  const c = catalog(p), r = PARTS.equippedParts(player, charId, c.storage, c.groupOf, c.recipes);
  if (!r) return null;
  const nm = (id) => nameOf(p, id);
  return {
    max: PARTS.MAX_EACH, parts: r.parts,
    slots: r.slots.map((x) => ({ ...x, name: nm(x.id), behemoth: x.code ? String(c.behemoths.get(x.code + '_NORMAL') || c.codeNames.get(x.code) || '').replace(/\bHost\b/, 'Boreus') || null : null,
      parts: x.parts.map((id) => [id, nm(id)]) })),
  };
}
function nameOf(p, id) { return catalog(p).names.get(id) || cellName(id) || id; }

// ---------------------------------------------------------------- cells
// Cells are stacked items (a count), CELL_<perk>_<UC|R|E> for +1, +2 and +3 (a few perks exist at one level only),
// named in the game catalog ("+3 Acidic Cell"). CELL_DP_* are Repeater mods and CELLv2_* test cells: left out.
const CELL_LEVEL = { UC: 1, R: 2, E: 3 };
function cellName(id) {   // for the few cells the catalog has no name for
  const m = /^CELL_([A-Z0-9_]+)_(UC|R|E)$/.exec(id || '');
  if (!m) return null;
  const words = m[1].toLowerCase().split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return `+${CELL_LEVEL[m[2]]} ${words} Cell`;
}
function cells(p) {
  const c = catalog(p);
  if (c.cells) return c.cells;
  const out = [];
  for (const [id, group] of c.groupOf) {
    const m = /^CELL_([A-Z0-9_]+)_(UC|R|E)$/.exec(id);
    if (group === 'Cells' && m && !id.startsWith('CELL_DP_') && c.storage.get(id) === 's') out.push([id, m[1], CELL_LEVEL[m[2]], c.names.get(id) || cellName(id)]);
  }
  c.cells = out;
  return out;
}

// ---------------------------------------------------------------- weapon levels
// 1.14.7 levels weapons per type (1 to 20), not per item: players.<you>.progress.tracks.ExperienceTrack_Weapon_<type>
// holds the XP. 27,775 XP is level 20 (the package's slayer-copy.js curve).
const WEAPON_TYPES = ['Axe', 'ChainBlades', 'Hammer', 'Repeaters', 'Spear', 'Strikers', 'Sword'];
const WEAPON_NAMES = { Axe: 'Axe', ChainBlades: 'Chain Blades', Hammer: 'Hammer', Repeaters: 'Repeaters', Spear: 'War Pike', Strikers: 'Aether Strikers', Sword: 'Sword' };

const listNames = (p, ids, max = 2) => {
  const n = ids.map((i) => nameOf(p, i));
  return n.length <= max ? n.join(', ') : `${n.slice(0, max).join(', ')} and ${n.length - max} more`;
};

// ---------------------------------------------------------------- helpers
// Is the game's backend up? Asked by the state ticks, the overlay (ten times a second) and every gift: one answer is
// shared for up to a second (maxAge 0 asks fresh), so the backend is not knocked on a dozen times a second.
let upCache = { at: 0, v: false, p: null };
function backendUp(maxAge = 1000) {
  if (upCache.p) return upCache.p;
  if (maxAge > 0 && Date.now() - upCache.at < maxAge) return Promise.resolve(upCache.v);
  upCache.p = backendProbe().then((v) => { upCache = { at: Date.now(), v, p: null }; return v; });
  return upCache.p;
}
function backendProbe() {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: BACKEND_PORT });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(600, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}
// "items.js list" only reads the save (and the picker): the answer is kept until either file changes, instead of a new
// Node process (about 40 MB for a moment) for every look at your characters
let listCache = { key: '', r: null };
function statKey(f) { try { const st = fs.statSync(f); return st.size + ':' + st.mtimeMs; } catch { return '-'; } }
async function listChars(p) {
  const key = statKey(path.join(p.dataDir, 'state.json')) + '|' + statKey(path.join(p.pkg, 'tools', 'gear-1147.json')) + '|' + p.pkg;
  if (listCache.key === key && listCache.r) return listCache.r;
  const r = await runTool(p, 'items.js', ['list']);
  if (r && r.ok) { delete r.gearCatalog; listCache = { key, r }; }
  return r;
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
// Lantern Client's own scripts get their arguments in a temporary file: a long item list on the command line goes past
// Windows' 32,767-character limit (spawn ENAMETOOLONG)
function runOwn(p, script, args, { timeout = 120000 } = {}) {
  return new Promise((resolve) => {
    const file = path.join(os.tmpdir(), `lantern-args-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`);
    try { fs.writeFileSync(file, JSON.stringify(args)); } catch (e) { resolve({ ok: false, error: `Could not hand ${script} its work: ${e.message}` }); return; }
    execFile(p.node, [path.join(HERE, script), '--args', file], { cwd: p.pkg, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (e, out) => {
      try { fs.unlinkSync(file); } catch {}
      const text = String(out || '').trim();
      try { resolve(JSON.parse(text)); }
      catch { resolve({ ok: false, error: e ? `${script} failed: ${e.message.split('\n')[0]}` : `${script} gave no answer.` }); }
    });
  });
}
// the package's items.js takes its list on the command line: long lists go in several calls, the results merged
const ARG_BUDGET = 20000;
async function runItemsTool(p, job) {
  const args = itemArgs(job);
  if (args[2].length <= ARG_BUDGET || args[2] === 'all') return runTool(p, 'items.js', args);
  const keys = job.action === 'set' ? Object.keys(job.counts) : job.list;
  const per = Math.max(1, Math.floor(keys.length * ARG_BUDGET / args[2].length));
  const merged = { ok: true };
  for (let i = 0; i < keys.length; i += per) {
    const part = keys.slice(i, i + per);
    const sub = job.action === 'set' ? { ...job, counts: Object.fromEntries(part.map((k) => [k, job.counts[k]])) } : { ...job, list: part };
    const r = await runTool(p, 'items.js', itemArgs(sub));
    if (!r || !r.ok) return i ? { ...(r || {}), ok: false, error: `${(r && r.error) || 'items.js failed'} (after ${i} of ${keys.length} were done)` } : r;
    for (const [k, v] of Object.entries(r)) if (Array.isArray(v)) merged[k] = (merged[k] || []).concat(v); else if (!(k in merged)) merged[k] = v;
  }
  return merged;
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
const TOGGLE_DEFAULTS = { refresh: false, refreshFn: '' };
// the behemoth overlay (anyone's panel, not just the owner's): the mod tracks behemoths only while Lantern's own card
// is the one showing (with Dauntless Forever's Boss Health Bar, the default since 3.9.21, the mod does no searches)
const overlayOn = () => !!(settings.overlay && settings.overlay.on);
const lanternOverlay = () => overlayOn() && settings.overlay.engine === 'lantern';
// instant refresh is the owner's: anyone else's client keeps the mod locked
const isOwner = () => !!LIC.status().owner;
function readToggles(p) {
  const t = p.modDir ? readJson(path.join(p.modDir, 'trainer-toggles.json'), null) : null;
  if (!isOwner()) return { ...TOGGLE_DEFAULTS };
  // a file written while no owner key was present says "locked": it is not the owner's setting, so it is ignored
  const all = { ...TOGGLE_DEFAULTS, ...(settings.toggles || {}), ...(t && !t.locked ? t : {}) };
  return { refresh: all.refresh, refreshFn: all.refreshFn };
}
let lockLogsGone = false;
function writeToggles(p, t) {
  const clean = {
    refresh: !!t.refresh, refreshFn: /^[A-Za-z_]\w{0,80}$/.test(String(t.refreshFn || '')) ? String(t.refreshFn) : '',
  };
  // the owner's settings are kept only from the owner's panel (without the key, defaults must not overwrite them)
  if (isOwner()) { settings.toggles = clean; saveSettings(); }
  if (p.modDir && fs.existsSync(p.modDir)) {
    const f = path.join(p.modDir, 'trainer-toggles.json');
    // not the owner: the mod gets the defaults and "locked"
    const out = { ...(isOwner() ? { ...clean, locked: false } : { ...TOGGLE_DEFAULTS, locked: true }) };
    // 3.9.26: Lantern's card is fed by the native tracker (mod folder native\); the Lua mod tracks only if it is not
    // running (the mod decides: track\native.json goes stale)
    out.native = lanternOverlay();
    out.track = lanternOverlay();
    fs.mkdirSync(path.join(p.modDir, 'track'), { recursive: true });
    // each copy of the game that ever ran left a track file: those over an hour old are done with
    try { const td = path.join(p.modDir, 'track'); for (const f of fs.readdirSync(td)) { const full = path.join(td, f); if (Date.now() - fs.statSync(full).mtimeMs > 3600000) fs.unlinkSync(full); } } catch {}
    // the mod's own logs (logs\<date>-<process>.log, one per copy of the game): a week is kept
    const logs = path.join(p.modDir, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    try { for (const f of fs.readdirSync(logs)) { const full = path.join(logs, f); if (Date.now() - fs.statSync(full).mtimeMs > 7 * 86400000) fs.unlinkSync(full); } } catch {}
    // once per start: the mod logs written while the removed part lock-on existed (3.5.0-3.8.3) go too
    if (!lockLogsGone) { lockLogsGone = true; try { for (const f of fs.readdirSync(logs)) { const full = path.join(logs, f); if (/lock-on:|part lock-on/.test(fs.readFileSync(full, 'utf8'))) fs.unlinkSync(full); } } catch {} }
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
  if (!p.pkg) return { ok: false, error: 'Dauntless Forever 1.14.7 was not found. Set its folder first.' };
  if (!p.gameDir) return { ok: false, error: 'The game folder is not known yet. Run Set up in the launcher first.' };
  if (await backendUp(0)) return { ok: false, error: 'Close the game first (Stop in the launcher), then set up the trainer.' };
  if (!fs.existsSync(p.ue4ssDll)) {
    const r = await runTool(p, 'ue4ss.cjs', ['install'], { timeout: 300000 });
    if (!r.ok) return { ok: false, error: r.error || 'Could not install UE4SS.' };
    steps.push('Installed UE4SS (the mod loader).');
  }
  copyDir(MOD_SRC, p.modDir, new Set(['trainer-toggles.json', 'status', 'track', 'quests', 'logs', 'refresh-request.json']));
  fs.mkdirSync(path.join(p.modDir, 'status'), { recursive: true });
  writeToggles(p, readToggles(p));
  steps.push('Copied the Lantern Client mod.');
  if (ue4ssSafeSettings(p)) steps.push('Turned off the UE4SS object cache (it crashed the game while loading).');
  for (const a of [['set', 'on'], ['set', 'servers-on'], ['mod', MOD_NAME, 'on']]) {
    const r = await runTool(p, 'ue4ss.cjs', a);
    if (!r.ok) return { ok: false, error: r.error || `ue4ss.cjs ${a.join(' ')} failed.`, steps };
  }
  steps.push('Turned on modded mode, server mods and the Lantern Client mod.');
  note('mod', 'Trainer set up', 'Press Play in the launcher.');
  return { ok: true, steps };
}

// ---------------------------------------------------------------- items
// atleast: top stacks up to a count, never lower. add: add exactly the count to a stack. maxweapons: every weapon
// type to level 20 (1.14.7 levels weapons per type, not per item, so there is no "give at max level")
const ITEM_ACTIONS = new Set(['addgear', 'set', 'atleast', 'add', 'maxweapons', 'addcosmetic', 'remove']);
const COUNTED = new Set(['set', 'atleast', 'add']);   // jobs with counts, not a list
// moving from 1.6.2: gifts that were waiting were for 1.6.2 characters, and its package folder no longer applies
if (settings.build !== GAME_BUILD) { settings.queue = []; if (settings.package && !isPackage(settings.package)) delete settings.package; settings.build = GAME_BUILD; saveSettings(); }
let queue = settings.queue || [];
const history = [];
const deliveries = [];   // gifts saved while the game ran, waiting for the game to load the inventory again
function itemArgs(job) {
  const who = String(job.character);
  if (job.action === 'addcosmetic' && job.list === 'all') return ['addcosmetic', who, 'all'];
  return [job.action, who, JSON.stringify(job.action === 'set' ? job.counts : job.list)];
}
function validJob(b) {
  if (b.action === 'addgearmax') b.action = 'addgear';      // 1.6.2's "at max level": no item levels in 1.14.7
  if (b.action === 'surgeall') b.action = 'maxweapons';    // 1.6.2's "Max all my gear": weapon levels in 1.14.7
  if (!ITEM_ACTIONS.has(b.action)) return 'Unknown action.';
  if (!/^[\w-]{1,64}$|^\*$/.test(String(b.character))) return 'Unknown character.';
  if (b.action === 'remove' && b.character === '*') return 'Pick one character to remove items from.';
  if (b.action === 'maxweapons' || (b.action === 'addcosmetic' && b.list === 'all')) return null;
  if (COUNTED.has(b.action)) {
    const c = {};
    for (const [k, n] of Object.entries(b.counts || {})) if (/^[A-Z0-9_]{3,80}$/.test(k) && Number.isFinite(Number(n))) c[k] = Math.max(b.action === 'set' ? 0 : 1, Math.min(99999999, Math.floor(Number(n))));
    if (!Object.keys(c).length) return 'Nothing to change.';
    b.counts = c;
  } else {
    const l = (Array.isArray(b.list) ? b.list : []).map(String).filter((x) => /^[\w-]{1,80}$/.test(x)).slice(0, b.action === 'remove' ? 10000 : 2000);
    if (!l.length) return 'Pick something first.';
    b.list = l;
  }
  return null;
}
const describe = (j) => {
  if (j.label) return j.label;
  const n = COUNTED.has(j.action) ? Object.keys(j.counts).length : Array.isArray(j.list) ? j.list.length : 0, s = n === 1 ? '' : 's';
  return { maxweapons: 'Max weapon levels', set: `Set ${n} amount${s}`, atleast: `Top up ${n} item${s}`, add: `Add to ${n} item${s}`, addgear: `Give ${n} item${s}`,
    remove: `Remove ${n} item${s}`,
    addcosmetic: j.list === 'all' ? 'Unlock all cosmetics' : `Unlock ${n} cosmetic${s}` }[j.action] || j.action;
};
function jobIds(job) { return COUNTED.has(job.action) ? Object.keys(job.counts) : Array.isArray(job.list) ? job.list : []; }
function jobSummary(p, job) {
  if (job.action === 'maxweapons') return 'Every weapon type at level 20';
  if (job.action === 'addcosmetic' && job.list === 'all') return 'Every cosmetic unlocked';
  if (job.action === 'set' || job.action === 'add') { const e = Object.entries(job.counts); const t = e.slice(0, 2).map(([k, v]) => `${nameOf(p, k)} ${job.action === 'add' ? '+' : ''}${Number(v).toLocaleString('en-US')}`).join(', '); return e.length > 2 ? `${t} and ${e.length - 2} more` : t; }
  return listNames(p, jobIds(job));
}
// one change to your save at a time: two at once (a double click, a gift while the queue is applied) both rewrote
// the save from the same copy, so one of them was lost although it said it was added
let saveChain = Promise.resolve();
function applyJob(p, job, live = false) {
  const run = saveChain.then(() => applyJobNow(p, job, live));
  saveChain = run.catch(() => {});
  return run;
}
async function applyJobNow(p, job, live) {
  let r;
  if (live) {
    try {
      const mine = await listChars(p);   // read-only: which characters are yours
      const res = await LIVE.give(p.pkg, job, ((mine && mine.characters) || []).map((c) => c.id), catalog(p).live);
      r = { ok: true, ...res };
    } catch (e) { r = { ok: false, error: e.message }; }
  } else if (job.action === 'maxweapons' || job.action === 'atleast' || job.action === 'add' || job.action === 'remove') {
    // the package's items.js only sets counts and adds items: offline.js tops counts up, adds to them and raises weapon levels
    const mine = await listChars(p);
    r = mine && mine.ok ? await runOwn(p, 'offline.js', [p.pkg, JSON.stringify(job), JSON.stringify((mine.characters || []).map((c) => c.id))])
      : (mine || { ok: false, error: 'Could not read your characters.' });
  } else r = await runItemsTool(p, job);
  history.unshift({ at: Date.now(), what: describe(job), ok: !!r.ok, live, error: r.ok ? undefined : r.error });
  history.length = Math.min(history.length, 40);
  return r;
}
function giftOutcome(p, job, r) {
  const ids = (k) => (Array.isArray(r[k]) ? r[k] : []);
  const added = ids('added'), raised = ids('raised'), already = ids('already'), unknown = ids('unknown');
  const o = { added: added.length, raised: raised.length };
  if (already.length) o.owned = listNames(p, already, 3);
  if (raised.length) o.raisedNames = job.action === 'maxweapons' ? raised.map((w) => WEAPON_NAMES[w] || w).join(', ') : listNames(p, raised, 3);
  if (unknown.length) o.unknownNames = listNames(p, unknown, 3);
  o.nothingNew = !added.length && !raised.length && !r.queued;
  if (o.nothingNew && already.length) o.message = job.action === 'maxweapons' ? 'Every weapon type is already at level 20.'
    : job.action === 'atleast' ? `You already have ${Math.max(...Object.values(job.counts))} or more of ${already.length > 3 ? `all ${already.length} of those` : o.owned}.`
    : job.action === 'add' ? `${o.owned} is already at the most it can hold (${(99999999).toLocaleString('en-US')}).`
    : `You already own ${o.owned}.`;
  if (job.action === 'atleast' || job.action === 'maxweapons') { o.topped = added.length; delete o.owned; }   // counts and levels, not "already own"
  return o;
}
function removeOutcome(p, r) {
  const removed = r.removed || [], kept = [...(r.kept || []), ...(r.starter || [])];
  if (removed.length) note('applied', 'Removed from your save', `${removed.length.toLocaleString('en-US')} item${removed.length === 1 ? '' : 's'}${kept.length ? `; kept ${kept.length} in use or starter kit` : ''}.`);
  const message = removed.length ? undefined : kept.length ? `Nothing removed: ${listNames(p, kept, 3)} ${kept.length === 1 ? 'is' : 'are'} in use or starter kit, which is always kept.` : 'You do not own any of those.';
  if (message) note('ok', 'Nothing removed', message);
  return { ok: true, removed: removed.length, keptNames: kept.length ? listNames(p, kept, 3) : undefined, nothingNew: !removed.length, message };
}
function enqueue(job) { queue.push(job); settings.queue = queue; saveSettings(); }

async function giveLive(p, job) {
  // weapon levels live in the backend's memory with the rest of the save while the game runs: they wait for it to close
  if (job.action === 'maxweapons') { enqueue(job); return { ok: true, queued: true, note: 'Weapon levels are raised the moment you close the game.' }; }
  // removing while the game runs could pull something out from under it: removals wait for it to close too
  if (job.action === 'remove') { enqueue(job); return { ok: true, queued: true, note: 'They are removed the moment you close the game.' }; }
  const r = await applyJob(p, job, true);
  if (!r.ok) return r;
  const later = null;
  const liveJob = r.added && r.added.length ? (COUNTED.has(job.action) ? { ...job, counts: Object.fromEntries(r.added.map((i) => [i, job.counts[i]])) } : { ...job, list: r.added }) : null;
  if (liveJob) {
    const what = job.list === 'all' ? `${r.added.length} cosmetics unlocked` : jobSummary(p, liveJob);
    deliveries.push({ id: crypto.randomBytes(4).toString('hex'), at: Date.now(), character: liveJob.character, what, status: 'saved' });
    note('added', 'Added to your save', what);
    announce(`[Lantern] Added: ${what}. It shows up after your next loading screen.`);
    requestRefresh(p);
  }
  if (later) { enqueue(later); note('queued', 'Waiting for the game to close', later.label); }
  const o = giftOutcome(p, job, { added: r.added, already: r.already, unknown: r.unknown, queued: !!later });
  if (!liveJob && !later) return { ok: true, live: true, ...o };
  return { ok: true, live: !!liveJob, queued: !!later, ...o };
}

let draining = false;
async function drainQueue() {
  if (draining || !queue.length) return;
  draining = true;
  try {
    const p = places();
    if (!p.pkg || await backendUp(0)) return;
    while (queue.length) {
      const job = queue[0];
      const r = await applyJob(p, job);
      if (!r.ok && /still running|close the game/i.test(r.error || '')) break;   // started again meanwhile
      // this job, not whatever is first now (the queue may have been cleared, and a new gift added, meanwhile)
      const at = queue.indexOf(job); if (at >= 0) queue.splice(at, 1);
      settings.queue = queue; saveSettings();
      if (!r.ok) note('error', 'Could not apply', r.error || describe(job));
      else if (job.action === 'remove') removeOutcome(p, r);
      else if (r.raised && r.raised.length) note('applied', 'Weapon levels raised', `${r.raised.map((w) => WEAPON_NAMES[w] || w).join(', ')}: level 20.`);
      else if (r.added && r.added.length) note('applied', 'Added to your save', job.action === 'add' ? jobSummary(p, job) : listNames(p, r.added));
      else if (job.action === 'set' || job.list === 'all') note('applied', 'Added to your save', jobSummary(p, job));
      else if (job.action === 'maxweapons') note('ok', 'Weapons already maxed', 'Every weapon type is already at level 20.');
      else if (r.already && r.already.length) note('ok', 'Already yours', `You already own ${listNames(p, r.already, 3)}.`);
    }
  } finally { draining = false; }
}
setInterval(() => { drainQueue().catch(() => {}); }, 2500);

// ---------------------------------------------------------------- following the backend log (logs\requests.jsonl)
// The 1.14.7 backend writes one JSON line per request. A GET /inventory/<account>/<character> with a sign-in token
// ("auth") is the game loading that inventory; the panel's own reads carry no token.
let logPos = -1, logFile = null, playingAs = null;
function followLog() {
  const p = places(); if (!p.pkg) return;
  if (logFile !== p.requestLog) { logFile = p.requestLog; logPos = -1; }
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
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e && e.svc === 'mm2' && e.m === 'POST' && e.status === 200 && /^\/candidate\/join/.test(String(e.path || ''))) { placeJoined(e.note); continue; }
    if (!e || e.svc !== 'dauntless' || e.m !== 'GET' || !e.auth || e.status !== 200) continue;
    const m = /^\/inventory\/[^/]+\/([A-Z2-7]{26})\/?$/.exec(String(e.path || ''));
    if (m) inventoryLoaded(p, m[1]);
  }
}
// Where the game is going: the backend notes each join as "<mode>/<type> <hunt>" (CITY/CITY, SHARED/HUNTING_GROUND,
// .../ESCALATION ...). Dauntless Forever (25 Oct, 1.14.7 2026-10-25.2) warns that modded mode (UE4SS, which the game mod
// needs) can crash in busy escalations: the panel says so when one starts. It does not turn anything off by itself.
let inEscalation = false;
function placeJoined(label) {
  const m = /^[A-Z_]+\/([A-Z_]+|-)/.exec(String(label || ''));
  if (!m) return;
  const esc = m[1] === 'ESCALATION';
  if (esc && !inEscalation) note('mod', 'Escalation: modded mode can crash', 'Dauntless Forever advises turning Modded mode off for escalations (launcher, Mods page) until they fix it. The overlay needs it, so it pauses while it is off.');
  inEscalation = esc;
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
// DF reads rules.txt once when its backend starts, and a value that is not one of a rule's choices stops the backend from
// starting. So picks are checked against the current choices (an invalid or stale one falls back to the default and is
// never written back), and while the game runs the panel says when the file differs from what the game started with.
let rulesAtStart = null;   // the rules in effect when the panel saw the game start (null: game closed or not seen)
function readRules(p) {
  const defs = readJson(path.join(p.pkg, 'rules.json'), {}).rules || [];
  const raw = {}, picks = {}, invalid = [];
  let text = ''; try { text = fs.readFileSync(path.join(p.dataDir, 'rules.txt'), 'utf8'); } catch {}
  for (const l of text.split(/\r?\n/)) {
    const m = /^\s*([a-z_]+)\s*=\s*(\S+)\s*$/.exec(l); if (m) raw[m[1]] = m[2];
  }
  for (const r of defs) {
    if (raw[r.key] != null && (r.choices || []).some((c) => c[0] === raw[r.key])) picks[r.key] = raw[r.key];
    else { if (raw[r.key] != null) invalid.push(r.key); if (r.default != null) picks[r.key] = String(r.default); }
  }
  return { defs, picks, invalid };
}
const rulesKey = (p) => JSON.stringify(readRules(p).picks);
const rulesPending = (p) => rulesAtStart != null && rulesAtStart !== rulesKey(p);
function rulesInfo(p) { return { ...readRules(p), pending: rulesPending(p) }; }
function writeRules(p, want) {
  const { defs, picks } = readRules(p);
  for (const r of defs) {
    const v = want[r.key];
    if (v != null && (r.choices || []).some((c) => c[0] === String(v))) picks[r.key] = String(v);
  }
  const lines = ['# Game Rules, written by the launcher (Game Rules page). Takes effect the next time you press Play.'];
  for (const r of defs) if (picks[r.key] != null) lines.push(`${r.key}=${picks[r.key]}`);
  fs.mkdirSync(p.dataDir, { recursive: true });
  const f = path.join(p.dataDir, 'rules.txt');
  fs.writeFileSync(f + '.tmp', lines.join('\r\n') + '\r\n'); fs.renameSync(f + '.tmp', f);
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
// UE4SS ships a mod that switches on the game's built-in cheat manager; Lantern Client has no use for it, so it is
// turned off whenever the game is closed (UE4SS's own mods list, ue4ss\Mods\mods.txt; the folder itself stays)
function devModsOff(p) {
  try {
    if (!p.modsDir || !/^\s*CheatManagerEnablerMod\s*:\s*1\s*$/m.test(fs.readFileSync(path.join(p.modsDir, 'mods.txt'), 'utf8'))) return;
    runTool(p, 'ue4ss.cjs', ['mod', 'CheatManagerEnablerMod', 'off']).catch(() => {});
  } catch {}
}
// UE4SS's UObject cache (bUseUObjectArrayCache) keeps a list of every new object, updated from whichever thread makes
// it, the game's loading threads included. Loading many items at once (a login after a big gift of cosmetics) crashed
// the game inside it (an access violation in UE4SS, on a loading thread). Turned off, as UE4SS's own settings advise
// for crashes; the setting is read when the game starts. The original is kept once as UE4SS-settings.ini.lantern-bak.
function ue4ssSafeSettings(p) {
  try {
    if (!p.ue4ssDll) return false;
    const f = path.join(path.dirname(p.ue4ssDll), 'UE4SS-settings.ini');
    const s = fs.readFileSync(f, 'utf8');
    const re = /^([ \t]*bUseUObjectArrayCache[ \t]*=[ \t]*)(true|1)([ \t]*\r?)$/mi;   // that one value; line endings kept
    if (!re.test(s)) return false;
    if (!fs.existsSync(f + '.lantern-bak')) fs.writeFileSync(f + '.lantern-bak', s);
    fs.writeFileSync(f, s.replace(re, '$1false$3'));
    console.log('UE4SS: turned off its UObject cache (bUseUObjectArrayCache = false)');
    return true;
  } catch { return false; }
}
function syncMod(gameRunning) {
  try {
    const p = places();
    ue4ssSafeSettings(p);
    if (!p.modDir || !fs.existsSync(path.join(p.modDir, 'Scripts', 'main.lua'))) return false;   // not set up: Set up does it
    const stale = modFiles(MOD_SRC).filter((rel) => {
      const a = path.join(MOD_SRC, rel), b = path.join(p.modDir, rel);
      try { return !fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return true; }
    });
    if (!stale.length) return false;
    for (const rel of stale) {
      fs.mkdirSync(path.dirname(path.join(p.modDir, rel)), { recursive: true });
      // the native tracker DLL is locked while a copy of the game has it loaded: it is copied once the game is closed
      try { fs.copyFileSync(path.join(MOD_SRC, rel), path.join(p.modDir, rel)); } catch (e) { if (!rel.endsWith('.dll')) throw e; }
    }
    fs.mkdirSync(path.join(p.modDir, 'status'), { recursive: true });
    // heartbeats and switches from an older mod version: rewritten in the current form
    if (!gameRunning) for (const f of fs.readdirSync(path.join(p.modDir, 'status'))) { try { fs.unlinkSync(path.join(p.modDir, 'status', f)); } catch {} }
    writeToggles(p, readToggles(p));
    note('mod', 'Game mod updated', gameRunning ? 'Restart the game to use it.' : 'It loads the next time you press Play.');
    return true;
  } catch (e) { return false; }
}

// ---------------------------------------------------------------- behemoth overlay
// The game mod (in your game and in each hunt server) writes the behemoth you are fighting to track\<process>.json in
// its folder while the overlay is on. The overlay itself is "Lantern Client.exe --overlay": a small click-through
// window over the game, drawn natively, that asks this panel for GET /api/overlay/state ten times a second. Names come
// from the game's own kill tokens (TOKEN_KILL_COUNT_LERAWR_BETA = "Kill Token: Rogue Embermane").
// engine 'df' (default, 3.9.21): the overlay is Dauntless Forever's Boss Health Bar, built into its loader. It reads
// the game's memory directly, so it costs nothing in co-op, where the mod's object searches made the game hitch; the
// mod tracks nothing then and Lantern's own window is not started. engine 'lantern': Lantern's own card (names,
// element, stagger, BROKEN parts), with DF's bar switched off. Either way two bars never show, and turning the
// overlay off puts DF's bar back the way it was (bossbarBefore).
const OVERLAY_DEFAULTS = { on: false, engine: 'df', pos: 'top', size: 'm', opacity: 0.85, parts: true, numbers: true };
const OVERLAY_ENGINES = ['df', 'lantern'];
const OVERLAY_POS = ['top', 'top-left', 'top-right', 'right'];
const OVERLAY_SIZE = { s: 0.85, m: 1, l: 1.2 };
const THEME_COLORS = { aether: ['#3cebff', '#4ff3ff', '#0b5f6d'], ember: ['#ff8a3d', '#ffa866', '#7a3410'], verdant: ['#4ff096', '#7cf5b0', '#0d5e35'],
  amethyst: ['#b284ff', '#c7a6ff', '#47297d'], crimson: ['#ff5c78', '#ff8399', '#7a1526'], gold: ['#ffc84a', '#ffd978', '#7a560a'] };
function overlaySettings() { return { ...OVERLAY_DEFAULTS, ...(settings.overlay || {}) }; }
// Which behemoth (name, element): behemoths.js, in one place. The game's own name (from the mod) first.
const BEHEMOTHS = require('./behemoths.js');
const PARTS = require('./parts.js');
function panelLog(m) { try { console.log(m); } catch {} }
let ovCache = null, ovCacheAt = 0;
const later = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };
// the mod rewrites its track file in place: a read in the middle of that finds it empty or cut off. The last good
// reading of that file (under a second old) is used then, so the hunt server's copy (with the parts) never drops out
const trackGood = new Map();   // file -> { t, at }
function readTrack(file) {
  const t = readJson(file, null);
  if (t) { trackGood.set(file, { t, at: Date.now() }); return t; }
  const g = trackGood.get(file);
  return g && Date.now() - g.at < 1000 ? g.t : null;
}
// 7.1: your own game says which behemoth you are fighting (of those being hit, the one nearest to you); a hunt server
// on this PC (when you host) has every behemoth's real health and parts and lists those being hit. Yours is matched in
// that list by kind and place, since actor names differ between your game and the server. Without your game's pick
// (an older mod, or no hit yet), the hunt server's latest hit, as before.
const near2 = (a, b) => (Array.isArray(a) && Array.isArray(b) ? (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2 : Infinity);
function pickTrack(tracks) {
  let mine = null, best = null;
  for (const t of tracks) {
    if (t.role === 'game' && (!mine || (t.b.at || 0) > (mine.b.at || 0))) mine = t;
    const score = [t.role === 'server' ? 1 : 0, t.b.at || 0, (t.b.parts || []).length, t.b.n || 0];
    if (!best || later(score, best.score)) best = { t, score };
  }
  if (!mine) return best ? best.t.b : null;
  let match = null, d = Infinity;
  for (const t of tracks) {
    if (t.role !== 'server') continue;
    for (const e of [t.b, ...(Array.isArray(t.list) ? t.list : [])]) {
      if (!e || e.cls !== mine.b.cls) continue;
      const dd = near2(e.loc, mine.b.loc);
      if (!match || dd < d) { match = e; d = dd; }
    }
  }
  return match || mine.b;
}
function overlayTrack(p) {
  if (ovCache && Date.now() - ovCacheAt < 80) return ovCache;
  const tracks = [];
  const dir = p.modDir && path.join(p.modDir, 'track');
  try {
    const now = Date.now() / 1000;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const t = readTrack(path.join(dir, f));
      if (t && t.b && now - (t.time || 0) <= 4) tracks.push(t);
    }
  } catch {}
  ovCacheAt = Date.now();
  const b = pickTrack(tracks);
  if (!b) return (ovCache = null);
  const who = BEHEMOTHS.resolveBehemoth(b.cls, { gameRow: b.nm || b.mn, gameArch: b.da, gameClass: b.dc,
    tokens: catalog(p).behemoths, codeNames: catalog(p).codeNames, log: panelLog });
  const el = who, stg = Array.isArray(b.stg) && b.stg[1] > 0 ? b.stg : null;
  if (!Number.isFinite(b.max) || b.max <= 0 || !Number.isFinite(b.cur)) return (ovCache = null);   // no valid health: nothing to show
  return (ovCache = { key: b.key, name: who.name, cur: Math.min(Math.max(b.cur, 0), b.max), max: b.max, dead: !!b.dead,
    element: el.element, weak: el.weak, stagger: stg ? stg[0] : 0, staggerMax: stg ? stg[1] : 0, staggerDmg: Number.isFinite(b.sdmg) ? b.sdmg : -1,
    parts: (b.parts || []).filter((x) => Array.isArray(x) && Number.isFinite(x[2]) && x[2] > 0).map(([n, c, m, k, x]) => {
      const broken = x === 1, known = Number.isFinite(c) && c >= 0;
      return { name: String(n), cur: broken ? 0 : known ? Math.min(c, m) : null, max: m, breaks: k || 0, broken };
    }) });
}
function overlayStyle() {
  const o = overlaySettings(), c = THEME_COLORS[(settings.prefs || {}).theme] || THEME_COLORS.aether;
  return { accent: c[0], light: c[1], deep: c[2], pos: o.pos, scale: OVERLAY_SIZE[o.size] || 1, opacity: o.opacity, parts: o.parts, numbers: o.numbers };
}
function bossbarOn(p) {
  try { return !/^\s*bossbar\s*=\s*off\s*$/mi.test(fs.readFileSync(path.join(p.dataDir, 'mods.txt'), 'utf8')); } catch { return true; }
}
async function overlayBossbar(p) {
  // overlay on: DF's bar on for engine 'df', off for 'lantern' (its state before is remembered the first time it is
  // changed); overlay off: it goes back to that. DF's loader reads it when the game starts.
  const o = settings.overlay || {};
  if (o.restoreBossbar) { o.bossbarBefore = true; delete o.restoreBossbar; }   // 3.9.20 and older remembered only "was on"
  const want = o.on ? (o.engine || 'df') === 'df' : o.bossbarBefore;
  if (typeof want === 'boolean') {
    const cur = bossbarOn(p);
    if (cur !== want) {
      const r = await runTool(p, 'ue4ss.cjs', ['mod', 'Boss Health Bar', want ? 'on' : 'off']);
      if (r && r.ok && o.on && o.bossbarBefore === undefined) o.bossbarBefore = cur;
      if (!(r && r.ok)) { settings.overlay = o; saveSettings(); return; }
    }
  }
  if (!o.on) delete o.bossbarBefore;
  settings.overlay = o; saveSettings();
}
let overlayPid = 0, overlayTriedAt = 0;
// the overlay is part of launcher 1.6.0 and later (an older one would just open the panel window)
const launcherHasOverlay = () => { const v = String(process.env.DFT_LAUNCHER_VERSION || '0').split('.').map(Number); return v[0] > 1 || (v[0] === 1 && v[1] >= 6); };
function overlayAlive() { if (!overlayPid) return false; try { process.kill(overlayPid, 0); return true; } catch { overlayPid = 0; return false; } }
function ensureOverlay(running) {
  if (!LAUNCHER || !launcherHasOverlay() || !lanternOverlay() || !running || overlayAlive() || !LIC.ok() || Date.now() - overlayTriedAt < 10000) return;
  overlayTriedAt = Date.now();
  try {
    // not windowsHide: Windows would apply a hidden start to the overlay's window too
    const c = spawn(LAUNCHER, ['--overlay', `http://127.0.0.1:${PORT}`, TOKEN], { detached: true, stdio: 'ignore' });
    c.on('error', (e) => { overlayPid = 0; console.log(`overlay: could not start the launcher (${e.message})`); });   // a missing exe is reported here, not thrown
    overlayPid = c.pid || 0; c.unref();
  } catch {}
}

// ---------------------------------------------------------------- state, watched for changes and pushed
let lastRunning = false, lastProcCount = 0;
async function buildState() {
  const p = places();
  const license = LIC.status();
  const user = (() => { try { return process.env.USERNAME || os.userInfo().username; } catch { return ''; } })();
  if (!p.pkg) return { found: false, license, user, app: { version: VERSION, managed: !!LAUNCHER, update: updateReady, checking: updateChecking }, guess: process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'DauntlessForever', 'versions', GAME_BUILD) : '' };
  const running = await backendUp();
  const procs = modProcesses(p);
  return {
    found: true, license, user, pkg: p.pkg, gameDir: p.gameDir, running, playingAs,
    app: { version: VERSION, managed: !!LAUNCHER, launcher: process.env.DFT_LAUNCHER_VERSION || '', overlay: launcherHasOverlay(), update: updateReady, checking: updateChecking },
    ue4ss: !!(p.ue4ssDll && fs.existsSync(p.ue4ssDll)),
    modInstalled: !!(p.modDir && fs.existsSync(path.join(p.modDir, 'Scripts', 'main.lua'))),
    modOn: !!(p.modsDir && modListed(p)), mode: modsMode(p),
    toggles: readToggles(p), processes: procs.map(({ time, ...s }) => s),
    // live copies of the game running another version of the mod than this panel's (restart the game to update them)
    modStale: MOD_VERSION ? procs.filter((s) => s.v !== MOD_VERSION).length : 0, modVersion: MOD_VERSION,
    escalation: running && inEscalation,
    rulesPending: rulesPending(p),
    overlay: { ...overlaySettings(), restoreBossbar: undefined, bossbarBefore: undefined, running: overlayAlive() },
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
      if (!s.running) inEscalation = false;
      if (!s.running) { syncMod(false); devModsOff(places()); }
    }
    const n = s.processes.length;
    if (n && !lastProcCount) note('mod', 'Mod connected', `${s.processes.filter((x) => x.role === 'game').length ? 'Game' : 'No game'} + ${s.processes.filter((x) => x.role === 'server').length} server(s)`);
    lastProcCount = n;
    if (s.running !== lastRunning) { const p = places(); rulesAtStart = s.running && p.pkg ? rulesKey(p) : null; }
    lastRunning = s.running;
    ensureOverlay(s.running);
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
        // the launcher itself is installing one right now (it started first): not a failure; asked again shortly
        else if (r.error === 'another update is running') { note('update', 'An update is already installing', 'Checking again in 30 seconds.'); setTimeout(() => stageUpdate(true), 30000); }
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
  if (res.headersSent) { try { res.end(); } catch {} return; }   // an answer already started: never a second one
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);   // before the headers
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}
// the bytes are joined before decoding (a character split between two chunks stays whole); a body over 2 MB, or a
// connection that drops, ends the request instead of leaving it waiting
function body(req) {
  return new Promise((resolve, reject) => {
    const parts = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > 2e6) { req.destroy(); reject(new Error('Request too large.')); } else parts.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch { resolve({}); } });
    req.on('error', reject); req.on('aborted', () => reject(new Error('Request aborted.')));
  });
}

const routes = {
  'GET /api/state': async () => buildState(),
  'POST /api/package': async (b) => {
    const dir = String(b.package || '').trim();
    if (!isPackage(dir)) return { ok: false, error: 'That folder is not the 1.14.7 package (no tools\\gear-1147.json). Pick the ...\\versions\\1.14.7 folder.' };
    settings.package = dir; saveSettings(); placesCache = null;
    return { ok: true };
  },
  'GET /api/catalog': async () => {
    const p = places(); if (!p.pkg) return { ok: false };
    const groups = (readJson(path.join(p.pkg, 'items.json'), {}).groups || []);
    const c = catalog(p);
    return { ok: true, build: GAME_BUILD, gear: c.gear, types: c.types, groups, rules: rulesInfo(p), cells: cells(p) };
  },
  // Meta Build Creator (anyone with a key): the choices, and a build for them (made in a worker thread)
  'GET /api/builds/options': async () => ({ ok: true, ...BUILDS.options() }),
  'POST /api/builds/generate': async (b) => {
    let owned = null;
    if (b && b.ownedOnly) {
      const p = places();
      const l = p.pkg ? await listChars(p) : null;
      const c = l && l.ok && (l.characters || []).find((x) => x && x.id === String(b.character || ''));
      if (c) {
        const gear = new Set((c.gear || []).map((g) => g.id)), cells = {};
        for (const g of c.gear || []) if (/^CELL_/.test(g.id)) cells[g.id] = (cells[g.id] || 0) + 1;
        for (const [id, n] of Object.entries(c.items || {})) if (n > 0) { gear.add(id); cells[id] = n; }
        owned = { gear: [...gear], cells };
      }
    }
    return BUILDS.generate(b || {}, owned);
  },
  'GET /api/save': async () => {
    const p = places(); if (!p.pkg) return { ok: false, error: 'Package not found.' };
    const l = await listChars(p);
    const r = l && l.ok ? JSON.parse(JSON.stringify(l)) : l;   // a copy: inUse is added per answer
    if (r && r.ok) {
      // what Remove items keeps (in use); the save is only read here
      const st = readJson(path.join(p.dataDir, 'state.json'), null);
      const players = Object.values((st && st.players) || {});
      for (const c of r.characters || []) {
        const pl = players.find((x) => (x.characters || []).some((y) => y && y.id === c.id));
        c.inUse = pl ? [...protectedIds(pl, c.id)].filter((id) => catalog(p).storage.has(id)) : [];
        c.starter = (c.gear || []).map((g) => g.id).filter(isStarter);
        c.equippedParts = pl ? equippedPartsOf(p, pl, c.id) : null;   // the Parts page: behemoth parts for equipped gear
      }
    }
    return r;
  },
  'GET /api/feed': async () => feed,
  // the owner or anyone who turned the behemoth overlay on
  'POST /api/setup': async () => (isOwner() || overlayOn()) ? setup() : { ok: false, error: 'Turn on the behemoth overlay in Settings first.' },
  'POST /api/toggles': async (b) => {
    if (!isOwner()) return { ok: false, error: 'The game mod is the owner\'s.' };
    const p = places(); if (!p.pkg) return { ok: false, error: 'Package not found.' };
    const t = writeToggles(p, { ...readToggles(p), ...b });
    return { ok: true, toggles: t };
  },
  'POST /api/items': async (b) => {
    const p = places(); if (!p.pkg) return { ok: false, error: 'Package not found.' };
    const bad = validJob(b); if (bad) return { ok: false, error: bad };
    const job = { action: b.action, character: String(b.character), list: b.list, counts: b.counts, label: String(b.label || '').slice(0, 120) || undefined };
    if (await backendUp(0)) return giveLive(p, job);
    if (queue.length) { enqueue(job); return { ok: true, queued: true }; }
    const r = await applyJob(p, job);
    if (!r.ok) return r;
    if (job.action === 'set' || (job.action === 'addcosmetic' && job.list === 'all')) { note('applied', 'Added to your save', jobSummary(p, job)); return { ok: true }; }
    if (job.action === 'remove') return removeOutcome(p, r);
    const o = giftOutcome(p, job, r);
    if (r.added && r.added.length) note('applied', 'Added to your save', job.action === 'add' ? jobSummary(p, job) : listNames(p, r.added));
    if (r.raised && r.raised.length) note('applied', 'Weapon levels raised', `${o.raisedNames}: level 20.`);
    if (job.action === 'maxweapons' && !o.raised) return { ok: true, nothingNew: true, message: 'Every weapon type is already at level 20.' };
    return { ok: true, ...o };
  },
  // Parts: the behemoth parts for the gear equipped now (weapon and armour only, no other materials), topped up to
  // `amount` each (1 to 90; more than you already have is never taken away). Worked out here from the save, not sent in.
  'POST /api/parts': async (b) => {
    const p = places(); if (!p.pkg) return { ok: false, error: 'Package not found.' };
    const who = String(b.character || '');
    if (!/^[\w-]{1,64}$|^\*$/.test(who)) return { ok: false, error: 'Unknown character.' };
    const amount = PARTS.clampAmount(b.amount);
    const l = await listChars(p);
    if (!l || !l.ok) return l || { ok: false, error: 'Could not read your characters.' };
    const st = readJson(path.join(p.dataDir, 'state.json'), null);
    const players = Object.values((st && st.players) || {});
    const chars = (l.characters || []).filter((c) => who === '*' || c.id === who);
    if (!chars.length) return { ok: false, error: 'Character not found.' };
    let last = null, given = 0;
    for (const c of chars) {
      const pl = players.find((x) => (x.characters || []).some((y) => y && y.id === c.id));
      const eq = pl && equippedPartsOf(p, pl, c.id);
      if (!eq || !eq.parts.length) continue;
      const counts = Object.fromEntries(eq.parts.map((id) => [id, amount]));
      last = await routes['POST /api/items']({ action: 'atleast', character: c.id, counts, label: `Parts for equipped gear, ${amount} each` });
      if (!last.ok) return last;
      given += eq.parts.length;
    }
    if (!last) return { ok: false, error: 'Nothing equipped takes behemoth parts, so there are none to give.' };
    return { ...last, parts: given, amount };
  },
  // Aetherdust (CURRENCY_CELLDUST): adds exactly one of the five amounts, counted from the inventory at that moment
  'POST /api/aetherdust': async (b) => {
    const amount = Number(b.amount);
    if (!PARTS.AETHERDUST_STEPS.includes(amount)) return { ok: false, error: 'Pick 1,000, 2,000, 3,000, 4,000 or 5,000.' };
    const r = await routes['POST /api/items']({ action: 'add', character: b.character, counts: { [PARTS.AETHERDUST]: amount }, label: `Aetherdust +${amount.toLocaleString('en-US')}` });
    return r.ok ? { ...r, amount } : r;
  },
  'GET /api/overlay/state': async () => {
    const p = places(), o = overlaySettings();
    if (!o.on || o.engine !== 'lantern' || !p.pkg) return { ok: true, on: false };   // "off" also closes a running Lantern window
    return { ok: true, on: true, running: await backendUp(), style: overlayStyle(), b: overlayTrack(p), q: null };
  },
  'POST /api/overlay': async (b) => {
    const p = places(), o = overlaySettings(), was = o.on, wasEngine = o.engine;
    if (typeof b.on === 'boolean') o.on = b.on;
    if (OVERLAY_ENGINES.includes(b.engine)) o.engine = b.engine;
    if (OVERLAY_POS.includes(b.pos)) o.pos = b.pos;
    if (Object.prototype.hasOwnProperty.call(OVERLAY_SIZE, b.size)) o.size = b.size;
    if (typeof b.opacity === 'number' && b.opacity >= 0.4 && b.opacity <= 1) o.opacity = Math.round(b.opacity * 100) / 100;
    if (typeof b.parts === 'boolean') o.parts = b.parts;
    if (typeof b.numbers === 'boolean') o.numbers = b.numbers;
    settings.overlay = { ...(settings.overlay || {}), ...o }; saveSettings();
    if (p.pkg) {
      if (o.on !== was || o.engine !== wasEngine) { try { await overlayBossbar(p); } catch {} }
      writeToggles(p, readToggles(p));
      ensureOverlay(await backendUp());
    }
    return { ok: true, overlay: { ...overlaySettings(), restoreBossbar: undefined, bossbarBefore: undefined, running: overlayAlive() } };
  },
  'POST /api/queue/clear': async () => { queue.length = 0; settings.queue = queue; saveSettings(); return { ok: true }; },
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
    // not windowsHide: Windows would apply that hidden start to the launcher's window too
    const ok = await new Promise((resolve) => {
      const c = spawn(LAUNCHER, ['--after', String(process.pid)], { detached: true, stdio: 'ignore' });
      c.on('error', () => resolve(false));   // the launcher is gone: this panel keeps running instead of quitting
      c.on('spawn', () => { c.unref(); resolve(true); });
    });
    if (!ok) return { ok: false, error: 'The Lantern Client launcher could not be started. Open Lantern Client from its shortcut.' };
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
      let data;
      try { data = fs.readFileSync(path.join(HERE, 'ui', 'fonts', font[1] + '.woff')); } catch { return send(res, 404, 'Not found', 'text/plain'); }
      res.writeHead(200, { 'Content-Type': 'font/woff', 'Cache-Control': 'public, max-age=31536000, immutable' });
      return res.end(data);
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
    // an overlay turned on before 3.9.21 had DF's bar switched off: it is now the default engine, so it goes back on
    try { const p = places(); if (p.pkg && overlayOn()) overlayBossbar(p).catch(() => {}); } catch {}
    backendUp().then((up) => { syncMod(up); if (!up) devModsOff(places()); }).catch(() => {});
    tickState().catch(() => {});
    openWindow(url);
  });
}
listen();
