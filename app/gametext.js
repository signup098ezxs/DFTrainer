// Lantern Client - the game's own English item names, read from the localisation table (Game.locres) that the package's
// paks (bin\*.pak) carry uncompressed. Licence: AGPL-3.0-only.
//
// Why: tools\catalog-1147.json has no name for ~2,600 items, and the package's picker (tools\gear-1147.json) then guesses
// one from the id (AR_CRYSTAL_CHEST -> "Crystal Chest", really "Timeweave Robes"). The table keys an item's name as
// <catalog asset>::<ID>|Display Name (armour_gameplay_catalog::AR_CRYSTAL_CHEST|Display Name).
// A .locres holds one language; the paks hold all of them. English is the one where UI::Common.Accept is "ACCEPT".
// Format (UE4 locres v1-v3; the package's is v1): magic, version byte, int64 offset of the string array, [v3: entry
// count], namespaces ([v2+: hash] name, keys: [v2+: hash] key, source hash, string index), then the strings ([v2+: ref
// count] each). FStrings: int32 length, < 0 means UTF-16.
'use strict';
const fs = require('fs'), path = require('path');

const MAGIC = Buffer.from([0x0E, 0x14, 0x74, 0x75, 0x67, 0x4A, 0x03, 0xFC, 0x4A, 0x15, 0x90, 0x9D, 0xC3, 0x37, 0x7F, 0x1B]);

function parseAt(b, at) {
  let o = at + 16;
  const ver = b[o]; o += 1;
  if (ver < 1 || ver > 3) return null;
  const hashed = ver >= 2;
  const i32 = () => { const v = b.readInt32LE(o); o += 4; return v; };
  const str = () => {
    const n = i32();
    if (n === 0) return '';
    if (n > 0) { const s = b.toString('latin1', o, o + n - 1); o += n; return s; }
    const s = b.toString('utf16le', o, o + (-n - 1) * 2); o += -n * 2; return s;
  };
  const strOff = Number(b.readBigInt64LE(o)); o += 8;
  if (ver >= 3) i32();
  const head = o;
  o = at + strOff;
  const strings = new Array(i32());
  for (let i = 0; i < strings.length; i++) { strings[i] = str(); if (hashed) i32(); }
  o = head;
  const out = new Map();
  for (let ns = i32(); ns > 0; ns--) {
    if (hashed) i32();
    const name = str();
    for (let k = i32(); k > 0; k--) { if (hashed) i32(); const key = str(); i32(); out.set(`${name}::${key}`, strings[i32()]); }
  }
  return out;
}

// -> Map "<namespace>::<key>" -> English text, empty when no pak has the table
function englishText(pkg) {
  const dir = path.join(pkg, 'bin');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.pak$/i.test(f)).sort(); } catch { return new Map(); }
  for (const f of files) {
    let b; try { b = fs.readFileSync(path.join(dir, f)); } catch { continue; }
    for (let at = b.indexOf(MAGIC); at >= 0; at = b.indexOf(MAGIC, at + 16)) {
      let t = null; try { t = parseAt(b, at); } catch {}   // a truncated or foreign block is skipped
      if (t && t.get('UI::Common.Accept') === 'ACCEPT') return t;
    }
  }
  return new Map();
}

// a catalog entry's name in the game text, from its asset (Gear_Catalogs/armour_gameplay_catalog.uasset)
function displayName(text, item) {
  const ns = String(item.source || '').split('/').pop().replace(/\.uasset$/i, '');
  return (ns && text.get(`${ns}::${item.id}|Display Name`)) || null;
}

module.exports = { englishText, displayName, parseAt };
