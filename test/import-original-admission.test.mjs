import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptsImportOriginal } from '../src/lib/import-original-admission.js';

const bytes = new Blob(['valid source']);
const metadata = (mimeType, width = 1000, height = 1000, extra = {}) => ({ mimeType, width, height, orientation: 1, animated: false, ...extra });

test('original fallback respects importer dimensions rather than the larger exporter decode limit', async () => {
  for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) {
    assert.equal(await acceptsImportOriginal(bytes, metadata(mime, 8000, 5000)), true);
    assert.equal(await acceptsImportOriginal(bytes, metadata(mime, 8000, 5001)), false);
    assert.equal(await acceptsImportOriginal(bytes, metadata(mime, 32769, 1)), false);
  }
  assert.equal(await acceptsImportOriginal(bytes, null), false);
  assert.equal(await acceptsImportOriginal(bytes, metadata('image/svg+xml')), false);
});

test('animation originals respect actual frame and cumulative-pixel limits', async () => {
  assert.equal(await acceptsImportOriginal(bytes, metadata('image/gif', 1000, 1000, { animated: true, frameCount: 160 })), true);
  assert.equal(await acceptsImportOriginal(bytes, metadata('image/gif', 1000, 1000, { animated: true, frameCount: 161 })), false);
  assert.equal(await acceptsImportOriginal(bytes, metadata('image/webp', 2000, 2000, { animated: true, frameCount: 63 })), false);
  assert.equal(await acceptsImportOriginal(bytes, metadata('image/webp', 100, 100, { animated: true, frameCount: 501 })), false);
});

test('AVIF originals require the complete 32-bit ftyp avif brand recognized by the importer', async () => {
  const ftyp = brand => new Blob([Uint8Array.from([0, 0, 0, 20]), 'ftyp', brand, new Uint8Array(4), 'mif1']);
  assert.equal(await acceptsImportOriginal(ftyp('avif'), metadata('image/avif', 10000, 10000)), true);
  assert.equal(await acceptsImportOriginal(ftyp('avis'), metadata('image/avif')), false);
  assert.equal(await acceptsImportOriginal(new Blob(['incomplete']), metadata('image/avif')), false);
});
