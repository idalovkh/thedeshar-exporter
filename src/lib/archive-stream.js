import { prepareZipEntries, zipLocalHeader, zipCentralHeader, zipEndHeader, MAX_ARCHIVE_BYTES } from './archive.js';
import { updateCrc } from './crc32.js';
import { archiveMediaCrc32 } from './media-sha256.js';

const BLOCK_BYTES = 1024 * 1024;
const check = signal => signal?.throwIfAborted();
const invalid = () => Object.assign(new Error('ZIP не прошёл проверку. Не используйте этот файл. Повторите скачивание; если ошибка повторится, скачайте отчёт и пришлите нам.'), { code: 'zip_verification' });

function validateInventory(manifest, entries, prepared) {
  if (!manifest) return;
  const sizes = new Map(entries.map((entry, index) => [entry.name, prepared.files[index].size]));
  const inventory = manifest.inventory;
  if (!inventory || !['pages', 'responses', 'assets'].every(kind => Array.isArray(inventory[kind]))) throw invalid();
  for (const item of [...inventory.pages, ...inventory.responses]) if (!item.file || !sizes.has(item.file)) throw invalid();
  for (const item of inventory.assets) {
    if (item.status === 'downloaded') {
      if (!item.file || !sizes.has(item.file) || sizes.get(item.file) !== item.size) throw invalid();
    } else if (item.file != null) throw invalid();
  }
  for (const name of Object.values(manifest.reports || {})) if (name != null && !sizes.has(name)) throw invalid();
}

async function chunkOf(bytes, start, end) {
  return bytes instanceof Blob ? new Uint8Array(await bytes.slice(start, end).arrayBuffer()) : bytes.subarray(start, end);
}

async function equalAt(file, offset, expected, signal) {
  check(signal);
  const actual = new Uint8Array(await file.slice(offset, offset + expected.byteLength).arrayBuffer());
  if (actual.byteLength !== expected.byteLength || actual.some((byte, index) => byte !== expected[index])) throw invalid();
}

/** Read the committed file in bounded blocks; never trust a successful write alone. */
export async function verifyWrittenZip(file, prepared, { signal, onProgress } = {}) {
  if (file.size !== prepared.size) throw invalid();
  let loaded = 0;
  for (const item of prepared.files) {
    await equalAt(file, item.offset, zipLocalHeader(item), signal);
    await equalAt(file, item.offset + 30, item.filename, signal);
    const start = item.offset + 30 + item.filename.length;
    let crc = 0xffffffff;
    for (let offset = 0; offset < item.size; offset += BLOCK_BYTES) {
      check(signal);
      const block = new Uint8Array(await file.slice(start + offset, start + Math.min(item.size, offset + BLOCK_BYTES)).arrayBuffer());
      if (!block.length) throw invalid();
      crc = updateCrc(crc, block);
      loaded += block.length;
      onProgress?.({ loaded, total: prepared.size, verifying: true });
    }
    if (((crc ^ 0xffffffff) >>> 0) !== item.crc) throw invalid();
  }
  let offset = prepared.localSize;
  for (const item of prepared.files) {
    await equalAt(file, offset, zipCentralHeader(item), signal);
    await equalAt(file, offset + 46, item.filename, signal);
    offset += 46 + item.filename.length;
  }
  await equalAt(file, offset, zipEndHeader(prepared.files, prepared.localSize, prepared.centralSize), signal);
  check(signal);
  onProgress?.({ loaded: prepared.size, total: prepared.size, verifying: true });
}

/** Write STORE entries directly into the selected file, with backpressure. */
export async function writeZipFile(entries, handle, { signal, onProgress, manifest, maxBytes = MAX_ARCHIVE_BYTES } = {}) {
  check(signal);
  if (!handle?.createWritable || !handle?.getFile) throw Object.assign(new Error('Браузер не поддерживает безопасное сохранение ZIP. Откройте экспортёр в Chrome и попробуйте снова.'), { code: 'file_save_unavailable' });
  const prepared = prepareZipEntries(entries, maxBytes);
  validateInventory(manifest, entries, prepared);
  let writable, closed = false;
  try {
    writable = await handle.createWritable();
    let loaded = 0;
    for (const item of prepared.files) {
      check(signal);
      item.crc = 0;
      await writable.write(zipLocalHeader(item));
      await writable.write(item.filename);
      let crc = 0xffffffff;
      for (let offset = 0; offset < item.size; offset += BLOCK_BYTES) {
        check(signal);
        const block = await chunkOf(item.bytes, offset, Math.min(item.size, offset + BLOCK_BYTES));
        check(signal);
        crc = updateCrc(crc, block);
        await writable.write(block);
        loaded += block.length;
        onProgress?.({ loaded, total: prepared.size, verifying: false });
      }
      item.crc = (crc ^ 0xffffffff) >>> 0;
      const expected = item.bytes instanceof Blob ? archiveMediaCrc32(item.bytes) : undefined;
      if (expected !== undefined && expected !== item.crc) throw invalid();
      await writable.seek(item.offset);
      await writable.write(zipLocalHeader(item));
      await writable.seek(item.offset + 30 + item.filename.length + item.size);
      loaded += 30 + item.filename.length;
    }
    for (const item of prepared.files) {
      check(signal);
      await writable.write(zipCentralHeader(item));
      await writable.write(item.filename);
    }
    await writable.write(zipEndHeader(prepared.files, prepared.localSize, prepared.centralSize));
    check(signal);
    await writable.close();
    closed = true;
    const file = await handle.getFile();
    await verifyWrittenZip(file, prepared, { signal, onProgress });
    return { size: prepared.size, entries: prepared.files.length };
  } catch (error) {
    if (writable && !closed) try { await writable.abort(); } catch { /* Keep the original failure. */ }
    if (error.name === 'AbortError' || error.code === 'zip_verification') throw error;
    throw Object.assign(new Error(closed ? 'Не удалось проверить сохранённый ZIP. Повторите скачивание. Если ошибка повторится, скачайте отчёт и пришлите нам.'
      : 'Не удалось сохранить ZIP. Проверьте свободное место и доступ к выбранному файлу, затем повторите скачивание.'),
    { code: closed ? 'zip_verification' : 'zip_write', cause: error });
  }
}
