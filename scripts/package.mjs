import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildZipBlob } from '../src/lib/archive.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const entries = [];
async function include(relative) {
  const location = path.join(root, relative);
  if (relative === 'src') {
    async function walk(directory) {
      for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
        const next = `${directory}/${entry.name}`;
        if (entry.isDirectory()) await walk(next);
        else entries.push({ name: next, data: new Uint8Array(await readFile(path.join(root, next))) });
      }
    }
    await walk(relative);
  } else entries.push({ name: relative, data: new Uint8Array(await readFile(location)) });
}
for (const relative of ['manifest.json', 'exporter.html', 'src']) await include(relative);
await mkdir(path.join(root, 'dist'), { recursive: true });
const output = path.join(root, 'dist', `exporter-${manifest.version}.zip`);
const archive = await buildZipBlob(entries);
await writeFile(output, new Uint8Array(await archive.arrayBuffer()));
console.log(output);
