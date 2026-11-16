import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { createWebpOptimizer } from '../src/lib/webp-optimizer.js';

const webpBlob = new Blob([Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvBwABAAdQsvrXo/+BiOh/AAA=', 'base64')],
  { type: 'image/webp' });

function original(mimeType = 'image/jpeg') {
  // The fake worker only needs a JPEG signature to exercise client routing.
  return { data: new Blob([Uint8Array.of(255, 216, 255)], { type: mimeType }), mimeType };
}

class FakeWorker extends EventTarget {
  posted = [];
  stopped = false;
  postMessage(message) { this.posted.push(message); }
  reply(message) {
    const { id } = this.posted.at(-1);
    this.dispatchEvent(new MessageEvent('message', { data: { id, ...message } }));
  }
  terminate() { this.stopped = true; }
}

async function waitForPosts(worker, count) {
  for (let i = 0; i < 10 && worker.posted.length < count; i++) await setImmediate();
  assert.equal(worker.posted.length, count);
}

test('optimizer sends one raster at a time and accepts a larger WebP at the same resolution', async () => {
  const worker = new FakeWorker();
  const optimizer = createWebpOptimizer({ createWorker: () => worker });
  const a = { ...original(), id: 'first' }, b = original('application/octet-stream');
  const first = optimizer.optimize(a), second = optimizer.optimize(b);
  await waitForPosts(worker, 1);
  assert.equal(worker.posted[0].blob, a.data);
  assert.ok(webpBlob.size > a.data.size);
  worker.reply({ blob: webpBlob, resized: false });
  assert.deepEqual(await first, { data: webpBlob, mimeType: 'image/webp', id: 'first' });
  assert.equal(worker.posted.length, 2);
  assert.equal(worker.posted[1].blob, b.data);
  worker.reply({ blob: webpBlob, resized: false });
  assert.deepEqual(await second, { data: webpBlob, mimeType: 'image/webp' });
  optimizer.close();
  assert.equal(worker.stopped, true);
});

test('optimizer leaves non-raster media alone without starting the codec', async () => {
  const optimizer = createWebpOptimizer({ createWorker: () => assert.fail('non-raster media must bypass the codec') });
  try {
    for (const [bytes, mimeType] of [
      ['<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml'],
      ['%PDF-1.7', 'application/pdf'],
      ['ID3', 'audio/mpeg'],
      ['\0\0\0\x10ftypmp42\0\0\0\0', 'video/mp4'],
    ]) {
      const file = { data: new Blob([bytes], { type: mimeType }), mimeType };
      assert.equal(await optimizer.optimize(file), file);
    }
  } finally {
    optimizer.close();
  }
});

test('aborting the download pool or export terminates the worker and rejects all waiting work', async () => {
  for (const kind of ['pool', 'export']) {
    const worker = new FakeWorker();
    const download = new AbortController(), exportSignal = new AbortController();
    const optimizer = createWebpOptimizer({ createWorker: () => worker, signal: exportSignal.signal });
    const options = { signal: download.signal };
    const a = original(), b = original();
    const stopped = [assert.rejects(optimizer.optimize(a, options), { name: 'AbortError' }),
      assert.rejects(optimizer.optimize(b, options), { name: 'AbortError' })];
    await waitForPosts(worker, 1);
    (kind === 'pool' ? download : exportSignal).abort();
    await Promise.all(stopped);
    await assert.rejects(optimizer.optimize(a, options), { name: 'AbortError' });
    assert.equal(worker.stopped, true);
    assert.equal(worker.posted.length, 1);
  }
});

test('timeouts, startup errors, crashes and missing or invalid output fail the raster', async () => {
  const outputs = {
    codec: { failed: true },
    empty: { blob: new Blob([], { type: 'image/webp' }) },
    unchanged: { blob: null },
    wrongType: { blob: webpBlob.slice(0, webpBlob.size, 'image/jpeg') },
  };
  for (const failure of ['timeout', 'startup', 'event', ...Object.keys(outputs)]) {
    const worker = new FakeWorker(), reasons = [];
    let creations = 0;
    const optimizer = createWebpOptimizer({
      createWorker: () => {
        creations++;
        if (failure === 'startup') throw new Error('CSP');
        return worker;
      },
      timeoutMs: 15, onFailure: reason => reasons.push(reason),
    });
    const a = original(), b = original();
    const reason = failure === 'timeout' ? 'image_webp_timeout' : 'image_webp_failed';
    const first = assert.rejects(optimizer.optimize(a), { reason });
    const second = assert.rejects(optimizer.optimize(b), { reason });
    if (failure !== 'startup') await waitForPosts(worker, 1);
    if (outputs[failure]) worker.reply(outputs[failure]);
    if (failure === 'event') worker.dispatchEvent(new Event('error', { cancelable: true }));
    await Promise.all([first, second]);
    await assert.rejects(optimizer.optimize(b), { reason });
    assert.equal(creations, 1);
    assert.deepEqual(reasons, [failure === 'timeout' ? 'timeout' : 'worker-error']);
    if (failure !== 'startup') assert.equal(worker.stopped, true);
    optimizer.close();
  }
});
