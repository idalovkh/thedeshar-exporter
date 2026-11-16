const MAX_WEBP_BYTES = 100 * 1024 * 1024;
const MAX_FRAME_DURATION_MS = 0xffffff;
const HEADER_BYTES = 44;
const encoder = new TextEncoder();

function matchesTag(bytes, offset, tag) {
  return bytes[offset] === tag.charCodeAt(0) && bytes[offset + 1] === tag.charCodeAt(1) &&
    bytes[offset + 2] === tag.charCodeAt(2) && bytes[offset + 3] === tag.charCodeAt(3);
}

function writeChunkHeader(bytes, view, offset, tag, length) {
  bytes.set(encoder.encode(tag), offset);
  view.setUint32(offset + 4, length, true);
}

function writeUint24(bytes, offset, value) {
  bytes[offset] = value;
  bytes[offset + 1] = value >>> 8;
  bytes[offset + 2] = value >>> 16;
}

// The codec returns a verified simple WebP containing one VP8L chunk. The
// animation embeds that chunk directly, including any required RIFF padding.
function losslessFrame(webp, width, height) {
  const invalid = () => new Error('Expected one lossless WebP frame.');
  if (!(webp instanceof Uint8Array) || webp.length < 26 || !matchesTag(webp, 0, 'RIFF') ||
      !matchesTag(webp, 8, 'WEBP') || !matchesTag(webp, 12, 'VP8L') || webp[20] !== 0x2f) {
    throw invalid();
  }
  const view = new DataView(webp.buffer, webp.byteOffset, webp.byteLength);
  const payloadBytes = view.getUint32(16, true);
  if (view.getUint32(4, true) !== webp.length - 8 || payloadBytes < 5 ||
      20 + payloadBytes + (payloadBytes & 1) !== webp.length ||
      ((payloadBytes & 1) && webp.at(-1) !== 0)) throw invalid();
  const parameters = view.getUint32(21, true);
  if (parameters >>> 29) throw invalid();
  if ((parameters & 0x3fff) + 1 !== width || ((parameters >>> 14) & 0x3fff) + 1 !== height) {
    throw new Error('WebP frame dimensions do not match the canvas.');
  }
  return { chunk: webp.subarray(12), alpha: (parameters & (1 << 28)) !== 0 };
}

/** Mux already verified full-canvas lossless frames without decoding them again. */
export function createAnimatedWebp(width, height, repetitionCount, { maxBytes = MAX_WEBP_BYTES } = {}) {
  if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= 16_384)) {
    throw new RangeError('Invalid WebP animation dimensions.');
  }
  if (repetitionCount !== Infinity && (!Number.isInteger(repetitionCount) || repetitionCount < 0 || repetitionCount > 65_534)) {
    throw new RangeError('WebP cannot represent this animation repeat count.');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < HEADER_BYTES || maxBytes > MAX_WEBP_BYTES) {
    throw new RangeError('Invalid WebP animation size limit.');
  }
  const frames = [];
  let bytes = HEADER_BYTES;
  let hasAlpha = false;
  let elapsedUs = 0;

  return {
    addFrame(webp, durationUs) {
      const nextUs = elapsedUs + durationUs;
      if (!Number.isSafeInteger(durationUs) || durationUs < 0 || !Number.isSafeInteger(nextUs)) {
        throw new RangeError('Invalid WebP frame duration.');
      }
      const durationMs = Math.round(nextUs / 1000) - Math.round(elapsedUs / 1000);
      if (durationMs > MAX_FRAME_DURATION_MS) throw new RangeError('WebP cannot represent this frame duration.');
      const { chunk, alpha } = losslessFrame(webp, width, height);
      const frameHeader = new Uint8Array(24);
      if (bytes + frameHeader.length + chunk.length > maxBytes) throw new RangeError('WebP animation exceeds the media size limit.');
      writeChunkHeader(frameHeader, new DataView(frameHeader.buffer), 0, 'ANMF', 16 + chunk.length);
      writeUint24(frameHeader, 14, width - 1);
      writeUint24(frameHeader, 17, height - 1);
      writeUint24(frameHeader, 20, durationMs);
      frameHeader[23] = 2; // Replace the full canvas, including transparent pixels.
      // Store each compressed frame as a Blob so assembling the final
      // container can reuse its backing data instead of copying it again.
      frames.push(new Blob([frameHeader, chunk]));
      hasAlpha ||= alpha;
      elapsedUs = nextUs;
      bytes += frameHeader.length + chunk.length;
    },
    finish() {
      if (!frames.length) throw new Error('WebP animation has no frames.');
      const header = new Uint8Array(HEADER_BYTES);
      const view = new DataView(header.buffer);
      writeChunkHeader(header, view, 0, 'RIFF', bytes - 8);
      header.set(encoder.encode('WEBP'), 8);
      writeChunkHeader(header, view, 12, 'VP8X', 10);
      header[20] = 2 | (hasAlpha ? 16 : 0);
      writeUint24(header, 24, width - 1);
      writeUint24(header, 27, height - 1);
      writeChunkHeader(header, view, 30, 'ANIM', 6);
      view.setUint16(42, repetitionCount === Infinity ? 0 : repetitionCount + 1, true);
      return new Blob([header, ...frames], { type: 'image/webp' });
    },
  };
}
