import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareDiskExport } from '../src/ui/export-record-stream.js';
import { createExportPackage } from '../src/lib/package.js';

function fixture() {
  const root = 'https://progressme.ru/cabinet/school/materials/book/71/content';
  const snapshots = [{ url: root, title: 'Book', coverUrl: 'https://cdn.example.org/cover.png',
    blocks: [{ text: 'Retained raw page' }], assets: ['https://cdn.example.org/a.mp3'] }];
  const captures = [{ kind: 'websocket', pageUrl: root, url: 'wss://proxy.progressme.ru/websocket',
    data: { Class: 'GetExerciseWsController', Value: { Items: [{ Id: 1, Image: 'https://cdn.example.org/cover.png' }] } } }];
  const requests = [], files = new Map(), writes = [];
  return { snapshots, captures, requests, files, writes, summary: { exportRevision: 3, warnings: [], dropped: 0 },
    async send(type, payload = {}) {
      requests.push({ type, ...payload });
      if (type === 'GET_EXPORT_INFO') return { revision: 3, snapshotCount: snapshots.length, captureCount: captures.length };
      return { revision: 3, total: payload.kind === 'snapshots' ? snapshots.length : captures.length,
        nextOffset: payload.offset + 1, records: [(payload.kind === 'snapshots' ? snapshots : captures)[payload.offset]] };
    },
    spool: {
      async open(name) { const blocks = []; return { async write(block) { writes.push(block.length); blocks.push(block); },
        async close() { files.set(name, new Blob(blocks)); }, async abort() {} }; },
      async file(name) { return files.get(name); },
    },
  };
}

test('raw records are spooled one at a time while package metadata and bytes stay equivalent', async () => {
  const input = fixture();
  const result = await prepareDiskExport(input.summary, input);
  const old = createExportPackage({ snapshots: input.snapshots, captures: input.captures, assets: result.assets,
    source: undefined, warnings: [], dropped: 0, exportedAt: result.prepared.manifest.exportedAt });
  assert.deepEqual(result.prepared.manifest, old.manifest);
  for (const entry of result.prepared.entries) {
    const before = old.entries.find(candidate => candidate.name === entry.name);
    assert.equal(entry.data instanceof Blob ? await entry.data.text() : entry.data, before.data);
  }
  assert.equal(result.state.snapshots[0].blocks, undefined);
  assert.equal(result.state.captures[0].data, true);
  assert.ok(input.requests.filter(request => request.type === 'GET_EXPORT_RECORDS').every(request => request.limit === 1));
});

test('bounded record writes preserve unicode across chunk boundaries', async () => {
  const input = fixture();
  input.snapshots[0].blocks[0].text = '😀'.repeat(400000);
  const result = await prepareDiskExport(input.summary, input);
  const raw = result.prepared.entries.find(entry => entry.name.startsWith('originals/pages/'));
  assert.equal(JSON.parse(await raw.data.text()).blocks[0].text, input.snapshots[0].blocks[0].text);
  assert.ok(Math.max(...input.writes) <= 1024 * 1024);
});

test('stale, malformed or cancelled streams cannot produce a package', async () => {
  const input = fixture();
  await assert.rejects(prepareDiskExport({ ...input.summary, exportRevision: 4 }, input), { code: 'export_changed' });
  await assert.rejects(prepareDiskExport(input.summary, { ...input, send: async type => type === 'GET_EXPORT_INFO'
    ? { revision: 3, snapshotCount: 1, captureCount: 0 } : { revision: 3, total: 1, records: [], nextOffset: 1 } }), /прочитать/);
  const controller = new AbortController();
  await assert.rejects(prepareDiskExport(input.summary, { ...input, signal: controller.signal,
    onProgress({ loaded }) { if (loaded) controller.abort(); } }), { name: 'AbortError' });
});
