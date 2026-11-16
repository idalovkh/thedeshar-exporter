import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createWebpEncoder } from '../src/vendor/webp/encode-png.mjs';

async function loadEncoder() {
  return createWebpEncoder(await readFile(new URL('../src/vendor/webp/codec.wasm', import.meta.url)));
}

test('bundled codec produces deterministic lossless WebP and distinguishes all RGBA channels', async () => {
  const { encodeRGBA } = await loadEncoder();
  const pixels = new Uint8ClampedArray([7, 11, 13, 0, 31, 73, 118, 128, 21, 25, 28, 255]);
  const first = encodeRGBA(pixels, 3, 1);
  assert.ok(first);
  const webp = Buffer.from(first);
  assert.equal(webp.toString('ascii', 0, 4), 'RIFF');
  assert.equal(webp.toString('ascii', 8, 16), 'WEBPVP8L');
  assert.deepEqual(encodeRGBA(pixels, 3, 1), first);
  for (const channel of [0, 1, 2, 3]) {
    const changed = pixels.slice();
    changed[channel]++;
    assert.notDeepEqual(encodeRGBA(changed, 3, 1), first);
  }
});

test('lossless RGBA encoding accepts a tiny frame even when the WebP is larger than its pixels', async () => {
  const { encodeRGBA } = await loadEncoder();
  const pixel = new Uint8Array([7, 11, 13, 0]);
  assert.ok(encodeRGBA(pixel, 1, 1)?.length > pixel.length);
});

test('RGBA encoding enforces the oriented Full HD bound and exact byte length', async () => {
  const { encodeRGBA } = await loadEncoder();
  const pixels = new Uint8Array(1920 * 1080 * 4);
  assert.ok(encodeRGBA(pixels, 1920, 1080));
  assert.ok(encodeRGBA(pixels, 1080, 1920));
  assert.equal(encodeRGBA(new Uint8Array(1921 * 4), 1921, 1), null);
  assert.equal(encodeRGBA(new Uint8Array(1081 * 1081 * 4), 1081, 1081), null);
  assert.equal(encodeRGBA(pixels, 1920, 1079), null);
  assert.equal(encodeRGBA(pixels, 1080.5, 1920), null);
  assert.throws(() => encodeRGBA(new Uint16Array(4), 1, 1), TypeError);
  assert.ok(encodeRGBA(new Uint8Array(4), 1, 1));
});
