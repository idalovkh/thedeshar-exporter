import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreparedMediaCache } from '../src/lib/prepared-media-cache.js';
import { createExportSpool } from '../src/lib/export-spool.js';
import { downloadDiskMedia } from '../src/ui/download-disk-media.js';
import { memoryOPFS, testResources } from './disk-spool-fixture.mjs';
import { cacheIndexedDB, cacheLocks } from './prepared-media-cache-fixture.mjs';

const asset = { id: 'picture', name: 'picture.png', url: 'https://cdn.example.org/picture.png' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
const webp = new Blob([Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvBwABAAdQsvrXo/+BiOh/AAA=', 'base64')], { type: 'image/webp' });
const response = (etag = '"one"') => new Response(png, { headers: { 'content-type': 'image/png', ...(etag ? { etag } : {}) } });

async function fixture() {
  const memory = memoryOPFS(), indexedDB = cacheIndexedDB(), locks = cacheLocks();
  const mediaCache = await createPreparedMediaCache({ storage: memory.storage, indexedDB, locks });
  let number = 0, encoded = 0;
  return { ...memory, mediaCache, get encoded() { return encoded; },
    async run(fetchFile, options = {}) {
      const spool = await createExportSpool({ jobId: `attempt-${++number}`, storage: memory.storage, locks: null });
      try { return await downloadDiskMedia(options.candidates || [asset], { spool, mediaCache, resources: testResources(), fetchFile,
        createOptimizer: () => ({ async optimize(file) { encoded++; return { ...file, data: webp, mimeType: 'image/webp' }; }, close() {} }), ...options }); }
      finally { await spool.dispose(); }
    },
  };
}

test('each export revalidates a strong ETag and a 304 reuses verified prepared bytes without a decoder', async () => {
  const f = await fixture();
  try {
    const [first] = await f.run(async () => response());
    assert.equal(first.name, 'picture.webp');
    let requests = 0;
    const [second] = await f.run(async (_url, options) => {
      requests++; assert.equal(options.headers['If-None-Match'], '"one"');
      assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
      return new Response(null, { status: 304 });
    });
    assert.equal(requests, 1); assert.equal(f.encoded, 1);
    assert.equal(second.name, 'picture.webp'); assert.equal(second.mimeType, 'image/webp');
    assert.deepEqual(new Uint8Array(await second.data.slice().arrayBuffer()), new Uint8Array(await webp.arrayBuffer()));
  } finally { await f.mediaCache.close(); }
});

test('a full GET without a strong validator still reuses transformation by verified source SHA', async () => {
  const f = await fixture();
  try {
    await f.run(async () => response('W/"weak"'));
    let requests = 0;
    await f.run(async (_url, options) => { requests++; assert.equal(options.headers?.['If-None-Match'], undefined); return response(); });
    assert.equal(requests, 1); assert.equal(f.encoded, 1);
  } finally { await f.mediaCache.close(); }
});

test('HTTP failures, denied permissions and temporary URLs never use stale cached media', async () => {
  const f = await fixture();
  try {
    await f.run(async () => response());
    assert.equal((await f.run(async () => new Response('Denied', { status: 403 })))[0].status, 'failed');
    assert.equal((await f.run(() => assert.fail('permission refusal cannot request media'), { hasPermission: async () => false }))[0].status, 'skipped');
    assert.equal((await f.run(() => assert.fail('temporary links cannot request or restore media'), { candidates: [{ ...asset, downloadUnavailable: true }] }))[0].status, 'unavailable');
    assert.equal(f.encoded, 1);
  } finally { await f.mediaCache.close(); }
});

test('changed source bytes are processed again and cached results keep all export size gates', async () => {
  const f = await fixture();
  try {
    await f.run(async () => response());
    const other = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
    await f.run(async () => new Response(other, { headers: { 'content-type': 'image/png', etag: '"changed"' } }));
    assert.equal(f.encoded, 2);
    await assert.rejects(f.run(async () => new Response(null, { status: 304 }), { maxTotalBytes: 1 }), { code: 'archive_limit' });
    assert.equal((await f.run(async () => new Response(null, { status: 304 }), { maxFileBytes: 1 }))[0].status, 'failed');
    assert.equal(f.encoded, 2);
  } finally { await f.mediaCache.close(); }
});

test('cancellation retains completed cache records for a following revalidated attempt', async () => {
  const f = await fixture(), controller = new AbortController();
  try {
    await assert.rejects(f.run(async () => response(), { signal: controller.signal,
      onProgress: progress => { if (progress.completed === 1) controller.abort(); } }), { name: 'AbortError' });
    assert.ok(await f.mediaCache.lookup(asset.url));
    assert.equal((await f.run(async (_url, options) => {
      assert.equal(options.headers['If-None-Match'], '"one"'); return new Response(null, { status: 304 });
    }))[0].status, 'downloaded');
    assert.equal(f.encoded, 1);
  } finally { await f.mediaCache.close(); }
});

test('a 304 with a missing cached output retries one unconditional GET', async () => {
  const f = await fixture();
  try {
    await f.run(async () => response());
    const entry = await f.mediaCache.lookup(asset.url);
    await (await f.root.getDirectoryHandle('export-media-cache-v1')).removeEntry(entry.fileName);
    let requests = 0;
    const [file] = await f.run(async (_url, options) => {
      requests++;
      if (requests === 1) { assert.equal(options.headers['If-None-Match'], '"one"'); return new Response(null, { status: 304 }); }
      assert.equal(options.headers?.['If-None-Match'], undefined); return response('"two"');
    });
    assert.equal(requests, 2); assert.equal(file.status, 'downloaded'); assert.equal(f.encoded, 2);
  } finally { await f.mediaCache.close(); }
});

test('failed optional cache writes do not turn valid downloaded media into losses', async () => {
  const f = await fixture();
  try {
    const [file] = await f.run(async () => response(), { mediaCache: { lookup: async () => null, restoreSource: async () => null,
      put: async () => { throw new DOMException('Optional cache full', 'QuotaExceededError'); } } });
    assert.equal(file.status, 'downloaded'); assert.equal(file.name, 'picture.webp');
  } finally { await f.mediaCache.close(); }
});

test('an independent cache transaction abort does not cancel an otherwise valid export', async () => {
  const f = await fixture();
  try {
    const aborted = async () => { throw new DOMException('Optional transaction aborted', 'AbortError'); };
    const [file] = await f.run(async () => response(), { mediaCache: { lookup: aborted, restoreSource: aborted, put: aborted } });
    assert.equal(file.status, 'downloaded'); assert.equal(file.name, 'picture.webp');
  } finally { await f.mediaCache.close(); }
});
