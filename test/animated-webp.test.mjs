import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAnimatedWebp } from '../src/lib/animated-webp.js';

// Lossless 2 × 2 WebP images. The first has both fully and partly transparent pixels.
const transparent = Buffer.from('UklGRkAAAABXRUJQVlA4TDMAAAAvAUAAEB+gpm0DNvSmi0sVtZECx/aEL1IgyLZNCWy7ywUChFlVYkVWdkzm/+EHCBH9jwAA', 'base64');
const opaque = Buffer.from('UklGRjYAAABXRUJQVlA4TCoAAAAvAUAAAB8gpiFjn7kloZBtBDi1exAO5IQEZMoD2Q3zH6UMVn/4AUJE/yM=', 'base64');

async function readAnimation(blob) {
  assert.equal(blob.type, 'image/webp');
  const bytes = Buffer.from(await blob.arrayBuffer());
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.readUInt32LE(4), bytes.length - 8);
  assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
  const chunks = [];
  for (let offset = 12; offset < bytes.length;) {
    const length = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + length;
    assert.ok(end <= bytes.length);
    chunks.push([bytes.toString('ascii', offset, offset + 4), bytes.subarray(offset + 8, end)]);
    offset = end + (length & 1);
  }
  const [[extended, flags], [animation, parameters], ...frames] = chunks;
  assert.equal(extended, 'VP8X');
  assert.equal(flags.length, 10);
  assert.equal(animation, 'ANIM');
  assert.equal(parameters.length, 6);
  assert.equal(parameters.readUInt32LE(0), 0);
  return {
    flags: flags[0], width: flags.readUIntLE(4, 3) + 1, height: flags.readUIntLE(7, 3) + 1,
    loops: parameters.readUInt16LE(4), frames,
  };
}

test('writes full lossless frames with transparency, order, and cumulative timing', async () => {
  const encoder = createAnimatedWebp(2, 2, 3);
  const originals = [transparent, opaque, transparent];
  for (const image of originals) encoder.addFrame(image, 40_500);
  const { flags, width, height, loops, frames } = await readAnimation(encoder.finish());
  assert.deepEqual({ flags, width, height, loops }, { flags: 0x12, width: 2, height: 2, loops: 4 });
  assert.equal(frames.length, originals.length);
  frames.forEach(([type, data], index) => {
    assert.equal(type, 'ANMF');
    assert.deepEqual(data.subarray(0, 6), Buffer.alloc(6));
    assert.equal(data.readUIntLE(6, 3) + 1, width);
    assert.equal(data.readUIntLE(9, 3) + 1, height);
    assert.equal(data.readUIntLE(12, 3), [41, 40, 41][index]);
    assert.equal(data[15], 2, 'transparent pixels must replace the previous frame');
    assert.deepEqual(data.subarray(16), originals[index].subarray(12));
  });
});

test('represents a single frame and maps play-once and infinite loops', async () => {
  for (const [repetitions, loops] of [[0, 1], [Infinity, 0], [65_534, 65_535]]) {
    const encoder = createAnimatedWebp(2, 2, repetitions);
    encoder.addFrame(opaque, 0);
    const result = await readAnimation(encoder.finish());
    assert.equal(result.loops, loops);
    assert.equal(result.flags, 2);
    assert.equal(result.frames.length, 1);
    assert.equal(result.frames[0][1].readUIntLE(12, 3), 0);
  }
});

test('checks the exact output budget and rejects unrepresentable or invalid frames', () => {
  const length = 44 + 24 + opaque.length - 12;
  const limited = createAnimatedWebp(2, 2, 0, { maxBytes: length });
  assert.throws(() => limited.finish(), /frame/i);
  assert.throws(() => limited.addFrame(opaque.subarray(0, -1), 1000), /lossless/i);
  assert.throws(() => limited.addFrame(opaque, 0x1000000 * 1000), /duration/i);
  assert.throws(() => createAnimatedWebp(1, 2, 0).addFrame(opaque, 1000), /dimensions/i);
  assert.throws(() => createAnimatedWebp(2, 2, 65535), /repeat/i);
  assert.throws(() => createAnimatedWebp(2, 2, 0, { maxBytes: length - 1 }).addFrame(opaque, 1000), /size/i);
  limited.addFrame(opaque, 1000);
  assert.throws(() => limited.addFrame(opaque, 1000), /size/i);
  assert.equal(limited.finish().size, length);
});
