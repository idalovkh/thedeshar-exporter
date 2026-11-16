import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { archiveMediaCrc32, hashArchiveMedia } from '../src/lib/media-sha256.js';
import { crc32 } from '../src/lib/archive.js';

const BLOCK_BYTES = 1024 * 1024;

test('media SHA-256 reads at most 1 MiB per block and matches the standard digest', async () => {
  const reads = [];
  class ObservedBlob extends Blob {
    arrayBuffer() { assert.fail('must not read the entire file'); }
    slice(start, end) {
      reads.push([start, end]);
      return super.slice(start, end);
    }
  }
  const bytes = Buffer.alloc(BLOCK_BYTES * 2 + 17, 0x91);
  const expected = createHash('sha256').update(bytes).digest('hex');
  assert.equal(await hashArchiveMedia(new ObservedBlob([bytes])), expected);
  assert.deepEqual(reads, [[0, BLOCK_BYTES], [BLOCK_BYTES, BLOCK_BYTES * 2],
    [BLOCK_BYTES * 2, bytes.length]]);
});

test('concurrent media hashes retain independent state', async () => {
  const inputs = [Buffer.alloc(BLOCK_BYTES + 1, 0xab), Buffer.alloc(BLOCK_BYTES + 1, 0x57), Buffer.alloc(0)];
  const actual = await Promise.all(inputs.map(bytes => hashArchiveMedia(new Blob([bytes]))));
  assert.deepEqual(actual, inputs.map(bytes => createHash('sha256').update(bytes).digest('hex')));
});

test('cancellation before or during a read prevents subsequent reads', async () => {
  const controller = new AbortController();
  let reads = 0;
  class AbortingBlob extends Blob {
    slice(start, end) {
      reads++;
      const part = super.slice(start, end);
      return { async arrayBuffer() {
        controller.abort();
        return part.arrayBuffer();
      } };
    }
  }
  const blob = new AbortingBlob([Buffer.alloc(BLOCK_BYTES + 1)]);
  await assert.rejects(hashArchiveMedia(blob, controller.signal), { name: 'AbortError' });
  await assert.rejects(hashArchiveMedia(blob, controller.signal), { name: 'AbortError' });
  assert.equal(reads, 1);
});

test('media SHA-256 propagates file read errors', async () => {
  class UnreadableBlob extends Blob {
    slice() {
      return { arrayBuffer: () => Promise.reject(new DOMException('File unavailable', 'NotReadableError')) };
    }
  }
  await assert.rejects(hashArchiveMedia(new UnreadableBlob(['file'])), { name: 'NotReadableError' });
});

test('one archive read computes SHA-256 and CRC and only publishes after completion', async () => {
  const reads = [];
  const controller = new AbortController();
  let abort = true;
  class CountedBlob extends Blob {
    slice(start, end) {
      reads.push([start, end]);
      if (abort && start === BLOCK_BYTES) controller.abort();
      return super.slice(start, end);
    }
  }
  const bytes = Buffer.alloc(BLOCK_BYTES + 7, 0x9d);
  const blob = new CountedBlob([bytes]);
  await assert.rejects(hashArchiveMedia(blob, controller.signal), { name: 'AbortError' });
  assert.equal(archiveMediaCrc32(blob), undefined);
  reads.length = 0;
  abort = false;
  const hash = createHash('sha256').update(bytes).digest('hex');
  assert.equal(await hashArchiveMedia(blob), hash);
  assert.equal(archiveMediaCrc32(blob), crc32(bytes));
  assert.equal(await hashArchiveMedia(blob), hash);
  assert.equal(archiveMediaCrc32(new Blob([bytes])), undefined);
  assert.deepEqual(reads, [[0, BLOCK_BYTES], [BLOCK_BYTES, bytes.length]]);
});
