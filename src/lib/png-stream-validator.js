import { updateCrc } from './archive.js';

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const DEPTHS = new Map([[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]]]);
const CRITICAL_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);
const uint32 = (bytes, offset = 0) => ((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
const upper = value => value >= 65 && value <= 90;
const letter = value => upper(value) || value >= 97 && value <= 122;

/** Validate the PNG container and chunk CRCs without decoding pixels or retaining chunk data. */
export function createPngStreamValidator({ maxBytes = 100 * 1024 * 1024, allowTrailing = false } = {}) {
  const header = new Uint8Array(8), ihdr = new Uint8Array(13), checksum = new Uint8Array(4);
  let phase = 'signature', signatureOffset = 0, headerOffset = 0, checksumOffset = 0;
  let inputBytes = 0, position = 0, chunkLength = 0, remaining = 0, chunkType = '', crc = 0;
  let seenHeader = false, seenPalette = false, seenData = false, dataEnded = false, dataBytes = 0;
  let bitDepth = 0, colorType = 0, failure;
  const fail = (reason = 'invalid_png') => {
    const message = reason === 'unsupported_content_type' ? 'Ссылка вернула страницу или другой неподдерживаемый тип файла.'
      : reason === 'file_limit' ? 'Превышен лимит размера файла.' : 'Получен повреждённый PNG-файл.';
    failure ||= Object.assign(new Error(message), { reason });
    throw failure;
  };

  function startChunk() {
    chunkLength = uint32(header);
    if (chunkLength > 0x7fffffff) fail();
    if (position + chunkLength + 4 > maxBytes) fail('file_limit');
    if (![...header.subarray(4)].every(letter) || !upper(header[6])) fail();
    chunkType = String.fromCharCode(...header.subarray(4));
    if (upper(header[4]) && !CRITICAL_CHUNKS.has(chunkType)) fail();
    if (!seenHeader && (chunkType !== 'IHDR' || chunkLength !== 13)) fail();
    if (chunkType === 'IHDR' && (seenHeader || chunkLength !== 13)) fail();
    if (chunkType === 'PLTE') {
      if (seenPalette || seenData || colorType === 0 || colorType === 4 ||
        chunkLength === 0 || chunkLength % 3 !== 0 || chunkLength > 768 ||
        colorType === 3 && chunkLength / 3 > 2 ** bitDepth) fail();
    }
    if (chunkType === 'IDAT' && (dataEnded || colorType === 3 && !seenPalette)) fail();
    if (chunkType !== 'IDAT' && seenData) dataEnded = true;
    if (chunkType === 'IEND' && (chunkLength !== 0 || !seenData || dataBytes === 0)) fail();
    remaining = chunkLength;
    crc = updateCrc(0xffffffff, header.subarray(4));
    checksumOffset = 0;
    phase = remaining ? 'data' : 'checksum';
  }

  function finishChunk() {
    if (((crc ^ 0xffffffff) >>> 0) !== uint32(checksum)) fail();
    if (chunkType === 'IHDR') {
      const width = uint32(ihdr), height = uint32(ihdr, 4);
      bitDepth = ihdr[8]; colorType = ihdr[9];
      if (!width || width > 0x7fffffff || !height || height > 0x7fffffff ||
        !DEPTHS.get(colorType)?.includes(bitDepth) || ihdr[10] !== 0 || ihdr[11] !== 0 || ihdr[12] > 1) fail();
      seenHeader = true;
    } else if (chunkType === 'PLTE') seenPalette = true;
    else if (chunkType === 'IDAT') { seenData = true; dataBytes += chunkLength; }
    phase = chunkType === 'IEND' ? 'ended' : 'header';
    headerOffset = 0;
  }

  function feed(bytes) {
    if (failure) throw failure;
    inputBytes += bytes.byteLength;
    if (inputBytes > maxBytes) fail('file_limit');
    let offset = 0;
    while (offset < bytes.byteLength) {
      if (phase === 'ended') { if (allowTrailing) break; fail(); }
      if (phase === 'signature') {
        if (bytes[offset++] !== SIGNATURE[signatureOffset++]) fail('unsupported_content_type');
        position++;
        if (signatureOffset === SIGNATURE.length) phase = 'header';
      } else if (phase === 'header') {
        const length = Math.min(header.length - headerOffset, bytes.byteLength - offset);
        header.set(bytes.subarray(offset, offset + length), headerOffset);
        offset += length; position += length; headerOffset += length;
        if (headerOffset === header.length) startChunk();
      } else if (phase === 'data') {
        const length = Math.min(remaining, bytes.byteLength - offset);
        const part = bytes.subarray(offset, offset + length);
        crc = updateCrc(crc, part);
        if (chunkType === 'IHDR') ihdr.set(part, chunkLength - remaining);
        offset += length; position += length; remaining -= length;
        if (!remaining) phase = 'checksum';
      } else {
        const length = Math.min(checksum.length - checksumOffset, bytes.byteLength - offset);
        checksum.set(bytes.subarray(offset, offset + length), checksumOffset);
        offset += length; position += length; checksumOffset += length;
        if (checksumOffset === checksum.length) finishChunk();
      }
    }
  }

  function finish() {
    if (failure) throw failure;
    if (signatureOffset < SIGNATURE.length) fail('unsupported_content_type');
    if (phase !== 'ended') fail();
    return position;
  }

  return Object.freeze({ feed, finish });
}
