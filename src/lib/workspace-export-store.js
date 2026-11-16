import { recordDownloadResult } from './record-download-result.js';

const META = 'workspace-metadata';
const RECORDS = 'workspace-records';
const changed = () => Object.assign(new Error('Собранная книга изменилась. Повторите скачивание.'), { code: 'export_changed' });

function validate(meta) {
  if (!meta) throw Object.assign(new Error('Сохранённая книга ещё не создана.'), { code: 'export_metadata_missing' });
  if (!Number.isSafeInteger(meta.storageRevision) || meta.storageRevision < 1 ||
    !['snapshotCount', 'captureCount'].every(field => Number.isSafeInteger(meta[field]) && meta[field] >= 0 && meta[field] <= 20000))
    throw new Error('Повреждены сведения о локальном сборе.');
}

/** Export operations touch metadata and individual records, never the full cache. */
export function createWorkspaceExportStore({ database, scope, releaseWorkspace }) {
  async function access(storageId, write, operation) {
    const [db, session] = await Promise.all([database(), scope()]);
    const key = `${session}:${storageId}`;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(write ? META : [META, RECORDS], write ? 'readwrite' : 'readonly');
      let result, failure;
      const fail = error => { failure = error; try { tx.abort(); } catch { /* Already aborted. */ } };
      const request = tx.objectStore(META).get(key);
      request.onsuccess = () => {
        try {
          const meta = request.result;
          validate(meta);
          operation({ meta, key, tx, done: value => { result = value; }, fail });
        } catch (error) { fail(error); }
      };
      tx.oncomplete = () => { if (write) releaseWorkspace(storageId); resolve(result); };
      tx.onerror = tx.onabort = () => reject(failure || tx.error || new Error('Не удалось прочитать сохранённую книгу.'));
    });
  }

  function readExportMetadata(storageId) {
    return access(storageId, false, ({ meta, done }) => {
      const revision = meta.state.exportRevision || 0;
      const summary = meta.exportSummary?.exportRevision === revision ? meta.exportSummary : undefined;
      done({ revision, snapshotCount: meta.snapshotCount, captureCount: meta.captureCount, summary });
    });
  }

  function saveExportSummary(storageId, summary) {
    return access(storageId, true, ({ meta, tx, done }) => {
      if (summary.exportRevision !== (meta.state.exportRevision || 0) ||
        summary.snapshots?.length !== meta.snapshotCount || summary.captures?.length !== meta.captureCount) throw changed();
      if (summary.snapshots.some(snapshot => 'blocks' in snapshot || 'html' in snapshot) ||
        summary.captures.some(capture => capture.data != null && typeof capture.data !== 'boolean'))
        throw new Error('Сводка экспорта не должна содержать исходные задания.');
      tx.objectStore(META).put({ ...meta, exportSummary: summary });
      done(summary);
    });
  }

  function readExportRecordPage(storageId, { kind, offset, limit, revision }) {
    if (!['snapshots', 'captures'].includes(kind) || !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new Error('Недопустимая страница исходных записей.');
    return access(storageId, false, ({ meta, key, tx, done, fail }) => {
      if (revision !== (meta.state.exportRevision || 0)) throw changed();
      const total = kind === 'snapshots' ? meta.snapshotCount : meta.captureCount;
      if (offset > total) throw new Error('Недопустимая страница исходных записей.');
      if (offset === total) { done({ revision, total, nextOffset: offset, records: [] }); return; }
      const request = tx.objectStore(RECORDS).get(`${key}/${kind}/${offset}`);
      request.onsuccess = () => {
        if (!request.result || !Object.hasOwn(request.result, 'value')) { fail(new Error('В локальном сборе отсутствует сохранённая запись.')); return; }
        done({ revision, total, nextOffset: offset + 1, records: [request.result.value] });
      };
    });
  }

  function recordExportResult(storageId, payload) {
    return access(storageId, true, ({ meta, tx, done }) => {
      const state = recordDownloadResult(meta.state, payload);
      state.exportRevision = (meta.state.exportRevision || 0) + 1;
      const exportSummary = meta.exportSummary?.exportRevision === payload.revision
        ? { ...meta.exportSummary, ...state } : undefined;
      tx.objectStore(META).put({ ...meta, state, storageRevision: meta.storageRevision + 1, exportSummary });
      done(exportSummary || state);
    });
  }
  return { readExportMetadata, saveExportSummary, readExportRecordPage, recordExportResult };
}
