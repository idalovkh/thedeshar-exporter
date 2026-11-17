import { createWebpOptimizer } from '../lib/webp-optimizer.js';
import { inspectRasterImage, rasterImageSource } from '../lib/raster-image-metadata.js';
import { acceptsImportOriginal } from '../lib/import-original-admission.js';
import { imagePreparationError } from '../lib/fullhd-image.js';
import { downloadMediaAssets } from './assets.js';
import { downloadDiskMedia } from './download-disk-media.js';
import { createPreparedMediaCache } from '../lib/prepared-media-cache.js';

const LOCK = 'thedeshar-exporter-webp';

/** Hold the profile-wide codec slot only while downloading and preparing media. */
export async function downloadExportMedia(candidates, { onWait, onCodecFailure, ...options } = {}, locks = globalThis.navigator?.locks) {
  const { signal } = options;
  if (!candidates.length) return downloadMediaAssets(candidates, options);
  if (signal?.aborted) throw new DOMException('Скачивание отменено.', 'AbortError');

  async function diskMedia(allowCodec = true) {
    let cache = options.mediaCache;
    const ownsCache = cache === undefined;
    if (ownsCache) try { cache = await createPreparedMediaCache({ signal, locks }); }
    catch (error) { if (signal?.aborted) throw error; }
    try { return await downloadDiskMedia(candidates, { ...options, mediaCache: cache, allowCodec, onCodecFailure }); }
    finally { if (ownsCache) try { await cache?.close(); } catch { /* Optional cache cleanup cannot fail a valid export. */ } }
  }

  function downloadWithoutCodec() {
    if (options.spool) return diskMedia(false);
    onCodecFailure?.('unavailable');
    return downloadMediaAssets(candidates, { ...options, deduplicate: true, async optimizeMedia(file) {
      const metadata = await inspectRasterImage(file.data, file.mimeType);
      if (metadata) {
        const data = rasterImageSource(file.data, metadata);
        if (!await acceptsImportOriginal(data, metadata)) throw imagePreparationError('image_dimensions_limit');
        return { ...file, data, mimeType: metadata.mimeType, originalImage: true };
      }
      return file;
    } });
  }

  if (!locks) return downloadWithoutCodec();
  let acquired = false;
  try {
    onWait?.();
    return await locks.request(LOCK, { mode: 'exclusive', ...(signal ? { signal } : {}) }, async () => {
      acquired = true;
      if (options.spool) return diskMedia();
      const optimizer = createWebpOptimizer({ signal, onFailure: onCodecFailure });
      try {
        return await downloadMediaAssets(candidates, { ...options, deduplicate: true, optimizeMedia: optimizer.optimize });
      } finally { optimizer.close(); }
    });
  } catch (error) {
    if (acquired || error.name === 'AbortError' || signal?.aborted) throw error;
    return downloadWithoutCodec();
  }
}
