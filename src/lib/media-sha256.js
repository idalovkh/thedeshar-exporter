import { updateCrc } from './crc32.js';

const BLOCK_BYTES = 1024 * 1024;
const archiveChecksums = new WeakMap();
let hasherModule;

/** Bind both checksums to the exact immutable Blob going into the archive. */
export async function hashArchiveMedia(blob, signal) {
  signal?.throwIfAborted();
  const existing = archiveChecksums.get(blob);
  if (existing) return existing.sha256;
  // Shared modules also load in the background service worker. Only an export
  // page or its dedicated worker asks for a hasher.
  hasherModule ??= import('../vendor/hash-wasm/sha256.umd.min.js').then(() => globalThis.hashwasm.createSHA256);
  const createSHA256 = await hasherModule;
  const hash = await createSHA256();
  signal?.throwIfAborted();
  let crc = 0xffffffff;
  for (let offset = 0; offset < blob.size; offset += BLOCK_BYTES) {
    const end = Math.min(offset + BLOCK_BYTES, blob.size);
    const block = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    signal?.throwIfAborted();
    hash.update(block);
    crc = updateCrc(crc, block);
  }
  const sha256 = hash.digest('hex');
  archiveChecksums.set(blob, { sha256, crc32: (crc ^ 0xffffffff) >>> 0 });
  return sha256;
}

export function archiveMediaCrc32(blob) {
  return archiveChecksums.get(blob)?.crc32;
}
