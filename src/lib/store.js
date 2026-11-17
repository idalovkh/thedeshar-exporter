import { createWorkspace } from './state.js';
import { createWorkspaceExportStore } from './workspace-export-store.js';
import { isTrustedSourceOrigin } from './source-origins.js';
import { createDurableWorkspaceScope } from './durable-workspace-scope.js';

const META_STORE = 'workspace-metadata';
const RECORD_STORE = 'workspace-records';
const TRANSACTION_STORES = [META_STORE, RECORD_STORE];
const kinds = ['snapshots', 'captures'];
const recordKey = (workspace, kind, index) => `${workspace}/${kind}/${index}`;
const bookIdentity = book => {
  try {
    const url = new URL(book?.rootUrl);
    const match = url.pathname.match(/^\/cabinet\/(?:school|teacher)\/materials\/book\/(\d+)\/content\/?$/);
    return match && url.protocol === 'https:' && !url.port && !url.username && !url.password &&
      isTrustedSourceOrigin(url.origin) ? `${url.origin}/book/${match[1]}` : '';
  } catch { return ''; }
};

export function createWorkspaceStore({ indexedDB = globalThis.indexedDB,
  sessionStorage = globalThis.chrome?.storage?.session,
  localStorage = sessionStorage === globalThis.chrome?.storage?.session ? globalThis.chrome?.storage?.local : undefined,
  randomUUID = () => globalThis.crypto.randomUUID(), databaseName = 'deshar-material-export',
  IDBKeyRange = globalThis.IDBKeyRange } = {}) {
  let opening;
  const scope = createDurableWorkspaceScope({ localStorage, sessionStorage, randomUUID });
  const cache = new Map();

  function database() {
    if (!opening) opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 3);
      request.onupgradeneeded = () => {
        for (const name of TRANSACTION_STORES) {
          if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); opening = undefined; cache.clear(); };
        resolve(db);
      };
      request.onerror = () => { opening = undefined; reject(request.error); };
    });
    return opening;
  }

  function access(db, key, tabId, updater) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(TRANSACTION_STORES, updater ? 'readwrite' : 'readonly');
      const metadata = transaction.objectStore(META_STORE);
      const records = transaction.objectStore(RECORD_STORE);
      let result;
      let nextRevision;
      let failure;
      const abort = error => { failure = error; try { transaction.abort(); } catch { /* Transaction already finished. */ } };

      function ready(previous, meta) {
        try {
          const revision = meta?.storageRevision ?? null;
          if (!updater) { result = previous; nextRevision = revision; return; }
          // Capture these references before append helpers prepare a new root.
          // Existing records are immutable; a changed record replaces its
          // object at that index. Metadata-only updates never rewrite records.
          const before = { snapshots: previous.snapshots, captures: previous.captures };
          result = updater(previous);
          if (result === previous) { nextRevision = revision; return; }
          if (!result || !kinds.every(kind => Array.isArray(result[kind]))) throw new Error('Недопустимые данные локального сбора.');
          nextRevision = (revision || 0) + 1;
          if (!Number.isSafeInteger(nextRevision)) throw new Error('Не удалось обновить версию локального сбора.');
          for (const kind of kinds) {
            for (let index = 0; index < result[kind].length; index++) {
              if (!meta || before[kind][index] !== result[kind][index]) {
                records.put({ key: recordKey(key, kind, index), value: result[kind][index] });
              }
            }
            for (let index = result[kind].length; meta && index < before[kind].length; index++) records.delete(recordKey(key, kind, index));
          }
          const { snapshots, captures, ...state } = result;
          metadata.put({ key, storageRevision: nextRevision, snapshotCount: snapshots.length, captureCount: captures.length, state });
        } catch (error) { abort(error); }
      }

      const request = metadata.get(key);
      request.onsuccess = () => {
        const meta = request.result;
        const revision = meta?.storageRevision ?? null;
        const retained = cache.get(key);
        if (retained && retained.storageRevision === revision) { ready(retained.state, meta); return; }
        if (!meta) { ready(createWorkspace(tabId), null); return; }
        if (!Number.isSafeInteger(meta.storageRevision) || meta.storageRevision < 1 ||
          !['snapshotCount', 'captureCount'].every(field => Number.isSafeInteger(meta[field]) && meta[field] >= 0 && meta[field] <= 20000)) {
          abort(new Error('Повреждены сведения о локальном сборе.')); return;
        }
        const state = { ...meta.state, snapshots: new Array(meta.snapshotCount), captures: new Array(meta.captureCount) };
        let remaining = meta.snapshotCount + meta.captureCount;
        if (!remaining) { ready(state, meta); return; }
        for (const kind of kinds) for (let index = 0; index < state[kind].length; index++) {
          const record = records.get(recordKey(key, kind, index));
          record.onsuccess = () => {
            if (failure) return;
            if (!record.result || !Object.hasOwn(record.result, 'value')) { abort(new Error('В локальном сборе отсутствует сохранённая запись.')); return; }
            state[kind][index] = record.result.value;
            if (--remaining === 0) ready(state, meta);
          };
        }
      };
      transaction.oncomplete = () => {
        cache.set(key, { storageRevision: nextRevision, state: result });
        resolve(result);
      };
      const failed = () => { cache.delete(key); reject(failure || transaction.error || new Error('Сохранение отменено.')); };
      transaction.onerror = failed;
      transaction.onabort = failed;
    });
  }

  async function readWorkspace(tabId) {
    const [db, session] = await Promise.all([database(), scope()]);
    return access(db, `${session}:${tabId}`, tabId);
  }

  async function updateWorkspace(tabId, updater) {
    const [db, session] = await Promise.all([database(), scope()]);
    return access(db, `${session}:${tabId}`, tabId, updater);
  }

  async function resetWorkspace(tabId, { book, requireStoredBook = false } = {}) {
    const [db, session] = await Promise.all([database(), scope()]);
    const key = `${session}:${tabId}`;
    cache.delete(key);
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(TRANSACTION_STORES, 'readwrite');
      const metadata = transaction.objectStore(META_STORE);
      let result;
      let failure;
      const request = metadata.get(key);
      request.onsuccess = () => {
        try {
          const previous = request.result;
          const increment = value => {
            const revision = value ?? 0;
            if (!Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(revision + 1)) {
              throw new Error('Не удалось обновить версию локального сбора.');
            }
            return revision + 1;
          };
          const state = previous?.state;
          // A later collection supersedes the book retained by an earlier reset.
          const storedBook = state?.collection?.rootUrl ? { title: state.collection.title || '', rootUrl: state.collection.rootUrl } : state?.book;
          if (requireStoredBook && (!bookIdentity(book) || bookIdentity(book) !== bookIdentity(storedBook))) {
            throw Object.assign(new Error('Сохранённые материалы относятся к другому учебнику. Обновите выбранный учебник и повторите очистку.'), { code: 'book_mismatch' });
          }
          const selectedBook = book === undefined ? storedBook : book;
          result = { ...createWorkspace(tabId), exportRevision: increment(state?.exportRevision),
            contentRevision: increment(state?.contentRevision), snapshotRevision: increment(state?.snapshotRevision) };
          if (selectedBook && typeof selectedBook.title === 'string' && typeof selectedBook.rootUrl === 'string' &&
            selectedBook.title.length <= 500 && selectedBook.rootUrl.length <= 2048) {
            result.book = { title: selectedBook.title, rootUrl: selectedBook.rootUrl };
          }
          const { snapshots, captures, ...emptyState } = result;
          metadata.put({ key, storageRevision: increment(previous?.storageRevision), snapshotCount: 0, captureCount: 0, state: emptyState });
          // Delete the workspace's rows by key range. Reset never loads record
          // values, even after a worker restart with an empty memory cache.
          const prefix = `${key}/`;
          transaction.objectStore(RECORD_STORE).delete(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
        } catch (error) {
          failure = error;
          try { transaction.abort(); } catch { /* Transaction already finished. */ }
        }
      };
      transaction.oncomplete = () => { cache.delete(key); resolve(result); };
      const failed = () => { cache.delete(key); reject(failure || transaction.error || new Error('Сброс отменён.')); };
      transaction.onerror = failed;
      transaction.onabort = failed;
    });
  }

  async function releaseWorkspace(tabId) { cache.delete(`${await scope()}:${tabId}`); }

  async function listWorkspaceMetadata() {
    const [db, session] = await Promise.all([database(), scope()]);
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(TRANSACTION_STORES, 'readonly');
      const result = [];
      const prefix = `${session}:`;
      const request = transaction.objectStore(META_STORE).openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const meta = cursor.value, suffix = meta.key.slice(prefix.length);
        const storageId = /^\d+$/.test(suffix) ? Number(suffix) : suffix;
        const state = { ...meta.state, snapshots: [] };
        result.push({ storageId, state });
        if (meta.snapshotCount > 0) {
          const first = transaction.objectStore(RECORD_STORE).get(recordKey(meta.key, 'snapshots', 0));
          first.onsuccess = () => { if (first.result?.value) state.snapshots.push({ url: first.result.value.url, title: first.result.value.title }); };
        }
        cursor.continue();
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error || new Error('Не удалось прочитать сохранённые книги.'));
      transaction.onabort = transaction.onerror;
    });
  }

  const exportStore = createWorkspaceExportStore({ database, scope, releaseWorkspace });
  return Object.freeze({ readWorkspace, updateWorkspace, resetWorkspace, releaseWorkspace, listWorkspaceMetadata, ...exportStore });
}

let persistent;
const defaultStore = () => persistent ||= createWorkspaceStore();
export const readWorkspace = tabId => defaultStore().readWorkspace(tabId);
export const updateWorkspace = (tabId, updater) => defaultStore().updateWorkspace(tabId, updater);
export const resetWorkspace = (tabId, options) => defaultStore().resetWorkspace(tabId, options);
export const releaseWorkspace = tabId => defaultStore().releaseWorkspace(tabId);
export const listWorkspaceMetadata = () => defaultStore().listWorkspaceMetadata();
export const readExportMetadata = storageId => defaultStore().readExportMetadata(storageId);
export const saveExportSummary = (storageId, summary) => defaultStore().saveExportSummary(storageId, summary);
export const readExportRecordPage = (storageId, page) => defaultStore().readExportRecordPage(storageId, page);
export const recordExportResult = (storageId, result) => defaultStore().recordExportResult(storageId, result);
