import { createPreparedMediaCache } from '../src/lib/prepared-media-cache.js';
import { createExportSpool } from '../src/lib/export-spool.js';
import { hashArchiveMedia } from '../src/lib/media-sha256.js';
import { downloadDiskMedia } from '../src/ui/download-disk-media.js';

/** Real IndexedDB/OPFS checks for an isolated extension QA page; no source/CDN access. */
export async function runPreparedMediaCacheChecks({ onCase = () => {} } = {}) {
  const id = crypto.randomUUID(), databaseName = `prepared-media-qa-${id}`;
  const cacheDirectory = `prepared-media-qa-${id}`, spoolDirectory = `prepared-spool-qa-${id}`;
  const root = await navigator.storage.getDirectory(), cases = [];
  const stats = { largestWrite: 0, largestSlice: 0, wholeReads: 0, simulatedQuotaFailures: 0 };
  let failCacheWrites = 0, encoded = 0, cache;
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const guardedFile = file => new Proxy(file, { get(target, key) {
    if (key === 'arrayBuffer') return () => { stats.wholeReads++; throw new Error('Whole OPFS reads are forbidden'); };
    if (key === 'slice') return (start = 0, end = target.size, type) => {
      stats.largestSlice = Math.max(stats.largestSlice, Math.min(end, target.size) - start);
      return target.slice(start, end, type);
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const guardedDirectory = (directory, cacheFiles = false) => ({
    kind: 'directory', entries: () => directory.entries(),
    removeEntry: (...args) => directory.removeEntry(...args),
    async getDirectoryHandle(name, options) {
      const mapped = name === 'export-media-cache-v1' ? cacheDirectory : name === 'export-spool-v1' ? spoolDirectory : name;
      return guardedDirectory(await directory.getDirectoryHandle(mapped, options), cacheFiles || mapped === cacheDirectory);
    },
    async getFileHandle(name, options) {
      const handle = await directory.getFileHandle(name, options);
      return { async getFile() { return guardedFile(await handle.getFile()); }, async createWritable() {
        const writer = await handle.createWritable();
        return { async write(bytes) {
          stats.largestWrite = Math.max(stats.largestWrite, bytes.byteLength || bytes.size || 0);
          if (cacheFiles && failCacheWrites > 0) { failCacheWrites--; stats.simulatedQuotaFailures++; throw new DOMException('Simulated cache quota', 'QuotaExceededError'); }
          await writer.write(bytes);
        }, close: () => writer.close(), abort: () => writer.abort() };
      } };
    },
  });
  const storage = { getDirectory: async () => guardedDirectory(root) };
  const open = options => createPreparedMediaCache({ databaseName, storage, ...options });
  const resources = () => ({ async sample() {}, check() {}, async acquireDownload() { return () => {}; },
    async admitImage() { return true; }, recordWrite() {}, recordDownload() {}, close() {} });
  const bytes = base64 => Uint8Array.from(atob(base64), character => character.charCodeAt(0));
  const png = bytes('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==');
  const webp = new Blob([bytes('UklGRh4AAABXRUJQVlA4TBEAAAAvBwABAAdQsvrXo/+BiOh/AAA=')], { type: 'image/webp' });
  const asset = { id: 'qa-picture', url: 'https://cdn.example.org/cache-qa.png', name: 'picture.png' };
  const response = () => new Response(png, { headers: { 'content-type': 'image/png', etag: '"qa-one"' } });
  const attempt = async fetchFile => {
    const spool = await createExportSpool({ jobId: crypto.randomUUID(), storage });
    try {
      const [file] = await downloadDiskMedia([asset], { spool, mediaCache: cache, resources: resources(), fetchFile,
        createOptimizer: () => ({ async optimize(file) { encoded++; return { ...file, data: webp, mimeType: 'image/webp' }; }, close() {} }) });
      return { status: file.status, name: file.name, mimeType: file.mimeType, hash: file.data ? await hashArchiveMedia(file.data) : null };
    } finally { await spool.dispose(); }
  };
  const run = async (name, operation) => {
    const details = await operation();
    const result = { name, passed: true, ...details }; cases.push(result); await onCase(result);
  };
  try {
    cache = await open();
    await run('reopen-200-to-304', async () => {
      const first = await attempt(async () => response());
      await cache.close(); cache = await open();
      let fetched = 0;
      const second = await attempt(async (_url, options) => {
        fetched++; check(options.headers?.['If-None-Match'] === '"qa-one"', 'Reopened cache must revalidate');
        return new Response(null, { status: 304 });
      });
      check(first.status === 'downloaded' && second.status === 'downloaded' && second.name === 'picture.webp', 'Prepared WebP was not restored');
      check(first.hash === second.hash && encoded === 1 && fetched === 1, 'Revalidation changed bytes or started another decoder');
      return { requests: fetched, encodes: encoded };
    });
    await run('missing-and-corrupt-304-recovery', async () => {
      const directory = await root.getDirectoryHandle(cacheDirectory);
      for (const corrupt of [false, true]) {
        const entry = await cache.lookup(asset.url);
        if (corrupt) {
          const writer = await (await directory.getFileHandle(entry.fileName)).createWritable();
          await writer.write(new Uint8Array(entry.size).fill(7)); await writer.close();
        } else await directory.removeEntry(entry.fileName);
        let requests = 0;
        const file = await attempt(async (_url, options) => {
          requests++;
          if (requests === 1) return new Response(null, { status: 304 });
          check(!options.headers?.['If-None-Match'], 'Recovery GET must be unconditional'); return response();
        });
        check(requests === 2 && file.status === 'downloaded', 'A missing or corrupt file did not recover');
      }
      return { recovered: 2 };
    });
    await run('http-refusal-never-serves-stale', async () => {
      const file = await attempt(async () => new Response('Denied', { status: 403 }));
      check(file.status === 'failed' && !file.hash, 'HTTP refusal used stale media'); return {};
    });
    await run('lru-and-byte-budget', async () => {
      await cache.close(); cache = await open({ maxBytes: 12, maxEntries: 2 });
      for (const suffix of ['one', 'two', 'new']) {
        const blob = new Blob([`ID3${suffix}`]);
        await cache.put(`https://cdn.example.org/${suffix}.mp3`, { hash: await hashArchiveMedia(blob), size: blob.size },
          { file: { data: blob, mimeType: 'audio/mpeg' }, converted: false, originalImage: false });
      }
      check(!await cache.lookup('https://cdn.example.org/one.mp3'), 'LRU entry survived the byte budget');
      check(Boolean(await cache.lookup('https://cdn.example.org/new.mp3')), 'Newest entry was not retained'); return {};
    });
    await run('quota-retry-and-bounded-streaming', async () => {
      await cache.close(); cache = await open();
      const blob = new Blob([new Uint8Array(2 * 1024 * 1024 + 17).fill(17)]);
      failCacheWrites = 1;
      const put = await cache.put('https://cdn.example.org/large.mp3', { hash: await hashArchiveMedia(blob), size: blob.size },
        { file: { data: blob, mimeType: 'audio/mpeg' }, converted: false, originalImage: false });
      check(put && stats.simulatedQuotaFailures === 1, 'Quota retry did not recover after eviction');
      const spool = await createExportSpool({ jobId: crypto.randomUUID(), storage });
      try {
        const restored = await cache.restore(await cache.lookup('https://cdn.example.org/large.mp3'), spool, 'large.bin');
        check(restored?.file.data.size === blob.size && await hashArchiveMedia(restored.file.data) === await hashArchiveMedia(blob), 'Large cached media changed');
      } finally { await spool.dispose(); }
      check(stats.wholeReads === 0 && stats.largestWrite <= 1024 * 1024 && stats.largestSlice <= 1024 * 1024, 'Media operations exceeded bounded chunks');
      return { ...stats };
    });
    return { passed: cases.length, cases, ...stats };
  } finally {
    await cache?.close();
    await new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase(databaseName); request.onsuccess = resolve; request.onerror = () => reject(request.error); });
    for (const name of [cacheDirectory, spoolDirectory]) try { await root.removeEntry(name, { recursive: true }); } catch { /* QA cleanup is best effort. */ }
  }
}
