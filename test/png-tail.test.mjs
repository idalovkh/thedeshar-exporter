import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { inspectRasterImage } from '../src/lib/raster-image-metadata.js';
import { createWebpEncodingSession } from '../src/lib/webp-worker.js';
import { readMediaResponse, downloadMediaAssets } from '../src/ui/assets.js';
import { downloadDiskMedia } from '../src/ui/download-disk-media.js';
import { createExportSpool } from '../src/lib/export-spool.js';
import { memoryOPFS, testResources } from './disk-spool-fixture.mjs';
import { appendProblemEvent, createProblemReport } from '../src/lib/problem-report.js';
import { createPreparedMediaCache } from '../src/lib/prepared-media-cache.js';
import { cacheIndexedDB, cacheLocks } from './prepared-media-cache-fixture.mjs';
import { downloadExportMedia } from '../src/ui/export-media.js';
import { createExportPackage, replacePackageAssets } from '../src/lib/package.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNoWHDiPwAGdALoLm59EwAAAABJRU5ErkJggg==', 'base64');
const extended = Buffer.concat([png, Buffer.alloc(6511, 37)]);
const sha = bytes => createHash('sha256').update(Buffer.from(bytes)).digest('hex');
const assets = Array.from({ length: 3 }, (_, i) => ({ id: `asset-${i}`, name: `${i}.png`, url: `https://cdn.example.org/${i}.png` }));

test('metadata confirms the exact PNG prefix only after validating every chunk CRC', async () => {
  assert.equal((await inspectRasterImage(new Blob([extended]))).pngBytes, png.length);
  assert.equal((await inspectRasterImage(new Blob([png]))).pngBytes, undefined);
  for (const offset of [29, 45, png.length - 1]) {
    const corrupt = Buffer.from(extended); corrupt[offset] ^= 1;
    await assert.rejects(inspectRasterImage(new Blob([corrupt])));
  }
  await assert.rejects(inspectRasterImage(new Blob([png.subarray(0, -1)])));
});

test('text/plain accepts a tail across arbitrary network fragments while counting the full response', async () => {
  for (const splits of [[extended.length], [png.length, extended.length], [png.length - 1, png.length + 1, 1000, extended.length]]) {
    const progress = [], diagnostic = {};
    const body = new ReadableStream({ start(controller) {
      let start = 0;
      for (const end of splits) { controller.enqueue(extended.subarray(start, end)); start = end; }
      controller.close();
    } });
    const file = await readMediaResponse(new Response(body, { headers: { 'content-type': 'text/plain', 'content-length': String(extended.length) } }),
      { diagnostic, onProgress: event => progress.push(event) });
    assert.equal(file.data.size, extended.length, 'source identity retains every received byte until preparation');
    assert.equal(progress.at(-1).loaded, extended.length);
    assert.equal(diagnostic.receivedBytes, extended.length);
  }
  await assert.rejects(readMediaResponse(new Response(extended, { headers: { 'content-type': 'text/plain' } }), { maxBytes: png.length }), { reason: 'file_limit' });
});

test('the image worker passes only the validated PNG prefix to its decoder', async () => {
  const encode = createWebpEncodingSession({ createEncoder: async () => ({ encodeRGBA() {} }),
    resizeRaster: async blob => {
      assert.deepEqual(Buffer.from(await blob.arrayBuffer()), png);
      return new Blob(['webp'], { type: 'image/webp' });
    } });
  assert.equal((await encode(new Blob([extended]), 'image/png')).blob.type, 'image/webp');
});

test('disk original fallback trims once, keeps all aliases and identifies the unmodified source for cache', async () => {
  const memory = memoryOPFS(), spool = await createExportSpool({ jobId: 'png-tail', storage: memory.storage, locks: null });
  const cached = [], events = [];
  try {
    const files = await downloadDiskMedia(assets, { spool, allowCodec: false, resources: testResources(),
      fetchFile: async () => new Response(extended, { headers: { 'content-type': 'image/png', etag: '"original"' } }),
      mediaCache: { put: async (...args) => cached.push(args) }, onDiagnostic: event => events.push(event) });
    assert.deepEqual(files.map(file => file.status), ['downloaded', 'downloaded', 'downloaded']);
    assert.deepEqual(Buffer.from(await files[0].data.slice().arrayBuffer()), png);
    assert.equal(files[0].data, files[1].data); assert.equal(files[1].data, files[2].data);
    assert.deepEqual(files.map(file => file.url), assets.map(asset => asset.url));
    const archive = replacePackageAssets(createExportPackage({ assets }), files);
    assert.equal(archive.entries.filter(entry => entry.name.startsWith('media/')).length, 1);
    assert.deepEqual(archive.manifest.inventory.assets.map(file => file.url), assets.map(asset => asset.url));
    assert.ok(archive.manifest.inventory.assets.every(file => file.size === png.length && file.mimeType === 'image/png'));
    assert.equal(cached[0][1].hash, sha(extended)); assert.equal(cached[0][1].size, extended.length);
    assert.equal(cached[0][1].etag, '"original"');
    assert.equal(sha(await cached[0][2].file.data.slice().arrayBuffer()), sha(png));
    assert.ok(events.some(event => event.normalization === 'png_trailing_bytes_removed' && event.removedBytes === 6511));
    const report = events.reduce((result, event) => appendProblemEvent(result, event), createProblemReport());
    assert.ok(report.events.some(event => event.normalization === 'png_trailing_bytes_removed'));
  } finally { await spool.dispose(); }
});

test('memory downloads normalize a text/plain PNG before saving without an optimizer', async () => {
  const [file] = await downloadMediaAssets([assets[0]], { fetchFile: async () => new Response(extended, { headers: { 'content-type': 'text/plain' } }) });
  assert.equal(file.status, 'downloaded');
  assert.deepEqual(Buffer.from(await file.data.arrayBuffer()), png);
});

test('dimension errors survive the safe problem report projection', () => {
  const report = appendProblemEvent(createProblemReport(), { stage: 'files', status: 'failed', reason: 'image_dimensions_invalid' });
  assert.equal(report.events[0].reason, 'image_dimensions_invalid');
});

test('the disk text/plain codec path and real cache retain original identity and canonical output', async () => {
  const memory = memoryOPFS(), locks = cacheLocks();
  const cache = await createPreparedMediaCache({ storage: memory.storage, locks, indexedDB: cacheIndexedDB() });
  const webp = new Blob(['canonical-webp'], { type: 'image/webp' });
  let encoded = 0;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const spool = await createExportSpool({ jobId: `cached-tail-${attempt}`, storage: memory.storage, locks: null });
      try {
        const [file] = await downloadDiskMedia([assets[0]], { spool, mediaCache: cache, resources: testResources(), fetchFile: async (_url, options) => {
          if (attempt) { assert.equal(options.headers['If-None-Match'], '"raw-tail"'); return new Response(null, { status: 304 }); }
          return new Response(extended, { headers: { 'content-type': 'text/plain', etag: '"raw-tail"' } });
        }, createOptimizer: () => ({ async optimize(file) {
          encoded++;
          assert.deepEqual(Buffer.from(await file.data.slice().arrayBuffer()), png);
          return { ...file, data: webp, mimeType: 'image/webp' };
        }, close() {} }) });
        assert.equal(file.status, 'downloaded');
        assert.equal(file.name, '0.webp');
        const entry = await cache.lookup(assets[0].url);
        assert.equal(entry.sourceSize, extended.length); assert.equal(entry.sourceHash, sha(extended));
        assert.equal(entry.size, webp.size); assert.equal(entry.outputHash, sha(await webp.arrayBuffer()));
        assert.deepEqual(Buffer.from(await file.data.slice().arrayBuffer()), Buffer.from(await webp.arrayBuffer()));
      } finally { await spool.dispose(); }
    }
    assert.equal(encoded, 1);
  } finally { await cache.close(); }
});

test('memory mode without the codec saves an admissible PNG without its tail and keeps its extension', async () => {
  const [file] = await downloadExportMedia([assets[0]], { fetchFile: async () => new Response(extended, { headers: { 'content-type': 'text/plain' } }) }, null);
  assert.equal(file.status, 'downloaded'); assert.equal(file.originalImage, true); assert.equal(file.name, '0.png');
  assert.deepEqual(Buffer.from(await file.data.arrayBuffer()), png);
});
