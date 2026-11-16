import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32 } from '../src/lib/archive.js';
import { createWebpEncodingSession } from '../src/lib/webp-worker.js';

function image(width) {
  const header = Buffer.alloc(25);
  header.writeUInt32BE(13); header.write('IHDR', 4); header.writeUInt32BE(width, 8); header.writeUInt32BE(1, 12);
  header.set([8, 2, 0, 0, 0], 16); header.writeUInt32BE(crc32(header.subarray(4, 21)), 21);
  return new Blob([Buffer.from('89504e470d0a1a0a', 'hex'), header,
    Buffer.from('000000014944415400000000000000000049454e44ae426082', 'hex')], { type: 'image/png' });
}

test('worker cache evicts older outputs instead of retaining every converted image', async () => {
  let conversions = 0;
  const encode = createWebpEncodingSession({ cacheEntries: 2, createEncoder: async () => ({}),
    resizeRaster: async () => new Blob([Uint8Array.of(++conversions)], { type: 'image/webp' }) });
  const first = image(1), second = image(2), third = image(3);
  await encode(first); await encode(second); await encode(third);
  await encode(second); assert.equal(conversions, 3, 'recent results may still be reused');
  await encode(first); assert.equal(conversions, 4, 'the oldest output was released');
});

test('production cache-disabled sessions do not keep encoded Blob bodies between jobs', async () => {
  let conversions = 0;
  const encode = createWebpEncodingSession({ cacheEntries: 0, createEncoder: async () => ({}),
    resizeRaster: async () => new Blob([Uint8Array.of(++conversions)], { type: 'image/webp' }) });
  const source = image(1);
  await encode(source); await encode(source);
  assert.equal(conversions, 2);
});
