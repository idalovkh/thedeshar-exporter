import assert from 'node:assert/strict';
import test from 'node:test';
import { installBackground } from '../src/background.js';
import { createExporterContextFixture } from './exporter-context-fixture.js';
import { createWorkspace, LIMITS } from '../src/lib/state.js';

const sourceUrl = 'https://progressme.ru/cabinet/school/materials/book/867169/content';
const documentToken = 'source-document-00000001';
const dashboard = id => ({ id: 'test-extension', url: 'chrome-extension://test-extension/exporter.html?tab=7', tab: { id, url: 'chrome-extension://test-extension/exporter.html?tab=7' } });
const sourceSender = { id: 'test-extension', url: sourceUrl, frameId: 0, tab: { id: 7, url: sourceUrl } };
const running = { status: 'running', rootUrl: sourceUrl, items: [{ key: 'lesson', status: 'running' }], warnings: [] };
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness({ sessions = {}, records = new Map(), tabs = new Map([[7, { id: 7, url: sourceUrl }], [99, dashboard(99).tab], [100, dashboard(100).tab]]) } = {}) {
  let onMessage;
  let onRemoved;
  let onUpdated;
  const messages = [];
  let reads = 0;
  const chrome = {
    runtime: { id: 'test-extension', getURL: value => `chrome-extension://test-extension/${value}`, onMessage: { addListener: listener => { onMessage = listener; } }, sendMessage: async () => {} },
    action: { onClicked: { addListener: () => {} } },
    storage: { session: {
      get: async key => ({ [key]: sessions[key] }),
      set: async value => Object.assign(sessions, value),
      remove: async key => { delete sessions[key]; },
    } },
    tabs: {
      onRemoved: { addListener: listener => { onRemoved = listener; } }, create: async () => {},
      onUpdated: { addListener: listener => { onUpdated = listener; } },
      get: async id => { if (!tabs.has(id)) throw new Error('Tab closed'); return tabs.get(id); },
      reload: async () => {}, update: async () => {},
      sendMessage: async (id, message) => {
        if (!tabs.has(id)) throw new Error('Tab closed');
        messages.push({ id, ...message });
        if (message.type === 'CAPTURE_START') return { ok: true, captureId: message.captureId };
        if (message.type === 'PAGE_SNAPSHOT') return { ok: true, snapshot: { url: tabs.get(id).url, title: 'Saved page', blocks: [], assets: [] } };
        if (message.type === 'MATERIAL_NAVIGATION') return { ok: true, navigation: { url: tabs.get(id).url } };
        return { ok: true };
      },
    },
  };
  const withExporterDocument = createExporterContextFixture(chrome);
  installBackground(chrome, {
    readWorkspace: async id => { reads++; return records.get(id) || createWorkspace(id); },
    updateWorkspace: async (id, update) => { const state = update(records.get(id) || createWorkspace(id)); records.set(id, state); return state; },
  });
  return {
    sessions, records, tabs, messages,
    get reads() { return reads; },
    send: (message, sender = dashboard(99)) => new Promise(resolve => {
      const token = sender.tab?.id === 7 ? { captureId: sessions['capture-id:7'] } : { collectionId: sessions['collection:7']?.collectionId };
      const document = ['PREPARE_BOOK', 'OPEN_MATERIAL_ITEM', 'TAKE_SNAPSHOT', 'NAVIGATE_SOURCE'].includes(message.type)
        ? { expectedDocumentToken: documentToken } : {};
      if (!onMessage({ tabId: 7, ...token, ...document, ...message }, withExporterDocument(sender), resolve)) resolve(undefined);
    }),
    async remove(id) { tabs.delete(id); onRemoved(id); for (let i = 0; i < 10; i++) await tick(); },
    async navigate(id, url) { const tab = { id, url }; tabs.set(id, tab); onUpdated(id, { url }, tab); for (let i = 0; i < 10; i++) await tick(); },
  };
}

test('a collection lease blocks every competing dashboard mutation but permits reads', async () => {
  const app = harness();
  assert.equal((await app.send({ type: 'BEGIN_COLLECTION' })).ok, true);
  assert.equal(app.sessions['collection:7'].ownerTabId, 99);
  assert.equal(typeof app.sessions['collection:7'].collectionId, 'string');
  assert.equal(app.sessions['collection-owner:99'], 7);
  assert.equal((await app.send({ type: 'BEGIN_COLLECTION' })).ok, true, 'The owner can resume its own lease');
  for (const type of ['BEGIN_COLLECTION', 'END_COLLECTION', 'SAVE_COLLECTION', 'START_CAPTURE', 'STOP_CAPTURE', 'CLEAR_CAPTURE', 'RESET_CAPTURE', 'RECONNECT_SOURCE', 'TAKE_SNAPSHOT', 'PREPARE_BOOK', 'OPEN_MATERIAL_ITEM', 'NAVIGATE_SOURCE']) {
    const response = await app.send({ type, collection: running, expectedUrl: sourceUrl, url: sourceUrl }, dashboard(100));
    assert.equal(response.ok, false, type);
    assert.match(response.error, /другом окне/, type);
  }
  for (const type of ['GET_STATE', 'GET_SOURCE', 'GET_NAVIGATION']) assert.equal((await app.send({ type }, dashboard(100))).ok, true, type);
  assert.equal(app.records.size, 0, 'Competing mutations must not write or clear the dataset');
});

for (const closedId of [7, 99]) test(`closing tab ${closedId} releases the worker cache after retaining its cancelled dataset`, async () => {
  const saved = { ...createWorkspace(7), snapshots: [{ url: sourceUrl, title: 'Retained textbook' }], collection: structuredClone(running) };
  const app = harness({ records: new Map([[7, saved]]) });
  await app.send({ type: 'BEGIN_COLLECTION' });
  await app.send({ type: 'GET_STATE', summary: true });
  assert.equal(app.reads, 1);
  await app.remove(closedId);
  const state = (await app.send({ type: 'GET_STATE', summary: true }, dashboard(100))).state;
  assert.equal(app.reads, 2);
  assert.equal(state.snapshots[0].title, 'Retained textbook');
  assert.equal(state.collection.status, 'cancelled');
});

test('state exposes whether another dashboard owns the collection', async () => {
  const app = harness();
  assert.equal((await app.send({ type: 'GET_STATE' })).state.collectionLocked, false);
  await app.send({ type: 'BEGIN_COLLECTION' });
  assert.equal((await app.send({ type: 'GET_STATE' })).state.collectionLocked, false);
  assert.equal((await app.send({ type: 'GET_STATE' }, dashboard(100))).state.collectionLocked, true);
  await app.send({ type: 'END_COLLECTION' });
  assert.equal((await app.send({ type: 'GET_STATE' }, dashboard(100))).state.collectionLocked, false);
});

test('book preparation is allowed only for the active owner and its exact book page', async () => {
  const app = harness();
  assert.equal((await app.send({ type: 'PREPARE_BOOK', expectedUrl: sourceUrl })).ok, false);
  await app.send({ type: 'BEGIN_COLLECTION' });
  assert.equal((await app.send({ type: 'PREPARE_BOOK', expectedUrl: sourceUrl })).ok, false);
  await app.send({ type: 'START_CAPTURE' });
  assert.equal((await app.send({ type: 'PREPARE_BOOK', expectedUrl: sourceUrl })).ok, true);
  assert.equal(app.messages.filter(message => message.type === 'PREPARE_BOOK').length, 1);
  for (const expectedUrl of [sourceUrl.replace('867169', '123'), sourceUrl.replace('progressme.ru', 'platform.desharschool.ru')]) {
    assert.equal((await app.send({ type: 'PREPARE_BOOK', expectedUrl })).ok, false, expectedUrl);
  }
  assert.equal((await app.send({ type: 'PREPARE_BOOK', expectedUrl: sourceUrl }, sourceSender)).ok, false);
  assert.equal((await app.send({ type: 'PREPARE_BOOK', expectedUrl: sourceUrl }, dashboard(100))).ok, false);
  assert.equal(app.messages.filter(message => message.type === 'PREPARE_BOOK').length, 1);
  await app.send({ type: 'STOP_CAPTURE' });
  assert.equal((await app.send({ type: 'PREPARE_BOOK', expectedUrl: sourceUrl })).ok, false);
  await app.send({ type: 'START_CAPTURE' });
  const lessonUrl = 'https://progressme.ru/lesson-editor/book/867169/lesson/12/section/13';
  app.tabs.set(7, { id: 7, url: lessonUrl });
  assert.equal((await app.send({ type: 'PREPARE_BOOK', expectedUrl: lessonUrl })).ok, false);
});

test('a complete large-book progress report is not rejected by the retired 200 KB bound', async () => {
  const app = harness();
  await app.send({ type: 'BEGIN_COLLECTION' });
  const items = Array.from({ length: 1000 }, (_, i) => ({ kind: 'section', title: 'Учебный раздел '.repeat(20), key: `section-${i}`, status: 'visited' }));
  const report = { status: 'finished', rootUrl: sourceUrl, items, warnings: [] };
  assert.ok(new TextEncoder().encode(JSON.stringify(report)).length > 200000);
  assert.equal((await app.send({ type: 'SAVE_COLLECTION', collection: report })).ok, true);
  assert.equal(app.records.get(7).collection.items.length, 1000);
});

test('reset removes the selected collection and all captured state, then permits a new owner', async () => {
  const state = { ...createWorkspace(7),
    snapshots: [{ url: sourceUrl, blocks: [{ text: 'Old textbook' }] }],
    captures: [{ kind: 'fetch', data: { lesson: { id: 1 } } }],
    collection: running, warnings: ['Old warning'], dropped: 8, bytes: 456 };
  const app = harness({ records: new Map([[7, state]]) });
  await app.send({ type: 'BEGIN_COLLECTION' });
  await app.send({ type: 'START_CAPTURE' });
  const preserved = structuredClone(app.records.get(7));
  assert.equal((await app.send({ type: 'RESET_CAPTURE' }, dashboard(100))).ok, false);
  assert.deepEqual(app.records.get(7), preserved);
  assert.equal(app.sessions['capture:7'], true);
  assert.equal((await app.send({ type: 'RESET_CAPTURE' })).ok, true);
  const reset = app.records.get(7);
  assert.deepEqual(reset.snapshots, []);
  assert.deepEqual(reset.captures, []);
  assert.deepEqual(reset.warnings, []);
  assert.equal(reset.dropped, 0);
  assert.equal(reset.bytes, 0);
  assert.equal(reset.collection, undefined);
  assert.equal(reset.id, 7);
  assert.equal(app.sessions['capture:7'], undefined);
  assert.equal(app.sessions['collection:7'], undefined);
  assert.equal(app.sessions['collection-owner:99'], undefined);
  assert.equal((await app.send({ type: 'GET_STATE' })).state.collectionLocked, false);
  assert.equal((await app.send({ type: 'CAPTURE_EVENT', event: {
    kind: 'fetch', url: 'https://progressme.ru/api/lessons/1', data: { lesson: { id: 1 } },
  } }, sourceSender)).ok, false, 'An event delivered after reset cannot restore old capture data');
  assert.deepEqual(app.records.get(7).captures, []);
  assert.equal((await app.send({ type: 'CAPTURE_READY' }, sourceSender)).enabled, false);
  assert.equal((await app.send({ type: 'BEGIN_COLLECTION' }, dashboard(100))).ok, true);
  assert.equal(app.sessions['collection:7'].ownerTabId, 100);
});

test('reset works after the source closes and clears its remaining owner lease', async () => {
  const app = harness();
  await app.send({ type: 'BEGIN_COLLECTION' });
  await app.send({ type: 'START_CAPTURE' });
  await app.send({ type: 'SAVE_COLLECTION', collection: running });
  await app.send({ type: 'TAKE_SNAPSHOT' });
  app.tabs.delete(7); // Simulate a close event the worker has not processed yet.
  assert.equal((await app.send({ type: 'RESET_CAPTURE' })).ok, true);
  assert.deepEqual(app.records.get(7).snapshots, []);
  assert.equal(app.records.get(7).collection, undefined);
  assert.equal(app.sessions['capture:7'], undefined);
  assert.equal(app.sessions['collection:7'], undefined);
  assert.equal(app.sessions['collection-owner:99'], undefined);
  assert.equal((await app.send({ type: 'RESET_CAPTURE' })).ok, true, 'Reset remains idempotent without a source');
});

test('reset cleans a stale owner lease before discarding its interrupted report', async () => {
  const app = harness();
  await app.send({ type: 'BEGIN_COLLECTION' });
  await app.send({ type: 'START_CAPTURE' });
  await app.send({ type: 'SAVE_COLLECTION', collection: running });
  app.tabs.delete(99);
  assert.equal((await app.send({ type: 'RESET_CAPTURE' }, dashboard(100))).ok, true);
  assert.equal(app.records.get(7).collection, undefined);
  assert.deepEqual(app.records.get(7).warnings, []);
  assert.equal(app.sessions['capture:7'], undefined);
  assert.equal(app.sessions['collection:7'], undefined);
  assert.equal(app.sessions['collection-owner:99'], undefined);
  assert.equal((await app.send({ type: 'BEGIN_COLLECTION' }, dashboard(100))).ok, true);
});

test('clear keeps the owner lease so collection can restart without losing ownership', async () => {
  const app = harness();
  await app.send({ type: 'BEGIN_COLLECTION' });
  await app.send({ type: 'START_CAPTURE' });
  await app.send({ type: 'SAVE_COLLECTION', collection: running });
  assert.equal((await app.send({ type: 'CLEAR_CAPTURE' })).ok, true);
  assert.equal(app.sessions['collection:7'].ownerTabId, 99);
  assert.equal(app.sessions['collection-owner:99'], 7);
  assert.equal((await app.send({ type: 'START_CAPTURE' })).ok, true);
});

test('only the owner releases the lease and another dashboard can claim it afterward', async () => {
  const app = harness();
  await app.send({ type: 'BEGIN_COLLECTION' });
  await app.send({ type: 'START_CAPTURE' });
  assert.equal((await app.send({ type: 'END_COLLECTION' }, dashboard(100))).ok, false);
  assert.equal(app.sessions['capture:7'], true);
  assert.equal((await app.send({ type: 'END_COLLECTION' })).ok, true);
  assert.equal(app.sessions['capture:7'], undefined);
  assert.equal(app.sessions['collection:7'], undefined);
  assert.equal(app.sessions['collection-owner:99'], undefined);
  assert.equal((await app.send({ type: 'END_COLLECTION' })).code, 'stale_collection', 'A released run cannot affect a later run');
  assert.equal((await app.send({ type: 'BEGIN_COLLECTION' }, dashboard(100))).ok, true);
  assert.equal(app.sessions['collection:7'].ownerTabId, 100);
});

test('leases survive a service-worker restart and still reject another dashboard', async () => {
  const first = harness();
  await first.send({ type: 'BEGIN_COLLECTION' });
  await first.send({ type: 'START_CAPTURE' });
  const restarted = harness(first);
  assert.equal((await restarted.send({ type: 'CLEAR_CAPTURE' }, dashboard(100))).ok, false);
  assert.equal((await restarted.send({ type: 'CAPTURE_READY' }, sourceSender)).enabled, true);
  assert.equal((await restarted.send({ type: 'BEGIN_COLLECTION' })).ok, true);
});

test('closing the owner stops capture, cancels only its running report and retains collected pages', async () => {
  const app = harness();
  await app.send({ type: 'BEGIN_COLLECTION' });
  await app.send({ type: 'START_CAPTURE' });
  await app.send({ type: 'SAVE_COLLECTION', collection: running });
  await app.send({ type: 'TAKE_SNAPSHOT' });
  const snapshot = structuredClone(app.records.get(7).snapshots[0]);
  await app.remove(99);
  assert.equal(app.sessions['capture:7'], undefined);
  assert.equal(app.sessions['collection:7'], undefined);
  assert.equal(app.sessions['collection-owner:99'], undefined);
  assert.equal(app.records.get(7).collection.status, 'cancelled');
  assert.equal(app.records.get(7).collection.items[0].status, 'cancelled');
  assert.ok(app.records.get(7).collection.finishedAt);
  assert.deepEqual(app.records.get(7).snapshots, [snapshot]);
  assert.ok(app.messages.some(message => message.type === 'CAPTURE_STOP'));
  assert.equal((await app.send({ type: 'BEGIN_COLLECTION' }, dashboard(100))).ok, true);
});

test('closing the source also removes the reverse lease and preserves saved data', async () => {
  const app = harness();
  await app.send({ type: 'BEGIN_COLLECTION' });
  await app.send({ type: 'START_CAPTURE' });
  await app.send({ type: 'SAVE_COLLECTION', collection: running });
  await app.send({ type: 'TAKE_SNAPSHOT' });
  await app.remove(7);
  assert.equal(app.sessions['collection:7'], undefined);
  assert.equal(app.sessions['collection-owner:99'], undefined);
  assert.equal(app.sessions['capture:7'], undefined);
  assert.equal(app.records.get(7).snapshots.length, 1);
  assert.equal(app.records.get(7).collection.status, 'cancelled');
});

test('a stale lease is cleaned up after a missed close event and before more capture data is accepted', async () => {
  const app = harness();
  await app.send({ type: 'BEGIN_COLLECTION' });
  await app.send({ type: 'START_CAPTURE' });
  await app.send({ type: 'SAVE_COLLECTION', collection: running });
  app.tabs.delete(99);
  assert.equal((await app.send({ type: 'CAPTURE_READY' }, sourceSender)).enabled, false);
  assert.equal(app.records.get(7).collection.status, 'cancelled');
  assert.equal(app.sessions['collection:7'], undefined);
  assert.equal(app.sessions['collection-owner:99'], undefined);
  assert.equal((await app.send({ type: 'BEGIN_COLLECTION' }, dashboard(100))).ok, true);
});

test('an already queued command from a now-closed owner cannot overwrite its cancelled report', async () => {
  const app = harness();
  await app.send({ type: 'BEGIN_COLLECTION' });
  await app.send({ type: 'SAVE_COLLECTION', collection: running });
  app.tabs.delete(99);
  assert.equal((await app.send({ type: 'SAVE_COLLECTION', collection: running })).ok, false);
  assert.equal(app.records.get(7).collection.status, 'cancelled');
});

test('BEGIN_COLLECTION rejects a content script or a dashboard without a real tab', async () => {
  const app = harness();
  assert.equal((await app.send({ type: 'BEGIN_COLLECTION' }, sourceSender)).ok, false);
  const noTab = { ...dashboard(99), tab: undefined };
  assert.equal((await app.send({ type: 'BEGIN_COLLECTION' }, noTab)).ok, false);
  const closed = dashboard(101);
  assert.equal((await app.send({ type: 'BEGIN_COLLECTION' }, closed)).ok, false);
  assert.equal(app.sessions['collection:7'], undefined);
});

test('snapshot capacity rejection is returned as an error instead of a successful saved URL', async () => {
  const state = createWorkspace(7);
  state.snapshots = Array.from({ length: LIMITS.snapshots }, (_, index) => ({ url: `https://progressme.ru/lesson-editor/book/867169/lesson/1/section/${index + 1}`, blocks: [] }));
  const app = harness({ records: new Map([[7, state]]) });
  await app.send({ type: 'BEGIN_COLLECTION' });
  const response = await app.send({ type: 'TAKE_SNAPSHOT' });
  assert.equal(response.ok, false);
  assert.equal(response.snapshotUrl, undefined);
  assert.match(response.error, /лимит/);
  assert.equal(app.records.get(7).dropped, 1);
});

test('a saved snapshot preserves the snapshotUrl response contract', async () => {
  const app = harness();
  await app.send({ type: 'BEGIN_COLLECTION' });
  const response = await app.send({ type: 'TAKE_SNAPSHOT', expectedUrl: sourceUrl });
  assert.equal(response.ok, true);
  assert.equal(response.snapshotUrl, sourceUrl);
  assert.equal(app.records.get(7).snapshots[0].url, sourceUrl);
});

test('navigating the owner away cancels its report and releases the source without deleting pages', async () => {
  const app = harness();
  await app.send({ type: 'BEGIN_COLLECTION' });
  await app.send({ type: 'START_CAPTURE' });
  await app.send({ type: 'SAVE_COLLECTION', collection: running });
  await app.send({ type: 'TAKE_SNAPSHOT' });
  await app.navigate(99, 'https://example.com/');
  assert.equal(app.sessions['collection:7'], undefined);
  assert.equal(app.sessions['collection-owner:99'], undefined);
  assert.equal(app.sessions['capture:7'], undefined);
  assert.equal(app.records.get(7).collection.status, 'cancelled');
  assert.equal(app.records.get(7).snapshots.length, 1);
  assert.equal((await app.send({ type: 'SAVE_COLLECTION', collection: running })).ok, false, 'A delayed old-owner checkpoint cannot undo navigation cleanup');
  assert.equal(app.records.get(7).collection.status, 'cancelled');
  assert.equal((await app.send({ type: 'BEGIN_COLLECTION' }, dashboard(100))).ok, true);
});

test('a missed owner navigation event is recovered by its exact exporter page and source association', async () => {
  for (const url of ['https://example.com/', 'chrome-extension://other/exporter.html?tab=7',
    'chrome-extension://test-extension/exporter.html-other?tab=7', 'chrome-extension://test-extension/exporter.html?tab=8']) {
    const app = harness();
    await app.send({ type: 'BEGIN_COLLECTION' });
    await app.send({ type: 'START_CAPTURE' });
    app.tabs.set(99, { id: 99, url });
    assert.equal((await app.send({ type: 'GET_STATE' }, dashboard(100))).state.collectionLocked, false, url);
    assert.equal(app.sessions['capture:7'], undefined);
    assert.equal((await app.send({ type: 'RESET_CAPTURE' }, dashboard(100))).ok, true, url);
  }
});
