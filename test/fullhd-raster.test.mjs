import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32 } from '../src/lib/archive.js';
import { assertExportFilesReady } from '../src/lib/export-readiness.js';
import { resizeRasterImage } from '../src/lib/fullhd-image.js';
import { createExportPackage, replacePackageAssets } from '../src/lib/package.js';
import { createWebpOptimizer } from '../src/lib/webp-optimizer.js';
import { createWebpEncodingSession } from '../src/lib/webp-worker.js';
import { downloadMediaAssets } from '../src/ui/assets.js';
import { downloadExportMedia } from '../src/ui/export-media.js';

function image(width, height, ImageBlob = Blob, pixelData = Uint8Array.of(0)) {
  const header = Buffer.alloc(25);
  header.writeUInt32BE(13);
  header.write('IHDR', 4);
  header.writeUInt32BE(width, 8);
  header.writeUInt32BE(height, 12);
  header.set([8, 2, 0, 0, 0], 16);
  header.writeUInt32BE(crc32(header.subarray(4, 21)), 21);
  const idat = Buffer.alloc(8);
  idat.writeUInt32BE(pixelData.byteLength);
  idat.write('IDAT', 4);
  // These fixtures exercise metadata and the cache with a stub decoder.
  return new ImageBlob([Buffer.from('89504e470d0a1a0a', 'hex'), header, idat, pixelData,
    Buffer.from('000000000000000049454e44ae426082', 'hex')], { type: 'image/png' });
}

const readyWebp = Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvBwABAAdQsvrXo/+BiOh/AAA=', 'base64');

test('the worker converts in-bounds PNG and only scales images outside Full HD', async () => {
  class StreamOnlyBlob extends Blob {
    arrayBuffer() { assert.fail('the source must be hashed in bounded slices'); }
  }
  const dimensions = [];
  const result = new Blob([new Uint8Array(100)], { type: 'image/webp' });
  const encode = createWebpEncodingSession({
    createEncoder: async () => ({}),
    resizeRaster: async (_blob, _metadata, width, height) => {
      dimensions.push([width, height]);
      return result;
    },
  });
  assert.deepEqual(await encode(image(1920, 1080)), { blob: result, resized: false });
  assert.deepEqual(await encode(image(1080, 1920)), { blob: result, resized: false });
  assert.deepEqual(await encode(image(10427, 5668, StreamOnlyBlob)), { blob: result, resized: true });
  assert.deepEqual(await encode(image(10427, 5668, StreamOnlyBlob)), { blob: result, resized: true });
  assert.deepEqual(dimensions, [[1920, 1080], [1080, 1920], [1920, 1044]]);
  await assert.rejects(encode(image(16000, 16000)), { reason: 'image_dimensions_limit' });
  await assert.rejects(encode(new Blob(['bad image'], { type: 'image/png' })), { reason: 'image_dimensions_unverified' });
  const invalid = new Uint8Array(await image(1, 1).arrayBuffer());
  invalid[29] ^= 1; // IHDR CRC
  await assert.rejects(encode(new Blob([invalid])), { reason: 'image_dimensions_unverified' });
});

test('image conversion cache distinguishes bytes beyond its first block', async () => {
  const blockBytes = 1024 * 1024;
  class BoundedBlob extends Blob {
    arrayBuffer() { assert.fail('the source must be hashed in bounded slices'); }
    slice(start, end, type) {
      assert.ok(end - start <= blockBytes);
      return super.slice(start, end, type);
    }
  }
  let conversions = 0;
  const encode = createWebpEncodingSession({
    createEncoder: async () => ({}),
    resizeRaster: async () => new Blob([Uint8Array.of(++conversions)], { type: 'image/webp' }),
  });
  const pixels = new Uint8Array(blockBytes + 1);
  const first = await encode(image(1920, 1000, BoundedBlob, pixels));
  assert.equal(await encode(image(1920, 1000, BoundedBlob, pixels)), first);
  pixels[blockBytes] = 1;
  const second = await encode(image(1920, 1000, BoundedBlob, pixels));
  assert.notEqual(second, first);
  assert.equal(conversions, 2);
});

test('an in-bounds WebP is preserved byte for byte despite a misleading MIME', async () => {
  const encode = createWebpEncodingSession({
    createEncoder: () => assert.fail('an existing WebP must not create the encoder'),
    resizeRaster: () => assert.fail('an existing WebP must not be decoded for conversion'),
  });
  const original = new Blob([readyWebp], { type: 'image/webp' });
  const mislabeled = original.slice(0, original.size, 'image/jpeg');
  for (const source of [original, mislabeled]) {
    const result = await encode(source);
    assert.equal(result.resized, false);
    assert.equal(result.blob.type, 'image/webp');
    assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), readyWebp);
  }
});

test('the archive records one WebP body and keeps each reference with canonical MIME and name', async () => {
  const assets = [
    { id: 'a', name: 'first.jpeg', url: 'https://cdn.example.org/first.jpeg' },
    { id: 'b', name: 'second.png', url: 'https://cdn.example.org/second.png' },
  ];
  const encode = createWebpEncodingSession();
  class EncodeWorker extends EventTarget {
    async postMessage({ id, blob, mimeType }) {
      const result = await encode(blob, mimeType);
      this.dispatchEvent(new MessageEvent('message', { data: { id, ...result } }));
    }
    terminate() {}
  }
  const optimizer = createWebpOptimizer({ createWorker: () => new EncodeWorker() });
  try {
    const files = await downloadMediaAssets(assets, {
      fetchFile: async url => new Response(readyWebp, {
        headers: { 'content-type': url.endsWith('.jpeg') ? 'image/jpeg' : 'application/octet-stream' },
      }),
      optimizeMedia: optimizer.optimize,
      deduplicate: true,
      maxTotalBytes: readyWebp.length,
    });
    assertExportFilesReady(files, assets);
    const { manifest, entries } = replacePackageAssets(createExportPackage({ assets }), files);
    assert.deepEqual(manifest.inventory.assets.map(({ id, url, name, mimeType, file, size }) =>
      [id, url, name, mimeType, file, size]), [
      ['a', assets[0].url, 'first.webp', 'image/webp', 'media/00001-first.webp', readyWebp.length],
      ['b', assets[1].url, 'second.webp', 'image/webp', 'media/00001-first.webp', readyWebp.length],
    ]);
    assert.deepEqual(entries.filter(entry => entry.name.startsWith('media/')).map(entry => entry.name),
      ['media/00001-first.webp']);
  } finally {
    optimizer.close();
  }
});

test('an animation cannot silently become a still when the decoder exposes only one frame', async t => {
  const originals = [globalThis.OffscreenCanvas, globalThis.ImageDecoder];
  t.after(() => {
    [globalThis.OffscreenCanvas, globalThis.ImageDecoder] = originals;
  });
  let closed = false;
  globalThis.OffscreenCanvas = class {
    getContext() { return {}; }
  };
  globalThis.ImageDecoder = class {
    tracks = { ready: Promise.resolve(), selectedTrack: { animated: false, frameCount: 1 } };
    completed = Promise.resolve();
    async decode() {
      return { complete: true, image: { codedWidth: 2, codedHeight: 2, displayWidth: 2, displayHeight: 2, close() {} } };
    }
    close() { closed = true; }
  };
  const metadata = { mimeType: 'image/gif', animated: true, frameCount: 2, orientation: 1 };
  await assert.rejects(resizeRasterImage(new Blob(), metadata, 2, 2, () => assert.fail('lost animation frames')), {
    reason: 'image_webp_failed',
  });
  assert.equal(closed, true);
});

class WorkerStub extends EventTarget {
  postMessage({ id }) {
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: { id, reason: 'image_webp_failed' } })));
  }
  terminate() {}
}

test('a failed in-bounds conversion is a named missing file and blocks the archive', async () => {
  const source = image(800, 600);
  const asset = { id: 'photo', name: 'page.png', url: 'https://cdn.example.org/page.png' };
  const diagnostics = [];
  const optimizer = createWebpOptimizer({ createWorker: () => new WorkerStub() });
  try {
    const [file] = await downloadMediaAssets([asset], {
      fetchFile: async () => new Response(source, { headers: { 'content-type': source.type } }),
      optimizeMedia: optimizer.optimize,
      onDiagnostic: value => diagnostics.push(value),
    });
    assert.equal(file.name, 'page.png');
    assert.equal(file.status, 'failed');
    assert.match(file.error, /WebP/);
    assert.ok(diagnostics.some(event => event.reason === 'image_webp_failed'));
    assert.throws(() => assertExportFilesReady([file], [asset]), { code: 'incomplete_export' });
  } finally {
    optimizer.close();
  }
});

test('an unavailable profile lock cannot bypass raster validation', async () => {
  const source = image(2000, 1000);
  const asset = { id: 'photo', name: 'page.png', url: 'https://cdn.example.org/page.png' };
  const [file] = await downloadExportMedia([asset], {
    fetchFile: async () => new Response(source, { headers: { 'content-type': source.type } }),
  }, null);
  assert.equal(file.status, 'failed');
  assert.throws(() => assertExportFilesReady([file], [asset]), { code: 'incomplete_export' });
});

test('the worker client accepts a resized WebP larger than the original', async () => {
  class ResizeWorker extends EventTarget {
    postMessage({ id }) {
      const blob = new Blob([new Uint8Array(100)], { type: 'image/webp' });
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: { id, blob, resized: true } })));
    }
    terminate() {}
  }
  const source = image(2000, 1000);
  const optimizer = createWebpOptimizer({ createWorker: () => new ResizeWorker() });
  try {
    const file = await optimizer.optimize({ data: source, mimeType: source.type });
    assert.equal(file.mimeType, 'image/webp');
    assert.ok(file.data.size > source.size);
  } finally {
    optimizer.close();
  }
});
