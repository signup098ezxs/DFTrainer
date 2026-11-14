// SPDX-License-Identifier: AGPL-3.0-only
// Model Swaps: another character's model shown in place of your own Slayer, on your screen only.
// A character is a folder in the library (<Lantern's data folder>\models\<id>\) made by the converter
// (modelswaps-tool\convert.py) or copied from someone else:
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
async function convert({ lib, file, name, game, author, description, source, license, paks, oodle, cache }) {
  const py = await python();
  if (!py) return { ok: false, error: 'Converting needs Python 3 with numpy and Pillow on this PC (python -m pip install numpy pillow). Characters someone else converted work without it: copy their folder into the library.' };
  file = String(file || '').trim().replace(/^"|"$/g, '');
  if (!/\.(gltf|glb)$/i.test(file)) return { ok: false, error: 'Give the path of a glTF model file (.gltf or .glb).' };
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return { ok: false, error: 'That file was not found.' };
  const id = idFrom(name || path.basename(path.dirname(file)));
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

// ---------------------------------------------------------------- characters to download
// Ready-made characters (converted with the current converter, so every fix is in them) are files of the "models"
// release of Lantern's own GitHub repository: <id>.json (the character's model.json), <id>.pak and <id>.png. The list
// is models/catalog.json on the main branch: [{ id, name, game, author, license, source, description, size, sha256 }].
// Addresses are always built here from the repository and the id: the list cannot point anywhere else. A download is
// checked twice (the list's checksum, then the same checks as any library entry) before it replaces anything.
// DFT_MODELS_BASE (a http://127.0.0.1 address only) is for tests: the list and the files come from there.
const TEST_BASE = /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.DFT_MODELS_BASE || '') ? process.env.DFT_MODELS_BASE : '';
const catalogUrl = (repo) => TEST_BASE ? `${TEST_BASE}/catalog.json` : `https://raw.githubusercontent.com/${repo}/main/models/catalog.json`;
const assetUrl = (repo, name) => TEST_BASE ? `${TEST_BASE}/${name}` : `https://github.com/${repo}/releases/download/models/${name}`;
async function get(url, max, ms = 30000) {   // -> Buffer; throws on anything but a 200 of at most max bytes
  const r = await fetch(url, { headers: { 'User-Agent': 'LanternClient' }, signal: AbortSignal.timeout(ms), redirect: 'follow' });
  if (!r.ok) throw new Error(`the download answered ${r.status}`);
  if (Number(r.headers.get('content-length')) > max) throw new Error('the file is larger than it should be');
  const parts = []; let n = 0;
  for await (const c of r.body) { n += c.length; if (n > max) throw new Error('the file is larger than it should be'); parts.push(c); }
  return Buffer.concat(parts);
}
let catCache = null, catAt = 0;
async function catalog(repo, fresh = false) {
  if (!repo && !TEST_BASE) return [];
  if (catCache && !fresh && Date.now() - catAt < 300000) return catCache;
  let rows; try { rows = JSON.parse((await get(`${catalogUrl(repo)}${TEST_BASE ? '' : `?t=${Date.now()}`}`, 1e6, 15000)).toString('utf8')); } catch (e) { throw new Error(`The list of characters could not be fetched (${e.message}).`); }
  catCache = (Array.isArray(rows) ? rows : []).filter((r) => r && ID.test(String(r.id)) && /^[0-9a-f]{64}$/.test(String(r.sha256)) && Number(r.size) > 1000 && Number(r.size) <= MAX_PAK).slice(0, 500)
    .map((r) => ({ id: r.id, name: str(r.name, 60) || r.id, game: str(r.game, 80), author: str(r.author, 80), license: str(r.license, 60), source: str(r.source, 300), description: str(r.description, 400), size: Number(r.size), sha256: r.sha256 }));
  catAt = Date.now();
  return catCache;
}
const pics = new Map();   // previews of characters not downloaded yet, kept while the panel runs
async function remotePreview(repo, id) {
  if (!ID.test(id)) throw new Error('Not a character.');
  if (!pics.has(id)) { const b = await get(assetUrl(repo, `${id}.png`), 4e6); if (b.length < 8 || b.readUInt32BE(0) !== 0x89504e47) throw new Error('not a picture'); if (pics.size > 200) pics.clear(); pics.set(id, b); }
  return pics.get(id);
}
async function download(repo, lib, id) {
  const row = (await catalog(repo)).find((r) => r.id === id);
  if (!row) throw new Error('That character is not on the list.');
  const tmp = path.join(lib, '.downloading'), dir = path.join(tmp, id);
  fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  try {
    const meta = await get(assetUrl(repo, `${id}.json`), 1e6);
    const pak = await get(assetUrl(repo, `${id}.pak`), row.size, 600000);
    if (pak.length !== row.size || crypto.createHash('sha256').update(pak).digest('hex') !== row.sha256) throw new Error('the downloaded file does not match the list (try again)');
    fs.writeFileSync(path.join(dir, 'model.json'), meta); fs.writeFileSync(path.join(dir, pakName(id)), pak);
    try { fs.writeFileSync(path.join(dir, 'preview.png'), await remotePreview(repo, id)); } catch {}
    const made = read(tmp, id);
    if (made.problem) throw new Error(made.problem);
    const dest = path.join(lib, id);
    fs.rmSync(dest, { recursive: true, force: true }); fs.renameSync(dir, dest);
    return { ok: true, id, name: made.name };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

module.exports = { catalog, download, remotePreview, ID, list, read, inGame, install, strays, removePak, writeConfig, status, remove, convert, python, pakName, meshPath, paksDir, idFrom };
