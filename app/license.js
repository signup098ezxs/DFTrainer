// Lantern Client - license keys. Licence: AGPL-3.0-only.
//
// A key is signed with the owner's private key (Ed25519) and checked here with the public half, so keys cannot be
// made up and work offline. A key carries: an id, who it is for, when it was made and when it runs out (or never).
//   LANTERN-<base64url of: version | id(5) | issued minutes(4) | expires minutes(4, 0 = never) | name length(1) | name | signature(64)>
//
// Revoking: the owner adds the key's id to licenses/revoked.txt in the GitHub repository. The client reads that list
// at start and every few hours (kept for offline starts).
//
// Owner tools: the owner imports the private key once (Owner key... on the key screen or in Settings). With it this
// client counts as licensed and shows the Keys page, where keys are made, listed and revoked.
'use strict';
const crypto = require('crypto'), fs = require('fs'), path = require('path'), https = require('https');

const PUBLIC_KEY_B64 = 'LLgDPnbikBnEKsddU9q3BTQfCH6ETbWJRqRQZAnKMeg=';
const PREFIX = 'LANTERN-';
const SPKI_HEAD = Buffer.from('302a300506032b6570032100', 'hex');
const PUBLIC_KEY = crypto.createPublicKey({ key: Buffer.concat([SPKI_HEAD, Buffer.from(PUBLIC_KEY_B64, 'base64')]), format: 'der', type: 'spki' });
const DURATIONS = { '1d': 1, '7d': 7, '30d': 30, '90d': 90, '365d': 365, life: 0 };

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { try { fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 2)); fs.renameSync(f + '.tmp', f); } catch {} };

function decode(text) {
  let s = String(text || '').replace(/\s+/g, '');
  if (s.toUpperCase().startsWith(PREFIX)) s = s.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]{80,400}$/.test(s)) return { ok: false, error: 'That does not look like a Lantern key.' };
  const buf = Buffer.from(s, 'base64url');
  if (buf.length < 15 + 64 || buf[0] !== 1) return { ok: false, error: 'That does not look like a Lantern key.' };
  const nameLen = buf[14];
  const body = buf.subarray(0, 15 + nameLen), sig = buf.subarray(15 + nameLen);
  if (sig.length !== 64) return { ok: false, error: 'That key is incomplete. Copy all of it.' };
  if (!crypto.verify(null, body, PUBLIC_KEY, sig)) return { ok: false, error: 'That key is not valid.' };
  return {
    ok: true, id: buf.subarray(1, 6).toString('hex').toUpperCase(),
    issued: buf.readUInt32BE(6) * 60000, expires: buf.readUInt32BE(10) * 60000 || 0,
    name: body.subarray(15).toString('utf8'),
  };
}

function encode({ name, days }, privateKey) {
  const nm = Buffer.from(String(name || '').trim().slice(0, 32), 'utf8').subarray(0, 32);
  const now = Math.floor(Date.now() / 60000);
  const body = Buffer.alloc(15 + nm.length);
  body[0] = 1;
  crypto.randomBytes(5).copy(body, 1);
  body.writeUInt32BE(now, 6);
  body.writeUInt32BE(days ? now + days * 1440 : 0, 10);
  body[14] = nm.length; nm.copy(body, 15);
  const sig = crypto.sign(null, body, privateKey);
  return PREFIX + Buffer.concat([body, sig]).toString('base64url');
}

function pemMatches(pem) {
  try {
    const k = crypto.createPrivateKey(pem);
    if (k.asymmetricKeyType !== 'ed25519') return null;
    const raw = crypto.createPublicKey(k).export({ type: 'spki', format: 'der' }).subarray(12);
    return raw.toString('base64') === PUBLIC_KEY_B64 ? k : null;
  } catch { return null; }
}

module.exports = function license({ dataDir, repo, onChange = () => {} }) {
  const F = {
    lic: path.join(dataDir, 'license.json'),
    revoked: path.join(dataDir, 'license-revoked.json'),
    owner: path.join(dataDir, 'owner-key.pem'),
    issued: path.join(dataDir, 'issued-keys.json'),
  };
  let lic = readJson(F.lic, {});          // { key, seen }
  let revoked = readJson(F.revoked, { ids: [], at: 0 });
  let ownerKey = null;
  try { ownerKey = pemMatches(fs.readFileSync(F.owner, 'utf8')); } catch {}
  let last = null;

  // the clock may be wound back to stretch a key: never go back past the latest time seen
  function now() {
    const t = Date.now();
    if (!lic.seen || t > lic.seen + 60000) { lic.seen = Math.max(t, lic.seen || 0); writeJson(F.lic, lic); }
    return Math.max(t, (lic.seen || 0) - 10 * 60000);
  }

  function status() {
    if (ownerKey) return { ok: true, owner: true, state: 'owner', name: 'Owner', expires: 0 };
    if (!lic.key) return { ok: false, state: 'none' };
    const k = decode(lic.key);
    if (!k.ok) return { ok: false, state: 'invalid', error: k.error };
    const base = { id: k.id, name: k.name, issued: k.issued, expires: k.expires };
    if (revoked.ids.includes(k.id)) return { ok: false, state: 'revoked', ...base };
    if (k.expires && now() > k.expires) return { ok: false, state: 'expired', ...base };
    return { ok: true, state: 'valid', ...base };
  }
  function refresh() {
    const s = status(), key = JSON.stringify(s);
    if (key !== JSON.stringify(last)) { const was = last; last = s; onChange(s, was); }
    return s;
  }

  // revoked ids, from licenses/revoked.txt in the repository (one id per line, # comments)
  function fetchRevoked() {
    if (!repo) return;
    const url = `https://raw.githubusercontent.com/${repo}/main/licenses/revoked.txt?t=${Date.now()}`;
    https.get(url, { headers: { 'User-Agent': 'LanternClient', 'Cache-Control': 'no-cache' }, timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return; }
      let s = ''; res.setEncoding('utf8');
      res.on('data', (c) => { s += c; if (s.length > 1e6) res.destroy(); });
      res.on('end', () => {
        const ids = [...new Set(s.split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim().toUpperCase()).filter((l) => /^[0-9A-F]{10}$/.test(l)))];
        revoked = { ids, at: Date.now() }; writeJson(F.revoked, revoked); refresh();
      });
    }).on('error', () => {}).on('timeout', function () { this.destroy(); });
  }
  setTimeout(fetchRevoked, 3000);
  setInterval(fetchRevoked, 3 * 3600 * 1000).unref();
  setInterval(refresh, 60000).unref();   // keys running out while the client is open
  refresh();

  const issued = () => readJson(F.issued, []);
  const ownerOnly = (fn) => (...a) => ownerKey ? fn(...a) : { ok: false, error: 'Owner tools need the owner key.' };
  const revokeUrl = repo ? `https://github.com/${repo}/edit/main/licenses/revoked.txt` : '';

  return {
    status: () => refresh(),
    ok: () => (last || refresh()).ok,
    activate(text) {
      const k = decode(text);
      if (!k.ok) return k;
      if (revoked.ids.includes(k.id)) return { ok: false, error: 'That key has been revoked.' };
      if (k.expires && now() > k.expires) return { ok: false, error: 'That key has run out.' };
      lic = { key: String(text).replace(/\s+/g, ''), seen: lic.seen }; writeJson(F.lic, lic);
      return { ok: true, status: refresh() };
    },
    remove() { lic = { seen: lic.seen }; writeJson(F.lic, lic); return { ok: true, status: refresh() }; },
    importOwner(pem) {
      const k = pemMatches(String(pem || ''));
      if (!k) return { ok: false, error: 'That is not the Lantern owner key.' };
      try { fs.writeFileSync(F.owner, String(pem), { mode: 0o600 }); } catch (e) { return { ok: false, error: e.message }; }
      ownerKey = k;
      return { ok: true, status: refresh() };
    },
    removeOwner() { try { fs.unlinkSync(F.owner); } catch {} ownerKey = null; return { ok: true, status: refresh() }; },
    keys: ownerOnly(() => ({ ok: true, revokeUrl, revokedAt: revoked.at, keys: issued().map((k) => ({ ...k, live: revoked.ids.includes(k.id) })) })),
    generate: ownerOnly(({ name, duration, note }) => {
      name = String(name || '').trim();
      if (!name) return { ok: false, error: 'Who is the key for? Enter a name.' };
      if (!(duration in DURATIONS)) return { ok: false, error: 'Pick how long the key lasts.' };
      const key = encode({ name, days: DURATIONS[duration] }, ownerKey);
      const k = decode(key);
      const list = issued();
      list.unshift({ id: k.id, name: k.name, note: String(note || '').trim().slice(0, 120), issued: k.issued, expires: k.expires, key, revoked: false });
      writeJson(F.issued, list);
      return { ok: true, key, id: k.id };
    }),
    revoke: ownerOnly(({ id, undo }) => {
      const list = issued(), k = list.find((x) => x.id === id);
      if (!k) return { ok: false, error: 'Key not found.' };
      k.revoked = !undo; writeJson(F.issued, list);
      return { ok: true, revokeUrl, id };
    }),
    fetchRevoked,
  };
};
module.exports.decode = decode;
module.exports.encode = encode;
