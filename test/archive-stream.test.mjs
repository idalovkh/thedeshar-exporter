import assert from 'node:assert/strict';
import test from 'node:test';
import { buildZipBlob } from '../src/lib/archive.js';
import { writeZipFile } from '../src/lib/archive-stream.js';

function destination({ failWrite = false, failClose = false, corrupt = false } = {}) {
  let output = new Uint8Array(), at = 0;
  const state = { closed: false, aborted: false, largestWrite: 0 };
  return { state, async getFile() { const bytes = output.slice(); if (corrupt && bytes.length > 40) bytes[40] ^= 1; return new Blob([bytes]); },
    async createWritable() { return {
      async write(input) {
        if (failWrite) throw Error('Disk full');
        const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
        state.largestWrite = Math.max(state.largestWrite, bytes.length);
        if (output.length < at + bytes.length) { const grown = new Uint8Array(at + bytes.length); grown.set(output); output = grown; }
        output.set(bytes, at); at += bytes.length;
      },
      async seek(position) { at = position; },
      async close() { if (failClose) throw Error('Cannot commit file'); state.closed = true; },
      async abort() { state.aborted = true; },
    }; },
  };
}

test('streamed ZIP matches the existing format and never writes a whole media file at once', async () => {
  class DiskFile extends Blob { async arrayBuffer() { throw Error('Whole-file allocation is forbidden'); } }
  const entries = [{ name: 'manifest.json', data: '{"format":"test"}' },
    { name: 'media/озвучивание.mp3', data: new DiskFile([new Uint8Array(2 * 1024 * 1024 + 3).fill(17)]) }];
  const handle = destination();
  const progress = [];
  const result = await writeZipFile(entries, handle, { onProgress: event => progress.push(event) });
  assert.equal(handle.state.closed, true);
  assert.ok(handle.state.largestWrite <= 1024 * 1024);
  assert.equal(result.entries, 2);
  assert.deepEqual(new Uint8Array(await (await handle.getFile()).arrayBuffer()), new Uint8Array(await (await buildZipBlob(entries)).arrayBuffer()));
  assert.equal(progress.at(-1).verifying, true);
  assert.equal(progress.at(-1).loaded, result.size);
});

test('write, close, cancellation and readback corruption never report success', async () => {
  const entries = [{ name: 'media/test.bin', data: new Blob(['verified bytes']) }];
  for (const settings of [{ failWrite: true }, { failClose: true }]) {
    const handle = destination(settings);
    await assert.rejects(writeZipFile(entries, handle), error => error.code === 'zip_write' && /Disk full|Cannot commit/.test(error.cause.message));
    assert.equal(handle.state.aborted, true);
  }
  const corrupt = destination({ corrupt: true });
  await assert.rejects(writeZipFile(entries, corrupt), { code: 'zip_verification' });
  const controller = new AbortController();
  const handle = destination();
  await assert.rejects(writeZipFile(entries, handle, { signal: controller.signal, onProgress() { controller.abort(); } }), { name: 'AbortError' });
  assert.equal(handle.state.aborted, true);
});

test('oversized and unsafe archives fail before opening the destination', async () => {
  let opened = false;
  const handle = { createWritable() { opened = true; }, getFile() {} };
  await assert.rejects(writeZipFile([{ name: '../secret', data: '' }], handle));
  await assert.rejects(writeZipFile([{ name: 'media/a', data: new Blob(['123456']) }], handle, { maxBytes: 20 }), { code: 'archive_limit' });
  assert.equal(opened, false);
});

test('manifest references and exact media sizes are validated before opening the destination', async () => {
  let opened = false;
  const handle = { createWritable() { opened = true; }, getFile() {} };
  for (const assets of [[{ status: 'downloaded', file: 'media/missing', size: 5 }],
    [{ status: 'downloaded', file: 'media/a', size: 6 }], [{ status: 'failed', file: 'media/a' }]]) {
    await assert.rejects(writeZipFile([{ name: 'media/a', data: new Blob(['12345']) }], handle, {
      manifest: { inventory: { pages: [], responses: [], assets } },
    }), { code: 'zip_verification' });
  }
  assert.equal(opened, false);
});
