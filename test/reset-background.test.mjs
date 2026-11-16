import assert from 'node:assert/strict';
import test from 'node:test';
import { installBackground } from '../src/background.js';
import { createExporterContextFixture } from './exporter-context-fixture.js';
import { createWorkspace } from '../src/lib/state.js';

const rootUrl = 'https://progressme.ru/cabinet/school/materials/book/867169/content';
const book = { title: 'Selected textbook', rootUrl };
const owner = id => ({ id: 'extension', url: 'chrome-extension://extension/exporter.html?tab=7', tab: { id, url: 'chrome-extension://extension/exporter.html?tab=7' } });
const source = { id: 'extension', url: rootUrl, frameId: 0, tab: { id: 7, url: rootUrl } };
const tick = () => new Promise(resolve => setImmediate(resolve));
const event = { kind: 'fetch', url: 'https://progressme.ru/api/lessons/1', data: { lesson: { id: 1, title: 'Authored text' } } };
function setup({ initial = createWorkspace(7) } = {}) {
  let listener, beforeUpdate;
  let state = initial;
  let resets = 0, reads = 0;
  const sessions = {};
  const messages = [];
  const tabs = new Map([[7, { id: 7, url: rootUrl }], [99, owner(99).tab], [100, owner(100).tab]]);
  const sourceReplies = new Map();
  const chrome = {
    runtime: { id: 'extension', getURL: path => `chrome-extension://extension/${path}`,
      sendMessage: async () => {}, onMessage: { addListener: callback => { listener = callback; } } },
    action: { onClicked: { addListener() {} } },
    storage: { session: { get: async key => ({ [key]: sessions[key] }),
      set: async value => Object.assign(sessions, value), remove: async key => { delete sessions[key]; } } },
    tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} }, create: async () => {},
      get: async id => { if (!tabs.has(id)) throw new Error('Closed'); return tabs.get(id); },
      sendMessage: async (id, message) => {
        messages.push(message);
        if (sourceReplies.has(message.type)) return sourceReplies.get(message.type)(message);
        if (message.type === 'CAPTURE_START') return { ok: true, captureId: message.captureId };
        return { ok: true, navigation: { url: tabs.get(id)?.url } };
      },
    },
  };
  const withExporterDocument = createExporterContextFixture(chrome);
  installBackground(chrome, {
    readWorkspace: async () => { reads++; return state; },
    updateWorkspace: async (_id, updater) => { if (beforeUpdate) await beforeUpdate(); state = updater(state); return state; },
    resetWorkspace: async (_id, options) => {
      if (options.requireStoredBook) {
        const previous = state.collection?.rootUrl || state.book?.rootUrl;
        const key = value => { try { const url = new URL(value); return `${url.origin}/${url.pathname.match(/\/book\/(\d+)/)?.[1]}`; } catch { return ''; } };
        if (!previous || key(previous) !== key(options.book?.rootUrl)) throw Object.assign(new Error('Выбранный учебник не совпадает с сохранённым.'), { code: 'book_mismatch' });
      }
      resets++;
      state = { ...createWorkspace(7), book: options.book || state.book, exportRevision: (state.exportRevision || 0) + 1,
        contentRevision: (state.contentRevision || 0) + 1, snapshotRevision: (state.snapshotRevision || 0) + 1 };
      return state;
    },
  });
  const send = (message, sender = owner(99)) => new Promise(resolve => listener({ tabId: 7, ...message }, withExporterDocument(sender), resolve));
  async function begin(sender = owner(99)) {
    const result = await send({ type: 'BEGIN_COLLECTION' }, sender);
    assert.equal(result.ok, true);
    const started = await send({ type: 'START_CAPTURE', collectionId: result.collectionId }, sender);
    assert.equal(started.ok, true);
    return { collectionId: result.collectionId, captureId: started.captureId };
  }
  return { send, begin, sessions, messages, tabs, sourceReplies, setBeforeUpdate: callback => { beforeUpdate = callback; },
    get state() { return state; }, get resets() { return resets; }, get reads() { return reads; } };
}

async function fast(promise) {
  // The losing timer is cancelled so a pending source promise cannot delay a run.
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Reset waited for stale work')), 300); })]); }
  finally { clearTimeout(timer); }
}

test('reset bypasses a blocked source wait and returns an empty selected book without reading records', async () => {
  const initial = { ...createWorkspace(7), snapshots: [{ url: rootUrl, title: 'Old snapshot', assets: [{ url: 'https://cdn.example.org/old.png', kind: 'image' }] }],
    captures: [event], warnings: ['Old warning'], dropped: 3, bytes: 123 };
  const app = setup({ initial });
  const run = await app.begin();
  await app.send({ type: 'GET_STATE', summary: true });
  const reads = app.reads;
  app.sourceReplies.set('MATERIAL_NAVIGATION', () => new Promise(() => {}));
  app.sourceReplies.set('CAPTURE_STOP', () => new Promise(() => {}));
  const oldRead = app.send({ type: 'GET_NAVIGATION' });
  await tick();
  const queuedCheckpoint = app.send({ type: 'SAVE_COLLECTION', collectionId: run.collectionId, collection: { status: 'running', rootUrl } });
  const result = await fast(app.send({ type: 'RESET_CAPTURE', book }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.state.book, book);
  assert.deepEqual(result.state.snapshots, []);
  assert.deepEqual(result.state.captures, []);
  assert.deepEqual(result.state.warnings, []);
  assert.equal(result.state.collection, undefined);
  assert.equal(result.state.enabled, false);
  assert.equal(result.state.collectionLocked, false);
  assert.equal(app.resets, 1);
  assert.equal(app.reads, reads, 'fast reset does not hydrate old records');
  assert.equal((await oldRead).code, 'stale_collection');
  assert.equal((await queuedCheckpoint).code, 'stale_collection');
  const after = await fast(app.send({ type: 'GET_STATE', summary: true }));
  assert.deepEqual(after.state.snapshots, []);
  assert.deepEqual(after.state.assetInventory, []);
  assert.deepEqual(after.state.book, book);
});

test('old run commands and source JSON cannot resurrect data or stop a new run after reset', async () => {
  const app = setup();
  const old = await app.begin();
  assert.equal((await app.send({ type: 'CAPTURE_EVENT', captureId: old.captureId, event }, source)).ok, true);
  assert.equal((await app.send({ type: 'RESET_CAPTURE', book })).ok, true);
  for (const type of ['SAVE_COLLECTION', 'START_CAPTURE', 'STOP_CAPTURE', 'END_COLLECTION', 'CLEAR_CAPTURE', 'TAKE_SNAPSHOT']) {
    const result = await app.send({ type, collectionId: old.collectionId, collection: { status: 'cancelled', rootUrl } });
    assert.equal(result.code, 'stale_collection', type);
  }
  const current = await app.begin();
  assert.notEqual(current.collectionId, old.collectionId);
  assert.notEqual(current.captureId, old.captureId);
  for (const type of ['SAVE_COLLECTION', 'START_CAPTURE', 'STOP_CAPTURE', 'END_COLLECTION']) {
    assert.equal((await app.send({ type, collectionId: old.collectionId, collection: { status: 'running', rootUrl } })).code, 'stale_collection', type);
  }
  for (const captureId of [undefined, old.captureId]) {
    assert.equal((await app.send({ type: 'CAPTURE_EVENT', captureId, event }, source)).code, 'stale_capture');
    assert.equal((await app.send({ type: 'CAPTURE_ISSUE', captureId, code: 'response_too_large' }, source)).code, 'stale_capture');
  }
  assert.deepEqual(app.state.captures, []);
  assert.deepEqual(app.state.warnings, []);
  assert.equal(app.state.collection, undefined);
  assert.equal(app.sessions['collection:7'].collectionId, current.collectionId);
  assert.equal(app.sessions['capture-id:7'], current.captureId);
  assert.equal((await app.send({ type: 'CAPTURE_EVENT', captureId: current.captureId, event }, source)).ok, true);
  assert.equal(app.state.captures.length, 1);
});

test('an old write whose database callback resumes after reset is rejected before committing', async () => {
  const app = setup();
  const run = await app.begin();
  let release, entered;
  const awaitingUpdate = new Promise(resolve => { entered = resolve; });
  app.setBeforeUpdate(() => { entered(); return new Promise(resolve => { release = resolve; }); });
  const writing = app.send({ type: 'CAPTURE_EVENT', captureId: run.captureId, event }, source);
  await awaitingUpdate;
  const result = await fast(app.send({ type: 'RESET_CAPTURE', book }));
  assert.equal(result.ok, true);
  app.setBeforeUpdate(null);
  release();
  assert.equal((await writing).code, 'stale_collection');
  assert.deepEqual(app.state.captures, []);
  assert.deepEqual((await app.send({ type: 'GET_STATE' })).state.captures, []);
});

test('reset validates selected book metadata and owner before revoking an active run', async () => {
  const app = setup();
  const run = await app.begin();
  for (const value of [{ title: 1, rootUrl }, { title: 'Wrong', rootUrl: rootUrl.replace('867169', '999') },
    { title: 'Foreign', rootUrl: rootUrl.replace('progressme.ru', 'evil.example') }]) {
    assert.equal((await app.send({ type: 'RESET_CAPTURE', book: value })).ok, false);
  }
  // Invalid metadata is rejected before revocation; an atomic stored-book guard
  // may stop the run while retaining the old dataset, so acquire a fresh run.
  const resumed = await app.begin();
  assert.equal((await app.send({ type: 'RESET_CAPTURE', book }, owner(100))).ok, false);
  assert.equal(app.sessions['capture-id:7'], resumed.captureId);
  app.tabs.delete(7);
  const result = await app.send({ type: 'RESET_CAPTURE', book });
  assert.equal(result.ok, true, 'a closed textbook may still be cleared');
  assert.deepEqual(result.state.book, book);
  assert.equal(app.sessions['capture:7'], undefined);
});

test('an older source script without the capture-ID acknowledgment fails with an update instruction', async () => {
  const app = setup();
  const run = await app.send({ type: 'BEGIN_COLLECTION' });
  app.sourceReplies.set('CAPTURE_START', () => ({ ok: true }));
  const result = await app.send({ type: 'START_CAPTURE', collectionId: run.collectionId });
  assert.equal(result.code, 'source_update_required');
  assert.match(result.error, /Обновите расширение.*перезагрузите/);
  assert.equal(app.sessions['capture:7'], undefined);
  assert.equal(app.sessions['capture-id:7'], undefined);
  assert.equal((await app.send({ type: 'CAPTURE_EVENT', event }, source)).code, 'stale_capture');
});

test('reset may clear the stored book after its source tab has navigated to another book', async () => {
  const app = setup({ initial: { ...createWorkspace(7), book, captures: [event] } });
  const run = await app.begin();
  await app.send({ type: 'SAVE_COLLECTION', collectionId: run.collectionId, collection: { status: 'running', rootUrl, title: book.title } });
  app.tabs.set(7, { id: 7, url: rootUrl.replace('867169', '999') });
  const result = await app.send({ type: 'RESET_CAPTURE', book });
  assert.equal(result.ok, true);
  assert.deepEqual(result.state.book, book);
  assert.deepEqual(result.state.captures, []);
});

test('a rejected stored-book guard retains old data and marks its revoked running report cancelled', async () => {
  const app = setup({ initial: { ...createWorkspace(7), book, captures: [event] } });
  const run = await app.begin();
  await app.send({ type: 'SAVE_COLLECTION', collectionId: run.collectionId, collection: { status: 'running', rootUrl } });
  app.tabs.set(7, { id: 7, url: rootUrl.replace('867169', '999') });
  const result = await app.send({ type: 'RESET_CAPTURE', book: { title: 'Arbitrary third book', rootUrl: rootUrl.replace('867169', '888') } });
  assert.equal(result.code, 'book_mismatch');
  assert.equal(app.resets, 0);
  assert.equal(app.state.captures.length, 1);
  assert.equal(app.state.collection.status, 'cancelled');
  assert.deepEqual(app.state.book, book);
  assert.equal(app.sessions['capture:7'], undefined);
  assert.equal(app.sessions['collection:7'], undefined);
});

test('ending an aborted run cancels only a still-running report and preserves terminal reports', async () => {
  for (const status of ['running', 'finished', 'failed', 'cancelled']) {
    const app = setup();
    const run = await app.begin();
    await app.send({ type: 'SAVE_COLLECTION', collectionId: run.collectionId, collection: { status, rootUrl } });
    assert.equal((await app.send({ type: 'END_COLLECTION', collectionId: run.collectionId })).ok, true);
    assert.equal(app.state.collection.status, status === 'running' ? 'cancelled' : status);
  }
});

test('a frozen old source cannot block a new collection after its dashboard chooses another book', async () => {
  const app = setup();
  const old = await app.begin();
  app.sourceReplies.set('CAPTURE_STOP', () => new Promise(() => {}));
  const nextOwner = { id: 'extension', url: 'chrome-extension://extension/exporter.html?tab=8',
    tab: { id: 99, url: 'chrome-extension://extension/exporter.html?tab=8' } };
  app.tabs.set(99, nextOwner.tab);
  app.tabs.set(8, { id: 8, url: rootUrl.replace('867169', '999') });
  const next = await fast(app.send({ type: 'BEGIN_COLLECTION', tabId: 8 }, nextOwner));
  assert.equal(next.ok, true);
  assert.notEqual(next.collectionId, old.collectionId);
  assert.equal(app.sessions['capture:7'], undefined);
  assert.equal(app.sessions['collection:7'], undefined);
  assert.equal(app.sessions['collection-owner:99'], 8);
  assert.equal(app.sessions['collection:8'].collectionId, next.collectionId);
});
