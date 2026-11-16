import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32 } from '../src/lib/archive.js';
import { inspectRasterImage, rasterImageCandidate } from '../src/lib/raster-image-metadata.js';

const bytes = (...values) => Buffer.from(values);
const text = value => Buffer.from(value, 'ascii');
const concat = (...values) => Buffer.concat(values);
const zeros = size => Buffer.alloc(size);
function be16(value) {
  const out = zeros(2);
  out.writeUInt16BE(value);
  return out;
}
function be32(value) {
  const out = zeros(4);
  out.writeUInt32BE(value);
  return out;
}
function le16(value) {
  const out = zeros(2);
  out.writeUInt16LE(value);
  return out;
}
function le32(value) {
  const out = zeros(4);
  out.writeUInt32LE(value);
  return out;
}
const le24 = value => le32(value).subarray(0, 3);
const pngChunk = (type, data) => {
  const chunk = concat(text(type), data);
  return concat(be32(data.length), chunk, be32(crc32(chunk)));
};
const box = (type, ...data) => concat(be32(8 + data.reduce((size, part) => size + part.length, 0)), text(type), ...data);
const webpChunk = (type, data) => concat(text(type), le32(data.length), data, zeros(data.length % 2));
const riff = (...chunks) => {
  const data = concat(text('WEBP'), ...chunks);
  return concat(text('RIFF'), le32(data.length), data);
};
const exif = orientation => concat(text('MM'), be16(42), be32(8), be16(1), be16(0x112), be16(3), be32(1), be16(orientation), zeros(6));

test('actual raster signature takes priority over the download MIME', async () => {
  const jpeg = concat(bytes(0xff, 0xd8, 0xff, 0xe1), be16(34), text('Exif\0\0'), exif(6),
    bytes(0xff, 0xc0), be16(11), bytes(8), be16(1080), be16(2200), bytes(1, 1, 0x11, 0),
    bytes(0xff, 0xda), be16(8), bytes(1, 1, 0, 0, 63, 0));
  const blob = new Blob([jpeg], { type: 'image/png' });
  assert.equal(await rasterImageCandidate(blob), true);
  assert.deepEqual(await inspectRasterImage(blob), {
    mimeType: 'image/jpeg', width: 2200, height: 1080, orientation: 6, animated: false,
  });
  assert.deepEqual(await inspectRasterImage(new Blob([jpeg])), await inspectRasterImage(blob));
});

test('PNG metadata reads dimensions and eXIf without reading the entire IDAT', async () => {
  const png = concat(bytes(137, 80, 78, 71, 13, 10, 26, 10),
    pngChunk('IHDR', concat(be32(10_427), be32(5668), bytes(8, 2, 0, 0, 0))),
    pngChunk('IDAT', zeros(1024 * 1024)), pngChunk('eXIf', exif(8)), pngChunk('IEND', zeros(0)));
  const blob = new Blob([png]);
  let total = 0;
  const source = { size: blob.size, slice(start, end) {
    total += end - start;
    return blob.slice(start, end);
  } };
  assert.deepEqual(await inspectRasterImage(source), {
    mimeType: 'image/png', width: 10_427, height: 5668, orientation: 8, animated: false,
    orientationChunk: [1024 * 1024 + 45, png.length - 12],
  });
  assert.ok(total < 256 * 1024);
  png[29] ^= 1;
  await assert.rejects(inspectRasterImage(new Blob([png])), /размер/i);
});

test('GIF dimensions describe the logical screen, including partial animated frames', async () => {
  const frame = concat(bytes(0x2c), le16(50), le16(70), le16(10), le16(20), bytes(0, 2, 1, 0x55, 0));
  const gif = concat(text('GIF89a'), le16(2000), le16(1100), bytes(0, 0, 0), frame, frame, bytes(0x3b));
  assert.deepEqual(await inspectRasterImage(new Blob([gif])), {
    mimeType: 'image/gif', width: 2000, height: 1100, orientation: 1, animated: true, frameCount: 2,
  });
});

test('WebP inspection uses the RIFF canvas and EXIF and checks frame bounds', async () => {
  const vp8x = webpChunk('VP8X', concat(bytes(10, 0, 0, 0), le24(2199), le24(1099)));
  const vp8l = webpChunk('VP8L', concat(bytes(0x2f), le32(9 | (19 << 14))));
  const frame = x => webpChunk('ANMF', concat(le24(x), le24(30), le24(9), le24(19), le24(100), bytes(2), vp8l));
  const input = x => new Blob([riff(vp8x, webpChunk('ANIM', zeros(6)), frame(x), webpChunk('EXIF', exif(2)))]);
  assert.deepEqual(await inspectRasterImage(input(50)), {
    mimeType: 'image/webp', width: 2200, height: 1100, orientation: 2, animated: true, frameCount: 1,
  });
  await assert.rejects(inspectRasterImage(input(1100)), /размер/i);
});

test('AVIF identifies the primary ispe property instead of a preceding thumbnail', async () => {
  const ftyp = box('ftyp', text('mif1'), zeros(4), text('avif'));
  const ispe = (width, height) => box('ispe', zeros(4), be32(width), be32(height));
  const ipco = box('ipco', ispe(120, 60), ispe(3000, 1500), box('irot', bytes(1)));
  const ipma = box('ipma', zeros(4), be32(2), be16(1), bytes(1, 1), be16(2), bytes(2, 0x82, 3));
  const meta = box('meta', zeros(4), box('pitm', zeros(4), be16(2)), box('iprp', ipco, ipma));
  assert.deepEqual(await inspectRasterImage(new Blob([ftyp, meta])), {
    mimeType: 'image/avif', width: 3000, height: 1500, orientation: 8, animated: false,
  });
});

test('AVIF clean aperture reports visible dimensions and keeps the coded size for preflight', async () => {
  const ftyp = box('ftyp', text('avif'), zeros(4));
  const ispe = box('ispe', zeros(4), be32(3000), be32(2000));
  const aperture = (width, offset) => box('clap', be32(width), be32(1), be32(1000), be32(1), be32(offset >>> 0), be32(2), be32(-500 >>> 0), be32(1));
  const ipma = box('ipma', zeros(4), be32(1), be16(1), bytes(2, 1, 2));
  const meta = clap => box('meta', zeros(4), box('pitm', zeros(4), be16(1)), box('iprp', box('ipco', ispe, clap), ipma));
  assert.deepEqual(await inspectRasterImage(new Blob([ftyp, meta(aperture(1901, -1099))])), {
    mimeType: 'image/avif', width: 1901, height: 1000, orientation: 1, animated: false,
    decodeWidth: 3000, decodeHeight: 2000,
  });
  await assert.rejects(inspectRasterImage(new Blob([ftyp, meta(aperture(1901, 0))])), /размер/i);
});

test('AVIF sequences inspect the av01 visual sample dimensions in the pict track', async () => {
  const ftyp = box('ftyp', text('avis'), zeros(4), text('avif'));
  const hdlr = box('hdlr', zeros(8), text('pict'), zeros(12));
  const tkhd = box('tkhd', zeros(12), be32(1), zeros(60), be32(3000 << 16), be32(2300 << 16));
  const sample = box('av01', zeros(24), be16(3200), be16(2200), zeros(50), box('irot', bytes(1)));
  const stsd = box('stsd', zeros(4), be32(1), sample);
  const stco = box('stco', zeros(4), be32(1), zeros(4));
  const stsz = box('stsz', zeros(4), be32(100), be32(3));
  const moov = box('moov', box('trak', tkhd, box('mdia', hdlr, box('minf', box('stbl', stsd, stco, stsz)))));
  assert.deepEqual(await inspectRasterImage(new Blob([ftyp, moov])), {
    mimeType: 'image/avif', width: 3000, height: 2300, orientation: 8, animated: true, frameCount: 3,
    decodeWidth: 3200, decodeHeight: 2300,
  });
});

test('AVIF sequences select the first populated color track and budget auxiliary and alternate tracks', async () => {
  const ftyp = box('ftyp', text('avis'), zeros(4), text('avif'));
  function track(id, type, width, height, { auxiliary, populated = true } = {}) {
    const hdlr = box('hdlr', zeros(8), text(type), zeros(12));
    const tkhd = box('tkhd', zeros(12), be32(id), zeros(60), be32(width * 65536), be32(height * 65536));
    const sample = box('av01', zeros(24), be16(width), be16(height), zeros(50));
    const stsd = box('stsd', zeros(4), be32(1), sample);
    const co64 = box('co64', zeros(4), be32(Number(populated)), zeros(populated ? 8 : 0));
    const media = box('mdia', hdlr, box('minf', box('stbl', stsd, co64)));
    return auxiliary ? box('trak', tkhd, box('tref', box('auxl', be32(auxiliary))), media) : box('trak', tkhd, media);
  }
  const moov = box('moov', track(1, 'pict', 200, 200, { populated: false }),
    track(2, 'pict', 50, 50, { auxiliary: 3 }), track(3, 'vide', 3000, 1500),
    track(4, 'pict', 9000, 8000), track(5, 'auxv', 9500, 8000, { auxiliary: 3 }));
  assert.deepEqual(await inspectRasterImage(new Blob([ftyp, moov])), {
    mimeType: 'image/avif', width: 3000, height: 1500, orientation: 1, animated: true,
    decodeWidth: 9500, decodeHeight: 8000,
  });
});

test('unrelated BMFF media bypasses inspection, but invalid declared raster cannot bypass it', async () => {
  const video = new Blob([box('ftyp', text('isom'), zeros(4), text('mp42'))], { type: 'video/mp4' });
  assert.equal(await rasterImageCandidate(video), false);
  assert.equal(await inspectRasterImage(video), null);
  for (const blob of [new Blob([bytes(0xff, 0xd8, 0xff)]), new Blob(['bad'], { type: 'image/avif' })]) {
    assert.equal(await rasterImageCandidate(blob), true);
    await assert.rejects(inspectRasterImage(blob), /размер/i);
  }
});
