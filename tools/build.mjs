// Builds a Lantern Client release into dist/:
//   LanternClient-app-<version>.zip  the panel (what updates install)
//   Lantern-Client-Setup.exe         the launcher: installer + launcher + updater, carrying this app version
//   dftrainer-manifest.json          (name kept from before the rename, older launchers look for it) what the launcher checks: versions, sizes, SHA-256 and an Ed25519 signature
//   notes.md                      release notes
//
//   node tools/build.mjs [--key release-key.pem] [--repo owner/name] [--out dist] [--goos windows]
// The private key comes from --key or the DFT_RELEASE_KEY environment variable (the GitHub secret). The update
// channel comes from --repo, app/release.json "repo", or GITHUB_REPOSITORY (set by GitHub Actions).
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const OUT = resolve(ROOT, arg('--out', 'dist'));
const GOOS = arg('--goos', 'windows');
const sha = (b) => createHash('sha256').update(b).digest('hex');

// ------------------------------------------------------------ version, channel, key
const rel = JSON.parse(readFileSync(join(ROOT, 'app', 'release.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(rel.version)) throw new Error('app/release.json needs a version like 1.2.0');
const repo = arg('--repo') || rel.repo || process.env.GITHUB_REPOSITORY || '';
if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`bad repo "${repo}"`);
const launcherVersion = readFileSync(join(ROOT, 'launcher', 'VERSION'), 'utf8').trim();
const pubKey = readFileSync(join(ROOT, 'launcher', 'release-public-key.txt'), 'utf8').trim();
const keyPem = process.env.DFT_RELEASE_KEY || (arg('--key') ? readFileSync(arg('--key'), 'utf8') : '');
if (!keyPem) throw new Error('No signing key: pass --key release-key.pem or set DFT_RELEASE_KEY.');
const key = createPrivateKey(keyPem);
const derivedPub = createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
if (derivedPub !== pubKey) throw new Error('The signing key does not match launcher/release-public-key.txt.');

// ------------------------------------------------------------ the app zip (same bytes for the same files)
const SKIP = new Set(['trainer-settings.json', 'trainer-toggles.json', 'refresh-request.json', 'node_modules', 'status', '.DS_Store']);
function files(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP.has(e.name) || e.name.endsWith('.log')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p)); else out.push(p);
  }
  return out;
}
// Windows ignores case in file names, and Node's require('./x') tries the file "x" before "x.js". Two app files that
// differ only by case or by a .js ending (LICENSE and license.js did) work on Linux and break on Windows: refuse them.
function checkWindowsNames(list) {
  const seen = new Map();
  for (const f of list) {
    const rel = relative(join(ROOT, 'app'), f).toLowerCase();
    for (const key of new Set([rel, rel.replace(/\.js$/, '')])) {
      if (seen.has(key) && seen.get(key) !== f) throw new Error(`These app files clash on Windows: ${relative(ROOT, seen.get(key))} and ${relative(ROOT, f)}`);
      seen.set(key, f);
    }
  }
  // and every require('./x') in the app must name its file exactly, with .js
  for (const f of list.filter((x) => x.endsWith('.js'))) {
    for (const m of readFileSync(f, 'utf8').matchAll(/require\((['"])(\.{1,2}\/[^'"]+)\1\)/g)) {
      if (!m[2].endsWith('.js') && !m[2].endsWith('.json')) throw new Error(`${relative(ROOT, f)}: require('${m[2]}') needs its .js ending (Windows resolves names without case)`);
    }
  }
}
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (b) => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function zip(entries) {   // [[name, Buffer]]
  const parts = [], central = [];
  let off = 0;
  const DOS_TIME = 0, DOS_DATE = (46 << 9) | (1 << 5) | 1;   // 2026-01-01, fixed so builds are reproducible
  for (const [name, data] of entries) {
    const nb = Buffer.from(name, 'utf8'), comp = deflateRawSync(data, { level: 9 }), crc = crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
    h.writeUInt16LE(DOS_TIME, 10); h.writeUInt16LE(DOS_DATE, 12); h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nb.length, 26); h.writeUInt16LE(0, 28);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt16LE(DOS_TIME, 12); c.writeUInt16LE(DOS_DATE, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(off, 42);
    parts.push(h, nb, comp); central.push(c, nb);
    off += h.length + nb.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const appDir = join(ROOT, 'app');
checkWindowsNames(files(appDir));
// the panel's page: a syntax error in its script leaves the window stuck on the intro, so it never ships
for (const [i, m] of [...readFileSync(join(appDir, 'ui', 'index.html'), 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)].entries()) {
  try { new Script(m[1], { filename: `ui/index.html <script> ${i + 1}` }); } catch (e) { console.error(`ui/index.html: ${e.message}`); process.exit(1); }
}
for (const f of files(appDir).filter((f) => f.endsWith('.js'))) execFileSync(process.execPath, ['--check', f], { stdio: 'inherit' });
const entries = files(appDir).map((p) => {
  const name = relative(appDir, p).split(sep).join('/');
  let data = readFileSync(p);
  if (name === 'release.json') data = Buffer.from(JSON.stringify({ ...rel, repo }, null, 2) + '\n');   // the channel travels with the app
  return [name, data];
});
const appZip = zip(entries);
const appFile = `LanternClient-app-${rel.version}.zip`;
writeFileSync(join(OUT, appFile), appZip);

// ------------------------------------------------------------ the launcher exe, carrying this app version
const L = join(ROOT, 'launcher');
writeFileSync(join(L, 'embedded', 'app.zip'), appZip);
writeFileSync(join(L, 'embedded', 'app-version.txt'), rel.version);
const env = { ...process.env, CGO_ENABLED: '0', GOOS, GOARCH: 'amd64' };
if (GOOS === 'windows') execFileSync('go', ['run', './cmd/mkres', '-ico', 'icon.ico', '-version', launcherVersion, '-app', rel.version, '-o', 'rsrc_windows_amd64.syso'], { cwd: L, stdio: 'inherit', env: { ...process.env } });
const exeFile = GOOS === 'windows' ? 'Lantern-Client-Setup.exe' : 'lantern-client-launcher';
// not stripped (-s): a Go exe with its symbol table looks less like a packed one to antivirus heuristics
const ldflags = [`-w`, GOOS === 'windows' ? '-H windowsgui' : '', `-X main.launcherVersion=${launcherVersion}`, `-X main.pubKeyB64=${pubKey}`, `-X main.defaultRepo=${repo}`].filter(Boolean).join(' ');
execFileSync('go', ['build', '-trimpath', '-ldflags', ldflags, '-o', join(OUT, exeFile), '.'], { cwd: L, stdio: 'inherit', env });
// Authenticode signature, when a code-signing certificate is available (SIGN_PFX = .pfx file, SIGN_PASS = its
// password; osslsigncode does the signing). Signed exes are what Windows Defender and SmartScreen trust.
if (GOOS === 'windows' && process.env.SIGN_PFX) {
  const out = join(OUT, exeFile), signed = out + '.signed';
  execFileSync('osslsigncode', ['sign', '-pkcs12', process.env.SIGN_PFX, '-pass', process.env.SIGN_PASS || '', '-n', 'Lantern Client',
    '-i', repo ? `https://github.com/${repo}` : 'https://github.com', '-h', 'sha256', '-t', 'http://timestamp.digicert.com', '-in', out, '-out', signed], { stdio: 'inherit' });
  renameSync(signed, out);
  console.log('signed', exeFile);
}
const exe = readFileSync(join(OUT, exeFile));

// ------------------------------------------------------------ the signed manifest
const m = {
  version: rel.version, notes: rel.notes || '',
  app: { file: appFile, sha256: sha(appZip), size: appZip.length },
  launcher: { version: launcherVersion, file: exeFile, sha256: sha(exe), size: exe.length },
};
const msg = ['dftrainer-release-v1', m.version, m.app.file, m.app.sha256, m.app.size, m.launcher.version, m.launcher.file, m.launcher.sha256, m.launcher.size].join('\n');
m.signature = sign(null, Buffer.from(msg), key).toString('base64');
writeFileSync(join(OUT, 'dftrainer-manifest.json'), JSON.stringify(m, null, 2) + '\n');
writeFileSync(join(OUT, 'notes.md'), `${rel.notes || ''}\n\n**Install:** download **Lantern-Client-Setup.exe** and run it. You need a key from the owner. Installed copies update by themselves.\n`);
console.log(`built ${rel.version} (launcher ${launcherVersion}, channel ${repo || 'none'}) in ${relative(ROOT, OUT)}: ${appFile} ${(appZip.length / 1024).toFixed(0)} KB, ${exeFile} ${(exe.length / 1048576).toFixed(1)} MB`);
