import { inspectRasterImage, rasterImageSource } from './raster-image-metadata.js';

/** Retain raw response bytes until source identity is known; prepare only the verified image. */
export async function normalizePngSource(file, diagnostic) {
  const signature = new Uint8Array(await file.data.slice(0, 8).arrayBuffer());
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => signature[index] === byte)) return file;
  const metadata = await inspectRasterImage(file.data, file.mimeType);
  if (!metadata.pngBytes) return file;
  if (diagnostic) Object.assign(diagnostic, { normalization: 'png_trailing_bytes_removed', removedBytes: file.data.size - metadata.pngBytes });
  return { ...file, data: rasterImageSource(file.data, metadata), mimeType: metadata.mimeType };
}
