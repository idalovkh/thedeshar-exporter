import { crc32 } from './archive.js';
import { createPngStreamValidator } from './png-stream-validator.js';

const PNG = [137, 80, 78, 71, 13, 10, 26, 10];
const RASTER_TYPES = new Set(['image/png', 'image/apng', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);
const PREFIX_BYTES = 32;
const READ_WINDOW = 4096;
const FTYP_LIMIT = 1024 * 1024;

const text = (bytes, offset, size) => String.fromCharCode(...bytes.subarray(offset, offset + size));
const matches = (bytes, signature) => signature.every((value, index) => bytes[index] === value);
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const u16 = (bytes, offset, little = false) => view(bytes).getUint16(offset, little);
const u32 = (bytes, offset, little = false) => view(bytes).getUint32(offset, little);
const u24le = (bytes, offset) => bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16;
const invalid = () => Object.assign(new Error('Не удалось определить размеры изображения.'), { reason: 'image_dimensions_invalid' });

function requireMetadata(condition) {
  if (!condition) throw invalid();
}

function dimensions(width, height) {
  requireMetadata(width > 0 && height > 0);
  return { width, height };
}

// Most payloads (including PNG IDAT and BMFF mdat) can be skipped by offset.
// Keep a small window for consecutive headers without holding an image in memory.
function blobReader(blob) {
  let window = new Uint8Array(), start = 0;
  return async (offset, length) => {
    requireMetadata(offset >= 0 && length >= 0 && length <= blob.size - offset);
    if (offset < start || offset + length > start + window.length) {
      start = offset;
      const end = Math.min(blob.size, start + Math.max(READ_WINDOW, length));
      window = new Uint8Array(await blob.slice(start, end).arrayBuffer());
    }
    return window.subarray(offset - start, offset - start + length);
  };
}

async function sniff(blob) {
  const prefix = new Uint8Array(await blob.slice(0, Math.min(PREFIX_BYTES, blob.size)).arrayBuffer());
  if (matches(prefix, PNG)) return 'image/png';
  if (matches(prefix, [255, 216, 255])) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(text(prefix, 0, 6))) return 'image/gif';
  if (text(prefix, 0, 4) === 'RIFF' && text(prefix, 8, 4) === 'WEBP') return 'image/webp';
  if (text(prefix, 4, 4) !== 'ftyp') return null;
  const size = u32(prefix, 0);
  const brandOffset = size === 1 ? 16 : 8;
  const brands = bytes => {
    for (let offset = brandOffset; offset + 4 <= bytes.length; offset += 4) {
      if (offset !== brandOffset + 4 && ['avif', 'avis'].includes(text(bytes, offset, 4))) return true;
    }
    return false;
  };
  // Detect a declared AVIF brand even in a malformed ftyp so it cannot bypass
  // the dimensions check. Read compatible brands only within the ftyp box.
  if (brands(prefix.subarray(0, size >= 16 ? size : brandOffset + 4))) return 'image/avif';
  const end = size === 1 && prefix.length >= 16 ? u32(prefix, 12) : size;
  if (end <= prefix.length || end > FTYP_LIMIT || end > blob.size || end % 4) return null;
  if (size === 1 && u32(prefix, 8) !== 0) return null;
  return brands(new Uint8Array(await blob.slice(0, end).arrayBuffer())) ? 'image/avif' : null;
}

export async function rasterImageCandidate(blob, mimeType = blob.type) {
  return RASTER_TYPES.has(mimeType) || Boolean(await sniff(blob));
}

// Orientation lives in TIFF IFD0. Read the exact entry rather than retaining
// unrelated EXIF data, which can include large thumbnails or maker notes.
async function exifOrientation(read, start, end) {
  if (end - start < 8) return 1;
  const header = await read(start, 8);
  const order = text(header, 0, 2);
  if (order !== 'II' && order !== 'MM') return 1;
  const little = order === 'II';
  if (u16(header, 2, little) !== 42) return 1;
  const directory = start + u32(header, 4, little);
  if (directory < start + 8 || directory + 2 > end) return 1;
  const entries = u16(await read(directory, 2), 0, little);
  if (directory + 2 + entries * 12 > end) return 1;
  for (let index = 0; index < entries; index++) {
    const entry = await read(directory + 2 + index * 12, 12);
    if (u16(entry, 0, little) !== 0x112) continue;
    if (u16(entry, 2, little) !== 3 || u32(entry, 4, little) !== 1) return 1;
    const orientation = u16(entry, 8, little);
    return orientation >= 1 && orientation <= 8 ? orientation : 1;
  }
  return 1;
}

async function pngMetadata(read, size) {
  const header = await read(8, 25);
  requireMetadata(u32(header, 0) === 13 && text(header, 4, 4) === 'IHDR' &&
    crc32(header.subarray(4, 21)) === u32(header, 21));
  const image = dimensions(u32(header, 8), u32(header, 12));
  requireMetadata(image.width <= 0x7fffffff && image.height <= 0x7fffffff);
  const validDepths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  requireMetadata(validDepths[header[17]]?.includes(header[16]) && header[18] === 0 && header[19] === 0 && header[20] <= 1);
  let orientation = 1, orientationChunk, frameCount = 0, frames = 0, hasImage = false;
  for (let offset = 33; offset < size;) {
    const chunk = await read(offset, 8);
    const length = u32(chunk, 0);
    const type = text(chunk, 4, 4);
    const data = offset + 8;
    offset = data + length + 4;
    requireMetadata(length <= 0x7fffffff && offset <= size);
    if (type === 'eXIf') {
      requireMetadata(!orientationChunk);
      orientation = await exifOrientation(read, data, data + length);
      orientationChunk = [data - 8, offset];
    }
    if (type === 'IDAT' && length > 0) hasImage = true;
    if (type === 'acTL') {
      requireMetadata(length === 8 && !hasImage && !frameCount);
      frameCount = u32(await read(data, 4), 0);
      requireMetadata(frameCount > 0);
    }
    if (type === 'fcTL') {
      requireMetadata(length === 26 && ++frames <= frameCount);
      const frame = await read(data, 20);
      const frameSize = dimensions(u32(frame, 4), u32(frame, 8));
      requireMetadata(u32(frame, 12) + frameSize.width <= image.width && u32(frame, 16) + frameSize.height <= image.height);
    }
    if (type === 'IEND') {
      requireMetadata(hasImage && length === 0 && frames === frameCount);
      return { ...image, orientation, animated: frameCount > 0, ...(frameCount ? { frameCount } : {}),
        ...(offset < size ? { pngBytes: offset } : {}),
        ...(orientation !== 1 ? { orientationChunk } : {}) };
    }
  }
  throw invalid();
}

const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

async function jpegMetadata(read, size) {
  let image, orientation = 1;
  for (let offset = 2; offset < size;) {
    requireMetadata((await read(offset++, 1))[0] === 0xff);
    let marker;
    do { marker = (await read(offset++, 1))[0]; } while (marker === 0xff);
    if (marker === 1) continue; // TEM is the only standalone marker allowed here.
    requireMetadata(marker >= 0xc0 && marker !== 0xd8 && marker !== 0xd9);
    const length = u16(await read(offset, 2), 0);
    const data = offset + 2;
    offset += length;
    requireMetadata(length >= 2 && offset <= size);
    if (marker === 0xda) {
      requireMetadata(image && length >= 6);
      return { ...image, orientation, animated: false };
    }
    if (marker === 0xe1 && length >= 16 && text(await read(data, 6), 0, 6) === 'Exif\0\0') {
      orientation = await exifOrientation(read, data + 6, offset);
    }
    if (JPEG_FRAMES.has(marker)) {
      requireMetadata(!image && length >= 11);
      const frame = await read(data, 6);
      requireMetadata(frame[5] > 0 && length === 8 + 3 * frame[5]);
      image = dimensions(u16(frame, 3), u16(frame, 1));
    }
  }
  throw invalid();
}

async function gifMetadata(read, size) {
  const header = await read(0, 13);
  const image = dimensions(u16(header, 6, true), u16(header, 8, true));
  const colorTable = flags => flags & 0x80 ? 3 * (2 << (flags & 7)) : 0;
  let offset = 13 + colorTable(header[10]), frames = 0;
  while (offset < size) {
    const marker = (await read(offset++, 1))[0];
    if (marker === 0x3b) {
      requireMetadata(frames > 0);
      return { ...image, orientation: 1, animated: frames > 1, ...(frames > 1 ? { frameCount: frames } : {}) };
    }
    if (marker === 0x2c) {
      const frame = await read(offset, 9);
      const frameSize = dimensions(u16(frame, 4, true), u16(frame, 6, true));
      requireMetadata(u16(frame, 0, true) + frameSize.width <= image.width && u16(frame, 2, true) + frameSize.height <= image.height);
      offset += 9 + colorTable(frame[8]);
      const minCodeSize = (await read(offset++, 1))[0];
      requireMetadata(minCodeSize >= 2 && minCodeSize <= 8);
      frames++;
    } else if (marker === 0x21) {
      offset++; // Extension label, followed by the same sequence of sub-blocks.
    } else {
      throw invalid();
    }
    let length;
    do {
      length = (await read(offset++, 1))[0];
      offset += length;
    } while (length > 0);
  }
  throw invalid();
}

async function webpFrameSize(read, type, offset, length) {
  if (type === 'VP8L') {
    requireMetadata(length >= 5);
    const frame = await read(offset, 5);
    const flags = u32(frame, 1, true);
    requireMetadata(frame[0] === 0x2f && flags >>> 29 === 0);
    return dimensions(1 + (flags & 0x3fff), 1 + ((flags >>> 14) & 0x3fff));
  }
  requireMetadata(length >= 10);
  const frame = await read(offset, 10);
  requireMetadata((frame[0] & 1) === 0 && frame[3] === 0x9d && frame[4] === 1 && frame[5] === 0x2a);
  return dimensions(u16(frame, 6, true) & 0x3fff, u16(frame, 8, true) & 0x3fff);
}

async function webpChunk(read, offset, end) {
  requireMetadata(offset + 8 <= end);
  const chunk = await read(offset, 8);
  const length = u32(chunk, 4, true);
  const data = offset + 8;
  const next = data + length + (length & 1);
  requireMetadata(next <= end);
  return { type: text(chunk, 0, 4), data, length, next };
}

async function webpMetadata(read, size) {
  const header = await read(0, 12);
  const end = u32(header, 4, true) + 8;
  requireMetadata(end <= size && end >= 20);
  let image, encoded, frames = 0, orientation = 1, animated = false, hasAnimationHeader = false;
  for (let offset = 12; offset < end;) {
    const { type, data, length, next } = await webpChunk(read, offset, end);
    offset = next;
    if (type === 'VP8X') {
      requireMetadata(data === 20 && length === 10);
      const canvas = await read(data, 10);
      image = dimensions(1 + u24le(canvas, 4), 1 + u24le(canvas, 7));
      animated = Boolean(canvas[0] & 2);
    } else if (type === 'VP8 ' || type === 'VP8L') {
      requireMetadata(!encoded && !animated);
      encoded = await webpFrameSize(read, type, data, length);
    } else if (type === 'EXIF') {
      const prefix = await read(data, Math.min(6, length));
      orientation = await exifOrientation(read, data + (text(prefix, 0, 6) === 'Exif\0\0' ? 6 : 0), data + length);
    } else if (type === 'ANIM') {
      requireMetadata(animated && !hasAnimationHeader && length === 6);
      hasAnimationHeader = true;
    } else if (type === 'ANMF') {
      requireMetadata(hasAnimationHeader && length >= 24);
      const frame = await read(data, 16);
      const frameSize = dimensions(1 + u24le(frame, 6), 1 + u24le(frame, 9));
      requireMetadata(2 * u24le(frame, 0) + frameSize.width <= image.width && 2 * u24le(frame, 3) + frameSize.height <= image.height);
      let frameEncoded;
      for (let at = data + 16; at < data + length;) {
        const part = await webpChunk(read, at, data + length);
        at = part.next;
        if (part.type === 'VP8 ' || part.type === 'VP8L') {
          requireMetadata(!frameEncoded);
          frameEncoded = await webpFrameSize(read, part.type, part.data, part.length);
        }
      }
      requireMetadata(frameEncoded?.width === frameSize.width && frameEncoded.height === frameSize.height);
      frames++;
    }
  }
  if (animated) requireMetadata(frames > 0);
  else requireMetadata(encoded && (!image || (encoded.width === image.width && encoded.height === image.height)));
  return { ...(image ?? encoded), orientation, animated, ...(animated ? { frameCount: frames } : {}) };
}

async function* boxes(read, offset, end) {
  while (offset < end) {
    requireMetadata(offset + 8 <= end);
    const header = await read(offset, 8);
    const type = text(header, 4, 4);
    let length = u32(header, 0), data = offset + 8;
    if (length === 1) {
      requireMetadata(data + 8 <= end);
      const extended = await read(data, 8);
      requireMetadata(u32(extended, 0) === 0); // The download limit is below 4 GiB.
      length = u32(extended, 4);
      data += 8;
    } else if (length === 0) {
      length = end - offset;
    }
    const next = offset + length;
    requireMetadata(next >= data && next <= end);
    yield { type, data, end: next };
    offset = next;
  }
}

async function boxBytes(read, box, offset, length) {
  requireMetadata(offset + length <= box.end - box.data);
  return read(box.data + offset, length);
}

function avifOrientation(rotation = 0, mirror) {
  requireMetadata(rotation <= 3 && (mirror === undefined || mirror <= 1));
  // HEIF applies counterclockwise rotation and then mirrors the rotated image.
  return mirror === undefined ? [1, 8, 3, 6][rotation]
    : (mirror === 0 ? [4, 5, 2, 7] : [2, 7, 4, 5])[rotation];
}

function avifDisplaySize(coded, aperture) {
  if (!aperture) return coded;
  const data = view(aperture);
  const fraction = offset => {
    const denominator = data.getUint32(offset + 4);
    requireMetadata(denominator > 0 && denominator <= 0x7fffffff);
    return data.getInt32(offset) / denominator;
  };
  const width = fraction(0), height = fraction(8);
  requireMetadata(Number.isInteger(width) && Number.isInteger(height) && width <= coded.width && height <= coded.height);
  // Chromium applies only clean apertures anchored at (0, 0). Do not accept
  // a conflicting visible size for other or malformed clean apertures.
  requireMetadata(fraction(16) === (width - coded.width) / 2 && fraction(24) === (height - coded.height) / 2);
  return dimensions(width, height);
}

async function avifPrimary(read, meta) {
  let itemId, itemProperties;
  for await (const box of boxes(read, meta.data + 4, meta.end)) {
    if (box.type === 'pitm') {
      const version = (await boxBytes(read, box, 0, 4))[0];
      requireMetadata(version <= 1);
      itemId = version === 0 ? u16(await boxBytes(read, box, 4, 2), 0) : u32(await boxBytes(read, box, 4, 4), 0);
    }
    if (box.type === 'iprp') itemProperties = box;
  }
  if (!itemId) return null;
  requireMetadata(itemProperties);
  let properties = [null];
  const links = [];
  for await (const box of boxes(read, itemProperties.data, itemProperties.end)) {
    if (box.type === 'ipco') {
      requireMetadata(properties.length === 1);
      for await (const property of boxes(read, box.data, box.end)) {
        requireMetadata(properties.length <= 0x7fff);
        if (property.type === 'ispe') {
          const extent = await boxBytes(read, property, 0, 12);
          requireMetadata(u32(extent, 0) === 0);
          properties.push(dimensions(u32(extent, 4), u32(extent, 8)));
        } else if (property.type === 'clap') {
          properties.push({ aperture: await boxBytes(read, property, 0, 32) });
        } else if (property.type === 'irot' || property.type === 'imir') {
          properties.push({ [property.type]: (await boxBytes(read, property, 0, 1))[0] });
        } else {
          properties.push(null);
        }
      }
    } else if (box.type === 'ipma') {
      links.push(box);
    }
  }
  let image, rotation, mirror, aperture;
  for (const link of links) {
    const header = await boxBytes(read, link, 0, 8);
    const version = header[0], wide = header[3] & 1, count = u32(header, 4);
    requireMetadata(version <= 1);
    const idLength = version === 0 ? 2 : 4;
    let at = 8;
    for (let entry = 0; entry < count; entry++) {
      const association = await boxBytes(read, link, at, idLength + 1);
      const id = version === 0 ? u16(association, 0) : u32(association, 0);
      const associationCount = association[idLength];
      at += idLength + 1;
      const length = associationCount * (wide ? 2 : 1);
      requireMetadata(link.data + at + length <= link.end);
      if (id === itemId) {
        const indices = await boxBytes(read, link, at, length);
        for (let offset = 0; offset < length; offset += wide ? 2 : 1) {
          const index = wide ? u16(indices, offset) & 0x7fff : indices[offset] & 0x7f;
          requireMetadata(index < properties.length);
          const property = properties[index];
          if (property?.width) {
            requireMetadata(!image || (image.width === property.width && image.height === property.height));
            image = property;
          }
          if (property?.irot !== undefined) rotation = property.irot;
          if (property?.imir !== undefined) mirror = property.imir;
          if (property?.aperture) {
            requireMetadata(!aperture);
            aperture = property.aperture;
          }
        }
      }
      at += length;
    }
  }
  requireMetadata(image);
  return { ...avifDisplaySize(image, aperture), orientation: avifOrientation(rotation, mirror),
    coded: properties.filter(property => property?.width) };
}

async function childBox(read, parent, type) {
  for await (const box of boxes(read, parent.data, parent.end)) {
    if (box.type === type) return box;
  }
  return null;
}

async function avifTracks(read, movie) {
  const images = [];
  for await (const track of boxes(read, movie.data, movie.end)) {
    if (track.type !== 'trak') continue;
    const media = await childBox(read, track, 'mdia');
    const handler = media && await childBox(read, media, 'hdlr');
    if (!handler) continue;
    const type = text(await boxBytes(read, handler, 8, 4), 0, 4);
    if (type !== 'pict' && type !== 'vide' && type !== 'auxv') continue;
    const trackHeader = await childBox(read, track, 'tkhd');
    requireMetadata(trackHeader);
    const version = (await boxBytes(read, trackHeader, 0, 4))[0];
    requireMetadata(version <= 1);
    const trackId = u32(await boxBytes(read, trackHeader, version === 0 ? 12 : 20, 4), 0);
    const trackSize = await boxBytes(read, trackHeader, version === 0 ? 76 : 88, 8);
    const trackDimensions = dimensions(u32(trackSize, 0) >>> 16, u32(trackSize, 4) >>> 16);
    const info = await childBox(read, media, 'minf');
    const table = info && await childBox(read, info, 'stbl');
    const descriptions = table && await childBox(read, table, 'stsd');
    requireMetadata(descriptions);
    const offsets = await childBox(read, table, 'stco') ?? await childBox(read, table, 'co64');
    const references = await childBox(read, track, 'tref');
    const auxiliary = references && await childBox(read, references, 'auxl');
    if (auxiliary) requireMetadata(u32(await boxBytes(read, auxiliary, 0, 4), 0) !== 0);
    const chunkCount = offsets ? u32(await boxBytes(read, offsets, 4, 4), 0) : 0;
    if (offsets) requireMetadata(chunkCount * (offsets.type === 'co64' ? 8 : 4) <= offsets.end - offsets.data - 8);
    // Chromium selects the first populated AV1 track without an auxiliary
    // reference. Some older sequences use 'vide' for the color track.
    const primary = trackId !== 0 && chunkCount > 0 && !auxiliary;
    const sizes = primary && (await childBox(read, table, 'stsz') ?? await childBox(read, table, 'stz2'));
    const frameCount = sizes ? u32(await boxBytes(read, sizes, 8, 4), 0) : undefined;
    if (sizes) requireMetadata(frameCount > 0);
    for await (const sample of boxes(read, descriptions.data + 8, descriptions.end)) {
      if (sample.type !== 'av01') continue;
      const size = await boxBytes(read, sample, 24, 4);
      const sampleDimensions = dimensions(u16(size, 0), u16(size, 2));
      let rotation, mirror, aperture;
      for await (const property of boxes(read, sample.data + 78, sample.end)) {
        if (property.type === 'irot') rotation = (await boxBytes(read, property, 0, 1))[0];
        if (property.type === 'imir') mirror = (await boxBytes(read, property, 0, 1))[0];
        if (property.type === 'clap') {
          requireMetadata(!aperture);
          aperture = await boxBytes(read, property, 0, 32);
        }
      }
      images.push({ ...avifDisplaySize(trackDimensions, aperture), primary, frameCount,
        orientation: avifOrientation(rotation, mirror), coded: [trackDimensions, sampleDimensions] });
    }
  }
  return images;
}

async function avifMetadata(read, size) {
  let still, tracks = [], sequenceBrand = false, hasFileType = false;
  for await (const box of boxes(read, 0, size)) {
    if (box.type === 'ftyp') {
      requireMetadata(!hasFileType && box.end - box.data >= 8 && (box.end - box.data) % 4 === 0 && box.end <= FTYP_LIMIT);
      const brands = await boxBytes(read, box, 0, box.end - box.data);
      requireMetadata(Array.from({ length: brands.length / 4 }, (_, index) => index)
        .some(index => index !== 1 && ['avif', 'avis'].includes(text(brands, index * 4, 4))));
      sequenceBrand = Array.from({ length: brands.length / 4 }, (_, index) => index)
        .some(index => index !== 1 && text(brands, index * 4, 4) === 'avis');
      hasFileType = true;
    } else if (box.type === 'meta') {
      still = await avifPrimary(read, box);
    } else if (box.type === 'moov') {
      tracks = await avifTracks(read, box);
    }
  }
  const sequence = tracks.find(track => track.primary);
  const image = sequence ?? still;
  requireMetadata(hasFileType && image && (!sequenceBrand || sequence));
  const { width, height } = image;
  let decodeWidth = width, decodeHeight = height;
  for (const item of [...(still ? [still] : []), ...tracks]) {
    for (const coded of item.coded) {
      decodeWidth = Math.max(decodeWidth, coded.width);
      decodeHeight = Math.max(decodeHeight, coded.height);
    }
  }
  return { width, height, orientation: image.orientation ?? 1, animated: Boolean(sequence),
    ...(sequence?.frameCount !== undefined ? { frameCount: sequence.frameCount } : {}),
    ...(decodeWidth !== width || decodeHeight !== height ? { decodeWidth, decodeHeight } : {}) };
}

const PARSERS = {
  'image/png': pngMetadata,
  'image/jpeg': jpegMetadata,
  'image/gif': gifMetadata,
  'image/webp': webpMetadata,
  'image/avif': avifMetadata,
};

export async function inspectRasterImage(blob, mimeType = blob.type) {
  const actualType = await sniff(blob);
  if (!actualType) {
    requireMetadata(!RASTER_TYPES.has(mimeType));
    return null;
  }
  const metadata = { mimeType: actualType, ...await PARSERS[actualType](blobReader(blob), blob.size) };
  if (metadata.pngBytes) {
    const validator = createPngStreamValidator();
    const prefix = blob.slice(0, metadata.pngBytes);
    const reader = prefix.stream().getReader();
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; validator.feed(value); }
      requireMetadata(validator.finish() === metadata.pngBytes);
    } finally { reader.releaseLock(); }
  }
  return metadata;
}

export function rasterImageSource(blob, metadata) {
  const size = metadata.pngBytes ?? blob.size;
  return size === blob.size && blob.type === metadata.mimeType ? blob : blob.slice(0, size, metadata.mimeType);
}
