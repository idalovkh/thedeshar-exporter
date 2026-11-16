import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32, updateCrc } from '../src/lib/archive.js';
import { createPngStreamValidator } from '../src/lib/png-stream-validator.js';

const validPng = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64'));
const signature = validPng.slice(0, 8);
const headerChunk = validPng.slice(8, 33), dataChunk = validPng.slice(33, 58), endChunk = validPng.slice(58);
const imageData = validPng.slice(41, 54);
const encoder = new TextEncoder();

function concat(...parts) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}

function chunk(type, data = new Uint8Array(), declaredLength = data.byteLength) {
  const bytes = new Uint8Array(data.byteLength + 12), view = new DataView(bytes.buffer);
  view.setUint32(0, declaredLength);
  bytes.set(encoder.encode(type), 4);
  bytes.set(data, 8);
  view.setUint32(data.byteLength + 8, crc32(bytes.subarray(4, data.byteLength + 8)));
  return bytes;
}

function ihdr({ width = 1, height = 1, bitDepth = 8, colorType = 6, compression = 0, filter = 0, interlace = 0 } = {}) {
  const bytes = new Uint8Array(13), view = new DataView(bytes.buffer);
  view.setUint32(0, width); view.setUint32(4, height);
  bytes.set([bitDepth, colorType, compression, filter, interlace], 8);
  return chunk('IHDR', bytes);
}

function validate(bytes, options) {
  const validator = createPngStreamValidator(options);
  validator.feed(bytes);
  validator.finish();
}

const rejects = (bytes, reason = 'invalid_png', options) => assert.throws(() => validate(bytes, options), error => error.reason === reason);

test('a complete known PNG passes validation with its original bytes intact', () => {
  const bytes = validPng.slice();
  const validator = createPngStreamValidator();
  validator.feed(bytes);
  assert.doesNotThrow(() => validator.finish());
  assert.deepEqual(bytes, validPng);
});

test('the shared incremental CRC matches the independent standard check value', () => {
  const bytes = encoder.encode('123456789');
  assert.equal(crc32(bytes), 0xcbf43926);
  let crc = 0xffffffff;
  for (const byte of bytes) crc = updateCrc(crc, new Uint8Array([byte]));
  assert.equal((crc ^ 0xffffffff) >>> 0, 0xcbf43926);
});

test('every possible network split, single-byte reads and offset subarrays preserve parsing', () => {
  for (let split = 0; split <= validPng.length; split++) {
    const validator = createPngStreamValidator();
    validator.feed(validPng.subarray(0, split));
    validator.feed(validPng.subarray(split));
    assert.doesNotThrow(() => validator.finish(), `Split ${split}`);
  }
  for (const size of [1, 2, 3, 5, 7, 31]) {
    const validator = createPngStreamValidator();
    const padded = concat(new Uint8Array([9, 9, 9]), validPng, new Uint8Array([9, 9]));
    for (let offset = 0; offset < validPng.length; offset += size) {
      validator.feed(padded.subarray(offset + 3, 3 + Math.min(offset + size, validPng.length)));
    }
    assert.doesNotThrow(() => validator.finish());
  }
});

test('empty or incomplete signatures and non-PNG responses remain unsupported', () => {
  for (let length = 0; length < signature.length; length++) rejects(signature.subarray(0, length), 'unsupported_content_type');
  for (const value of ['<!doctype html><html>Login</html>', '{"error":"no access"}', 'A text file', '%PDF-1.7']) {
    rejects(encoder.encode(value), 'unsupported_content_type');
  }
  for (let offset = 0; offset < signature.length; offset++) {
    const bytes = signature.slice(); bytes[offset] ^= 1;
    rejects(bytes, 'unsupported_content_type');
  }
});

test('a PNG signature alone and every truncated body fail container validation', () => {
  for (let length = signature.length; length < validPng.length; length++) rejects(validPng.subarray(0, length));
  rejects(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]));
});

test('CRC mismatches in headers, image data, ancillary chunks and IEND are rejected', () => {
  for (const offset of [29, 45, validPng.length - 1]) {
    const bytes = validPng.slice(); bytes[offset] ^= 1;
    rejects(bytes);
  }
  const ancillary = chunk('caBX', new Uint8Array([5, 6, 7]));
  ancillary[8] ^= 1;
  rejects(concat(signature, headerChunk, ancillary, dataChunk, endChunk));
});

test('IHDR must be first, unique, correctly sized and contain valid structural fields', () => {
  rejects(concat(signature, dataChunk, headerChunk, endChunk));
  rejects(concat(signature, headerChunk, headerChunk, dataChunk, endChunk));
  rejects(concat(signature, chunk('IHDR', new Uint8Array(12)), dataChunk, endChunk));
  for (const invalid of [
    { width: 0 }, { height: 0 }, { width: 0x80000000 }, { height: 0x80000000 },
    { colorType: 1 }, { colorType: 5 }, { bitDepth: 0 }, { bitDepth: 3 }, { colorType: 2, bitDepth: 4 },
    { colorType: 3, bitDepth: 16 }, { colorType: 4, bitDepth: 2 }, { colorType: 6, bitDepth: 1 },
    { compression: 1 }, { filter: 1 }, { interlace: 2 },
  ]) rejects(concat(signature, ihdr(invalid), dataChunk, endChunk));
});

test('supported PNG header combinations and Adam7 interlace retain their original container', () => {
  for (const [colorType, bitDepth] of [[0, 1], [0, 16], [2, 8], [2, 16], [4, 8], [4, 16], [6, 8], [6, 16]]) {
    // This validator checks the container; it deliberately does not decode the pixel stream.
    assert.doesNotThrow(() => validate(concat(signature, ihdr({ colorType, bitDepth, interlace: 1 }), dataChunk, endChunk)));
  }
});

test('indexed PNG requires a legal palette before IDAT', () => {
  const header = ihdr({ colorType: 3, bitDepth: 1 });
  const palette = chunk('PLTE', new Uint8Array([0, 0, 0, 255, 255, 255]));
  assert.doesNotThrow(() => validate(concat(signature, header, palette, dataChunk, endChunk)));
  rejects(concat(signature, header, dataChunk, endChunk));
  rejects(concat(signature, header, palette, palette, dataChunk, endChunk));
  rejects(concat(signature, header, dataChunk, palette, endChunk));
  for (const length of [0, 1, 4, 9, 771]) rejects(concat(signature, header, chunk('PLTE', new Uint8Array(length)), dataChunk, endChunk));
  for (const colorType of [0, 4]) rejects(concat(signature, ihdr({ colorType }), palette, dataChunk, endChunk));
  assert.doesNotThrow(() => validate(concat(signature, headerChunk, palette, dataChunk, endChunk)), 'Truecolor may have a suggested palette');
});

test('IDAT chunks must form one consecutive group with nonempty total data', () => {
  const first = chunk('IDAT', imageData.subarray(0, 5)), second = chunk('IDAT', imageData.subarray(5));
  assert.doesNotThrow(() => validate(concat(signature, headerChunk, chunk('IDAT'), first, second, chunk('IDAT'), endChunk)));
  rejects(concat(signature, headerChunk, endChunk));
  rejects(concat(signature, headerChunk, chunk('IDAT'), endChunk));
  rejects(concat(signature, headerChunk, first, chunk('tEXt', encoder.encode('Note\0metadata')), second, endChunk));
});

test('IEND must have no payload, finish the file and carry a correct checksum', () => {
  rejects(concat(signature, headerChunk, dataChunk));
  rejects(concat(signature, headerChunk, dataChunk, chunk('IEND', new Uint8Array([1]))));
  rejects(concat(validPng, endChunk));
  rejects(concat(validPng, new Uint8Array([0])));
  const validator = createPngStreamValidator();
  validator.feed(validPng);
  assert.doesNotThrow(() => validator.finish());
  assert.throws(() => validator.feed(new Uint8Array([1])), error => error.reason === 'invalid_png');
});

test('unknown ancillary chunks are preserved while unknown critical or malformed chunk types are rejected', () => {
  for (const type of ['caBX', 'tEXt', 'aaAA']) {
    assert.doesNotThrow(() => validate(concat(signature, headerChunk, chunk(type, new Uint8Array([1, 2, 3])), dataChunk, endChunk)));
  }
  for (const type of ['ABCD', 'cabX', '1ABC', 'AB1D', 'AB_D']) {
    rejects(concat(signature, headerChunk, chunk(type), dataChunk, endChunk));
  }
});

test('chunk and total-file lengths cannot exceed format or configured bounds', () => {
  rejects(concat(signature, headerChunk, chunk('IDAT', new Uint8Array(), 0x80000000)));
  rejects(concat(signature, headerChunk, chunk('IDAT', new Uint8Array(), 10000)), 'file_limit', { maxBytes: 100 });
  rejects(validPng, 'file_limit', { maxBytes: validPng.length - 1 });
  assert.doesNotThrow(() => validate(validPng, { maxBytes: validPng.length }));
});

test('large ancillary chunks can be validated incrementally using a reusable caller buffer', () => {
  const validator = createPngStreamValidator();
  validator.feed(concat(signature, headerChunk));
  const part = new Uint8Array(4096), repetitions = 64;
  const header = chunk('caBX', new Uint8Array(), part.length * repetitions).subarray(0, 8);
  validator.feed(header);
  let crc = updateCrc(0xffffffff, encoder.encode('caBX'));
  for (let index = 0; index < repetitions; index++) {
    part.fill(index);
    crc = updateCrc(crc, part);
    validator.feed(part);
  }
  part.fill(255);
  const checksum = new Uint8Array(4);
  new DataView(checksum.buffer).setUint32(0, (crc ^ 0xffffffff) >>> 0);
  validator.feed(checksum);
  validator.feed(concat(dataChunk, endChunk));
  assert.doesNotThrow(() => validator.finish());
});

test('a failed validator cannot resume to accept later valid bytes', () => {
  const validator = createPngStreamValidator();
  let failure;
  try { validator.feed(new Uint8Array([0])); } catch (error) { failure = error; }
  assert.equal(failure.reason, 'unsupported_content_type');
  assert.throws(() => validator.feed(validPng), error => error === failure);
  assert.throws(() => validator.finish(), error => error === failure);
});
