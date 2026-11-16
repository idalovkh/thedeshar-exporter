import assert from 'node:assert/strict';
import test from 'node:test';
import { createExportSpool } from '../src/lib/export-spool.js';
import { downloadDiskMedia } from '../src/ui/download-disk-media.js';
import { memoryOPFS, testResources } from './disk-spool-fixture.mjs';

const asset = index => ({ id: `asset-${index}`, url: `https://cdn.example.org/${index}.mp3`, name: `${index}.mp3` });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');

test('source downloads and prepared results stay disk-backed with bounded writes', async () => {
  const memory = memoryOPFS(), spool = await createExportSpool({ jobId: 'bounded', storage: memory.storage, locks: null });
  try {
    const files = await downloadDiskMedia([asset(1), asset(2)], { spool, resources: testResources(),
      fetchFile: async url => new Response(new Uint8Array(2 * 1024 * 1024 + 5).fill(url.includes('/1.') ? 1 : 2), { headers: { 'content-type': 'audio/mpeg' } }) });
    assert.equal(files.length, 2); assert.ok(files.every(file => file.status === 'downloaded'));
    assert.equal(files[0].data.size, 2 * 1024 * 1024 + 5);
    assert.ok(memory.stats.largestWrite <= 1024 * 1024);
    assert.equal(memory.stats.wholeReads, 0);
  } finally { await spool.dispose(); }
  assert.equal((await memory.root.getDirectoryHandle('export-spool-v1'))._entries.size, 0);
});

test('a safe original is preserved before starting a decoder when the memory budget refuses it', async () => {
  const memory = memoryOPFS(), spool = await createExportSpool({ jobId: 'original', storage: memory.storage, locks: null });
  let encoded = 0;
  try {
    const [file] = await downloadDiskMedia([{ ...asset(1), name: 'original.png' }], { spool, resources: testResources({ admit: false }),
      createOptimizer: () => ({ optimize() { encoded++; throw Error('Decoder must not start'); }, close() {} }),
      fetchFile: async () => new Response(png, { headers: { 'content-type': 'image/png' } }) });
    assert.equal(encoded, 0); assert.equal(file.status, 'downloaded'); assert.equal(file.originalImage, true);
    assert.equal(file.mimeType, 'image/png'); assert.equal(file.name, 'original.png');
    assert.deepEqual(new Uint8Array(await file.data.slice().arrayBuffer()), new Uint8Array(png));
  } finally { await spool.dispose(); }
});

test('disk write failures terminate the entire attempt instead of becoming forgivable missing files', async () => {
  const memory = memoryOPFS({ failWrites: true }), spool = await createExportSpool({ jobId: 'full', storage: memory.storage, locks: null });
  try {
    await assert.rejects(downloadDiskMedia([asset(1)], { spool, resources: testResources(),
      fetchFile: async () => new Response('ID3audio', { headers: { 'content-type': 'audio/mpeg' } }) }), { code: 'storage_error' });
  } finally { await spool.dispose(); }
});

test('identical source bytes from distinct URLs share one prepared result', async () => {
  const memory = memoryOPFS(), spool = await createExportSpool({ jobId: 'reuse', storage: memory.storage, locks: null });
  let calls = 0;
  try {
    const files = await downloadDiskMedia([asset(1), asset(2)], { spool, resources: testResources(),
      fetchFile: async () => { calls++; return new Response('ID3same', { headers: { 'content-type': 'audio/mpeg' } }); } });
    assert.equal(calls, 2); assert.equal(files[0].data, files[1].data);
  } finally { await spool.dispose(); }
});

test('resolved URL aliases download once and keep their logical references', async () => {
  const path = '/files/LessonExerciseImages/883a1997-622d-447f-8910-0a7dd7ba2040.png';
  const cdn = `https://media-a.edvibe.com${path}`;
  const urls = [`https://progressme.ru/lesson-editor/book/1/lesson/2/section/3${path}`, cdn];
  const memory = memoryOPFS(), spool = await createExportSpool({ jobId: 'aliases', storage: memory.storage, locks: null });
  const requested = [];
  try {
    const files = await downloadDiskMedia(urls.map((url, index) => ({ ...asset(index), url })), { spool, resources: testResources({ admit: false }),
      fetchFile: async url => { requested.push(url); return new Response(png, { headers: { 'content-type': 'image/png' } }); } });
    assert.deepEqual(requested, [cdn]);
    assert.deepEqual(files.map(file => file.url), urls);
    assert.equal(files[0].data, files[1].data);
  } finally { await spool.dispose(); }
});

test('three missing files terminate the attempt and cannot become a partial result', async () => {
  const memory = memoryOPFS(), spool = await createExportSpool({ jobId: 'loss-cap', storage: memory.storage, locks: null });
  try {
    await assert.rejects(downloadDiskMedia([asset(1), asset(2), asset(3), asset(4)], { spool, resources: testResources(),
      fetchFile: async () => new Response('Forbidden', { status: 403 }) }), { code: 'incomplete_export' });
  } finally { await spool.dispose(); }
});

test('the disk network stage continues past six images while the sole codec is busy', async () => {
  const memory = memoryOPFS(), spool = await createExportSpool({ jobId: 'separate-stages', storage: memory.storage, locks: null });
  let fetched = 0, encoded = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  const webp = new Blob([Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvBwABAAdQsvrXo/+BiOh/AAA=', 'base64')], { type: 'image/webp' });
  const downloading = downloadDiskMedia(Array.from({ length: 8 }, (_, index) => ({ ...asset(index), name: `${index}.png` })), {
    spool, resources: testResources(),
    fetchFile: async () => { fetched++; return new Response(png, { headers: { 'content-type': 'image/png' } }); },
    createOptimizer: () => ({ async optimize(file) { encoded++; await held; return { ...file, data: webp, mimeType: 'image/webp' }; }, close() {} }),
  });
  try {
    const deadline = performance.now() + 1000;
    while (fetched < 7 || encoded < 1) { assert.ok(performance.now() < deadline); await new Promise(resolve => setImmediate(resolve)); }
    assert.equal(encoded, 1);
    release();
    const files = await downloading;
    assert.ok(files.every(file => file.status === 'downloaded' && file.name.endsWith('.webp')));
    assert.equal(encoded, 1, 'identical sources are prepared once even across distinct source URLs');
  } finally { release(); await downloading.catch(() => {}); await spool.dispose(); }
});

test('codec corruption errors never masquerade as a memory-admission original fallback', async () => {
  const memory = memoryOPFS(), spool = await createExportSpool({ jobId: 'codec-error', storage: memory.storage, locks: null });
  try {
    const [file] = await downloadDiskMedia([asset(1)], { spool, resources: testResources(),
      fetchFile: async () => new Response(png, { headers: { 'content-type': 'image/png' } }),
      createOptimizer: () => ({ async optimize() { throw Object.assign(new Error('Invalid image'), { reason: 'image_webp_failed' }); }, close() {} }),
    });
    assert.equal(file.status, 'failed'); assert.equal(file.originalImage, undefined); assert.equal(file.data, undefined);
  } finally { await spool.dispose(); }
});
