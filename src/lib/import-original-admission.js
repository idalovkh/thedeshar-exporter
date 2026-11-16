import { fullHdSize } from './fullhd-image.js';

const MAX_BYTES = 100 * 1024 * 1024;
const text = bytes => String.fromCharCode(...bytes);
const u32 = (bytes, offset = 0, little = false) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, little);
const u16 = (bytes, offset = 0) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset);
const read = async (blob, offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());

/** Admission mirrors known importer bounds; malformed compressed data still fails its decoder. */
export async function acceptsImportOriginal(blob, metadata) {
  if (!metadata || blob.size <= 0 || blob.size > MAX_BYTES) return false;
  if (metadata.mimeType === 'image/avif') {
    const header = await read(blob, 0, 16);
    if (header.length !== 16 || text(header.subarray(4, 8)) !== 'ftyp') return false;
    const size = u32(header);
    if (size < 16 || size > Math.min(blob.size, 1024 * 1024) || size % 4) return false;
    const brands = await read(blob, 0, size);
    for (let offset = 8; offset < size; offset += 4) if (offset !== 12 && text(brands.subarray(offset, offset + 4)) === 'avif') return true;
    return false;
  }
  if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(metadata.mimeType)) return false;
  const { width, height, orientation = 1 } = metadata;
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 32768) || width * height > 40_000_000) return false;
  if (!metadata.animated) return true;
  const frames = metadata.frameCount;
  if (!Number.isSafeInteger(frames) || frames < 1 || frames > 500) return false;
  const pixels = width * height * frames;
  if (metadata.mimeType === 'image/gif') return pixels <= 160_000_000;
  if (metadata.mimeType === 'image/webp') {
    const [displayWidth, displayHeight] = orientation >= 5 ? [height, width] : [width, height];
    const fitted = fullHdSize(displayWidth, displayHeight);
    return fitted[0] === displayWidth && fitted[1] === displayHeight || pixels <= 250_000_000;
  }
  if (metadata.mimeType !== 'image/png') return false;
  const depth = (await read(blob, 24, 1))[0];
  if (pixels > (depth === 16 ? 32_000_000 : 64_000_000)) return false;
  for (let offset = 8; offset + 12 <= blob.size;) {
    const header = await read(blob, offset, 8), size = u32(header), kind = text(header.subarray(4));
    if (size > blob.size - offset - 12) return false;
    if (kind === 'acTL') {
      if (size !== 8 || u32(await read(blob, offset + 12, 4)) > 65535) return false;
    }
    if (kind === 'fcTL') {
      if (size !== 26) return false;
      const timing = await read(blob, offset + 28, 4);
      const milliseconds = Math.round(u16(timing) * 1000 / (u16(timing, 2) || 100));
      if (milliseconds > 0xffffff) return false;
    }
    offset += size + 12;
    if (kind === 'IEND') return offset === blob.size;
  }
  return false;
}
