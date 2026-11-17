import { hashArchiveMedia } from './media-sha256.js';
import { isSafeMediaUrl } from './security.js';

const DIRECTORY = 'export-media-cache-v1';
const RECORDS = 'prepared-media';
const LOCK = 'thedeshar-exporter-media-cache';
const BLOCK_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 100 * BLOCK_BYTES;
const HEX = /^[a-f0-9]{64}$/;
// Bump the transform version whenever decode, resize, animation or original admission changes.
export const PREPARED_MEDIA_POLICY = 'fullhd-srgb-lossless-v2-png-prefix:73ab61ce20c59d0ea488896dc03262c74f83a4939a704be0657f1237736904ba';

export const strongMediaEtag = value => typeof value === 'string' && value.length <= 1024 && /^"[^"\u0000-\u0020\u007f]*"$/.test(value) ? value : null;

function validEntry(entry, policy) {
  return entry && HEX.test(entry.key) && HEX.test(entry.sourceHash) && HEX.test(entry.outputHash) && entry.policy === policy &&
    [entry.sourceSize, entry.size].every(size => Number.isSafeInteger(size) && size > 0 && size <= MAX_FILE_BYTES) &&
    entry.fileName === `media-${entry.outputHash}-${entry.size}` && Number.isFinite(entry.usedAt) &&
    typeof entry.mimeType === 'string' && entry.mimeType.length <= 128 &&
    typeof entry.converted === 'boolean' && typeof entry.originalImage === 'boolean';
}

function openDatabase(indexedDB, name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(RECORDS, { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function readEntries(database, policy, limit) {
  return new Promise((resolve, reject) => {
    const entries = [], transaction = database.transaction(RECORDS, 'readwrite');
    const request = transaction.objectStore(RECORDS).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const entry = cursor.value;
      if (entries.length < limit && validEntry(entry, policy)) {
        const { key, sourceHash, outputHash, sourceSize, size, fileName, usedAt, mimeType, converted, originalImage, etag } = entry;
        entries.push({ key, sourceHash, outputHash, sourceSize, size, fileName, usedAt, mimeType, converted, originalImage, etag: strongMediaEtag(etag), policy });
      } else cursor.delete();
      cursor.continue();
    };
    transaction.oncomplete = () => resolve(entries);
    transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('Media cache index unavailable'));
  });
}

function updateEntries(database, remove, put) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(RECORDS, 'readwrite'), store = transaction.objectStore(RECORDS);
    for (const key of remove) store.delete(key);
    if (put) store.put(put);
    transaction.oncomplete = resolve;
    transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('Media cache transaction failed'));
  });
}

async function copyFile(file, writer, signal, onWrite) {
  try {
    for (let offset = 0; offset < file.size; offset += BLOCK_BYTES) {
      signal?.throwIfAborted();
      const block = new Uint8Array(await file.slice(offset, offset + BLOCK_BYTES).arrayBuffer());
      const started = performance.now();
      await writer.write(block); onWrite?.(performance.now() - started);
    }
    signal?.throwIfAborted(); await writer.close();
  } catch (error) { try { await writer.abort(); } catch { /* Preserve the copy failure. */ } throw error; }
}

/** An exclusive lease spans one media stage; cache hits are copied into its private spool. */
export async function createPreparedMediaCache({ indexedDB = globalThis.indexedDB, storage = globalThis.navigator?.storage,
  locks = globalThis.navigator?.locks, signal, databaseName = 'deshar-prepared-media-cache',
  maxBytes = 8_000_000_000, maxEntries = 20_000, now = () => Date.now(), policy = PREPARED_MEDIA_POLICY } = {}) {
  if (!indexedDB?.open || !storage?.getDirectory || !locks?.request) return null;
  signal?.throwIfAborted();
  maxBytes = Math.max(0, Math.min(8_000_000_000, Math.trunc(maxBytes) || 0));
  maxEntries = Math.max(0, Math.min(20_000, Math.trunc(maxEntries) || 0));
  let ready, failed, release;
  const available = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
  const held = new Promise(resolve => { release = resolve; });
  const lease = Promise.resolve().then(() => locks.request(LOCK, { mode: 'exclusive', ...(signal ? { signal } : {}) }, async () => {
    let database;
    try {
      database = await openDatabase(indexedDB, databaseName);
      const directory = await (await storage.getDirectory()).getDirectoryHandle(DIRECTORY, { create: true });
      const stored = await readEntries(database, policy, maxEntries), entries = new Map(), bySource = new Map(), files = new Map();
      let pending = Promise.resolve(), closed = false, usedBytes = 0, writable = true;
      const sourceKey = entry => `${entry.sourceHash}:${entry.sourceSize}`;
      const attach = entry => {
        entries.set(entry.key, entry);
        const source = sourceKey(entry);
        if (!bySource.has(source)) bySource.set(source, new Set());
        bySource.get(source).add(entry.key);
        if (!files.has(entry.fileName)) { files.set(entry.fileName, { size: entry.size, keys: new Set() }); usedBytes += entry.size; }
        files.get(entry.fileName).keys.add(entry.key);
      };
      const detach = key => {
        const entry = entries.get(key);
        if (!entry) return;
        entries.delete(key);
        const source = sourceKey(entry), refs = bySource.get(source);
        refs.delete(key); if (!refs.size) bySource.delete(source);
        const file = files.get(entry.fileName);
        file.keys.delete(key);
        if (!file.keys.size) { usedBytes -= file.size; files.delete(entry.fileName); }
      };
      const check = operationSignal => { signal?.throwIfAborted(); operationSignal?.throwIfAborted(); };
      const run = operation => {
        const result = pending.then(() => { if (closed) throw new Error('Media cache closed'); return operation(); });
        pending = result.catch(() => {}); return result;
      };
      const removeFiles = async names => {
        for (const name of new Set(names)) if (!files.has(name)) {
          try { await directory.removeEntry(name); }
          catch (error) { if (error.name !== 'NotFoundError') writable = false; }
        }
      };
      const removeEntries = async keys => {
        const names = keys.map(key => entries.get(key)?.fileName).filter(Boolean);
        await updateEntries(database, keys);
        for (const key of keys) detach(key);
        await removeFiles(names);
      };
      const evict = async (size, count, extraBytes = 0) => {
        let freed = 0, remainingBytes = usedBytes, remainingEntries = entries.size;
        const removed = [], remainingRefs = new Map();
        for (const entry of entries.values()) {
          if (remainingBytes + size <= maxBytes && remainingEntries + count <= maxEntries && freed >= extraBytes) break;
          removed.push(entry.key); remainingEntries--;
          const refs = (remainingRefs.get(entry.fileName) ?? files.get(entry.fileName).keys.size) - 1;
          remainingRefs.set(entry.fileName, refs);
          if (!refs) { remainingBytes -= entry.size; freed += entry.size; }
        }
        if (removed.length) await removeEntries(removed);
        return removed.length > 0;
      };
      for (const entry of stored.sort((a, b) => a.usedAt - b.usedAt)) attach(entry);
      await evict(0, 0);
      const referenced = new Set(files.keys());
      if (directory.entries) for await (const [name, item] of directory.entries()) {
        if (item.kind === 'file' && !referenced.has(name)) {
          try { await directory.removeEntry(name); } catch (error) { if (error.name !== 'NotFoundError') writable = false; }
        }
      }
      check();
      const keyFor = async url => {
        if (!isSafeMediaUrl(url)) return null;
        const selected = new URL(url); selected.hash = '';
        return hashArchiveMedia(new Blob([selected.href]), signal);
      };
      const restoreEntry = async (entry, spool, name, options = {}) => {
        const { signal: operationSignal, onWrite } = options;
        check(operationSignal);
        const current = entries.get(entry?.key);
        if (!current || current.fileName !== entry.fileName) return null;
        let file;
        try {
          file = await (await directory.getFileHandle(current.fileName)).getFile();
          if (file.size !== current.size || await hashArchiveMedia(file, operationSignal) !== current.outputHash) throw new Error('Invalid cached media');
        } catch (error) {
          check(operationSignal);
          await removeEntries([...files.get(current.fileName).keys]);
          return null;
        }
        // Never return an OPFS cache File: eviction must not invalidate a later ZIP read.
        await copyFile(file, await spool.open(name), operationSignal, onWrite);
        const restored = await spool.file(name);
        if (restored.size !== current.size || await hashArchiveMedia(restored, operationSignal) !== current.outputHash) {
          await spool.remove(name);
          await removeEntries([...files.get(current.fileName).keys]);
          return null;
        }
        const touched = { ...current, usedAt: now() };
        try { await updateEntries(database, [], touched); } catch { /* The copied result remains authoritative for this export. */ }
        entries.delete(current.key); entries.set(current.key, touched);
        return { file: { data: restored, mimeType: current.mimeType }, converted: current.converted, originalImage: current.originalImage };
      };
      ready({
        async lookup(url) {
          return run(async () => { check(); const key = await keyFor(url); return entries.has(key) ? { ...entries.get(key) } : null; });
        },
        restore(entry, spool, name, options) { return run(() => restoreEntry(entry, spool, name, options)); },
        restoreSource(hash, size, spool, name, options) {
          return run(() => restoreEntry(entries.get(bySource.get(`${hash}:${size}`)?.values().next().value), spool, name, options));
        },
        async put(url, source, prepared, { signal: operationSignal, onWrite } = {}) {
          return run(async () => {
            let fileName, created = false;
            try {
              check(operationSignal);
              const key = await keyFor(url), file = prepared.file.data;
              if (!writable || !key || !HEX.test(source.hash) || !Number.isSafeInteger(source.size) || source.size <= 0 || source.size > MAX_FILE_BYTES ||
                !file.size || file.size > Math.min(MAX_FILE_BYTES, maxBytes) || maxEntries < 1) return false;
              const outputHash = await hashArchiveMedia(file, operationSignal);
              fileName = `media-${outputHash}-${file.size}`;
              let shared = files.has(fileName);
              await evict(shared ? 0 : file.size, entries.has(key) ? 0 : 1);
              shared = files.has(fileName);
              if (!shared) {
                await evict(file.size, entries.has(key) ? 0 : 1);
                if (!writable) return false;
                created = true;
                const write = async () => {
                  const handle = await directory.getFileHandle(fileName, { create: true });
                  await copyFile(file, await handle.createWritable(), operationSignal, onWrite);
                  const saved = await handle.getFile();
                  if (saved.size !== file.size || await hashArchiveMedia(saved, operationSignal) !== outputHash) throw new Error('Invalid cache write');
                };
                try { await write(); }
                catch (error) {
                  if (error.name !== 'QuotaExceededError' || !await evict(0, 0, file.size)) throw error;
                  await write();
                }
              }
              check(operationSignal);
              const previous = entries.get(key);
              const record = { key, policy, fileName, sourceHash: source.hash, sourceSize: source.size,
                etag: strongMediaEtag(source.etag), outputHash, size: file.size, mimeType: prepared.file.mimeType,
                converted: prepared.converted === true, originalImage: prepared.originalImage === true, usedAt: now() };
              await updateEntries(database, [], record);
              detach(key); attach(record);
              if (previous) await removeFiles([previous.fileName]);
              return true;
            } catch (error) {
              if (created && fileName) await removeFiles([fileName]);
              check(operationSignal); return false;
            }
          });
        },
        async close() { await pending; closed = true; release(); await lease; },
      });
      await held;
    } catch (error) { failed(error); }
    finally { database?.close(); }
  }));
  lease.catch(failed);
  return available;
}
