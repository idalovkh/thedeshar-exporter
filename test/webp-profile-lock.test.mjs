import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadExportMedia } from '../src/ui/export-media.js';

const asset = { id: 'asset-1', url: 'https://cdn.example.org/audio.mp3', name: 'audio.mp3' };
const audio = () => new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'audio/mpeg' } });

test('the codec slot covers the media stage and waiting does not start downloads', async () => {
  const controller = new AbortController();
  let acquire, calls = 0, held = false;
  const locks = {
    request(name, options, run) {
      assert.equal(name, 'thedeshar-exporter-webp');
      assert.equal(options.mode, 'exclusive');
      assert.equal(options.signal, controller.signal);
      return new Promise(resolve => { acquire = resolve; }).then(async () => {
        held = true;
        try { return await run(); } finally { held = false; }
      });
    },
  };
  const result = downloadExportMedia([asset], {
    signal: controller.signal,
    fetchFile: async () => { assert.ok(held); calls++; return audio(); },
  }, locks);
  assert.equal(calls, 0);
  acquire();
  assert.equal((await result)[0].status, 'downloaded');
  assert.equal(calls, 1);
  assert.equal(held, false);
});

test('a canceled lock wait never starts downloading or silently falls back', async () => {
  const controller = new AbortController();
  const locks = { request(_name, { signal }) {
    return new Promise((_, reject) => signal.addEventListener('abort', () => {
      reject(new DOMException('cancelled', 'AbortError'));
    }, { once: true }));
  } };
  const result = downloadExportMedia([asset], {
    signal: controller.signal,
    fetchFile: () => assert.fail('canceled wait must not download'),
    onCodecFailure: () => assert.fail('canceled wait is not a codec failure'),
  }, locks);
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
});
