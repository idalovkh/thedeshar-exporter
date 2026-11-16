import assert from 'node:assert/strict';
import test from 'node:test';
import { createExportSpool } from '../src/lib/export-spool.js';
import { memoryOPFS } from './disk-spool-fixture.mjs';

function locks() {
  const held = new Set();
  return { held, async request(name, options, run) {
    if (held.has(name) && options.ifAvailable) return run(null);
    assert.equal(held.has(name), false);
    held.add(name);
    try { return await run({ name }); } finally { held.delete(name); }
  } };
}

test('new exports remove orphaned disk directories but preserve other live tabs', async () => {
  const memory = memoryOPFS(), manager = locks();
  const parent = await memory.root.getDirectoryHandle('export-spool-v1', { create: true });
  await parent.getDirectoryHandle('orphan', { create: true });
  const first = await createExportSpool({ jobId: 'live-one', storage: memory.storage, locks: manager });
  const writer = await first.open('page.json'); await writer.write(new Uint8Array([1, 2])); await writer.close();
  const second = await createExportSpool({ jobId: 'live-two', storage: memory.storage, locks: manager });
  assert.equal(parent._entries.has('orphan'), false);
  assert.equal(parent._entries.has('live-one'), true);
  assert.equal((await first.file('page.json')).size, 2);
  await second.dispose(); assert.equal(parent._entries.has('live-one'), true);
  await first.dispose(); assert.equal(parent._entries.size, 0);
});

test('spool rejects unsafe names and unavailable disk APIs without RAM fallback', async () => {
  await assert.rejects(createExportSpool({ jobId: '../bad', storage: {} }), /идентификатор/);
  await assert.rejects(createExportSpool({ jobId: 'safe', storage: {} }), { code: 'storage_unavailable' });
  const memory = memoryOPFS(), spool = await createExportSpool({ jobId: 'safe', storage: memory.storage, locks: null });
  try {
    for (const name of ['../secret', '/secret', 'a/b', 'a\\b', 'file..json']) await assert.rejects(spool.open(name), /имя/);
  } finally { await spool.dispose(); }
});
