import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadMediaAssets, MEDIA_CONCURRENCY } from '../src/ui/assets.js';
import { replacePackageAssets, createExportPackage } from '../src/lib/package.js';
import { buildZipBlob, zipByteLength } from '../src/lib/archive.js';

const candidate = index => ({ id: `asset-${index}`, name: 'page.png', url: `https://cdn.example.org/${index}.png` });
const response = size => new Response(new Uint8Array(size), { headers: { 'content-type': 'image/png' } });
const encoded = size => ({ data: new Blob([new Uint8Array(size)], { type: 'image/webp' }), mimeType: 'image/webp' });
const deferred = () => {
  let resolve;
  const done = new Promise(finish => { resolve = finish; });
  return { done, resolve };
};

test('archive admission counts selected bytes; manifest and ZIP keep the original references', async () => {
  const assets = [candidate(0), candidate(1)];
  const files = await downloadMediaAssets(assets, {
    maxTotalBytes: 10,
    fetchFile: async () => response(8),
    optimizeMedia: async () => encoded(5),
  });
  assert.deepEqual(files.map(f => [f.id, f.url, f.name, f.mimeType, f.data.size]),
    assets.map(a => [a.id, a.url, 'page.webp', 'image/webp', 5]));
  const { entries, manifest } = replacePackageAssets(createExportPackage({ assets }), files);
  assert.deepEqual(manifest.inventory.assets.map(m => [m.id, m.url, m.file, m.size, m.mimeType]),
    assets.map((a, i) => [a.id, a.url, `media/0000${i + 1}-page.webp`, 5, 'image/webp']));
  const limit = zipByteLength(entries);
  assert.equal((await buildZipBlob(entries, { maxBytes: limit })).size, limit);
  await assert.rejects(buildZipBlob(entries, { maxBytes: limit - 1 }), { code: 'archive_limit' });
  await assert.rejects(downloadMediaAssets(assets, {
    maxTotalBytes: 9, fetchFile: async () => response(8), optimizeMedia: async () => encoded(5),
  }), { code: 'archive_limit' });
});

test('the original file limit is checked before compression', async () => {
  const [file] = await downloadMediaAssets([candidate(0)], {
    maxFileBytes: 7, fetchFile: async () => response(8),
    optimizeMedia: () => assert.fail('oversized input must not reach the codec'),
  });
  assert.equal(file.status, 'failed');
  assert.match(file.error, /лимит размера файла/);
});

test('each downloader waits for admission before fetching more, and the network timer ends at EOF', async () => {
  const compressed = deferred(), lanesOccupied = deferred();
  let fetches = 0, pending = 0;
  const signals = [];
  const result = downloadMediaAssets(Array.from({ length: MEDIA_CONCURRENCY + 1 }, (_, i) => candidate(i)), {
    maxTotalBytes: 40, timeoutMs: 15,
    fetchFile: async (_url, { signal }) => { fetches++; signals.push(signal); return response(8); },
    optimizeMedia: async () => {
      if (++pending === MEDIA_CONCURRENCY) lanesOccupied.resolve();
      await compressed.done;
      return encoded(5);
    },
  });
  await lanesOccupied.done;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(fetches, MEDIA_CONCURRENCY);
  assert.ok(signals.every(s => !s.aborted));
  compressed.resolve();
  assert.ok((await result).every(f => f.status === 'downloaded'));
  assert.equal(fetches, MEDIA_CONCURRENCY + 1);
});

test('a terminal ZIP budget error aborts another slot waiting for the codec', async () => {
  const entered = deferred(), aborted = deferred();
  const job = downloadMediaAssets([candidate(0), candidate(1)], {
    maxTotalBytes: 4,
    fetchFile: async () => response(8),
    optimizeMedia: async (file, { signal, index }) => {
      if (index === 0) { await entered.done; return file; }
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => { aborted.resolve(); reject(new DOMException('cancelled', 'AbortError')); }, { once: true });
        entered.resolve();
      });
    },
  });
  await assert.rejects(job, { code: 'archive_limit' });
  await aborted.done;
});
