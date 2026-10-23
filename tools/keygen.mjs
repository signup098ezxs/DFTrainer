// Makes the release signing key (Ed25519), once per project.
//   node tools/keygen.mjs [path/to/release-key.pem]
// The private key stays with you (and in the GitHub secret DFT_RELEASE_KEY); never commit it. The public half goes
// into launcher/release-public-key.txt and is built into every launcher, which then only installs releases it signed.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || join(root, 'release-key.pem');
if (existsSync(out)) { console.error(`${out} exists already. A new key would stop every installed launcher from updating.`); process.exit(1); }
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
writeFileSync(join(root, 'launcher', 'release-public-key.txt'), raw.toString('base64') + '\n');
console.log(`private key: ${out}  (keep it secret)\npublic key:  launcher/release-public-key.txt`);
