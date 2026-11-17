import { readMediaResponse, MAX_MEDIA_BYTES } from './assets.js';
import { buildMediaRequestUrls } from '../lib/media-request-urls.js';
import { createExportResources } from '../lib/export-resources.js';
import { createWebpOptimizer } from '../lib/webp-optimizer.js';
import { inspectRasterImage, rasterImageSource } from '../lib/raster-image-metadata.js';
import { acceptsImportOriginal } from '../lib/import-original-admission.js';
import { hashArchiveMedia } from '../lib/media-sha256.js';
import { archiveSizeError } from '../lib/archive.js';
import { safeFilename } from '../lib/security.js';
import { emitMediaDiagnostic } from '../lib/media-response-diagnostics.js';
import { strongMediaEtag } from '../lib/prepared-media-cache.js';

const FATAL = new Set(['storage_error', 'storage_unavailable', 'export_resources', 'archive_limit', 'incomplete_export']);
const IO_BYTES = 1024 * 1024;
const cancel = () => new DOMException('Скачивание отменено.', 'AbortError');

function readyQueue(signal) {
  const queue = [], waiting = new Set();
  let closed = false;
  const wake = () => { for (const resolve of waiting) resolve(); waiting.clear(); };
  const check = () => signal.throwIfAborted();
  const wait = async () => { check(); await new Promise(resolve => waiting.add(resolve)); check(); };
  signal.addEventListener('abort', wake, { once: true });
  return {
    get size() { return queue.length; },
    async push(item) { while (queue.length >= 2) await wait(); check(); queue.push(item); wake(); },
    async pop() { while (!queue.length && !closed) await wait(); check(); const item = queue.shift(); wake(); return item; },
    close() { closed = true; wake(); },
    dispose() { signal.removeEventListener('abort', wake); },
  };
}

function retryAfter(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(cancel()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Network producers persist originals; one consumer prepares disk-backed outputs. */
export async function downloadDiskMedia(candidates, { spool, signal, resources: suppliedResources,
  maxFileBytes = MAX_MEDIA_BYTES, maxTotalBytes = Infinity, timeoutMs = 45000, retryDelayMs = 300,
  fetchFile = globalThis.fetch, hasPermission = async () => true, onProgress, onDiagnostic, onCodecFailure,
  allowCodec = true, mediaCache, createOptimizer = options => createWebpOptimizer(options) } = {}) {
  const operation = new AbortController();
  const abort = () => operation.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) operation.abort();
  let fatal;
  const resources = suppliedResources || createExportResources({ signal: operation.signal,
    onPressure: error => { fatal ||= error; operation.abort(); } });
  const optimizer = createOptimizer({ signal: operation.signal, onFailure: onCodecFailure });
  const queue = readyQueue(operation.signal), results = new Array(candidates.length);
  const requests = buildMediaRequestUrls(candidates), groupsByURL = new Map(), permission = new Map();
  const active = new Map(), sources = new Map(), outputs = new Map();
  let next = 0, completed = 0, missing = 0, transferred = 0, retained = 0, encoding = 0, originalImages = 0, cacheHits = 0, cacheReused = 0;
  const check = () => {
    if (fatal) throw fatal;
    operation.signal.throwIfAborted(); resources.check?.();
  };
  const report = () => onProgress?.({ completed, total: candidates.length, loadedBytes: transferred, missingFiles: missing,
    retainedBytes: retained, active: [...active.values()], encoding, originalImages, cacheHits, cacheReused });
  const cached = async (method, ...arguments_) => {
    try { return await mediaCache?.[method]?.(...arguments_); }
    catch (error) {
      check();
      // Writes into the actual attempt spool retain their existing fatal behavior.
      if (error.code === 'storage_error') throw error;
      return null;
    }
  };
  const diagnose = (asset, url, status, details = {}) => emitMediaDiagnostic(onDiagnostic, {
    assetId: asset.id, url, sourcePage: asset.sourcePage, status, ...details,
  });
  const fail = (group, error, details = {}) => {
    for (const index of group.indices) {
      results[index] = { ...candidates[index], status: 'failed', error: error.message || 'Не удалось получить файл.' };
      diagnose(candidates[index], group.url, 'failed', { ...details, reason: error.reason || 'download_failed' });
      completed++;
      missing++;
    }
    report(); check();
  };
  for (let index = 0; index < candidates.length; index++) {
    const asset = candidates[index], request = requests.get(asset.url);
    if (asset.downloadUnavailable || request?.reason) {
      const status = asset.downloadUnavailable ? 'unavailable' : 'failed';
      results[index] = { ...asset, status, error: asset.downloadUnavailable
        ? 'Файл доступен только по временной ссылке. Скачайте его на исходной платформе.'
        : 'Не удалось однозначно определить адрес файла: в книге найдены разные ссылки.' };
      diagnose(asset, asset.url, status, { reason: request?.reason || 'temporary_url' });
      completed++;
      missing++;
      continue;
    }
    const url = request?.url || asset.url;
    if (!groupsByURL.has(url)) groupsByURL.set(url, { url, indices: [], name: `source-${index}.bin` });
    groupsByURL.get(url).indices.push(index);
  }
  const groups = [...groupsByURL.values()];
  async function fetchGroup(group) {
    const first = group.indices[0], asset = candidates[first];
    const origin = `${new URL(group.url).origin}/*`;
    if (!permission.has(origin)) permission.set(origin, Promise.resolve().then(() => hasPermission(origin)));
    if (!await permission.get(origin)) {
      for (const index of group.indices) {
        results[index] = { ...candidates[index], status: 'skipped', error: 'Не разрешён доступ к серверу файла.' };
        diagnose(candidates[index], group.url, 'skipped', { reason: 'permission_denied' }); completed++; missing++;
      }
      report(); check(); return;
    }
    const release = await resources.acquireDownload();
    try {
      let previous = await cached('lookup', group.url);
      for (let attempt = 1; attempt <= 3; attempt++) {
        check();
        const controller = new AbortController(), abortFile = () => controller.abort();
        operation.signal.addEventListener('abort', abortFile, { once: true });
        let timer, writer;
        const restart = () => { clearTimeout(timer); timer = setTimeout(abortFile, timeoutMs); };
        const started = performance.now(), details = { attempt, receivedBytes: 0 };
        restart();
        diagnose(asset, group.url, 'started', details);
        active.set(first, { name: asset.name, loaded: 0, total: undefined }); report();
        try {
          const etag = strongMediaEtag(previous?.etag);
          const request = { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', signal: controller.signal };
          let response = await fetchFile(group.url, { ...request, ...(etag ? { headers: { 'If-None-Match': etag } } : {}) });
          if (response.status === 304 && etag) {
            if (previous.sourceSize > maxFileBytes) throw Object.assign(new Error('Превышен лимит размера файла.'), { reason: 'file_limit' });
            const prepared = await cached('restore', previous, spool, group.name, { signal: operation.signal, onWrite: ms => resources.recordWrite?.(ms) });
            if (prepared) {
              group.prepared = prepared;
              group.source = { hash: previous.sourceHash, size: previous.sourceSize, etag };
              group.details = { ...details, httpStatus: 304, elapsedMs: Math.round(performance.now() - started) };
              cacheHits++; report();
              return group;
            }
            // A 304 cannot repair missing or corrupt local bytes. Fetch the full source once.
            await response.body?.cancel().catch(() => {});
            previous = null;
            response = await fetchFile(group.url, request);
          }
          group.etag = strongMediaEtag(response.headers.get('etag'));
          details.httpStatus = response.status;
          details.mimeType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
          const declared = response.headers.get('content-length')?.trim() || '';
          if (/^\d+$/.test(declared) && Number.isSafeInteger(Number(declared))) details.declaredBytes = Number(declared);
          if (attempt < 3 && [429, 500, 502, 503, 504].includes(response.status)) {
            await response.body?.cancel().catch(() => {});
            diagnose(asset, group.url, 'retrying', { ...details, reason: 'http_error' });
          } else {
            writer = await spool.open(group.name);
            const file = await readMediaResponse(response, { signal: controller.signal, maxBytes: maxFileBytes,
              diagnostic: details, destination: writer, onWrite: ms => resources.recordWrite?.(ms), onProgress: ({ loaded, total }) => {
                check(); const previous = active.get(first); transferred += loaded - previous.loaded;
                details.receivedBytes = loaded; active.set(first, { name: asset.name, loaded, total }); restart(); report();
              } });
            check();
            group.mimeType = file.mimeType;
            group.details = { ...details, elapsedMs: Math.round(performance.now() - started) };
            resources.recordDownload?.(queue.size);
            return group;
          }
        } catch (error) {
          if (writer) try { await writer.abort(); } catch { /* The real error wins. */ }
          if (FATAL.has(error.code) || operation.signal.aborted) throw error;
          if (controller.signal.aborted) throw Object.assign(new Error('Сервер файла долго не передавал данные. Повторите скачивание.'), { reason: 'timeout' });
          if (!(error instanceof TypeError) || attempt === 3) throw error;
          diagnose(asset, group.url, 'retrying', { ...details, reason: 'network_error' });
        } finally {
          clearTimeout(timer); controller.abort(); operation.signal.removeEventListener('abort', abortFile);
          active.delete(first); report();
        }
        await spool.remove(group.name);
        await retryAfter(retryDelayMs * attempt, operation.signal);
      }
    } finally { release(); }
  }
  async function downloadWorker() {
    while (next < groups.length) {
      check(); const group = groups[next++];
      try { const downloaded = await fetchGroup(group); if (downloaded) await queue.push(downloaded); }
      catch (error) {
        if (FATAL.has(error.code) || operation.signal.aborted) throw error;
        await spool.remove(group.name); fail(group, error);
      }
    }
  }
  async function persistOutput(name, blob) {
    const writer = await spool.open(name);
    try {
      for (let offset = 0; offset < blob.size; offset += IO_BYTES) {
        check(); const bytes = new Uint8Array(await blob.slice(offset, offset + IO_BYTES).arrayBuffer());
        const started = performance.now(); await writer.write(bytes); resources.recordWrite?.(performance.now() - started);
      }
      await writer.close(); return await spool.file(name);
    } catch (error) { try { await writer.abort(); } catch { /* Keep the real failure. */ } throw error; }
  }
  async function prepare(group) {
    let file = group.prepared?.file;
    try { file ||= { data: await spool.file(group.name), mimeType: group.mimeType }; }
    catch (error) { throw Object.assign(error, { code: error.code || 'storage_error' }); }
    let sourceKey;
    try {
      group.source ||= { hash: await hashArchiveMedia(file.data, operation.signal), size: file.data.size, etag: group.etag };
      sourceKey = `${group.source.size}:${group.source.hash}`;
    }
    catch (error) { throw Object.assign(error, { code: error.code || 'storage_error' }); }
    if (sources.has(sourceKey)) {
      const prepared = sources.get(sourceKey);
      await spool.remove(group.name);
      await cached('put', group.url, group.source, prepared, { signal: operation.signal, onWrite: ms => resources.recordWrite?.(ms) });
      return prepared;
    }
    if (!group.prepared) {
      group.prepared = await cached('restoreSource', group.source.hash, group.source.size, spool, group.name,
        { signal: operation.signal, onWrite: ms => resources.recordWrite?.(ms) });
      if (group.prepared) { file = group.prepared.file; cacheReused++; report(); }
    }
    let metadata;
    try { if (!group.prepared) metadata = await inspectRasterImage(file.data, file.mimeType); }
    catch (error) { if (!error.reason) error.code ||= 'storage_error'; throw error; }
    let converted = group.prepared?.converted || false, originalImage = group.prepared?.originalImage || false;
    let storedName = group.name;
    if (metadata) {
      if (metadata.pngBytes) {
        group.details = { ...group.details, normalization: 'png_trailing_bytes_removed', removedBytes: file.data.size - metadata.pngBytes };
        file = { ...file, data: await persistOutput(`normalized-${group.indices[0]}.png`, rasterImageSource(file.data, metadata)), mimeType: metadata.mimeType };
        storedName = `normalized-${group.indices[0]}.png`;
        await spool.remove(group.name);
      }
      if (!allowCodec || !await resources.admitImage(metadata, file.data.size)) {
        let accepted;
        try { accepted = await acceptsImportOriginal(file.data, metadata); }
        catch (error) { error.code ||= 'storage_error'; throw error; }
        if (!accepted) {
          const asset = candidates[group.indices[0]];
          diagnose(asset, group.url, 'failed', { ...group.details, reason: 'export_resources' });
          throw Object.assign(new Error(`Для обработки изображения «${safeFilename(asset.name || 'изображение')}» не хватает свободной памяти. Сохранить его без сжатия нельзя. Закройте лишние приложения и повторите скачивание. Если ошибка повторится, скачайте отчёт и пришлите нам.`), { code: 'export_resources' });
        }
        file.mimeType = metadata.mimeType; originalImage = true;
      } else {
        encoding++; report();
        try {
          const selected = await optimizer.optimize(file, { signal: operation.signal });
          converted = selected.mimeType !== file.mimeType || selected.data !== file.data;
          if (selected.data === file.data) file = selected;
          else {
            const name = `prepared-${group.indices[0]}.webp`;
            file = { ...selected, data: await persistOutput(name, selected.data) };
            await spool.remove(storedName);
            storedName = name;
          }
        } finally { encoding--; report(); }
      }
    }
    let outputKey;
    try { outputKey = `${file.data.size}:${await hashArchiveMedia(file.data, operation.signal)}`; }
    catch (error) { throw Object.assign(error, { code: error.code || 'storage_error' }); }
    if (outputs.has(outputKey)) { file = { ...file, data: outputs.get(outputKey) }; await spool.remove(storedName); }
    else {
      if (file.data.size > maxTotalBytes - retained) throw archiveSizeError();
      retained += file.data.size; outputs.set(outputKey, file.data);
    }
    const prepared = { file, converted, originalImage };
    sources.set(sourceKey, prepared);
    await cached('put', group.url, group.source, prepared, { signal: operation.signal, onWrite: ms => resources.recordWrite?.(ms) });
    return prepared;
  }
  async function prepareWorker() {
    for (;;) {
      const group = await queue.pop();
      if (!group) return;
      try {
        const { file, converted, originalImage } = await prepare(group);
        for (const index of group.indices) {
          const asset = candidates[index];
          results[index] = { ...asset, ...file, status: 'downloaded', ...(originalImage ? { originalImage: true } : {}),
            ...(converted ? { name: safeFilename(`${safeFilename(asset.name || asset.url).replace(/\.[^.]+$/, '')}.webp`, 'image.webp') } : {}) };
          if (originalImage) originalImages++;
          diagnose(asset, group.url, 'downloaded', { ...group.details, ...(index === group.indices[0] ? {} : { receivedBytes: 0 }) }); completed++;
        }
        report();
      } catch (error) {
        if (FATAL.has(error.code) || operation.signal.aborted) throw error;
        await spool.remove(group.name); fail(group, error, group.details);
      }
    }
  }
  const guard = work => work.catch(error => { fatal ||= error; operation.abort(); queue.close(); throw error; });
  try {
    await resources.sample(); check(); report();
    const preparing = guard(prepareWorker());
    const downloading = Promise.allSettled(Array.from({ length: Math.min(6, groups.length) }, () => guard(downloadWorker()))).then(outcomes => {
      queue.close(); const rejected = outcomes.find(result => result.status === 'rejected'); if (rejected) throw rejected.reason;
    });
    const outcomes = await Promise.allSettled([preparing, downloading]);
    const rejected = outcomes.find(result => result.status === 'rejected');
    if (rejected) throw fatal || rejected.reason;
    check(); return results;
  } catch (error) {
    throw fatal || error;
  } finally {
    operation.abort(); queue.close(); queue.dispose(); optimizer.close();
    if (!suppliedResources) resources.close();
    signal?.removeEventListener('abort', abort);
  }
}
