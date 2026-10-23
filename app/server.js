// DF Trainer panel - a separate companion for Dauntless Forever (Dauntless 1.6.2), single player.
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
const fs = require('fs'), path = require('path'), http = require('http'), net = require('net'), crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const HERE = __dirname;
const UI_FILE = path.join(HERE, 'ui', 'index.html');
const MOD_SRC = path.join(HERE, 'mod', 'DFTrainer');
const LIVE = require('./live');
// Installed by the launcher, each version lives in its own folder (app\<version>): settings live one level up, in the
// install folder (DFT_ROOT), so updates keep them. Started by hand (Start Trainer.bat), they stay next to this file.
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

function isPackage(dir) { return !!dir && fs.existsSync(path.join(dir, 'tools', 'items.js')) && fs.existsSync(path.join(dir, 'tools', 'gear-162.json')); }
function findPackage() {
  const tries = [arg('--package'), process.env.DF_PACKAGE, settings.package];
  const la = process.env.LOCALAPPDATA;
  if (la) for (const root of ['DauntlessForever', 'DauntlessOffline']) tries.push(path.join(la, root, 'versions', '1.6.2'));
  return tries.find(isPackage) || null;
}
function places() {
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

// item names for messages
let NAMES = null, NAMES_PKG = null;
function nameOf(p, id) {
  if (NAMES_PKG !== p.pkg) {
    NAMES = new Map(); NAMES_PKG = p.pkg;
    for (const g of readJson(path.join(p.pkg, 'tools', 'gear-162.json'), [])) NAMES.set(g[0], g[1]);
    for (const grp of readJson(path.join(p.pkg, 'items.json'), {}).groups || []) for (const i of grp.items || []) NAMES.set(i.id, i.name);
  }
  return NAMES.get(id) || id;
}
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
function readToggles(p) {
  const t = p.modDir ? readJson(path.join(p.modDir, 'trainer-toggles.json'), null) : null;
  return { ...TOGGLE_DEFAULTS, ...(settings.toggles || {}), ...(t || {}) };
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
    fs.writeFileSync(f + '.tmp', JSON.stringify({ ...clean, by: 'panel', time: Math.floor(Date.now() / 1000) }));
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
  steps.push('Copied the DF Trainer mod.');
  for (const a of [['set', 'on'], ['set', 'servers-on'], ['mod', MOD_NAME, 'on']]) {
    const r = await runTool(p, 'ue4ss.cjs', a);
    if (!r.ok) return { ok: false, error: r.error || `ue4ss.cjs ${a.join(' ')} failed.`, steps };
  }
  steps.push('Turned on modded mode, server mods and the DF Trainer mod.');
  note('mod', 'Trainer set up', 'Press Play in the launcher.');
  return { ok: true, steps };
}

// ---------------------------------------------------------------- items
const ITEM_ACTIONS = new Set(['addgear', 'addgearmax', 'set', 'surgeall', 'addcosmetic']);
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
  if (b.action === 'set') {
    const c = {};
    for (const [k, n] of Object.entries(b.counts || {})) if (/^[A-Z0-9_]{3,80}$/.test(k) && Number.isFinite(Number(n))) c[k] = Math.max(0, Math.min(99999999, Math.floor(Number(n))));
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
  const n = j.action === 'set' ? Object.keys(j.counts).length : Array.isArray(j.list) ? j.list.length : 0, s = n === 1 ? '' : 's';
  return { surgeall: 'Max all gear', set: `Set ${n} amount${s}`, addgear: `Give ${n} item${s}`, addgearmax: `Give ${n} item${s} at max level`,
    addcosmetic: j.list === 'all' ? 'Unlock all cosmetics' : `Unlock ${n} cosmetic${s}` }[j.action] || j.action;
};
function jobIds(job) { return job.action === 'set' ? Object.keys(job.counts) : Array.isArray(job.list) ? job.list : []; }
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
  } else r = await runTool(p, 'items.js', itemArgs(job));
  history.unshift({ at: Date.now(), what: describe(job), ok: !!r.ok, live, error: r.ok ? undefined : r.error });
  history.length = Math.min(history.length, 40);
  return r;
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
  const liveJob = r.added && r.added.length ? (job.action === 'set' ? { ...job, counts: Object.fromEntries(r.added.map((i) => [i, job.counts[i]])) } : { ...job, list: r.added }) : null;
  if (liveJob) {
    const what = job.list === 'all' ? `${r.added.length} cosmetics unlocked` : jobSummary(p, liveJob);
    deliveries.push({ id: crypto.randomBytes(4).toString('hex'), at: Date.now(), character: liveJob.character, what, status: 'saved' });
    note('added', 'Added to your save', what);
    announce(`[DF Trainer] Added: ${what}. It shows up after your next loading screen.`);
    requestRefresh(p);
  }
  if (later) { enqueue(later); note('queued', 'Waiting for the game to close', later.label); }
  if (!liveJob && !later) return { ok: true, live: true, nothingNew: true };
  return { ok: true, live: !!liveJob, queued: !!later, added: r.added.length };
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
      if (r.ok) note('applied', 'Added to your save', jobSummary(p, job)); else note('error', 'Could not apply', r.error || describe(job));
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
    announce(`[DF Trainer] Delivered: ${what.slice(0, 220)} - check your inventory.`);
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

// ---------------------------------------------------------------- state, watched for changes and pushed
let lastRunning = false, lastProcCount = 0, lastToggleText = '';
async function buildState() {
  const p = places();
  if (!p.pkg) return { found: false, app: { version: VERSION, managed: !!LAUNCHER, update: updateReady, checking: updateChecking }, guess: process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'DauntlessForever', 'versions', '1.6.2') : '' };
  const running = await backendUp();
  const procs = modProcesses(p);
  return {
    found: true, pkg: p.pkg, gameDir: p.gameDir, running, playingAs,
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
setInterval(() => { tickState().catch(() => {}); }, 700);

// ---------------------------------------------------------------- updates (only when started by the DF Trainer launcher)
// The launcher does the work: "--stage" fetches the latest release from GitHub, checks its signature and checksums,
// unpacks it next to this version and makes it the one to start next time. This panel keeps running its own files; a
// restart (one click, or simply the next time DF Trainer opens) switches to the new version.
let updateReady = null, updateChecking = false, lastCheck = 0;
function stageUpdate(manual = false) {
  if (!LAUNCHER || updateChecking) return Promise.resolve({ ok: false, error: LAUNCHER ? 'Already checking.' : 'Updates come with the DF Trainer launcher.' });
  updateChecking = true; lastCheck = Date.now();
  return new Promise((resolve) => {
    execFile(LAUNCHER, ['--stage'], { timeout: 6 * 60 * 1000, windowsHide: true, env: { ...process.env } }, (e, out) => {
      updateChecking = false;
      let r; try { r = JSON.parse(String(out || '').trim()); } catch { r = { ok: false, error: e ? e.message.split('\n')[0] : 'No answer from the launcher.' }; }
      if (r.applied && r.to) {
        updateReady = { version: r.to, notes: r.notes || '' };
        note('update', `DF Trainer ${r.to} is ready`, r.notes ? `${r.notes} Restart to use it.` : 'Restart to use it.');
      } else if (manual) {
        if (r.error === 'no update channel set') note('error', 'No update channel yet', 'This build has no GitHub repository set for updates.');
        else if (r.error) note('error', r.available ? 'The update did not install' : 'Could not check for updates', r.error);
        else if (!updateReady) note('ok', 'You have the latest version', `DF Trainer ${VERSION}`);
      }
      if (r.launcherUpdated && !r.applied) note('update', 'Launcher updated', 'It is used the next time DF Trainer opens.');
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
    if (n.rolledBack) setTimeout(() => note('error', `Version ${n.rolledBack} did not start`, `DF Trainer went back to ${n.to}. That version will be skipped.`), 1500);
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
    settings.package = dir; saveSettings();
    return { ok: true };
  },
  'GET /api/catalog': async () => {
    const p = places(); if (!p.pkg) return { ok: false };
    const gear = readJson(path.join(p.pkg, 'tools', 'gear-162.json'), []);
    const groups = (readJson(path.join(p.pkg, 'items.json'), {}).groups || []);
    const cos = readJson(path.join(p.pkg, 'tools', 'cosmetics-162.json'), {});
    const cosmetic = new Set([...(cos.stacked || []), ...(cos.instanced || [])]);
    return { ok: true, gear: gear.map((g) => [g[0], g[1], g[2], cosmetic.has(g[0]) ? 1 : 0]), groups, rules: rulesInfo(p) };
  },
  'GET /api/save': async () => {
    const p = places(); if (!p.pkg) return { ok: false, error: 'Package not found.' };
    const r = await runTool(p, 'items.js', ['list']);
    if (r && r.ok) delete r.gearCatalog;
    return r;
  },
  'GET /api/feed': async () => feed,
  'POST /api/setup': async () => setup(),
  'POST /api/toggles': async (b) => {
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
    if (r.ok) note('applied', 'Added to your save', jobSummary(p, job));
    return r;
  },
  'POST /api/queue/clear': async () => { queue = []; settings.queue = queue; saveSettings(); return { ok: true }; },
  'POST /api/update/check': async () => stageUpdate(true),
  'POST /api/update/restart': async () => {
    if (!LAUNCHER) return { ok: false, error: 'Updates come with the DF Trainer launcher.' };
    // the launcher waits for this panel to exit, then starts the new version (gifts still waiting are kept)
    spawn(LAUNCHER, ['--after', String(process.pid)], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    setTimeout(() => process.exit(0), 400);
    return { ok: true };
  },
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
      if (url.searchParams.get('t') !== TOKEN) return send(res, 403, 'Open the trainer with Start Trainer.bat.', 'text/plain');
      return send(res, 200, fs.readFileSync(UI_FILE), 'text/html; charset=utf-8');
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

function openWindow(url) {
  if (NO_OPEN) return;
  if (IS_WIN) {
    const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
    const edge = pf.map((d) => path.join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe')).find((f) => fs.existsSync(f));
    if (edge) {
      // its own profile: a fresh browser process, so the window is the app alone and its sounds may play at once
      const profile = path.join(process.env.LOCALAPPDATA || HERE, 'DFTrainer', 'window');
      spawn(edge, [`--app=${url}`, `--user-data-dir=${profile}`, '--window-size=1280,840', '--no-first-run', '--no-default-browser-check',
        '--autoplay-policy=no-user-gesture-required', '--disable-features=Translate,msEdgeSidebarV2'], { detached: true, stdio: 'ignore' }).unref();
      return;
    }
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    console.log('Open ' + url);
  }
}

function listen(tries = 0) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries < 10) { PORT += 1; listen(tries + 1); }
    else { console.error(e.message); process.exit(1); }
  });
  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${PORT}/?t=${TOKEN}`;
    console.log(`DF Trainer panel: ${url}`);
    writeRunning(url);
    tickState().catch(() => {});
    openWindow(url);
  });
}
listen();
