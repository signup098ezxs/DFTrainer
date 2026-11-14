// SPDX-License-Identifier: AGPL-3.0-only
// Model Swaps: another character's model shown in place of your own Slayer, on your screen only.
// A character is a folder in the library (<Lantern's data folder>\models\<id>\) made by the converter
// (modelswaps-tool\convert.py) from a file of your own or from a Sketchfab download, or copied from someone else:
//   model.json   name, source game, author, the pak's name and checksum, the mesh's path in the game, compatibility notes
//   <pak>        the character's own game files (mesh, material, textures) under /Game/Lantern/ModelSwaps/<id>/
//   preview.png
// The pak adds files; it replaces none of the game's. In the game, Lantern's native library (lantern_native.dll, loaded
// by the ModelSwaps mod) sets the mesh on your Slayer's body and hides head, hair, armour and accessories; armour
// stays equipped. This file is the library and the files in the game; server.js decides when.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ID = /^[a-z0-9_]{1,32}$/;
const GAME = '1.14.7';
const TOOL = 1;                 // the converter's format this panel knows (model.json "tool")
const MAX_PAK = 600 * 1024 * 1024;
const pakName = (id) => `LanternModel_${id}_P.pak`;
const paksDir = (gameDir) => path.join(gameDir, 'Archon', 'Content', 'Paks');
const meshPath = (id) => `/Game/Lantern/ModelSwaps/${id}/${id}`;
const str = (v, n = 200) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n) : '');

// checksums are kept per file state (size + time): a 100 MB pak is read once, not on every look
const sums = new Map();
function sha256(f) {
  const st = fs.statSync(f), key = `${f}|${st.size}|${st.mtimeMs}`;
  if (!sums.has(key)) {
    const h = crypto.createHash('sha256'), fd = fs.openSync(f, 'r'), buf = Buffer.alloc(1 << 20);
    try { for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
    if (sums.size > 200) sums.clear();
    sums.set(key, h.digest('hex'));
  }
  return sums.get(key);
}

// one library entry, checked. problem: why it cannot be used (shown in the tab), or '' when it can
function read(lib, id) {
  const dir = path.join(lib, id);
  const out = { id, dir, name: id, game: '', author: '', description: '', source: '', license: '', notes: [], stats: {}, problem: '' };
  if (!ID.test(id)) return { ...out, problem: 'Its folder name may only have lower-case letters, digits and _.' };
  let m;
  try { m = JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8').replace(/^﻿/, '')); } catch { return { ...out, problem: 'Its model.json is missing or cannot be read.' }; }
  if (!m || typeof m !== 'object') return { ...out, problem: 'Its model.json is not valid.' };
  Object.assign(out, { name: str(m.name, 60) || id, game: str(m.game, 80), author: str(m.author, 80), description: str(m.description, 400), source: str(m.source, 300), license: str(m.license, 60) });
  out.notes = Array.isArray(m.compatibility && m.compatibility.notes) ? m.compatibility.notes.map((n) => str(n, 200)).filter(Boolean).slice(0, 8) : [];
  const s = m.stats || {};
  out.stats = { vertices: Number(s.vertices) || 0, triangles: Number(s.triangles) || 0 };
  out.preview = fs.existsSync(path.join(dir, 'preview.png'));
  if (m.id !== id) return { ...out, problem: 'Its folder name and the id in model.json differ.' };
  // everything below must be exactly what this panel would make itself: a pak by any other name or path is not loaded
  if (m.pak !== pakName(id) || m.mesh !== `${meshPath(id)}.${id}`) return { ...out, problem: 'It was not made by Lantern\'s converter (unexpected file names).' };
  if (m.gameVersion !== GAME) return { ...out, problem: `It was made for Dauntless ${str(String(m.gameVersion), 20) || '?'}, not ${GAME}: convert it again.` };
  if (Number(m.tool) !== TOOL) return { ...out, problem: Number(m.tool) > TOOL ? 'It was made by a newer Lantern: update Lantern Client.' : 'It was made by an older converter: convert it again.' };
  const pak = path.join(dir, m.pak);
  let st; try { st = fs.statSync(pak); } catch { return { ...out, problem: 'Its pak file is missing.' }; }
  if (!st.isFile() || st.size < 1000 || st.size > MAX_PAK) return { ...out, problem: 'Its pak file has an impossible size.' };
  out.pak = pak; out.size = st.size; out.sha256 = str(String(m.pakSha256), 64).toLowerCase();
  // the size it is drawn at, against the Slayer's skeleton (the converter works it out from the character's own height)
  out.scale = Number(m.scale) >= 0.5 && Number(m.scale) <= 1.5 ? Math.round(Number(m.scale) * 1000) / 1000 : 1;
  out.height = Number(m.height) > 0 ? Math.round(Number(m.height)) : 0;
  try { if (sha256(pak) !== out.sha256) return { ...out, problem: 'Its pak file is damaged (checksum): copy or convert it again.' }; }
  catch { return { ...out, problem: 'Its pak file cannot be read.' }; }
  return out;
}
function list(lib) {
  let names = [];
  try { names = fs.readdirSync(lib, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch {}
  return names.map((n) => read(lib, n)).sort((a, b) => a.name.localeCompare(b.name));
}

// the character's pak in the game: 'on' (this one), 'old' (same name, other bytes), 'off'
function inGame(gameDir, m) {
  const f = path.join(paksDir(gameDir), pakName(m.id));
  let st; try { st = fs.statSync(f); } catch { return 'off'; }
  try { return st.size === m.size && sha256(f) === m.sha256 ? 'on' : 'old'; } catch { return 'old'; }
}
// throws when the game holds the file (a copy of the game that mounted an older pak of this character is running)
function install(gameDir, m) {
  const f = path.join(paksDir(gameDir), pakName(m.id)), tmp = f + '.lantern-tmp';
  fs.copyFileSync(m.pak, tmp);
  try {
    if (sha256(tmp) !== m.sha256) throw new Error('the copy did not match');
    fs.renameSync(tmp, f);
  } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}
// Lantern's character paks in the game that the library no longer has (a removed character): [file names]
function strays(gameDir, keepIds) {
  const keep = new Set(keepIds.map(pakName));
  try { return fs.readdirSync(paksDir(gameDir)).filter((n) => /^LanternModel_[a-z0-9_]{1,32}_P\.pak(\.lantern-tmp)?$/.test(n) && !keep.has(n)); } catch { return []; }
}
function removePak(gameDir, name) {
  if (!/^LanternModel_[a-z0-9_]{1,32}_P\.pak(\.lantern-tmp)?$/.test(name)) return;
  fs.unlinkSync(path.join(paksDir(gameDir), name));
}

// what the game mod and the native library read (written whole, then renamed)
function writeConfig(modDir, id, scale = 1) {
  const f = path.join(modDir, 'modelswap.json'), text = JSON.stringify(id ? { on: true, mesh: meshPath(id), scale } : { on: false, mesh: '' });
  try { if (fs.readFileSync(f, 'utf8') === text) return false; } catch {}
  fs.writeFileSync(f + '.tmp', text); fs.renameSync(f + '.tmp', f);
  return true;
}
// what the native library says it shows: { live, on, shown, status } (live: your game is running it right now)
function status(modDir) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(modDir, 'native-status.json'), 'utf8'));
    return { live: Date.now() / 1000 - Number(s.time) < 6, on: !!s.on, shown: !!s.shown, status: str(String(s.status), 160) };
  } catch { return { live: false, on: false, shown: false, status: '' }; }
}

// the library entry is deleted (only inside the library, only a folder that is a character)
function remove(lib, id) {
  if (!ID.test(id)) throw new Error('Not a character.');
  const dir = path.join(lib, id);
  if (path.dirname(path.resolve(dir)) !== path.resolve(lib) || !fs.existsSync(path.join(dir, 'model.json'))) throw new Error('Not a character in the library.');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- the converter (Python: numpy and Pillow)
const TOOL_DIR = path.join(__dirname, 'modelswaps-tool');
function run(cmd, args, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 4e6 }, (e, out, err) => resolve({ code: e ? (e.code ?? 1) : 0, out: String(out || ''), err: String(err || '') }));
  });
}
let pythonOk = null;
async function python() {   // '' when there is none that can run the converter
  if (pythonOk !== null) return pythonOk;
  const r = await run('python', ['-c', 'import numpy, PIL, sys; print(sys.version_info[0])'], 20000);
  pythonOk = r.code === 0 && r.out.trim() === '3' ? 'python' : '';
  return pythonOk;
}
const idFrom = (name) => (String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'character');
// -> { ok, id, stats } or { ok: false, error }. The tool writes into a temporary folder; a complete entry replaces the old one.
async function convert({ lib, file, id, name, game, author, description, source, license, paks, oodle, cache }) {
  const py = await python();
  if (!py) return { ok: false, error: 'Converting needs Python 3 with numpy and Pillow on this PC (python -m pip install numpy pillow). Characters someone else converted work without it: copy their folder into the library.' };
  file = String(file || '').trim().replace(/^"|"$/g, '');
  if (!/\.(gltf|glb)$/i.test(file)) return { ok: false, error: 'Give the path of a glTF model file (.gltf or .glb).' };
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return { ok: false, error: 'That file was not found.' };
  id = ID.test(String(id || '')) ? id : idFrom(name || path.basename(path.dirname(file)));
  const tmp = path.join(lib, '.converting');
  fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
  const args = ['-I', path.join(TOOL_DIR, 'convert.py'), file, '--id', id, '--out', tmp, '--name', str(name, 60) || id, '--cache', cache, '--paks', paks];
  for (const [k, v] of [['game', game], ['author', author], ['description', description], ['source', source], ['license', license]]) if (str(v, 400)) args.push('--' + k, str(v, 400));
  if (oodle) args.push('--oodle', oodle);
  const r = await run(py, args, 600000);
  let res = null;
  try { res = JSON.parse(r.out.trim().split(/\r?\n/).pop()); } catch {}
  if (!res || !res.ok) { fs.rmSync(tmp, { recursive: true, force: true }); return { ok: false, error: (res && res.error) || 'The converter stopped without an answer.', detail: r.err.slice(-600) }; }
  const made = read(tmp, id);
  if (made.problem) { fs.rmSync(tmp, { recursive: true, force: true }); return { ok: false, error: 'The converted character did not pass its check: ' + made.problem }; }
  const dest = path.join(lib, id);
  fs.rmSync(dest, { recursive: true, force: true }); fs.renameSync(path.join(tmp, id), dest); fs.rmSync(tmp, { recursive: true, force: true });
  return { ok: true, id, stats: res.stats };
}

// ---------------------------------------------------------------- characters from Sketchfab
// Sketchfab's public search lists models that may be downloaded; the download itself needs a Sketchfab account: its
// API token (sketchfab.com > Settings > Password & API) is sent only to api.sketchfab.com, as "Authorization: Token".
// The model comes as one .glb file from the address Sketchfab answers with, and goes through the same converter as
// a file of your own, so every fix is applied; its author, licence and page are kept in the character's model.json.
// Nothing is hosted by Lantern. DFT_SKETCHFAB_BASE (a http://127.0.0.1 address only) is for tests.
const SF_TEST = /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.DFT_SKETCHFAB_BASE || '') ? process.env.DFT_SKETCHFAB_BASE : '';
const SF = SF_TEST || 'https://api.sketchfab.com';
const SF_UID = /^[0-9a-f]{32}$/;
const MAX_GLB = 300 * 1024 * 1024;
async function sfJson(pathname, token, ms = 20000) {
  const headers = { 'User-Agent': 'LanternClient', Accept: 'application/json' };
  if (token) headers.Authorization = `Token ${token}`;
  let r; try { r = await fetch(SF + pathname, { headers, signal: AbortSignal.timeout(ms) }); } catch { throw new Error('Sketchfab did not answer. Check your connection and try again.'); }
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error(token ? 'Sketchfab did not accept your API token. Check it in your Sketchfab settings.' : 'Downloading needs a Sketchfab account: add your API token first.'), { auth: true });
  if (r.status === 404) throw new Error('Sketchfab does not have that model (any more).');
  if (r.status === 429) throw new Error('Sketchfab asks to slow down: wait a minute and try again.');
  if (!r.ok) throw new Error(`Sketchfab answered ${r.status}.`);
  try { return await r.json(); } catch { throw new Error('Sketchfab answered with something unreadable.'); }
}
const sfRow = (m) => {
  const thumbs = ((m.thumbnails || {}).images || []).filter((t) => /^https:\/\/media\.sketchfab\.com\//.test(String(t.url))).sort((a, b) => a.width - b.width);
  const glb = (m.archives || {}).glb || {};
  return { uid: m.uid, name: str(m.name, 80), author: str((m.user || {}).displayName || (m.user || {}).username, 80), license: str((m.license || {}).label, 60),
    faces: Number(m.faceCount) || 0, size: Number(glb.size) || 0, page: /^https:\/\/sketchfab\.com\//.test(String(m.viewerUrl)) ? m.viewerUrl : '',
    thumb: ((thumbs.find((t) => t.width >= 200) || thumbs[thumbs.length - 1] || {}).url) || '' };
};
// -> { items, next }: downloadable character models; adult-only ones are left out
async function sfSearch(q, cursor) {
  const qs = new URLSearchParams({ type: 'models', downloadable: 'true', count: '24', max_face_count: '200000', categories: 'characters-creatures', q: str(q, 80) });
  if (/^\d{1,6}$/.test(String(cursor || ''))) qs.set('cursor', String(cursor));
  const r = await sfJson(`/v3/search?${qs}`);
  const items = (r.results || []).filter((m) => m && SF_UID.test(String(m.uid)) && m.isDownloadable && !m.isAgeRestricted).map(sfRow);
  let next = ''; try { next = new URL(r.next).searchParams.get('cursor') || ''; } catch {}
  return { items, next };
}
async function sfWho(token) { const r = await sfJson('/v3/me', token); return str(r.displayName || r.username, 80) || 'your account'; }
// the model's .glb into dir -> { file, row }. The file comes from wherever Sketchfab says (its own storage), without the token
async function sfFetch(uid, token, dir) {
  if (!SF_UID.test(String(uid))) throw new Error('Not a Sketchfab model.');
  const row = sfRow(await sfJson(`/v3/models/${uid}`));
  const d = await sfJson(`/v3/models/${uid}/download`, token);
  const g = d && d.glb;
  if (!g || !/^https?:\/\//.test(String(g.url))) throw new Error('Sketchfab offers no .glb file for this model.');
  if (!SF_TEST && !/^https:\/\//.test(g.url)) throw new Error('Sketchfab gave an address that is not secure.');
  if (Number(g.size) > MAX_GLB) throw new Error('That model is too large (over 300 MB).');
  let r; try { r = await fetch(g.url, { signal: AbortSignal.timeout(600000) }); } catch { throw new Error('The model file could not be fetched.'); }
  if (!r.ok) throw new Error(`The model file could not be fetched (${r.status}).`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'model.glb'), fd = fs.openSync(file, 'w'); let n = 0;
  try { for await (const c of r.body) { n += c.length; if (n > MAX_GLB) throw new Error('That model is too large (over 300 MB).'); fs.writeSync(fd, c); } } finally { fs.closeSync(fd); }
  const head = Buffer.alloc(4); const f2 = fs.openSync(file, 'r'); fs.readSync(f2, head, 0, 4, 0); fs.closeSync(f2);
  if (head.toString('latin1') !== 'glTF') throw new Error('Sketchfab sent something that is not a .glb model.');
  return { file, row };
}
// download + convert -> { ok, id, name } or { ok: false, error }
async function sfGet({ lib, uid, token, paks, oodle, cache }) {
  const tmp = path.join(lib, '.sketchfab');
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    const { file, row } = await sfFetch(uid, token, tmp);
    const id = `${idFrom(row.name).slice(0, 25)}_${uid.slice(0, 6)}`;   // the same model always lands in the same folder
    const r = await convert({ lib, file, id, name: row.name || id, author: row.author ? `${row.author} (Sketchfab)` : 'Sketchfab', license: row.license, source: row.page, paks, oodle, cache });
    return r.ok ? { ...r, name: row.name || id } : r;
  } catch (e) { return { ok: false, error: e.message, auth: !!e.auth }; }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

module.exports = { sfSearch, sfWho, sfGet, SF_UID, ID, list, read, inGame, install, strays, removePak, writeConfig, status, remove, convert, python, pakName, meshPath, paksDir, idFrom };
