// Lantern Client - which way the game is being played (Dauntless Forever 1.14.7). Licence: AGPL-3.0-only.
//
// The Assist features (Part lock-on) are for solo play and for playing with friends, never for games open to
// everyone. Dauntless Forever's launcher has the same split: "Host with friends" (and Host Mode set to Private, and
// joining a friend from its Friends page) is a game for friends; "Play online", "Allow randoms" and Host Mode set to
// Public are games open to everyone (the package's online-host script gets -Public, and the backend then forces
// standard game rules: DF_PUBLIC_GAME=1). Read from what the package and the launcher leave on this PC:
//   - hosting online: data\relay-1147.json exists while the relay is connected; whether it is open to everyone is on
//     the host script's command line (-Public), so the running processes are read (only in that case);
//   - joined someone online: data\join-proxy.json exists while the join proxy runs; whether that game came from Play
//     online is in the launcher's log ("Play online: looking for..." before "Friends: joining X...");
//   - neither: solo play, or LAN (always friends: same network).
// Anything that cannot be read counts as open to everyone ("unknown"), so Assist stays off.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const HOST_SCRIPT = /online-host-1147\.ps1/i;

// command lines of running processes -> is an online host script running, and is it -Public?
function hostFromCommandLines(lines) {
  const hosts = lines.filter((l) => HOST_SCRIPT.test(l));
  if (!hosts.length) return null;
  return { public: hosts.some((l) => /(^|\s)-Public(\s|$|')/i.test(l)) };
}

// the launcher's log -> did the latest join come from Play online?
function joinFromLog(text) {
  const lines = String(text || '').split(/\r?\n/);
  let j = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/Friends: joining /.test(lines[i])) { j = i; break; }
  if (j < 0) return null;   // joined by hand (LAN - JOIN / ONLINE join code): not Play online
  for (let i = j - 1; i >= 0; i--) {
    const l = lines[i];
    // a search that ended before this join: the join was not from it
    if (/Play online: (joined |stopped looking|no open game found)/.test(l)) return { public: false };
    if (/Play online: looking for /.test(l)) return { public: true };
    if (/Friends: joining /.test(l)) return { public: false };
  }
  return { public: false };
}

// the pieces put together: 'solo' | 'friends' | 'online' | 'unknown'
function classify({ hosting, host, joined, join }) {
  if (hosting) {
    if (!host) return host === null ? 'solo' : 'unknown';   // null: the relay file is left over, nothing hosts
    return host.public ? 'online' : 'friends';
  }
  if (joined) return join === undefined ? 'unknown' : join && join.public ? 'online' : 'friends';
  return 'solo';
}
const allowed = (mode) => mode === 'solo' || mode === 'friends';

function launcherLogs(pkg) {
  const out = [path.resolve(pkg, '..', '..', 'launcher.log')];
  const la = process.env.LOCALAPPDATA;
  if (la) for (const d of ['DauntlessForever', 'DauntlessOffline']) out.push(path.join(la, d, 'launcher.log'));
  return [...new Set(out)];
}
function tail(file, bytes = 65536) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, n = Math.min(size, bytes), buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    return buf.toString('utf8');
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

// process command lines (Windows): undefined when they could not be read
function commandLines(cb) {
  if (process.platform !== 'win32') return cb([]);
  const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'powershell.exe\' or Name=\'pwsh.exe\' or Name=\'cmd.exe\'" | ForEach-Object { $_.CommandLine }';
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { timeout: 15000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (e, out) => {
    if (!e) return cb(String(out).split(/\r?\n/).filter(Boolean));
    execFile('wmic', ['process', 'get', 'CommandLine'], { timeout: 15000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e2, out2) => cb(e2 ? undefined : String(out2).split(/\r?\n/).filter(Boolean)));
  });
}

// Watches the mode for one package. now() is cheap (two file checks; the log is read only after it changed); the
// process list is read only while hosting online, again when the relay file changes, and at most every 20 seconds.
function watcher() {
  let hostKey = '', host = undefined, hostAt = 0, busy = false;
  let logKey = '', join;
  return function now(p) {
    if (!p || !p.dataDir) return { mode: 'unknown' };
    const relay = path.join(p.dataDir, 'relay-1147.json'), proxy = path.join(p.dataDir, 'join-proxy.json');
    let hosting = false, joined = false, rk = '';
    try { const st = fs.statSync(relay); hosting = true; rk = st.mtimeMs + ':' + st.size; } catch {}
    try { fs.statSync(proxy); joined = true; } catch {}
    if (hosting && (rk !== hostKey || Date.now() - hostAt > 20000) && !busy) {
      busy = true;
      if (rk !== hostKey) host = undefined;   // a new hosting session: unknown until read
      commandLines((lines) => {
        busy = false; hostKey = rk; hostAt = Date.now();
        host = lines === undefined ? undefined : hostFromCommandLines(lines);
      });
    }
    if (!hosting) { hostKey = ''; host = undefined; }
    if (joined) {
      let found = false;
      for (const f of launcherLogs(p.pkg)) {
        let st; try { st = fs.statSync(f); } catch { continue; }
        const k = f + st.mtimeMs + st.size;
        if (k !== logKey) { logKey = k; const t = tail(f); join = t === null ? undefined : joinFromLog(t); }
        found = true;
        break;
      }
      if (!found) { logKey = ''; join = undefined; }   // no launcher log to tell: counted as open to everyone
    }
    const mode = classify({ hosting, host, joined, join });
    return { mode, hosting, joined };
  };
}

module.exports = { watcher, classify, allowed, hostFromCommandLines, joinFromLog };
