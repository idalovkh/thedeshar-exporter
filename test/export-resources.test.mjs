import assert from 'node:assert/strict';
import test from 'node:test';
import { createExportResources } from '../src/lib/export-resources.js';

test('unavailable resource APIs use one download and refuse decoding', async () => {
  const resources = createExportResources({ system: {} });
  try {
    assert.equal((await resources.sample()).concurrency, 1);
    assert.equal(await resources.admitImage({ width: 1, height: 1 }, 10), false);
  } finally { resources.close(); }
});

test('low memory fails clearly and large originals are rejected before decoder allocation', async () => {
  let available = 256 * 1024 * 1024;
  const resources = createExportResources({ system: { memory: { getInfo: async () => ({ capacity: 16 * 1024 ** 3, availableCapacity: available }) } } });
  try {
    await assert.rejects(resources.sample(), { code: 'export_resources' });
    available = 2 * 1024 ** 3;
    await resources.sample();
    assert.equal(await resources.admitImage({ width: 8000, height: 8000 }, 10), false);
    available = 12 * 1024 ** 3;
    await resources.sample();
    assert.equal(await resources.admitImage({ width: 1000, height: 1000 }, 10), true);
  } finally { resources.close(); }
});

test('good downloads increase concurrency, slow disk writes lower it, and aborted waits finish', async () => {
  const controller = new AbortController();
  const resources = createExportResources({ signal: controller.signal, system: { memory: { getInfo: async () => ({ capacity: 16 * 1024 ** 3, availableCapacity: 12 * 1024 ** 3 }) } } });
  try {
    await resources.sample();
    for (let count = 0; count < 3; count++) resources.recordDownload(0);
    assert.equal(resources.snapshot().concurrency, 3);
    resources.recordWrite(300);
    assert.equal(resources.snapshot().concurrency, 2);
    const a = await resources.acquireDownload(), b = await resources.acquireDownload();
    const pending = assert.rejects(resources.acquireDownload(), { name: 'AbortError' });
    controller.abort(); await pending; a(); b();
  } finally { resources.close(); }
});

test('a pressure sample can cancel an active native decode instead of waiting for its completion', async () => {
  let available = 8 * 1024 ** 3;
  const controller = new AbortController(), pressures = [];
  const resources = createExportResources({ signal: controller.signal,
    system: { memory: { getInfo: async () => ({ capacity: 16 * 1024 ** 3, availableCapacity: available }) } },
    onPressure(error) { pressures.push(error.code); controller.abort(); },
  });
  try {
    await resources.sample(); available = 256 * 1024 * 1024;
    await assert.rejects(resources.sample(), { name: 'AbortError' });
    assert.deepEqual(pressures, ['export_resources']);
    assert.equal(controller.signal.aborted, true);
  } finally { resources.close(); }
});

test('per-file admission reuses one OS sample for two seconds while explicit sampling stays fresh', async () => {
  let timestamp = 1000, memoryCalls = 0, cpuCalls = 0;
  const resources = createExportResources({ now: () => timestamp, system: {
    memory: { async getInfo() { memoryCalls++; return { capacity: 16 * 1024 ** 3, availableCapacity: 12 * 1024 ** 3 }; } },
    cpu: { async getInfo() { cpuCalls++; return { processors: [{ usage: { total: cpuCalls * 100, idle: cpuCalls * 80 } }] }; } },
  } });
  try {
    await resources.sample();
    for (let index = 0; index < 20; index++) {
      const release = await resources.acquireDownload();
      assert.equal(await resources.admitImage({ width: 100, height: 100 }, 10), true);
      release();
    }
    assert.equal(memoryCalls, 1); assert.equal(cpuCalls, 1);
    timestamp += 1999;
    await resources.admitImage({ width: 100, height: 100 }, 10);
    assert.equal(memoryCalls, 1);
    timestamp++;
    await Promise.all(Array.from({ length: 20 }, () => resources.admitImage({ width: 100, height: 100 }, 10)));
    assert.equal(memoryCalls, 2); assert.equal(cpuCalls, 2);
    await resources.sample();
    assert.equal(memoryCalls, 3); assert.equal(cpuCalls, 3);
  } finally { resources.close(); }
});
