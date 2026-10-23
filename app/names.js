// DF Trainer - reads item display names from the player's own Dauntless 1.6.2 game files. Licence: AGPL-3.0-only.
// The pak index and block reading follow Dauntless Forever's tools/event-island-fix.cjs (Addison2k, AGPL-3.0).
//
//   node names.js <game folder> <ids.json: {id: trustedName|null}> <out.json>
//
// The game keeps its item names in catalog assets (Gear_Catalogs/weapon_ac_cosmetic_catalog, emotes_catalog,
// banner_customization_catalog, ...). This reads every asset with "catalog" in its path from the game's paks, walks
// its tagged properties (cooked UE 4.25) and pairs each 1.6.2 catalog id with the display text next to it. Texts that
// point into a string table are looked up there.
//
// It checks itself: for every asset, the names it read are compared with the names already known for those ids. An
// asset is used only if it agrees on at least 90% of them (and at least 3); everything else is dropped. So a format it
// does not understand changes nothing.
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const MAGIC = 0x5A6F12E1;

// ------------------------------------------------------------------ paks
function index(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, tail = Buffer.alloc(Math.min(512, size));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    let m = -1; for (let i = tail.length - 4; i >= 0; i--) if (tail.readUInt32LE(i) === MAGIC) { m = i; break; }
    if (m < 0 || tail[m - 1]) return null;
    const off = Number(tail.readBigUInt64LE(m + 8)), isz = Number(tail.readBigUInt64LE(m + 16));
    const idx = Buffer.alloc(isz); fs.readSync(fd, idx, 0, isz, off);
    let p = 0;
    const fstr = () => { const n = idx.readInt32LE(p); p += 4; if (n < 0) { const s = idx.toString('utf16le', p, p - 2 * n - 2); p += -2 * n; return s; } const s = idx.toString('latin1', p, p + n - 1); p += n; return s; };
    const mount = fstr(), count = idx.readInt32LE(p); p += 4; const entries = new Map();
    for (let i = 0; i < count; i++) {
      const name = fstr();
      const e = { offset: Number(idx.readBigUInt64LE(p)), size: Number(idx.readBigUInt64LE(p + 8)), raw: Number(idx.readBigUInt64LE(p + 16)), method: idx.readUInt32LE(p + 24), blocks: [] };
      p += 48;
      if (e.method) { const nb = idx.readInt32LE(p); p += 4; for (let b = 0; b < nb; b++) { e.blocks.push([Number(idx.readBigUInt64LE(p)), Number(idx.readBigUInt64LE(p + 8))]); p += 16; } }
      e.flags = idx[p]; p += 5; entries.set(name, e);
    }
    return { mount: mount.replace(/^(\.\.\/)+/, ''), entries };
  } finally { fs.closeSync(fd); }
}
function read(file, e) {
  if (e.flags & 1) throw new Error('encrypted');
  const fd = fs.openSync(file, 'r');
  try {
    if (!e.method) { const b = Buffer.alloc(e.size); fs.readSync(fd, b, 0, e.size, e.offset + 53); return b; }
    const parts = []; for (const [a, b] of e.blocks) { const buf = Buffer.alloc(b - a); fs.readSync(fd, buf, 0, b - a, e.offset + a); parts.push(zlib.inflateSync(buf)); }
    return Buffer.concat(parts);
  } finally { fs.closeSync(fd); }
}

// ------------------------------------------------------------------ cooked asset reading
// name table of a cooked 1.6.2 .uasset (same layout tools/event-island-fix.cjs reads)
function nameTable(ua) {
  let o = 28; const n = ua.readInt32LE(o); o += 4 + n + 4;
  const count = ua.readUInt32LE(o), at0 = ua.readUInt32LE(o + 4); const out = []; let at = at0;
  for (let i = 0; i < count; i++) {
    const l = ua.readInt32LE(at); at += 4;
    if (l < 0) { out.push(ua.toString('utf16le', at, at - 2 * l - 2)); at += -2 * l + 4; }
    else { out.push(ua.toString('latin1', at, at + l - 1)); at += l + 4; }
  }
  return out;
}

class Reader {
  constructor(buf, N) { this.b = buf; this.N = N; }
  i32(o) { return this.b.readInt32LE(o); }
  fname(o) {
    const i = this.b.readUInt32LE(o), n = this.b.readInt32LE(o + 4);
    if (i >= this.N.length) throw new Error('bad name');
    return n > 0 ? `${this.N[i]}_${n - 1}` : this.N[i];
  }
  fstring(o) {   // -> [string, end]
    const n = this.b.readInt32LE(o); o += 4;
    if (n === 0) return ['', o];
    if (n > 0) { if (n > 4096) throw new Error('bad string'); return [this.b.toString('latin1', o, o + n - 1), o + n]; }
    if (-n > 4096) throw new Error('bad string');
    return [this.b.toString('utf16le', o, o - 2 * n - 2), o - 2 * n];
  }
  // FText: flags, history type, then (base) namespace, key, source string / (string table) table id, key
  ftext(o) {
    o += 4; const h = this.b.readInt8(o); o += 1;
    if (h === 0) { let ns, key, src; [ns, o] = this.fstring(o); [key, o] = this.fstring(o); [src, o] = this.fstring(o); return { src }; }
    if (h === -1) { const has = this.b.readInt32LE(o); o += 4; if (has) { const [src] = this.fstring(o); return { src }; } return { src: '' }; }
    if (h === 11) { const table = this.fname(o); const [key] = this.fstring(o + 8); return { table, key }; }
    return null;
  }
  // one property tag: name, type, size, array index, type extras, has-guid byte; value follows
  tag(o) {
    const name = this.fname(o); o += 8;
    if (name === 'None') return { name, end: o };
    const type = this.fname(o); o += 8;
    const size = this.b.readInt32LE(o); o += 8;
    if (size < 0 || size > this.b.length) throw new Error('bad size');
    let struct = null, inner = null;
    if (type === 'StructProperty') { struct = this.fname(o); o += 8 + 16; }
    else if (type === 'ArrayProperty' || type === 'SetProperty') { inner = this.fname(o); o += 8; }
    else if (type === 'ByteProperty' || type === 'EnumProperty') o += 8;
    else if (type === 'MapProperty') o += 16;
    else if (type === 'BoolProperty') o += 1;
    const guid = this.b[o]; o += 1; if (guid) o += 16;
    if (o + size > this.b.length) throw new Error('bad size');
    return { name, type, struct, inner, size, start: o, end: o + size };
  }
}

// structs written in binary, not as tagged properties
const BINARY = new Set(['Vector', 'Vector2D', 'Vector4', 'Rotator', 'Quat', 'Guid', 'Color', 'LinearColor', 'IntPoint', 'IntVector',
  'Box', 'Box2D', 'DateTime', 'Timespan', 'FrameNumber', 'SoftObjectPath', 'SoftClassPath', 'GameplayTagContainer', 'GameplayTag',
  'PerPlatformFloat', 'PerPlatformInt', 'Transform', 'Plane', 'Matrix', 'NavAgentSelector', 'RichCurveKey']);
const ID = /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/;

// walk tagged properties from o; every struct scope reports the ids and texts it holds
function walk(r, o, end, scopes, depth = 0) {
  const scope = { ids: [], texts: [] };
  scopes.push(scope);
  for (let guard = 0; o < end && guard < 5000; guard++) {
    const t = r.tag(o);
    if (t.name === 'None') return t.end;
    try {
      if (t.type === 'NameProperty') { const v = r.fname(t.start); if (ID.test(v)) scope.ids.push([t.name, v]); }
      else if (t.type === 'StrProperty') { const [v] = r.fstring(t.start); if (ID.test(v)) scope.ids.push([t.name, v]); }
      else if (t.type === 'TextProperty') { const v = r.ftext(t.start); if (v) scope.texts.push([t.name, v]); }
      else if (t.type === 'StructProperty' && !BINARY.has(t.struct) && depth < 8) walk(r, t.start, t.end, scopes, depth + 1);
      else if ((t.type === 'ArrayProperty' || t.type === 'SetProperty') && depth < 8) walkArray(r, t, scopes, depth);
    } catch { /* a value it can't read: skip just that property */ }
    o = t.end;
  }
  return o;
}
function walkArray(r, t, scopes, depth) {
  let o = t.start + (t.type === 'SetProperty' ? 4 : 0);
  const count = r.i32(o); o += 4;
  if (count < 0 || count > 100000) return;
  if (t.inner === 'StructProperty') {
    const it = r.tag(o);   // the inner tag, then the elements
    if (BINARY.has(it.struct)) return;
    o = it.start;
    for (let i = 0; i < count && o < t.end; i++) o = walk(r, o, t.end, scopes, depth + 1);
  } else if (t.inner === 'NameProperty' || t.inner === 'StrProperty') {
    const scope = { ids: [], texts: [] }; scopes.push(scope);
    for (let i = 0; i < count && o < t.end; i++) {
      if (t.inner === 'NameProperty') { const v = r.fname(o); o += 8; if (ID.test(v)) scope.ids.push([t.name, v]); }
      else { const [v, e] = r.fstring(o); o = e; if (ID.test(v)) scope.ids.push([t.name, v]); }
    }
  }
}

// which text of a scope is the display name
function nameScore(prop) {
  const p = prop.toLowerCase();
  if (/desc|lore|flavou?r|tooltip|hint|subtitle|unlock|source|rarity|category|type/.test(p)) return 0;
  return { displayname: 5, itemname: 4, name: 4, title: 3, displaytext: 3 }[p] || (p.includes('name') ? 2 : 0);
}
function bestText(texts) {
  let best = null, score = 0;
  for (const [prop, v] of texts) { const s = nameScore(prop); if (s > score) { best = v; score = s; } }
  return best;
}

// ------------------------------------------------------------------ string tables
function readStringTable(r, o) {
  const top = (() => { let p = o; for (let g = 0; g < 500; g++) { const t = r.tag(p); if (t.name === 'None') return t.end; p = t.end; } return p; })();
  for (const skip of [4, 0, 8]) {
    try {
      let p = top + skip, ns; [ns, p] = r.fstring(p);
      const n = r.i32(p); p += 4; if (n < 0 || n > 200000) continue;
      const map = new Map();
      for (let i = 0; i < n; i++) { let k, v; [k, p] = r.fstring(p); [v, p] = r.fstring(p); map.set(k, v); }
      if (n === 0 || map.size) return map;
    } catch {}
  }
  return null;
}

// ------------------------------------------------------------------ main
function main() {
  const [gameDir, idsFile, outFile] = process.argv.slice(2);
  const known = JSON.parse(fs.readFileSync(idsFile, 'utf8'));   // id -> trusted name, or null when unknown
  const paksDir = path.join(gameDir, 'Archon', 'Content', 'Paks');
  const paks = fs.readdirSync(paksDir).filter((f) => /^Archon_\d+-WindowsClient\.pak$/i.test(f)).map((f) => path.join(paksDir, f));
  const where = new Map();   // asset path (no extension) -> [pak, uasset entry, uexp entry]
  for (const pak of paks) {
    let ix; try { ix = index(pak); } catch { continue; } if (!ix) continue;
    for (const [rel, e] of ix.entries) {
      if (!rel.endsWith('.uasset')) continue;
      const base = rel.slice(0, -7), ue = ix.entries.get(base + '.uexp');
      if (ue) where.set(ix.mount + base, [pak, e, ue]);
    }
  }
  const load = (asset) => { const w = where.get(asset); if (!w) return null; const ua = read(w[0], w[1]); return { ua, ue: read(w[0], w[2]) }; };

  const tables = new Map();
  const resolve = (v) => {
    if (!v) return '';
    if (v.src !== undefined) return v.src;
    const asset = v.table.replace(/\.[^./]+$/, '').replace(/^\/Game\//, 'Archon/Content/');
    if (!tables.has(asset)) {
      let map = null;
      try { const a = load(asset); if (a) { const N = nameTable(a.ua); map = readStringTable(new Reader(a.ue, N), 0); } } catch {}
      tables.set(asset, map);
    }
    const m = tables.get(asset); return (m && m.get(v.key)) || '';
  };

  const result = { ok: true, assets: {}, names: {}, checked: 0, agreed: 0 };
  for (const [asset] of where) {
    if (!/catalog/i.test(asset)) continue;
    const found = {};   // id -> name read here
    try {
      const a = load(asset), N = nameTable(a.ua), r = new Reader(a.ue, N), scopes = [];
      const end = walk(r, 0, a.ue.length, scopes);
      // a data table: the rows follow (after the object's guid flag): row name, then the row's properties
      for (const skip of [4, 0]) {
        try {
          let o = end + skip; const rows = r.i32(o); o += 4;
          if (rows < 1 || rows > 100000) continue;
          const rowScopes = [];
          for (let i = 0; i < rows; i++) {
            const rowName = r.fname(o); o += 8;
            const before = rowScopes.length; o = walk(r, o, a.ue.length, rowScopes);
            const s = rowScopes[before]; if (s && ID.test(rowName)) s.ids.unshift(['RowName', rowName]);
          }
          scopes.push(...rowScopes); break;
        } catch {}
      }
      for (const s of scopes) {
        if (!s.ids.length || !s.texts.length) continue;
        const v = bestText(s.texts), name = resolve(v).trim();
        if (!name) continue;
        // the scope's item id: prefer a field that is plainly an id, then the row name
        const pick = s.ids.find(([p, id]) => /id$|catalog/i.test(p) && id in known) || s.ids.find(([, id]) => id in known);
        if (pick) found[pick[1]] = name;
      }
    } catch { continue; }
    const ids = Object.keys(found);
    if (!ids.length) continue;
    // same name = same letters and digits (apostrophe style, punctuation and case don't count)
    const same = (x, y) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') === y.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    const overlap = ids.filter((id) => known[id]), agree = overlap.filter((id) => same(known[id], found[id]));
    const used = overlap.length >= 3 && agree.length / overlap.length >= 0.9;
    result.assets[asset] = { read: ids.length, checked: overlap.length, agreed: agree.length, used };
    result.checked += overlap.length; result.agreed += agree.length;
    if (used) for (const id of ids) if (!known[id]) result.names[id] = found[id];
  }
  fs.writeFileSync(outFile, JSON.stringify(result));
  process.stdout.write(JSON.stringify({ ok: true, names: Object.keys(result.names).length, checked: result.checked, agreed: result.agreed }));
}

if (require.main === module) {
  try { main(); } catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: e.message })); }
}
module.exports = { index, read, nameTable, Reader, walk, bestText };
