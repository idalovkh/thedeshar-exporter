import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceStore } from '../src/lib/store.js';
import { runStoreChecks } from './store-checks.js';
import { appendCapture, appendSnapshot } from '../src/lib/state.js';
import { runExportStoreChecks } from './export-store-checks.js';

const memoryKeyRange = { bound: (lower, upper) => ({ lower, upper }) };

test('export reads and final result updates never hydrate the whole committed workspace', async () => {
  assert.equal(await runExportStoreChecks(memoryIndexedDB(), 'unit-export-pages'), 6);
});

// A transaction model for fast Node regressions. The same contract also runs
// against the browser's real IndexedDB in store-browser.html.
function memoryIndexedDB() {
  const databases = new Map();
  let writes = 0;
  const operations = [];
  return { operations, get writes() { return writes; }, open(name, version) {
    const request = {};
    setImmediate(() => {
      let data = databases.get(name);
      const upgrade = !data || version > data.version;
      if (!data) { data = { version: 0, stores: new Map(), pending: Promise.resolve() }; databases.set(name, data); }
      const db = {
        objectStoreNames: { contains: key => data.stores.has(key) },
        createObjectStore(key, options) { data.stores.set(key, { keyPath: options.keyPath, records: new Map() }); },
        close() {},
        transaction(keys) {
          keys = Array.isArray(keys) ? keys : [keys];
          const tx = {};
          const pendingRequests = [];
          let working;
          let aborted = false;
          let start;
          const starting = new Promise(resolve => { start = resolve; });
          const run = data.pending.then(async () => {
            working = new Map(keys.map(key => [key, structuredClone(data.stores.get(key).records)]));
            start();
            await new Promise(resolve => setImmediate(resolve));
            while (pendingRequests.length && !aborted) {
              const { request, id, key } = pendingRequests.shift();
              request.result = structuredClone(working.get(key).get(id));
              request.onsuccess?.();
            }
            if (aborted) tx.onabort?.();
            else { for (const key of keys) data.stores.get(key).records = working.get(key); tx.oncomplete?.(); }
          });
          data.pending = run.catch(() => {});
          tx.objectStore = key => ({
            get(id) { operations.push({ type: 'get', store: key, key: id }); const request = {}; pendingRequests.push({ request, id, key }); return request; },
            put(value) {
              writes++;
              operations.push({ type: 'put', store: key, key: value.key ?? value.id, rawArrayPayload: Array.isArray(value.state?.captures) || Array.isArray(value.state?.snapshots) });
              const store = data.stores.get(key);
              // Native IDB accepts put before the transaction begins, too.
              if (!working) starting.then(() => { working.get(key).set(value[store.keyPath], structuredClone(value)); });
              else working.get(key).set(value[store.keyPath], structuredClone(value));
            },
            delete(id) {
              operations.push({ type: 'delete', store: key, key: id });
              const remove = () => {
                if (id && typeof id === 'object' && 'lower' in id) {
                  for (const record of working.get(key).keys()) if (record >= id.lower && record <= id.upper) working.get(key).delete(record);
                } else working.get(key).delete(id);
              };
              if (!working) starting.then(remove); else remove();
            },
          });
          tx.abort = () => { aborted = true; };
          return tx;
        },
      };
      request.result = db;
      if (upgrade) { data.version = version; request.onupgradeneeded?.(); }
      request.onsuccess?.();
    });
    return request;
  } };
}

test('session-scoped storage contract preserves atomic writes and separates reused tab IDs', async () => {
  assert.equal((await runStoreChecks(memoryIndexedDB(), 'unit-workspaces', { IDBKeyRange: memoryKeyRange })).length, 26);
});

test('an unchanged updater never rewrites a retained workspace to IndexedDB', async () => {
  const indexedDB = memoryIndexedDB(), session = {};
  const store = createWorkspaceStore({ indexedDB, databaseName: 'unchanged-workspace',
    sessionStorage: { get: async key => ({ [key]: session[key] }), set: async value => Object.assign(session, value) },
    randomUUID: () => 'session-unchanged-00001' });
  await store.updateWorkspace(7, state => ({ ...state, warnings: ['Retained'] }));
  const writes = indexedDB.writes;
  await store.updateWorkspace(7, state => state);
  assert.equal(indexedDB.writes, writes);
  assert.deepEqual((await store.readWorkspace(7)).warnings, ['Retained']);
});

test('appends and metadata checkpoints write only their delta and never reread unchanged raw records', async () => {
  const indexedDB = memoryIndexedDB(), session = {};
  const store = createWorkspaceStore({ indexedDB, databaseName: 'delta-workspace',
    sessionStorage: { get: async key => ({ [key]: session[key] }), set: async value => Object.assign(session, value) },
    randomUUID: () => 'session-delta-00000001' });
  await store.updateWorkspace(7, state => ({ ...state,
    captures: Array.from({ length: 100 }, (_, id) => ({ kind: 'fetch', url: 'https://progressme.ru/lessons/1',
      data: { lesson: { id, text: 'x'.repeat(4000) } } })) }));
  const recordOperations = type => indexedDB.operations.filter(operation => operation.store === 'workspace-records' && operation.type === type);
  indexedDB.operations.length = 0;
  await store.updateWorkspace(7, state => appendCapture(state, { kind: 'fetch', url: 'https://progressme.ru/lessons/1', data: { lesson: { id: 100 } } }));
  assert.equal(recordOperations('put').length, 1);
  assert.match(recordOperations('put')[0].key, /\/captures\/100$/);
  assert.equal(recordOperations('get').length, 0);
  assert.equal(indexedDB.operations.filter(operation => operation.type === 'put').length, 2, 'Only the new record and small metadata are committed');
  assert.equal(indexedDB.operations.some(operation => operation.rawArrayPayload), false);
  indexedDB.operations.length = 0;
  await store.updateWorkspace(7, state => ({ ...state, collection: { status: 'running', visited: ['source-page'] } }));
  assert.equal(recordOperations('put').length, 0);
  assert.equal(recordOperations('get').length, 0);
  assert.equal(indexedDB.operations.filter(operation => operation.type === 'put').length, 1);
  const url = 'https://progressme.ru/lesson-editor/book/1/lesson/2/section/3';
  await store.updateWorkspace(7, state => appendSnapshot(state, { url, title: 'Before', blocks: [] }));
  indexedDB.operations.length = 0;
  await store.updateWorkspace(7, state => appendSnapshot(state, { url, title: 'After', blocks: [] }));
  assert.equal(recordOperations('put').length, 1);
  assert.match(recordOperations('put')[0].key, /\/snapshots\/0$/);
  assert.equal((await store.readWorkspace(7)).captures.length, 101);
  await store.releaseWorkspace(7);
  indexedDB.operations.length = 0;
  const reopened = await store.readWorkspace(7);
  assert.equal(reopened.snapshots[0].title, 'After');
  assert.equal(reopened.captures.length, 101);
  assert.equal(recordOperations('get').length, 102, 'Releasing a closed tab discards raw memory without deleting its committed records');
});

test('a failed session scope write is retried and never opens an unscoped dataset', async () => {
  const values = {};
  let attempts = 0;
  const store = createWorkspaceStore({ indexedDB: memoryIndexedDB(), databaseName: 'retry-scope',
    sessionStorage: { get: async key => ({ [key]: values[key] }), set: async value => {
      if (++attempts === 1) throw Error('Session storage temporarily unavailable');
      Object.assign(values, value);
    } }, randomUUID: () => 'session-retry-000001' });
  await assert.rejects(store.readWorkspace(7), /temporarily unavailable/);
  assert.deepEqual((await store.readWorkspace(7)).snapshots, []);
  assert.equal(attempts, 2);
});

test('a cold multi-megabyte reset reads only metadata, deletes one exact key range and retains book isolation', async () => {
  const indexedDB = memoryIndexedDB();
  const values = {};
  const sessionStorage = { get: async key => ({ [key]: values[key] }), set: async value => Object.assign(values, value) };
  const options = { indexedDB, databaseName: 'cold-range-reset', IDBKeyRange: memoryKeyRange, sessionStorage,
    randomUUID: () => 'session-cold-00000001' };
  const first = createWorkspaceStore(options);
  const url = 'https://progressme.ru/cabinet/school/materials/book/1/content';
  await first.updateWorkspace(7, state => ({ ...state,
    snapshots: [{ url, blocks: [{ text: 'Old page' }] }],
    captures: Array.from({ length: 256 }, (_, id) => ({ id, data: { text: 'x'.repeat(32768) } })),
    exportRevision: 15, contentRevision: 20, snapshotRevision: 30,
    collection: { status: 'finished', title: 'Previous title', rootUrl: url }, warnings: ['Previous warning'], dropped: 4, bytes: 8 * 1024 * 1024 }));
  await first.updateWorkspace(70, state => ({ ...state, captures: [{ id: 'neighbor-book' }] }));
  const previousSession = createWorkspaceStore({ ...options, sessionStorage: { get: async () => ({}), set: async () => {} },
    randomUUID: () => 'session-other-00000002' });
  await previousSession.updateWorkspace(7, state => ({ ...state, captures: [{ id: 'another-session' }] }));
  const cold = createWorkspaceStore(options);
  indexedDB.operations.length = 0;
  const result = await cold.resetWorkspace(7, { book: { title: 'Still selected', rootUrl: url } });
  assert.deepEqual(indexedDB.operations.map(({ type, store }) => `${type}:${store}`), [
    'get:workspace-metadata', 'put:workspace-metadata', 'delete:workspace-records',
  ], 'Reset never reads or rewrites raw record bodies');
  const range = indexedDB.operations.find(operation => operation.store === 'workspace-records').key;
  assert.equal(range.lower, 'session-cold-00000001:7/');
  assert.equal(range.upper, 'session-cold-00000001:7/\uffff');
  assert.deepEqual(result.snapshots, []);
  assert.deepEqual(result.captures, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.dropped, 0);
  assert.equal(result.bytes, 0);
  assert.equal(result.collection, undefined);
  assert.deepEqual(result.book, { title: 'Still selected', rootUrl: url });
  assert.equal(result.exportRevision, 16);
  assert.equal(result.contentRevision, 21);
  assert.equal(result.snapshotRevision, 31);
  assert.equal((await first.readWorkspace(7)).captures.length, 0, 'A warm older instance must observe the reset revision');
  assert.equal((await first.readWorkspace(70)).captures[0].id, 'neighbor-book');
  assert.equal((await previousSession.readWorkspace(7)).captures[0].id, 'another-session');
  await first.updateWorkspace(7, state => ({ ...state, captures: [...state.captures, { id: 'new-data' }] }));
  assert.deepEqual((await cold.readWorkspace(7)).captures, [{ id: 'new-data' }]);
});

test('current reset ignores retained legacy datasets and never reads or writes their bodies', async () => {
  const indexedDB = memoryIndexedDB();
  const db = await new Promise(resolve => {
    const request = indexedDB.open('cold-v2-reset', 2);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('workspaces', { keyPath: 'id' });
      request.result.createObjectStore('session-workspaces', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
  });
  const key = 'session-legacy-000001:7';
  await new Promise(resolve => {
    const transaction = db.transaction('session-workspaces', 'readwrite');
    transaction.objectStore('session-workspaces').put({ key, state: { id: 7, snapshots: [],
      captures: Array.from({ length: 128 }, (_, id) => ({ id, text: 'x'.repeat(32768) })), warnings: [], dropped: 0, bytes: 0 } });
    transaction.oncomplete = resolve;
  });
  db.close();
  const sessionStorage = { get: async name => ({ [name]: 'session-legacy-000001' }), set: async () => {} };
  const options = { indexedDB, databaseName: 'cold-v2-reset', IDBKeyRange: memoryKeyRange, sessionStorage };
  const store = createWorkspaceStore(options);
  indexedDB.operations.length = 0;
  await store.resetWorkspace(7, { book: { title: 'Legacy book', rootUrl: 'https://progressme.ru/cabinet/school/materials/book/1/content' } });
  assert.equal(indexedDB.operations.filter(operation => operation.type === 'get').length, 1);
  assert.equal(indexedDB.operations[0].store, 'workspace-metadata');
  assert.equal(indexedDB.operations.some(operation => ['workspaces', 'session-workspaces'].includes(operation.store)), false);
  const reopened = createWorkspaceStore(options);
  assert.equal((await reopened.readWorkspace(7)).captures.length, 0);
  assert.equal((await reopened.readWorkspace(7)).book.title, 'Legacy book');
});

test('a guarded reset validates the stored book atomically from small metadata before any deletion', async () => {
  const indexedDB = memoryIndexedDB(), values = {};
  const options = { indexedDB, databaseName: 'guarded-book-reset', IDBKeyRange: memoryKeyRange,
    sessionStorage: { get: async key => ({ [key]: values[key] }), set: async value => Object.assign(values, value) },
    randomUUID: () => 'session-guarded-00001' };
  const warm = createWorkspaceStore(options);
  const oldBook = { title: 'Book A', rootUrl: 'https://progressme.ru/cabinet/school/materials/book/1/content' };
  const activeBook = { title: 'Book B', rootUrl: 'https://progressme.ru/cabinet/school/materials/book/2/content' };
  await warm.updateWorkspace(7, state => ({ ...state, book: oldBook, collection: { ...activeBook, status: 'finished' },
    captures: [{ id: 'retained-book-B' }], exportRevision: 10 }));
  const cold = createWorkspaceStore(options);
  for (const book of [oldBook, { ...activeBook, rootUrl: activeBook.rootUrl.replace('progressme.ru', 'platform.desharschool.ru') }]) {
    indexedDB.operations.length = 0;
    await assert.rejects(cold.resetWorkspace(7, { book, requireStoredBook: true }), error => error.code === 'book_mismatch');
    assert.deepEqual(indexedDB.operations.map(({ type, store }) => `${type}:${store}`), ['get:workspace-metadata']);
    assert.deepEqual((await warm.readWorkspace(7)).captures, [{ id: 'retained-book-B' }]);
  }
  indexedDB.operations.length = 0;
  const result = await cold.resetWorkspace(7, { book: activeBook, requireStoredBook: true });
  assert.equal(indexedDB.operations.filter(operation => operation.type === 'get').length, 1);
  assert.equal(indexedDB.operations[0].store, 'workspace-metadata');
  assert.deepEqual(result.book, activeBook);
  assert.equal(result.exportRevision, 11);
  assert.deepEqual((await warm.readWorkspace(7)).captures, []);
  await assert.rejects(cold.resetWorkspace(8, { book: oldBook, requireStoredBook: true }), error => error.code === 'book_mismatch');
});


test('fresh runtime creates only current stores and never reads retained legacy records', async () => {
  const indexedDB = memoryIndexedDB(), values = {};
  const options = { indexedDB, databaseName: 'current-only-workspace', IDBKeyRange: memoryKeyRange,
    sessionStorage: { get: async key => ({ [key]: values[key] }), set: async value => Object.assign(values, value) },
    randomUUID: () => 'session-current-000001' };
  const store = createWorkspaceStore(options);
  assert.equal((await store.readWorkspace(7)).captures.length, 0);
  const db = await new Promise(resolve => {
    const request = indexedDB.open('current-only-workspace', 3);
    request.onsuccess = () => resolve(request.result);
  });
  for (const name of ['workspace-metadata', 'workspace-records']) assert.equal(db.objectStoreNames.contains(name), true);
  for (const name of ['workspaces', 'session-workspaces']) assert.equal(db.objectStoreNames.contains(name), false);
  assert.equal(indexedDB.operations.some(operation => ['workspaces', 'session-workspaces'].includes(operation.store)), false);
  db.close();
});
