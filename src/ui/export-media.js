import { createWebpOptimizer } from '../lib/webp-optimizer.js';
import { rasterImageCandidate } from '../lib/raster-image-metadata.js';
import { imagePreparationError } from '../lib/fullhd-image.js';
import { downloadMediaAssets } from './assets.js';
import { downloadDiskMedia } from './download-disk-media.js';

const LOCK = 'thedeshar-exporter-webp';

/** Hold the profile-wide codec slot only while downloading and preparing media. */
export async function downloadExportMedia(candidates, { onWait, onCodecFailure, ...options } = {}, locks = globalThis.navigator?.locks) {
  const { signal } = options;
  if (!candidates.length) return downloadMediaAssets(candidates, options);
  if (signal?.aborted) throw new DOMException('Скачивание отменено.', 'AbortError');

  function downloadWithoutCodec() {
    if (options.spool) return downloadDiskMedia(candidates, { ...options, allowCodec: false, onCodecFailure });
    onCodecFailure?.('unavailable');
    return downloadMediaAssets(candidates, { ...options, deduplicate: true, async optimizeMedia(file) {
      if (await rasterImageCandidate(file.data, file.mimeType)) {
        throw imagePreparationError('image_dimensions_unverified');
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
      if (options.spool) return downloadDiskMedia(candidates, { ...options, onCodecFailure });
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
