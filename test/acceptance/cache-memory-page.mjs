import { createExportSpool } from './src/lib/export-spool.js';
import { downloadExportMedia } from './src/ui/export-media.js';

const MIB = 1024 * 1024, FILE_BYTES = 4 * MIB, CHUNK = 64 * 1024;
let measurements;
const arrayBuffer = Blob.prototype.arrayBuffer;
Blob.prototype.arrayBuffer = function () {
  if (measurements) {
    measurements.largestRead = Math.max(measurements.largestRead, this.size);
    if (this.size > MIB) { measurements.wholeReads++; throw new Error('Whole-file reads above 1 MiB are forbidden'); }
  }
  return arrayBuffer.call(this);
};

globalThis.startCacheMemoryCase = count => {
  globalThis.cacheMemoryState = { done: false };
  void run(count).then(result => { globalThis.cacheMemoryState = { done: true, result }; }, error => {
    globalThis.cacheMemoryState = { done: true, error: { message: error.message, stack: error.stack } };
  });
};

async function run(count) {
  measurements = { largestRead: 0, largestWrite: 0, wholeReads: 0, networkBytes: 0, fullResponses: 0,
    validatedResponses: 0, active: 0, peakActive: 0 };
  const stats = measurements, started = performance.now();
  const spool = await createExportSpool();
  const instrumented = { ...spool, async open(name) {
    const writer = await spool.open(name);
    return { async write(bytes) {
      stats.largestWrite = Math.max(stats.largestWrite, bytes.byteLength || bytes.size || 0);
      return writer.write(bytes);
    }, close: () => writer.close(), abort: () => writer.abort() };
  } };
  const resources = { sample: async () => {}, check() {}, acquireDownload: async () => () => {},
    recordWrite() {}, recordDownload() {}, admitImage: async () => false };
  const candidates = Array.from({ length: count }, (_, index) => ({ id: `asset-${index + 1}`,
    name: `fixture-${index}.pdf`, url: `https://cdn.example.org/cache-qa/fixture-${index}.pdf` }));
  let progress;
  try {
    const files = await downloadExportMedia(candidates, { spool: instrumented, resources, hasPermission: async () => true,
      maxTotalBytes: 4_000_000_000, onProgress(value) { progress = value; },
      async fetchFile(url, options = {}) {
        const index = Number(new URL(url).pathname.match(/fixture-(\d+)\.pdf$/)[1]);
        const etag = `"fixture-${index}-v1"`;
        if (new Headers(options.headers).get('If-None-Match') === etag) {
          stats.validatedResponses++;
          return new Response(null, { status: 304, headers: { ETag: etag } });
        }
        stats.fullResponses++; stats.active++; stats.peakActive = Math.max(stats.peakActive, stats.active);
        let sent = 0;
        return new Response(new ReadableStream({ pull(controller) {
          if (sent === FILE_BYTES) { stats.active--; controller.close(); return; }
          const block = new Uint8Array(Math.min(CHUNK, FILE_BYTES - sent)); block.fill(index + 1);
          sent += block.byteLength; stats.networkBytes += block.byteLength; controller.enqueue(block);
        } }), { headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(FILE_BYTES), ETag: etag } });
      } });
    if (files.length !== count || files.some(file => file.status !== 'downloaded' || file.data.size !== FILE_BYTES)) throw new Error('A media file was lost');
    return { count, fileBytes: FILE_BYTES, totalBytes: count * FILE_BYTES, ...stats,
      cacheHits: progress?.cacheHits || 0, cacheReused: progress?.cacheReused || 0,
      elapsedMs: Math.round(performance.now() - started) };
  } finally { measurements = null; await spool.dispose(); }
}

globalThis.runRealCacheChecks = async () => {
  const { runPreparedMediaCacheChecks } = await import('./test/prepared-media-cache-checks.js');
  return runPreparedMediaCacheChecks({});
};
