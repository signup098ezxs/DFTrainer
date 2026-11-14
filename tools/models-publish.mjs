// Puts converted characters on Lantern's download list (the Model Swaps tab's "Download characters").
//   node tools/models-publish.mjs <character folder>...        (folders made by app/modelswaps-tool/convert.py)
// For each folder it writes dist-models/<id>.json, <id>.pak, <id>.png and adds or replaces its row in
// models/catalog.json. Nothing is uploaded here. To publish, upload the files to the "models" release and push the list:
//   gh release create models --title "Model Swaps characters" --notes "Characters for the Model Swaps tab." (once)
//   gh release upload models dist-models/* --clobber
//   git add models/catalog.json && git commit -m "models: ..." && git push
// Only publish characters you have the right to share.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIST = join(ROOT, 'models', 'catalog.json'), OUT = join(ROOT, 'dist-models');
const rows = JSON.parse(readFileSync(LIST, 'utf8'));
mkdirSync(OUT, { recursive: true });
for (const dir of process.argv.slice(2)) {
  const m = JSON.parse(readFileSync(join(dir, 'model.json'), 'utf8')), pak = readFileSync(join(dir, m.pak));
  const sha256 = createHash('sha256').update(pak).digest('hex');
  if (!/^[a-z0-9_]{1,32}$/.test(m.id) || m.pak !== `LanternModel_${m.id}_P.pak` || sha256 !== m.pakSha256) throw new Error(`${dir}: not a character folder the converter made`);
  copyFileSync(join(dir, 'model.json'), join(OUT, `${m.id}.json`)); writeFileSync(join(OUT, `${m.id}.pak`), pak);
  if (existsSync(join(dir, 'preview.png'))) copyFileSync(join(dir, 'preview.png'), join(OUT, `${m.id}.png`));
  const row = { id: m.id, name: m.name, game: m.game, author: m.author, license: m.license, source: m.source, description: m.description, size: pak.length, sha256 };
  const i = rows.findIndex((r) => r.id === m.id);
  if (i >= 0) rows[i] = row; else rows.push(row);
  console.log(`${m.id}: ${m.name}, ${(pak.length / 1048576).toFixed(1)} MB`);
}
writeFileSync(LIST, JSON.stringify(rows, null, 1) + '\n');
console.log(`models/catalog.json: ${rows.length} character(s). Files to upload are in dist-models/.`);
