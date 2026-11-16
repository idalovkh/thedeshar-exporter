import { createExportPackage, assertAssetCapacity } from '../lib/package.js';
import { redactSensitive } from '../lib/security.js';
import { collectAssets } from './assets.js';

const changed = () => Object.assign(new Error('Собранная книга изменилась. Дождитесь завершения сбора и скачайте архив ещё раз.'), { code: 'export_changed' });
const invalid = () => new Error('Не удалось прочитать часть собранной книги. Попробуйте скачать архив ещё раз.');
const snapshotFields = ['url', 'sourceUrl', 'pageUrl', 'title', 'lessonTitle', 'capturedAt', 'receivedAt', 'pageType', 'kind', 'coverUrl', 'route', 'links', 'materialLinks', 'warnings'];
const captureFields = ['kind', 'url', 'sourceUrl', 'pageUrl', 'receivedAt', 'capturedAt'];
const pick = (record, fields) => Object.fromEntries(fields.filter(field => record[field] !== undefined).map(field => [field, record[field]]));

async function writeRecord(spool, name, record, signal) {
  const text = `${JSON.stringify(redactSensitive(record))}\n`;
  const writer = await spool.open(name);
  const encoder = new TextEncoder();
  try {
    for (let start = 0; start < text.length;) {
      signal?.throwIfAborted();
      let end = Math.min(text.length, start + 256 * 1024);
      // Never split a surrogate pair between TextEncoder calls.
      if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
      await writer.write(encoder.encode(text.slice(start, end)));
      start = end;
    }
    await writer.close();
    return await spool.file(name);
  } catch (error) {
    try { await writer.abort(); } catch { /* Preserve the read/write error. */ }
    throw error;
  }
}

/** Package one committed record at a time, retaining only inventory metadata. */
export async function prepareDiskExport(summary, { send, spool, signal, source, onProgress } = {}) {
  if (!Number.isSafeInteger(summary.exportRevision) || summary.exportRevision < 0)
    throw Object.assign(new Error('Не удалось определить версию собранной книги. Обновите расширение и повторите сбор.'), { code: 'invalid_export_revision' });
  signal?.throwIfAborted();
  const info = await send('GET_EXPORT_INFO');
  if (info.revision !== summary.exportRevision) throw changed();
  if (![info.snapshotCount, info.captureCount].every(count => Number.isSafeInteger(count) && count >= 0 && count <= 20000)) throw invalid();
  const state = { ...summary, snapshots: [], captures: [] };
  const originals = new Map(), found = new Map();
  let loaded = 0;
  const total = info.snapshotCount + info.captureCount;
  onProgress?.({ loaded, total });
  for (const [kind, count, directory] of [['snapshots', info.snapshotCount, 'pages'], ['captures', info.captureCount, 'responses']]) {
    let offset = 0;
    while (offset < count) {
      signal?.throwIfAborted();
      const batch = await send('GET_EXPORT_RECORDS', { kind, offset, limit: 1, revision: info.revision });
      signal?.throwIfAborted();
      if (batch.revision !== info.revision) throw changed();
      if (batch.total !== count || batch.nextOffset !== offset + 1 || !Array.isArray(batch.records) || batch.records.length !== 1) throw invalid();
      const record = batch.records[0];
      if (!record || typeof record !== 'object') throw invalid();
      const number = String(offset + 1).padStart(5, '0');
      originals.set(`originals/${directory}/${number}.json`, await writeRecord(spool, `${directory}-${number}.json`, record, signal));
      const assets = kind === 'snapshots' ? collectAssets([record]) : collectAssets([], [record]);
      for (const asset of assets) {
        if (!found.has(asset.url)) found.set(asset.url, { ...asset, id: `asset-${String(found.size + 1).padStart(4, '0')}` });
        else if (!found.get(asset.url).sourcePage && asset.sourcePage) found.get(asset.url).sourcePage = asset.sourcePage;
      }
      assertAssetCapacity([...found.values()]);
      state[kind].push(kind === 'snapshots' ? pick(record, snapshotFields) : {
        ...pick(record, captureFields), data: record.data != null ? true : null,
      });
      offset = batch.nextOffset;
      onProgress?.({ loaded: ++loaded, total });
    }
  }
  const assets = [...found.values()];
  const prepared = createExportPackage({ snapshots: state.snapshots, captures: state.captures, assets, source,
    dropped: state.dropped, collection: state.collection,
    warnings: [...(state.warnings || []), ...state.snapshots.flatMap(snapshot => snapshot.warnings || [])] });
  prepared.entries = prepared.entries.map(entry => originals.has(entry.name) ? { ...entry, data: originals.get(entry.name) } : entry);
  return { prepared, assets, state, revision: info.revision };
}
