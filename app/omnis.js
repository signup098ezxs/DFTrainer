// SPDX-License-Identifier: AGPL-3.0-only
// BetterOmnis: small buffs to Omnicell passives (actives untouched), as one override pak in the game's Paks folder.
// betteromnis/ holds the pak and betteromnis.json (built by tools/betteromnis/build.py; each buff changes the gameplay
// value and the disc number together). The pak replaces 14 files of the game's paks and adds one (Revenant's Blood Ward); it is only put in
// while those paks still have exactly the files it was made from (fingerprints in betteromnis.json), so a game update
// never gets stale copies. Taking it out = deleting the file. Never while any copy of the game runs: the game and its
// hunt servers read the Paks folder only when they start.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const DIR = path.join(__dirname, 'betteromnis');
const M = JSON.parse(fs.readFileSync(path.join(DIR, 'betteromnis.json'), 'utf8'));
const SRC = path.join(DIR, M.pak);
const GAME_EXE = 'Dauntless-Win64-Shipping.exe';   // your game and each hunt server (same exe, "-server")

const paksDir = (gameDir) => path.join(gameDir, 'Archon', 'Content', 'Paks');
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// the game's own paks still have the files the buffs were made from (reads 53 bytes per file: the entry header's
// SHA-1). An entry names its pak when it is not M.base.pak (Revenant's catalog row is in Archon_24).
function baseOk(gameDir) {
  const byPak = new Map();
  for (const e of M.base.entries) { const k = e.pak || M.base.pak; if (!byPak.has(k)) byPak.set(k, []); byPak.get(k).push(e); }
  for (const [pak, entries] of byPak) {
    let fd;
    try {
      fd = fs.openSync(path.join(paksDir(gameDir), pak), 'r');
      const h = Buffer.alloc(53);
      for (const e of entries) {
        if (fs.readSync(fd, h, 0, 53, e.offset) !== 53 || h.subarray(28, 48).toString('hex') !== e.sha1) return false;
      }
    } catch { return false; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  }
  return true;
}
// 'on' = this version's pak is in; 'old' = a pak by that name with other bytes (an earlier BetterOmnis); 'off' = none
function installed(gameDir) {
  const f = path.join(paksDir(gameDir), M.pak);
  if (!fs.existsSync(f)) return 'off';
  try { return sha256(f) === M.sha256 ? 'on' : 'old'; } catch { return 'old'; }
}
function install(gameDir) {
  if (sha256(SRC) !== M.sha256) throw new Error('BetterOmnis pak in this Lantern install is damaged (checksum)');
  const f = path.join(paksDir(gameDir), M.pak), tmp = f + '.lantern-tmp';
  fs.copyFileSync(SRC, tmp);
  if (sha256(tmp) !== M.sha256) { try { fs.unlinkSync(tmp); } catch {} throw new Error('copy did not match'); }
  fs.renameSync(tmp, f);
}
function remove(gameDir) {
  const f = path.join(paksDir(gameDir), M.pak);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
// any copy of the game (your game or a hunt server) still running
function gameRunning() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', `IMAGENAME eq ${GAME_EXE}`, '/NH', '/FO', 'CSV'], { windowsHide: true, timeout: 15000 }, (e, out) => {
      resolve(e ? null : String(out).toLowerCase().includes(GAME_EXE.toLowerCase()));   // null = could not tell
    });
  });
}
const summary = () => M.buffs.map((b) => (b.from == null ? `${b.omnicell}: ${b.what}` : `${b.omnicell} ${b.what.toLowerCase()} ${b.from} -> ${b.to}`)).join(', ');
const basePaks = () => [...new Set(M.base.entries.map((e) => e.pak || M.base.pak))];   // the game paks it was made from

module.exports = { M, baseOk, installed, install, remove, gameRunning, summary, paksDir, basePaks };
