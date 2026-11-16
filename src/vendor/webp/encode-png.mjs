import loadCodec from './codec.mjs';

const MIB = 1024 * 1024;

/** A synchronous lossless encoder owned by one dedicated Web Worker. */
export async function createWebpEncoder(wasmBinary) {
  const codec = await loadCodec({ wasmBinary });

  function encodeRGBA(input, width, height) {
    if (!(input instanceof Uint8Array || input instanceof Uint8ClampedArray)) {
      throw new TypeError('RGBA input must be an array of unsigned bytes');
    }
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
        Math.max(width, height) > 1920 || Math.min(width, height) > 1080 ||
        input.byteLength !== width * height * 4) return null;
    const source = codec._malloc(input.byteLength);
    if (!source) return null;
    try {
      codec.HEAPU8.set(input, source);
      const size = codec._encode_verified_rgba(source, input.byteLength, width, height);
      if (!size) return null;
      const address = codec._encoded_webp_result();
      if (!address || size < 0 || size > 100 * MIB || address + size > codec.HEAPU8.length) {
        throw new Error('Invalid WebP encoder output');
      }
      return codec.HEAPU8.slice(address, address + size);
    } finally {
      codec._release_encoded_webp();
      codec._free(source);
    }
  }

  return { encodeRGBA };
}
