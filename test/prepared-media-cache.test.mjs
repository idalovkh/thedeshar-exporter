import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreparedMediaCache } from '../src/lib/prepared-media-cache.js';
import { hashArchiveMedia } from '../src/lib/media-sha256.js';
import { createExportSpool } from '../src/lib/export-spool.js';
import { memoryOPFS } from './disk-spool-fixture.mjs';
import { cacheIndexedDB, cacheLocks } from './prepared-media-cache-fixture.mjs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PREPARED_MEDIA_POLICY, strongMediaEtag } from '../src/lib/prepared-media-cache.js';

const url = 'https://cdn.example.org/audio.mp3?version=1';
const source = async (body = 'ID3source') => ({ hash: await hashArchiveMedia(new Blob([body])), size: body.length, mimeType: 'audio/mpeg', etag: '"first"' });
const prepared = body => ({ file: { data: new Blob([body]), mimeType: 'audio/mpeg' }, converted: false, originalImage: false });
const setup = () => {
  const memory = memoryOPFS(), indexedDB = cacheIndexedDB(), locks = cacheLocks();
  return { ...memory, indexedDB, locks, open: options => createPreparedMediaCache({ storage: memory.storage, indexedDB, locks, ...options }) };
};

test('prepared media persists across cache instances without raw URLs and stays independent of attempt cleanup', async () => {
  const env = setup();
  let cache = await env.open();
  assert.equal(await cache.put(url, await source(), prepared('ID3prepared')), true);
  await cache.close();
  cache = await env.open();
  const spool = await createExportSpool({ jobId: 'cached', storage: env.storage, locks: null });
  try {
    const entry = await cache.lookup(url);
    assert.equal(entry.etag, '"first"');
    const hit = await cache.restore(entry, spool, 'restored.bin');
    assert.equal(await hit.file.data.slice().text(), 'ID3prepared');
    assert.equal(await cache.lookup(url.replace('version=1', 'version=2')), null);
    assert.equal(await cache.lookup(url.replace('cdn.example.org', 'other.example.org')), null);
    const records = [...env.indexedDB.databases.values()].flatMap(stores => [...stores.values()].flatMap(items => [...items.values()]));
    assert.equal(JSON.stringify(records).includes('cdn.example.org'), false);
    assert.equal(JSON.stringify(records).includes('version='), false);
  } finally { await spool.dispose(); await cache.close(); }
  assert.equal(env.stats.wholeReads, 0);
  assert.ok(env.stats.largestWrite <= 1024 * 1024);
});

test('missing or corrupt cached bytes become misses and cannot replace the current source', async () => {
  const env = setup(), cache = await env.open();
  const spool = await createExportSpool({ jobId: 'corrupt', storage: env.storage, locks: null });
  try {
    await cache.put(url, await source(), prepared('ID3prepared'));
    const entry = await cache.lookup(url), directory = await env.root.getDirectoryHandle('export-media-cache-v1');
    const file = await directory.getFileHandle(entry.fileName), writer = await file.createWritable();
    await writer.write(new TextEncoder().encode('corruption!')); await writer.close();
    assert.equal(await cache.restore(entry, spool, 'bad.bin'), null);
    assert.equal(await cache.lookup(url), null);
    await cache.put(url, await source(), prepared('ID3prepared'));
    const missing = await cache.lookup(url); await directory.removeEntry(missing.fileName);
    assert.equal(await cache.restore(missing, spool, 'missing.bin'), null);
  } finally { await cache.close(); await spool.dispose(); }
});

test('cache evicts least recently used references, counts shared bytes once and invalidates old codec policies', async () => {
  const env = setup();
  let clock = 0, cache = await env.open({ maxBytes: 12, maxEntries: 2, now: () => ++clock });
  await cache.put(url, await source(), prepared('ID3one'));
  await cache.put(`${url}&alias=1`, await source(), prepared('ID3one'));
  await cache.put(`${url}&second=1`, await source('ID3two'), prepared('ID3two'));
  assert.equal(await cache.lookup(url), null);
  assert.ok(await cache.lookup(`${url}&alias=1`));
  assert.ok(await cache.lookup(`${url}&second=1`));
  await cache.close();
  cache = await env.open({ policy: 'a-new-codec-policy' });
  assert.equal(await cache.lookup(`${url}&alias=1`), null);
  await cache.close();
});

test('an alias replacing the sole allowed cache reference still retains its prepared file', async () => {
  const env = setup(), cache = await env.open({ maxEntries: 1, maxBytes: 6 });
  const spool = await createExportSpool({ jobId: 'one-reference', storage: env.storage, locks: null });
  try {
    await cache.put(url, await source(), prepared('ID3one'));
    await cache.put(`${url}&alias=1`, await source(), prepared('ID3one'));
    assert.equal(await cache.lookup(url), null);
    assert.equal(await (await cache.restore(await cache.lookup(`${url}&alias=1`), spool, 'alias.bin')).file.data.slice().text(), 'ID3one');
  } finally { await cache.close(); await spool.dispose(); }
});

test('cached copies survive eviction and startup cleans uncommitted files without touching attempt spool', async () => {
  const env = setup();
  let cache = await env.open({ maxEntries: 1 });
  const spool = await createExportSpool({ jobId: 'pinned-copy', storage: env.storage, locks: null });
  try {
    await cache.put(url, await source(), prepared('ID3one'));
    const restored = await cache.restore(await cache.lookup(url), spool, 'copy.bin');
    await cache.put(`${url}&new=1`, await source('ID3two'), prepared('ID3two'));
    assert.equal(await restored.file.data.slice().text(), 'ID3one');
    await cache.close();
    const directory = await env.root.getDirectoryHandle('export-media-cache-v1');
    await directory.getFileHandle('uncommitted', { create: true });
    cache = await env.open();
    assert.equal(directory._entries.has('uncommitted'), false);
    assert.equal(await (await spool.file('copy.bin')).slice().text(), 'ID3one');
  } finally { await cache.close(); await spool.dispose(); }
});

test('codec policy tracks the shipped binary and only strong bounded ETags are eligible', async () => {
  const codec = await readFile(new URL('../src/vendor/webp/codec.wasm', import.meta.url));
  assert.ok(PREPARED_MEDIA_POLICY.endsWith(createHash('sha256').update(codec).digest('hex')));
  assert.equal(strongMediaEtag('"valid"'), '"valid"');
  for (const etag of ['W/"weak"', 'unquoted', '"newline\n"', `"${'a'.repeat(1024)}"`]) assert.equal(strongMediaEtag(etag), null);
});

test('quota exhaustion evicts old files and retries once; permanent cache failure stays optional', async () => {
  const env = setup(), cache = await env.open();
  try {
    await cache.put(url, await source(), prepared('ID3old'));
    const directory = await env.root.getDirectoryHandle('export-media-cache-v1'), original = directory.getFileHandle.bind(directory);
    let writes = 0, permanent = false;
    directory.getFileHandle = async (...args) => {
      const handle = await original(...args);
      return { ...handle, async createWritable() {
        const writer = await handle.createWritable();
        return { ...writer, async write(block) {
          if (++writes === 1 || permanent) throw new DOMException('Full cache disk', 'QuotaExceededError');
          return writer.write(block);
        } };
      } };
    };
    assert.equal(await cache.put(`${url}&new=1`, await source('ID3new'), prepared('ID3new')), true);
    assert.equal(writes, 2); assert.equal(await cache.lookup(url), null);
    permanent = true;
    assert.equal(await cache.put(`${url}&failed=1`, await source('ID3failed'), prepared('ID3failed')), false);
    assert.equal(await cache.lookup(`${url}&failed=1`), null);
    assert.equal(directory._entries.size, 0, 'failed optional writes leave no published files or unbounded leftovers');
  } finally { await cache.close(); }
});

test('canceling an unfinished cache write retains earlier committed media and cleans its partial file', async () => {
  const env = setup(), cache = await env.open();
  try {
    await cache.put(url, await source(), prepared('ID3old'));
    const directory = await env.root.getDirectoryHandle('export-media-cache-v1'), original = directory.getFileHandle.bind(directory);
    const controller = new AbortController();
    directory.getFileHandle = async (...args) => {
      const handle = await original(...args);
      return { ...handle, async createWritable() {
        const writer = await handle.createWritable();
        return { ...writer, async write(block) { await writer.write(block); controller.abort(); } };
      } };
    };
    await assert.rejects(cache.put(`${url}&cancelled=1`, await source('ID3new'), prepared('ID3new'), { signal: controller.signal }), { name: 'AbortError' });
    assert.ok(await cache.lookup(url)); assert.equal(await cache.lookup(`${url}&cancelled=1`), null);
    assert.equal(directory._entries.size, 1);
  } finally { await cache.close(); }
});

test('a second cache instance waits for the first media lease and sees only committed records', async () => {
  const env = setup(), first = await env.open();
  let opened = false;
  const opening = env.open().then(cache => { opened = true; return cache; });
  await first.put(url, await source(), prepared('ID3old'));
  assert.equal(opened, false);
  await first.close();
  const second = await opening;
  try { assert.ok(await second.lookup(url)); } finally { await second.close(); }
});

test('startup cursor truncates oversized or invalid indexes without whole-index reads', async () => {
  const env = setup();
  let cache = await env.open();
  await cache.put(url, await source(), prepared('ID3old')); await cache.close();
  const records = [...env.indexedDB.databases.values()][0].get('prepared-media'), entry = [...records.values()][0];
  records.clear();
  for (let index = 0; index < 20_005; index++) {
    const key = index.toString(16).padStart(64, '0'); records.set(key, { ...entry, key, usedAt: index });
  }
  records.set('invalid', { ...entry, key: 'invalid', size: 1_000_000_000_000 });
  cache = await env.open({ maxEntries: 99_999 });
  try { assert.equal(records.size, 20_000); assert.equal(records.has('invalid'), false); }
  finally { await cache.close(); }
});

test('failed eviction stops optional writes instead of growing disk use beyond its byte cap', async () => {
  const env = setup(), cache = await env.open({ maxBytes: 6 });
  try {
    await cache.put(url, await source(), prepared('ID3old'));
    const directory = await env.root.getDirectoryHandle('export-media-cache-v1');
    directory.removeEntry = async () => { throw new DOMException('Cannot evict', 'UnknownError'); };
    assert.equal(await cache.put(`${url}&new=1`, await source('ID3new'), prepared('ID3new')), false);
    assert.equal(directory._entries.size, 1);
  } finally { await cache.close(); }
});

test('a silently corrupted spool copy never becomes a successful cached result', async () => {
  const env = setup(), cache = await env.open();
  const spool = await createExportSpool({ jobId: 'bad-copy', storage: env.storage, locks: null });
  try {
    await cache.put(url, await source(), prepared('ID3prepared'));
    const corruptingSpool = { ...spool, async open(name) {
      const writer = await spool.open(name);
      return { ...writer, async write(bytes) { const damaged = new Uint8Array(bytes); damaged[0] ^= 1; await writer.write(damaged); } };
    } };
    assert.equal(await cache.restore(await cache.lookup(url), corruptingSpool, 'copy.bin'), null);
    assert.equal(await cache.lookup(url), null);
    await assert.rejects(spool.file('copy.bin'), { code: 'storage_error' });
  } finally { await cache.close(); await spool.dispose(); }
});
