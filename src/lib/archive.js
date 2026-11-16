import { updateCrc } from './crc32.js';
import { archiveMediaCrc32 } from './media-sha256.js';

export { crc32, updateCrc } from './crc32.js';
export { prepareEntries as prepareZipEntries, localHeader as zipLocalHeader,
  centralHeader as zipCentralHeader, endHeader as zipEndHeader };

const encoder = new TextEncoder();
export const MAX_ARCHIVE_BYTES = 4_000_000_000;
const MAX_ENTRIES = 20000;
const READ_CHUNK_BYTES = 1024 * 1024;

function validatePath(name) {
  if (typeof name !== "string" || !name || name.startsWith("/") || /[\\:\u0000-\u001f\u007f]/.test(name)) throw new Error("Недопустимое имя файла в архиве");
  for (const segment of name.split("/")) {
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch { /* The literal ZIP path is still checked. */ }
    if (!segment || decoded === "." || decoded === ".." || /[\\/]/.test(decoded)) throw new Error("Недопустимый путь файла в архиве");
  }
}

function header(size) { return new DataView(new ArrayBuffer(size)); }
export function archiveSizeError() {
  const error = new RangeError("Архив превышает 4 ГБ. Скачивание остановлено; собранные уроки сохранены в расширении.");
  error.code = "archive_limit";
  return error;
}
function prepareEntries(entries, maxBytes = MAX_ARCHIVE_BYTES) {
  if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) throw new Error("Слишком много файлов в архиве");
  const names = new Set();
  let localSize = 0, centralSize = 0;
  const files = entries.map(({ name, data }) => {
    validatePath(name);
    if (names.has(name)) throw new Error("Повторяющееся имя файла в архиве");
    names.add(name);
    const filename = encoder.encode(name);
    if (filename.length > 0xffff) throw new Error("Слишком длинное имя файла в архиве");
    if (typeof data !== "string" && !(data instanceof Uint8Array) && !(data instanceof Blob)) throw new TypeError("Файл должен содержать строку, Uint8Array или Blob");
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    const size = bytes instanceof Blob ? bytes.size : bytes.byteLength;
    if (!Number.isSafeInteger(size) || size < 0 || size >= 0xffffffff) throw new Error("Недопустимый размер ZIP32; ZIP64 не поддерживается");
    const offset = localSize;
    if (offset >= 0xffffffff) throw new Error("Смещение ZIP32 требует ZIP64");
    localSize += 30 + filename.length + size;
    centralSize += 46 + filename.length;
    if (localSize >= 0xffffffff || centralSize >= 0xffffffff) throw new Error("Размер ZIP32 требует ZIP64");
    if (localSize + centralSize + 22 > Math.min(MAX_ARCHIVE_BYTES, maxBytes)) throw archiveSizeError();
    return { filename, bytes, size, offset };
  });
  return { files, localSize, centralSize, size: localSize + centralSize + 22 };
}

export function zipByteLength(entries) { return prepareEntries(entries).size; }

function localHeader(file) {
  const local = header(30);
  local.setUint32(0, 0x04034b50, true);
  local.setUint16(4, 20, true);
  local.setUint16(6, 0x0800, true);
  local.setUint16(12, 0x0021, true);
  local.setUint32(14, file.crc, true);
  local.setUint32(18, file.size, true);
  local.setUint32(22, file.size, true);
  local.setUint16(26, file.filename.length, true);
  return new Uint8Array(local.buffer);
}
function centralHeader(file) {
  const central = header(46);
  central.setUint32(0, 0x02014b50, true);
  central.setUint16(4, 20, true);
  central.setUint16(6, 20, true);
  central.setUint16(8, 0x0800, true);
  central.setUint16(14, 0x0021, true);
  central.setUint32(16, file.crc, true);
  central.setUint32(20, file.size, true);
  central.setUint32(24, file.size, true);
  central.setUint16(28, file.filename.length, true);
  central.setUint32(42, file.offset, true);
  return new Uint8Array(central.buffer);
}
function endHeader(files, localSize, centralSize) {
  const end = header(22);
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, localSize, true);
  return new Uint8Array(end.buffer);
}

function checkAborted(signal) {
  if (signal?.aborted) throw new DOMException("Скачивание отменено.", "AbortError");
}
const yieldToBrowser = () => new Promise(resolve => setTimeout(resolve, 0));

/** Assemble ZIP from Blob parts, without allocating a second whole archive buffer. */
export async function buildZipBlob(entries, { signal, onProgress, maxBytes = MAX_ARCHIVE_BYTES } = {}) {
  checkAborted(signal);
  const { files, localSize, centralSize, size } = prepareEntries(entries, maxBytes);
  const parts = [];
  let loaded = 0, sinceYield = 0;
  onProgress?.({ loaded, total: localSize, filesDone: 0, filesTotal: files.length });
  for (let index = 0; index < files.length; index++) {
    checkAborted(signal);
    const file = files[index];
    const checkedCrc = file.bytes instanceof Blob ? archiveMediaCrc32(file.bytes) : undefined;
    if (checkedCrc !== undefined) {
      file.crc = checkedCrc;
      loaded += file.size;
    } else {
      let crc = 0xffffffff;
      // Slice both binary kinds into bounded reads. Blob bytes can remain backed by
      // browser storage rather than one JavaScript allocation for the whole book.
      for (let offset = 0; offset < file.size; offset += READ_CHUNK_BYTES) {
        checkAborted(signal);
        const chunk = file.bytes instanceof Blob
          ? new Uint8Array(await file.bytes.slice(offset, offset + READ_CHUNK_BYTES).arrayBuffer())
          : file.bytes.subarray(offset, offset + READ_CHUNK_BYTES);
        checkAborted(signal);
        crc = updateCrc(crc, chunk);
        loaded += chunk.byteLength;
        sinceYield += chunk.byteLength;
        onProgress?.({ loaded, total: localSize, filesDone: index, filesTotal: files.length });
        if (sinceYield >= 4 * 1024 * 1024) { sinceYield = 0; await yieldToBrowser(); }
      }
      file.crc = (crc ^ 0xffffffff) >>> 0;
    }
    parts.push(localHeader(file), file.filename, file.bytes);
    loaded += 30 + file.filename.length;
    onProgress?.({ loaded, total: localSize, filesDone: index + 1, filesTotal: files.length });
    if ((index + 1) % 32 === 0) await yieldToBrowser();
  }
  checkAborted(signal);
  for (const file of files) parts.push(centralHeader(file), file.filename);
  parts.push(endHeader(files, localSize, centralSize));
  const archive = new Blob(parts, { type: "application/zip" });
  if (archive.size !== size) throw new Error("Размер ZIP не совпал с подготовленными файлами.");
  return archive;
}
