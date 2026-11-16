import { createWorkspaceStore } from '../src/lib/store.js';

export async function runStoreChecks(indexedDB, databaseName, { IDBKeyRange = globalThis.IDBKeyRange } = {}) {
  const passed = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); passed.push(message); };
  const session = () => {
    const values = {};
    return { values, gets: 0, sets: 0,
      async get(key) { this.gets++; return { [key]: values[key] }; },
      async set(value) { this.sets++; Object.assign(values, value); } };
  };
  const open = version => new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, version);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const firstSession = session();
  let generated = 0;
  const first = createWorkspaceStore({ indexedDB, databaseName, IDBKeyRange, sessionStorage: firstSession,
    randomUUID: () => { generated++; return 'session-one-00000001'; } });
  const empty = await Promise.all(Array.from({ length: 20 }, () => first.readWorkspace(7)));
  check(generated === 1 && firstSession.sets === 1 && firstSession.gets === 1, 'Concurrent first reads share one session scope');
  check(empty.every(state => state.id === 7 && state.snapshots.length === 0), 'Concurrent reads of an unwritten current tab start empty');
  const oldUrl = 'https://progressme.ru/lesson-editor/book/11/lesson/12/section/13';
  await first.updateWorkspace(7, state => ({ ...state, snapshots: [{ url: oldUrl }], counter: 0 }));
  await Promise.all(Array.from({ length: 20 }, () => first.updateWorkspace(7, state => ({ ...state, counter: state.counter + 1 }))));
  check((await first.readWorkspace(7)).counter === 20, 'Concurrent read-modify-write transactions retain every update');
  try {
    await first.updateWorkspace(7, state => { state.counter = 999; throw Error('Deliberate updater failure'); });
    throw Error('Expected rejection');
  } catch (error) { check(error.message === 'Deliberate updater failure', 'Updater errors reject their transaction'); }
  check((await first.readWorkspace(7)).counter === 20, 'An aborted update preserves committed records');
  const restarted = createWorkspaceStore({ indexedDB, databaseName, IDBKeyRange, sessionStorage: firstSession,
    randomUUID: () => { throw Error('Worker restart must reuse the session'); } });
  check((await restarted.readWorkspace(7)).snapshots[0].url === oldUrl, 'Worker restart retains the same browser-session dataset');
  await Promise.all(Array.from({ length: 12 }, (_, id) => (id % 2 ? first : restarted).updateWorkspace(7, state => ({ ...state,
    captures: [...state.captures, { kind: 'fetch', data: { lesson: { id } } }] }))));
  const combined = await first.readWorkspace(7);
  check(combined.captures.length === 12 && new Set(combined.captures.map(record => record.data.lesson.id)).size === 12,
    'Independent store instances retain every concurrent delta append');
  await first.updateWorkspace(8, state => ({ ...state, snapshots: [{ url: 'current-book' }], captures: [{ kind: 'fetch', data: { lesson: { id: 8 } } }] }));
  check((await restarted.readWorkspace(8)).captures[0].data.lesson.id === 8, 'A second current workspace is visible atomically to another store instance');
  try {
    await first.updateWorkspace(8, state => ({ ...state, captures: [...state.captures, { kind: 'fetch', data: { lesson: { id: 999 } } }],
      uncloneableMetadata: () => {} }));
    throw Error('Expected clone failure');
  } catch (error) { if (error.name !== 'DataCloneError') throw error; }
  check((await first.readWorkspace(8)).captures.length === 1 && (await restarted.readWorkspace(8)).captures.length === 1,
    'A metadata write failure rolls back previously scheduled record writes and invalidates the worker cache');
  const second = createWorkspaceStore({ indexedDB, databaseName, IDBKeyRange, sessionStorage: session(), randomUUID: () => 'session-two-00000002' });
  check((await second.readWorkspace(7)).snapshots.length === 0, 'Reused tab ID in a new browser session starts empty');
  await second.updateWorkspace(7, state => ({ ...state, snapshots: [{ url: 'new-session-book' }] }));
  check((await first.readWorkspace(7)).snapshots[0].url === oldUrl, 'A later browser session cannot overwrite prior-session records');
  const upgraded = await open(3);
  const read = (name, key) => new Promise((resolve, reject) => {
    const request = upgraded.transaction(name).objectStore(name).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const currentKey = 'session-one-00000001:8';
  const currentMeta = await read('workspace-metadata', currentKey);
  const currentRecord = await read('workspace-records', `${currentKey}/snapshots/0`);
  check(currentMeta.snapshotCount === 1 && currentMeta.captureCount === 1 && currentMeta.state.snapshots === undefined &&
    currentMeta.state.captures === undefined && currentRecord.value.url === 'current-book',
    'Raw records are stored separately from small metadata');
  await first.updateWorkspace(7, state => ({ ...state, collection: { title: 'Selected textbook', rootUrl: oldUrl },
    exportRevision: 40, contentRevision: 50, snapshotRevision: 60 }));
  await restarted.readWorkspace(7);
  const returnedReset = await first.resetWorkspace(7);
  const reset = await restarted.readWorkspace(7);
  check(reset.snapshots.length === 0 && reset.captures.length === 0 &&
    !await read('workspace-records', 'session-one-00000001:7/snapshots/0') &&
    !await read('workspace-records', 'session-one-00000001:7/captures/0') &&
    !await read('workspace-records', 'session-one-00000001:7/captures/11'), 'Reset deletes retained record rows and invalidates other-instance caches');
  check(returnedReset.book.title === 'Selected textbook' && reset.book.rootUrl === oldUrl && !reset.collection &&
    reset.exportRevision === 41 && reset.contentRevision === 51 && reset.snapshotRevision === 61,
    'Reset preserves the selected book and advances export and content revisions atomically');
  await restarted.updateWorkspace(7, state => ({ ...state, captures: [...state.captures, { id: 'new-after-reset' }] }));
  check((await first.readWorkspace(7)).captures.length === 1 && (await first.readWorkspace(7)).captures[0].id === 'new-after-reset',
    'An updater with a stale other-instance cache cannot restore pre-reset records');
  const beforeReset = first.updateWorkspace(7, state => ({ ...state, captures: [...state.captures, { id: 'before-reset' }] }));
  const concurrentReset = first.resetWorkspace(7, { book: { title: 'Still selected', rootUrl: oldUrl } });
  const afterReset = first.updateWorkspace(7, state => ({ ...state, captures: [...state.captures, { id: 'after-reset' }] }));
  await Promise.all([beforeReset, concurrentReset, afterReset]);
  const finalResetState = await restarted.readWorkspace(7);
  check(finalResetState.captures.length === 1 && finalResetState.captures[0].id === 'after-reset' &&
    finalResetState.book.title === 'Still selected', 'Reset serializes atomically between concurrent record updates');
  check((await second.readWorkspace(7)).snapshots[0].url === 'new-session-book' &&
    (await first.readWorkspace(8)).captures.length === 1, 'Reset leaves previous sessions and other selected books intact');
  const failedReset = createWorkspaceStore({ indexedDB, databaseName, sessionStorage: firstSession,
    IDBKeyRange: { bound() { throw Error('Deliberate reset failure'); } } });
  try { await failedReset.resetWorkspace(7); throw Error('Expected reset failure'); }
  catch (error) { if (error.message !== 'Deliberate reset failure') throw error; }
  check((await first.readWorkspace(7)).captures[0].id === 'after-reset' &&
    (await restarted.readWorkspace(7)).book.title === 'Still selected', 'A failed range reset rolls back its metadata and retains all prior records');
  const selectedBook = { title: 'Current selection', rootUrl: oldUrl };
  await first.resetWorkspace(9, { book: selectedBook });
  const newReset = await restarted.readWorkspace(9);
  check(newReset.snapshots.length === 0 && newReset.captures.length === 0 && newReset.book.title === selectedBook.title,
    'Reset of an unwritten workspace creates only an empty selected book');
  await first.resetWorkspace(8);
  check((await restarted.readWorkspace(8)).captures.length === 0 &&
    !await read('workspace-records', `${currentKey}/snapshots/0`),
    'Reset removes current raw records and does not restore them from an older cache');
  await first.updateWorkspace(10, state => ({ ...state, captures: Array.from({ length: 96 }, (_, id) => ({ id, text: 'x'.repeat(32768) })) }));
  const cold = createWorkspaceStore({ indexedDB, databaseName, IDBKeyRange, sessionStorage: firstSession });
  await cold.resetWorkspace(10, { book: { title: 'Large cold workspace', rootUrl: oldUrl } });
  check((await first.readWorkspace(10)).captures.length === 0 &&
    !await read('workspace-records', 'session-one-00000001:10/captures/95'),
    'A cold worker resets a multi-megabyte dataset and removes its final record');
  const bookA = { title: 'Stored book A', rootUrl: 'https://progressme.ru/cabinet/school/materials/book/101/content' };
  const bookB = { title: 'Current book B', rootUrl: 'https://progressme.ru/cabinet/school/materials/book/102/content' };
  await first.updateWorkspace(11, state => ({ ...state, collection: { ...bookA, status: 'finished' }, captures: [{ id: 'book-A' }] }));
  const guardedA = await cold.resetWorkspace(11, { book: bookA, requireStoredBook: true });
  check(guardedA.captures.length === 0 && guardedA.book.rootUrl === bookA.rootUrl,
    'A guarded reset can clear the stored book even after its source tab has changed');
  await first.updateWorkspace(11, state => ({ ...state, collection: { ...bookB, status: 'finished' }, captures: [{ id: 'book-B' }] }));
  let wrongBookRejected = false;
  try { await cold.resetWorkspace(11, { book: bookA, requireStoredBook: true }); }
  catch (error) { if (error.code !== 'book_mismatch') throw error; wrongBookRejected = true; }
  check(wrongBookRejected && (await first.readWorkspace(11)).captures[0].id === 'book-B',
    'A mismatched guarded reset leaves the committed book and records unchanged');
  const guardedB = await cold.resetWorkspace(11, { book: bookB, requireStoredBook: true });
  check(guardedB.book.rootUrl === bookB.rootUrl && (await first.readWorkspace(11)).captures.length === 0,
    'A later collection takes priority over the book retained by a previous reset');
  let missingBookRejected = false;
  try { await cold.resetWorkspace(12, { book: bookA, requireStoredBook: true }); }
  catch (error) { if (error.code !== 'book_mismatch') throw error; missingBookRejected = true; }
  check(missingBookRejected && !await read('workspace-metadata', 'session-one-00000001:12'),
    'A guarded reset without stored book metadata cannot create or delete a dataset');
  check(upgraded.objectStoreNames.contains('workspace-metadata') && upgraded.objectStoreNames.contains('workspace-records') &&
    !upgraded.objectStoreNames.contains('workspaces') && !upgraded.objectStoreNames.contains('session-workspaces'),
    'A fresh database contains only the current metadata and record stores');
  upgraded.close();
  return passed;
}
