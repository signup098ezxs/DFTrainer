// Play with a friend (Friend tab): direct co-op over Tailscale with Dauntless Forever's own LAN scripts, instead of DF's
// internet relay (Host Mode). Tailscale puts both PCs on one private network (100.64.0.0/10), so the friend's game talks
// straight to the host's PC. This file only reads Tailscale's answers; server.js runs the commands and DF's scripts.
const fs = require('fs'), path = require('path');

// Tailscale's private range, 100.64.0.0/10 (the only addresses the Friend tab will hand to DF's LAN scripts)
const isTailnetIp = (ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(String(ip || '')) && String(ip).split('.').every((n) => Number(n) <= 255);

function findExe(env = process.env) {
  const dirs = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432].filter(Boolean);
  for (const d of dirs) { const f = path.join(d, 'Tailscale', 'tailscale.exe'); if (fs.existsSync(f)) return f; }
  return null;
}

// `tailscale status --json` -> what the tab needs. state: Running, NeedsLogin, NeedsMachineAuth, Stopped, Starting, NoState
function parseStatus(text) {
  let j; try { j = JSON.parse(text); } catch { return null; }
  const v4 = (ips) => (ips || []).find(isTailnetIp) || null;
  const self = j.Self || {};
  const peers = Object.values(j.Peer || {}).map((p) => ({
    name: p.HostName || String(p.DNSName || '').split('.')[0] || '?', ip: v4(p.TailscaleIPs), os: p.OS || '',
    online: !!p.Online, shared: !!p.ShareeNode, direct: !!p.CurAddr, relay: p.Relay || '',
  })).filter((p) => p.ip).sort((a, b) => (b.online - a.online) || ((b.os === 'windows') - (a.os === 'windows')) || a.name.localeCompare(b.name));
  return { state: j.BackendState || 'NoState', authUrl: safeAuthUrl(j.AuthURL), name: self.HostName || '', ip: v4(self.TailscaleIPs), peers };
}

// only Tailscale's own sign-in page is ever opened from here
const safeAuthUrl = (u) => (/^https:\/\/login\.tailscale\.com\/[A-Za-z0-9/_\-.?=&]+$/.test(String(u || '')) ? String(u) : '');
const findAuthUrl = (text) => { const m = /https:\/\/login\.tailscale\.com\/[^\s"']+/.exec(String(text || '')); return m ? safeAuthUrl(m[0]) : ''; };

// `tailscale ping` lines: "pong from pc (100.x.y.z) via 203.0.113.9:41641 in 23ms" (direct) or "... via DERP(nyc) in 81ms"
function parsePing(text) {
  const pongs = [];
  for (const l of String(text || '').split(/\r?\n/)) {
    const m = /^pong from \S+ \((\S+)\) via (\S+) in ([\d.]+)(µs|us|ms|s)\b/.exec(l.trim());
    if (!m) continue;
    const ms = Number(m[3]) * (m[4] === 's' ? 1000 : m[4] === 'ms' ? 1 : 0.001);
    pongs.push({ via: m[2], direct: !/^DERP\(/.test(m[2]), ms: Math.round(ms) });
  }
  if (!pongs.length) return { ok: false, error: /no reply|timed out|timeout/i.test(text) ? 'no answer from that PC (is Tailscale on there?)' : 'no answer' };
  const last = pongs[pongs.length - 1], same = pongs.filter((p) => p.direct === last.direct).map((p) => p.ms).sort((a, b) => a - b);
  return { ok: true, direct: last.direct, via: last.via, ms: same[same.length >> 1] };
}

module.exports = { isTailnetIp, findExe, parseStatus, parsePing, findAuthUrl, safeAuthUrl };

// self-check: node friend.js --test
if (require.main === module && process.argv.includes('--test')) {
  const assert = require('assert');
  assert(isTailnetIp('100.101.102.103') && isTailnetIp('100.64.0.1') && isTailnetIp('100.127.255.254'));
  assert(!isTailnetIp('100.63.0.1') && !isTailnetIp('100.128.0.1') && !isTailnetIp('192.168.1.5') && !isTailnetIp('100.94.200.300') && !isTailnetIp('100.101.102.103:63000'));
  const st = parseStatus(JSON.stringify({ BackendState: 'Running', AuthURL: '', Self: { HostName: 'HOST', TailscaleIPs: ['100.101.102.103', 'fd7a::1'] },
    Peer: { a: { HostName: 'phone', OS: 'android', Online: true, TailscaleIPs: ['100.70.0.2'] }, b: { HostName: 'FRIEND-PC', OS: 'windows', Online: true, ShareeNode: true, CurAddr: '1.2.3.4:41641', TailscaleIPs: ['100.80.1.2'] }, c: { HostName: 'old', OS: 'windows', Online: false, TailscaleIPs: ['100.90.0.3'] } } }));
  assert.strictEqual(st.ip, '100.101.102.103'); assert.strictEqual(st.state, 'Running');
  assert.deepStrictEqual(st.peers.map((p) => p.name), ['FRIEND-PC', 'phone', 'old']); assert(st.peers[0].shared && st.peers[0].direct);
  assert.strictEqual(parseStatus('{"BackendState":"NoState","Self":{"TailscaleIPs":null}}').ip, null);
  assert.strictEqual(parseStatus('nope'), null);
  assert.strictEqual(parseStatus(JSON.stringify({ BackendState: 'NeedsLogin', AuthURL: 'https://login.tailscale.com/a/abc123' })).authUrl, 'https://login.tailscale.com/a/abc123');
  assert.strictEqual(safeAuthUrl('https://evil.com/a/x'), ''); assert.strictEqual(safeAuthUrl('javascript:alert(1)'), '');
  assert.strictEqual(findAuthUrl('\nTo authenticate, visit:\n\n\thttps://login.tailscale.com/a/1f2e3d\n'), 'https://login.tailscale.com/a/1f2e3d');
  let p = parsePing('pong from friend (100.80.1.2) via DERP(nyc) in 81ms\npong from friend (100.80.1.2) via 1.2.3.4:41641 in 23ms\n');
  assert(p.ok && p.direct && p.ms === 23 && p.via === '1.2.3.4:41641');
  p = parsePing('pong from friend (100.80.1.2) via DERP(nyc) in 90ms\npong from friend (100.80.1.2) via DERP(nyc) in 70ms\npong from friend (100.80.1.2) via DERP(nyc) in 80ms\ndirect connection not established\n');
  assert(p.ok && !p.direct && p.ms === 80);
  assert.strictEqual(parsePing('pong from x (100.80.1.2) via 1.2.3.4:41641 in 1.2s').ms, 1200);
  assert(!parsePing('ping "100.80.1.2" timed out').ok);
  console.log('friend.js self-check: ok');
}
