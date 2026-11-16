import assert from 'node:assert/strict';
import test from 'node:test';
import { buildZipBlob, zipByteLength } from '../src/lib/archive.js';
import { assertExportFilesReady } from '../src/lib/export-readiness.js';
import { createExportPackage, replacePackageAssets } from '../src/lib/package.js';
import { downloadMediaAssets } from '../src/ui/assets.js';
import { downloadExportMedia } from '../src/ui/export-media.js';

const makeAsset = (id, name) => ({ id, url: `https://cdn.example.org/${id}`, name });
const response = (body, type = 'audio/mpeg') => new Response(body, { headers: { 'content-type': type } });

test('different URLs, names and MIME types share one body and the first manifest path', async () => {
  const assets = [makeAsset('a', 'first.mp3'), makeAsset('b', 'second.bin'), makeAsset('c', 'distinct.mp3')];
  let resolveFirst;
  const first = new Promise(resolve => { resolveFirst = resolve; });
  const completed = [];
  const downloads = downloadExportMedia(assets, {
    maxTotalBytes: 8,
    fetchFile: async url => {
      if (url === assets[0].url) return first;
      if (url === assets[1].url) return response('same', 'application/octet-stream');
      return response('else');
    },
    onDiagnostic(event) {
      if (event.status === 'downloaded') {
        completed.push(event.assetId);
        if (event.assetId === 'b') resolveFirst(response('same'));
      }
    },
  }, null);
  const files = await downloads;
  assert.ok(completed.indexOf('b') < completed.indexOf('a'));
  assert.equal(files[0].data, files[1].data);
  assert.notEqual(files[0].data, files[2].data);
  const { manifest, entries } = replacePackageAssets(createExportPackage({ assets }), files);
  assert.deepEqual(manifest.inventory.assets.map(({ id, url, name, mimeType, file, size }) =>
    [id, url, name, mimeType, file, size]), [
    ['a', assets[0].url, 'first.mp3', 'audio/mpeg', 'media/00001-first.mp3', 4],
    ['b', assets[1].url, 'second.bin', 'application/octet-stream', 'media/00001-first.mp3', 4],
    ['c', assets[2].url, 'distinct.mp3', 'audio/mpeg', 'media/00003-distinct.mp3', 4],
  ]);
  assert.equal(manifest.counts.downloadedAssets, 3);
  assert.deepEqual(entries.filter(entry => entry.name.startsWith('media/')).map(entry => entry.name),
    ['media/00001-first.mp3', 'media/00003-distinct.mp3']);
  const limit = zipByteLength(entries);
  assert.equal((await buildZipBlob(entries, { maxBytes: limit })).size, limit);
  await assert.rejects(buildZipBlob(entries, { maxBytes: limit - 1 }), { code: 'archive_limit' });
});

test('only selected bytes enter the unique budget, and a second distinct result still costs space', async () => {
  const assets = [makeAsset('a', 'a.png'), makeAsset('b', 'b.png')];
  const options = {
    deduplicate: true,
    maxTotalBytes: 4,
    fetchFile: async url => response(url.endsWith('/a') ? 'source one' : 'source two', 'image/png'),
  };
  const webp = text => ({ data: new Blob([text], { type: 'image/webp' }), mimeType: 'image/webp' });
  const files = await downloadMediaAssets(assets, { ...options, optimizeMedia: async () => webp('same') });
  assert.ok(files.every(file => file.status === 'downloaded'));
  assert.equal(files[0].data, files[1].data);
  assert.deepEqual(files.map(file => file.name), ['a.webp', 'b.webp']);
  await assert.rejects(downloadMediaAssets(assets, {
    ...options, optimizeMedia: async (_file, { index }) => webp(index ? 'else' : 'same'),
  }), { code: 'archive_limit' });
});

test('a failed hash read identifies the file and blocks ZIP creation', async () => {
  class UnreadableBlob extends Blob {
    slice() { throw new Error('Cannot read Blob'); }
  }
  const asset = makeAsset('a', 'page.png');
  const diagnostics = [];
  const files = await downloadMediaAssets([asset], {
    deduplicate: true,
    fetchFile: async () => response('source', 'image/png'),
    optimizeMedia: async () => ({ data: new UnreadableBlob(['result']), mimeType: 'image/webp' }),
    onDiagnostic: event => diagnostics.push(event),
  });
  assert.equal(files[0].status, 'failed');
  assert.match(files[0].error, /проверки дубликатов/);
  assert.ok(diagnostics.some(event => event.assetId === asset.id && event.reason === 'media_hash_failed'));
  assert.throws(() => assertExportFilesReady(files, [asset]), { code: 'incomplete_export' });
});

test('canceling while hashing stops the lane before its next download', async () => {
  const controller = new AbortController();
  let hashing, release;
  const started = new Promise(resolve => { hashing = resolve; });
  const read = new Promise(resolve => { release = resolve; });
  class PendingBlob extends Blob {
    slice() {
      hashing();
      return { arrayBuffer: () => read };
    }
  }
  const assets = [makeAsset('a', 'a.png'), makeAsset('b', 'b.png')];
  const requests = [];
  const job = downloadMediaAssets(assets, {
    signal: controller.signal, concurrency: 1, deduplicate: true,
    fetchFile: async url => { requests.push(url); return response('source', 'image/png'); },
    optimizeMedia: async () => ({ data: new PendingBlob(['result']), mimeType: 'image/webp' }),
  });
  const canceled = assert.rejects(job, { name: 'AbortError' });
  await started;
  controller.abort();
  release(new TextEncoder().encode('result').buffer);
  await canceled;
  assert.deepEqual(requests, [assets[0].url]);
});
