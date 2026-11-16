import test from "node:test";
import assert from "node:assert/strict";
import { buildZipBlob, zipByteLength, MAX_ARCHIVE_BYTES, crc32 } from "../src/lib/archive.js";
import { hashArchiveMedia } from "../src/lib/media-sha256.js";

function readStoredZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = new Map();
  let cursor = 0;
  while (view.getUint32(cursor, true) === 0x04034b50) {
    assert.equal(view.getUint16(cursor + 6, true), 0x0800, "UTF-8 filenames");
    assert.equal(view.getUint16(cursor + 8, true), 0, "stored entries");
    const size = view.getUint32(cursor + 18, true);
    assert.equal(view.getUint32(cursor + 22, true), size);
    const nameSize = view.getUint16(cursor + 26, true);
    const extraSize = view.getUint16(cursor + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 30, cursor + 30 + nameSize));
    const start = cursor + 30 + nameSize + extraSize;
    const data = bytes.slice(start, start + size);
    assert.equal(view.getUint32(cursor + 14, true), crc32(data));
    files.set(name, data);
    cursor = start + size;
  }
  const directoryOffset = cursor;
  let directoryCount = 0;
  while (view.getUint32(cursor, true) === 0x02014b50) {
    assert.equal(view.getUint16(cursor + 8, true), 0x0800);
    const nameSize = view.getUint16(cursor + 28, true);
    const extraSize = view.getUint16(cursor + 30, true);
    const commentSize = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    assert.equal(view.getUint32(localOffset, true), 0x04034b50, "directory points to a local file header");
    assert.equal(view.getUint32(cursor + 16, true), view.getUint32(localOffset + 14, true), "both headers contain the same CRC");
    cursor += 46 + nameSize + extraSize + commentSize;
    directoryCount++;
  }
  assert.equal(view.getUint32(cursor, true), 0x06054b50);
  assert.equal(view.getUint16(cursor + 10, true), directoryCount);
  assert.equal(view.getUint32(cursor + 16, true), directoryOffset);
  assert.equal(view.getUint32(cursor + 12, true), cursor - directoryOffset);
  assert.equal(bytes.length, cursor + 22);
  return files;
}

test("ZIP entries preserve UTF-8 filenames, JSON text, binary bytes and valid directory offsets", async () => {
  const binary = new Uint8Array([0, 1, 127, 128, 255, 0x50, 0x4b]);
  const archive = await buildZipBlob([
    { name: "manifest.json", data: '{"version":1}' },
    { name: "media/озвучивание.mp3", data: binary },
    { name: "originals/empty.json", data: "" },
  ]);
  const files = readStoredZip(new Uint8Array(await archive.arrayBuffer()));
  assert.equal(new TextDecoder().decode(files.get("manifest.json")), '{"version":1}');
  assert.deepEqual(files.get("media/озвучивание.mp3"), binary);
  assert.equal(files.get("originals/empty.json").length, 0);
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("ZIP paths reject traversal, duplicate names, absolute paths and malformed entries", async () => {
  for (const name of ["../secret", "media/../secret", "/secret", "C:/secret", "media\\secret", "media//secret", "media/%2e%2e/secret", "media/%2fsecret", "media/./secret", "media/secret\u0000.txt"]) {
    await assert.rejects(buildZipBlob([{ name, data: "" }]), /имя|путь/i, name);
  }
  await assert.rejects(buildZipBlob([{ name: "same", data: "1" }, { name: "same", data: "2" }]), /Повторяющееся/);
  await assert.rejects(buildZipBlob([{ name: "invalid", data: {} }]), /Uint8Array/);
  await assert.rejects(buildZipBlob(Array.from({ length: 20001 }, () => ({ name: "one", data: "" }))), /много/);
  const empty = await buildZipBlob([]);
  assert.equal(readStoredZip(new Uint8Array(await empty.arrayBuffer())).size, 0);
});

test("ZIP stores Blob media with valid CRC and directory offsets", async () => {
  const entries = [
    { name: "manifest.json", data: '{"test":true}' },
    { name: "media/аудио.mp3", data: new Blob([new Uint8Array([0, 1, 255, 8])]) },
  ];
  const progress = [];
  const archive = await buildZipBlob(entries, { onProgress: value => progress.push(value) });
  assert.ok(archive instanceof Blob);
  assert.equal(archive.type, "application/zip");
  assert.equal(archive.size, zipByteLength(entries));
  const files = readStoredZip(new Uint8Array(await archive.arrayBuffer()));
  assert.deepEqual([...files.get("media/аудио.mp3")], [0, 1, 255, 8]);
  assert.equal(progress.at(-1).loaded, progress.at(-1).total);
});

test("ZIP reuses CRC for the exact immutable Blob already read by SHA-256", async () => {
  let reads = 0;
  class CountedBlob extends Blob {
    slice(...args) { reads++; return super.slice(...args); }
  }
  const input = new Uint8Array(2 * 1024 * 1024 + 7).fill(0xab);
  const media = new CountedBlob([input]);
  const different = new CountedBlob([new Uint8Array(input.length).fill(0xcd)]);
  const empty = new CountedBlob([]);
  await hashArchiveMedia(media);
  await hashArchiveMedia(empty);
  assert.equal(reads, 3);
  const progress = [];
  const archive = await buildZipBlob([
    { name: "media/hashed.mp3", data: media },
    { name: "media/unhashed.mp3", data: different, crc: 0 },
    { name: "media/empty.mp3", data: empty },
  ], { onProgress: item => progress.push(item) });
  assert.equal(reads, 6, "only the other Blob was read during ZIP assembly");
  const files = readStoredZip(new Uint8Array(await archive.arrayBuffer()));
  assert.deepEqual(files.get("media/hashed.mp3"), input);
  assert.deepEqual(files.get("media/unhashed.mp3"), new Uint8Array(input.length).fill(0xcd));
  assert.equal(files.get("media/empty.mp3").length, 0);
  assert.equal(progress.at(-1).loaded, progress.at(-1).total);
});

test("Blob ZIP accepts a book larger than the old 200 MiB limit without allocating a whole archive Uint8Array", async () => {
  const megabyte = new Blob([new Uint8Array(1024 * 1024)]);
  const media = new Blob(Array(70).fill(megabyte));
  const archive = await buildZipBlob(Array.from({ length: 3 }, (_, index) => ({ name: `media/${index}.mp3`, data: media })));
  assert.ok(archive.size > 200 * 1024 * 1024);
  assert.equal(MAX_ARCHIVE_BYTES, 4_000_000_000);
  const signature = new DataView(await archive.slice(0, 30).arrayBuffer());
  assert.equal(signature.getUint32(0, true), 0x04034b50);
  assert.equal(signature.getUint32(18, true), media.size);
});

test("ZIP size overflow is rejected before Blob bytes are read", async () => {
  let reads = 0;
  class UnreadableBlob extends Blob { slice() { reads++; throw new Error("Overflow must be caught in preflight"); } }
  const oversized = new UnreadableBlob(["large"]);
  await assert.rejects(buildZipBlob([{ name: "media/a.mp3", data: oversized }], { maxBytes: 20 }), error => error.code === "archive_limit");
  assert.equal(reads, 0);
  await assert.rejects(buildZipBlob([{ name: "../private", data: new Blob() }]), /путь/);
});

test("cancelling asynchronous ZIP assembly stops between bounded Blob reads", async () => {
  const controller = new AbortController();
  let progressCalls = 0;
  await assert.rejects(buildZipBlob([{ name: "media/a.mp3", data: new Blob([new Uint8Array(4 * 1024 * 1024)]) }], {
    signal: controller.signal,
    onProgress: ({ loaded }) => { progressCalls++; if (loaded >= 1024 * 1024) controller.abort(); },
  }), { name: "AbortError" });
  assert.equal(progressCalls, 2);
});

test("4 GB ZIP boundary includes all headers and is checked before reading data", () => {
  const name = "media/book.mp3";
  const overhead = zipByteLength([{ name, data: new Blob() }]);
  const entry = new Blob();
  Object.defineProperty(entry, "size", { value: MAX_ARCHIVE_BYTES - overhead });
  assert.equal(zipByteLength([{ name, data: entry }]), MAX_ARCHIVE_BYTES);
  const oversized = new Blob();
  Object.defineProperty(oversized, "size", { value: MAX_ARCHIVE_BYTES - overhead + 1 });
  assert.throws(() => zipByteLength([{ name, data: oversized }]), error => error.code === "archive_limit" && /4 ГБ/.test(error.message));
});


test("ZIP32 sentinel and invalid sizes are rejected before binary fields can wrap", () => {
  for (const size of [0xffffffff, 0x100000000, -1, NaN, Infinity, 1.5]) {
    const data = new Blob();
    Object.defineProperty(data, "size", { value: size });
    assert.throws(() => zipByteLength([{ name: "media/a", data }]), /ZIP32|ZIP64/);
  }
});
