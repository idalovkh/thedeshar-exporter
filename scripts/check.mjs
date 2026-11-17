import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const packageInfo = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, packageInfo.version, 'Package and Chrome extension versions must agree.');
assert.equal(manifest.name, 'exporter');
assert.equal(manifest.short_name, 'exporter');
assert.equal(manifest.action.default_title, 'exporter');
assert.deepEqual(manifest.host_permissions, ['https://platform.desharschool.ru/*', 'https://progressme.ru/*']);
for (const script of manifest.content_scripts) assert.deepEqual(script.matches, manifest.host_permissions);
assert.deepEqual(manifest.content_scripts.find(script => script.world === 'ISOLATED').js,
  ['src/capture/source-binding.js', 'src/capture/navigation.js', 'src/capture/section-visit.js', 'src/capture/confirmed-lesson.js', 'src/capture/content.js']);
assert.ok(!manifest.permissions.includes('cookies'));
assert.ok(!manifest.permissions.includes('debugger'));
assert.equal(manifest.content_security_policy.extension_pages,
  "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
const assets = [
  manifest.background.service_worker,
  'exporter.html',
  'src/lib/webp-worker.js',
  'src/vendor/webp/encode-png.mjs',
  ...['LICENSE-libwebp.txt', 'PATENTS-libwebp.txt',
    'LICENSE-emscripten.txt', 'LICENSE-musl.txt', 'LICENSE-compiler-rt.txt']
    .map(name => `src/vendor/webp/${name}`),
  ...manifest.content_scripts.flatMap(item => item.js),
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action.default_icon || {}),
];
for (const relative of assets) await access(path.join(root, relative));
const codecDir = path.join(root, 'src/vendor/webp');
const codecFiles = (await readFile(path.join(codecDir, 'SHA256SUMS'), 'utf8')).trim().split(/\r?\n/);
assert.equal(codecFiles.length, 2);
for (const [index, name] of ['codec.mjs', 'codec.wasm'].entries()) {
  const bytes = await readFile(path.join(codecDir, name));
  assert.equal(codecFiles[index], `${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
  if (name.endsWith('.wasm')) assert.ok(WebAssembly.validate(bytes), 'The packaged WebP codec must be valid WebAssembly.');
}
const hashWasmDir = path.join(root, 'src/vendor/hash-wasm');
for (const [name, expected] of [
  ['sha256.umd.min.js', 'ed7f5896b41aba98909ab143264c5b2ae5c81abf2e47f08dd2d1c0d02ce623de'],
  ['LICENSE.txt', 'c14dea172f72f2714284a0ac2ab1b00b5352a01409d58255a46227ffc541debd'],
  ['LICENSE-SHA256.txt', 'a26eb88ba874fcfd93eaaeb7cf0ff7a2284f336f795de2fc57aa2880355e053a'],
]) {
  const bytes = await readFile(path.join(hashWasmDir, name));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, `Invalid hash-wasm 4.12.0 artifact: ${name}`);
}
for (const [size, relative] of Object.entries(manifest.icons || {})) {
  const png = await readFile(path.join(root, relative));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${relative} must be a PNG.`);
  assert.equal(png.readUInt32BE(16), Number(size), `${relative} width must match its declared size.`);
  assert.equal(png.readUInt32BE(20), Number(size), `${relative} height must match its declared size.`);
}
let checked = 0;
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) { if (!['node_modules', 'dist', '.git'].includes(entry.name)) await walk(location); }
    else if (/\.(?:js|mjs)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', location], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      checked++;
    }
  }
}
await walk(root);
console.log(`Manifest and ${checked} JavaScript files checked.`);
