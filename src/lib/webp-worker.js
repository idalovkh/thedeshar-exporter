import { inspectRasterImage } from './raster-image-metadata.js';
import { checkDecodeSize, fullHdSize, imagePreparationError, resizeRasterImage } from './fullhd-image.js';

async function loadEncoder() {
  const { createWebpEncoder } = await import('../vendor/webp/encode-png.mjs');
  const response = await fetch(new URL('../vendor/webp/codec.wasm', import.meta.url));
  if (!response.ok) throw new Error('WebP codec unavailable');
  return createWebpEncoder(new Uint8Array(await response.arrayBuffer()));
}

async function sourceCacheKey(blob) {
  const blockBytes = 1024 * 1024;
  const hashes = new Uint8Array(Math.ceil(blob.size / blockBytes) * 32);
  for (let offset = 0; offset < blob.size; offset += blockBytes) {
    const bytes = await blob.slice(offset, offset + blockBytes).arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    hashes.set(new Uint8Array(hash), offset / blockBytes * 32);
  }
  // Only the conversion cache uses a digest of block hashes. ZIP deduplication
  // still uses the SHA-256 of the complete output bytes.
  const key = new Uint8Array(await crypto.subtle.digest('SHA-256', hashes));
  return `${blob.size}:${Array.from(key, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

// The client posts one Blob at a time. Cache only successfully encoded WebP,
// so the worker never retains extra originals or concurrent decode buffers.
export function createWebpEncodingSession({ createEncoder = loadEncoder, resizeRaster = resizeRasterImage, cacheEntries = 16 } = {}) {
  const cached = new Map();
  let encoder;
  const getEncoder = () => encoder ??= createEncoder();
  return async function encodeBlob(blob, mimeType, onProgress) {
    let metadata;
    try {
      metadata = await inspectRasterImage(blob, mimeType);
    } catch {
      throw imagePreparationError('image_dimensions_unverified');
    }
    if (!metadata) return { blob: null };
    const { width, height, orientation } = metadata;
    checkDecodeSize(width, height);
    checkDecodeSize(metadata.decodeWidth ?? width, metadata.decodeHeight ?? height);
    const [displayWidth, displayHeight] = orientation >= 5 ? [height, width] : [width, height];
    const [targetWidth, targetHeight] = fullHdSize(displayWidth, displayHeight);
    const resized = targetWidth !== displayWidth || targetHeight !== displayHeight;
    const source = blob.type === metadata.mimeType ? blob : blob.slice(0, blob.size, metadata.mimeType);
    if (!resized && metadata.mimeType === 'image/webp') return { blob: source, resized: false };
    try {
      const key = cacheEntries > 0 ? await sourceCacheKey(blob) : null;
      if (key && cached.has(key)) return cached.get(key);
      const result = { blob: await resizeRaster(source, metadata, targetWidth, targetHeight,
        (await getEncoder()).encodeRGBA, onProgress), resized };
      if (key && result.blob.size <= 32 * 1024 * 1024) {
        cached.set(key, result);
        while (cached.size > cacheEntries || [...cached.values()].reduce((size, item) => size + item.blob.size, 0) > 32 * 1024 * 1024)
          cached.delete(cached.keys().next().value);
      }
      return result;
    } catch (error) {
      throw error.reason ? error : imagePreparationError('image_webp_failed');
    }
  };
}

if (typeof DedicatedWorkerGlobalScope !== 'undefined' && globalThis instanceof DedicatedWorkerGlobalScope) {
  // Production deduplication lives in the disk pipeline, not in a growing worker cache.
  const encodeBlob = createWebpEncodingSession({ cacheEntries: 0 });
  self.addEventListener('message', async ({ data: { id, blob, mimeType } }) => {
    try {
      const result = await encodeBlob(blob, mimeType, () => self.postMessage({ id, progress: true }));
      self.postMessage({ id, ...result });
    } catch (error) {
      self.postMessage({ id, reason: error.reason || 'image_webp_failed' });
    }
  });
}
