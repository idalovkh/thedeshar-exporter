import assert from 'node:assert/strict';
import test from 'node:test';
import { installBackground } from '../src/background.js';
import { createExporterContextFixture } from './exporter-context-fixture.js';
import { createWorkspace } from '../src/lib/state.js';

const bookUrl = id => `https://progressme.ru/cabinet/school/materials/book/${id}/content`;
const dashboardUrl = (workspaceId, tabId = 7) => `chrome-extension://test-extension/exporter.html?workspace=${workspaceId}&tab=${tabId}`;
function fixture({ records = new Map(), sessions = {}, sourceReply, beforeRead = async () => {} } = {}) {
  let listener, clicked, removed;
  const tabs = new Map([[7, { id: 7, url: bookUrl(71) }], [8, { id: 8, url: bookUrl(81) }],
    [99, { id: 99, url: 'chrome-extension://test-extension/exporter.html?tab=7' }]]);
  const created = [], updated = [], notifications = [];
  let nextTab = 200;
  const chrome = {
    runtime: { id: 'test-extension', getURL: value => `chrome-extension://test-extension/${value}`,
      onMessage: { addListener: callback => { listener = callback; } }, sendMessage: async value => notifications.push(value) },
    storage: { session: { get: async key => ({ [key]: sessions[key] }), set: async values => Object.assign(sessions, structuredClone(values)), remove: async key => { delete sessions[key]; } } },
    action: { onClicked: { addListener: callback => { clicked = callback; } } },
    tabs: { onRemoved: { addListener: callback => { removed = callback; } }, onUpdated: { addListener() {} },
      get: async id => { if (!tabs.has(id)) throw new Error('Closed tab'); return tabs.get(id); },
      create: async ({ url }) => { const tab = { id: ++nextTab, url }; tabs.set(tab.id, tab); created.push(tab); return tab; },
      update: async (id, patch) => { Object.assign(tabs.get(id), patch); updated.push({ id, ...patch }); }, reload: async () => {},
      sendMessage: async (id, message) => {
        if (sourceReply) { const response = sourceReply(id, message); if (response !== undefined) return response; }
        if (message.type === 'CAPTURE_START') return { ok: true, captureId: message.captureId };
        if (message.type === 'MATERIAL_NAVIGATION') return { ok: true, navigation: { kind: 'book', title: `Book ${id}`, url: tabs.get(id).url } };
        return { ok: true };
      } },
  };
  const withExporterDocument = createExporterContextFixture(chrome);
  function install() {
    installBackground(chrome, { readWorkspace: async id => { const result = structuredClone(records.get(id) || createWorkspace(id)); await beforeRead(id); return result; },
      updateWorkspace: async (id, update) => { const state = update(structuredClone(records.get(id) || createWorkspace(id))); records.set(id, state); return state; },
      listWorkspaces: async () => [...records].map(([storageId, state]) => ({ storageId, state })) });
  }
  install();
  const send = (message, senderId = 99) => new Promise(resolve => {
    const tab = tabs.get(senderId);
    const sender = { id: 'test-extension', url: tab.url, tab, frameId: 0 };
    listener(message, withExporterDocument(sender), resolve);
  });
  return { tabs, records, sessions, send, created, updated, notifications, restart: install,
    click: tabId => clicked(tabs.get(tabId)),
    async resolve(tabId = 7) {
      const result = await send({ type: 'RESOLVE_WORKSPACE', tabId });
      assert.equal(result.ok, true, result.error);
      tabs.set(99, { id: 99, url: dashboardUrl(result.workspaceId, result.sourceTabId) });
      return result;
    },
    async remove(tabId) { tabs.delete(tabId); removed(tabId); for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); },
  };
}

test('changing a source tab to book B retains book A and gives B a clean workspace', async () => {
  const first = { ...createWorkspace(7), collection: { rootUrl: bookUrl(71), title: 'Book A', status: 'finished' }, snapshots: [{ url: bookUrl(71), title: 'Book A' }] };
  const app = fixture({ records: new Map([[7, first]]) });
  const a = await app.resolve();
  app.tabs.get(7).url = bookUrl(81);
  const b = await app.resolve();
  assert.notEqual(a.workspaceId, b.workspaceId);
  const fresh = await app.send({ type: 'GET_STATE', tabId: 7, workspaceId: b.workspaceId });
  assert.equal(fresh.ok, true, fresh.error);
  assert.deepEqual(fresh.state.snapshots, []);
  app.tabs.get(99).url = dashboardUrl(a.workspaceId);
  const retained = await app.send({ type: 'GET_EXPORT_INFO', workspaceId: a.workspaceId, tabId: 7 });
  assert.equal(retained.snapshotCount, 1);
  assert.deepEqual(app.records.get(7), first);
  const refused = await app.send({ type: 'BEGIN_COLLECTION', tabId: 7, workspaceId: a.workspaceId });
  assert.equal(refused.code, 'source_changed');
  assert.match(refused.error, /нажмите значок расширения/);
});

test('a workspace opened from a lesson exposes its pinned book key before its contents are known', async () => {
  const app = fixture();
  app.tabs.get(7).url = 'https://progressme.ru/lesson-editor/book/71/lesson/5/section/6';
  const resolved = await app.resolve();
  assert.equal(resolved.book, null);
  assert.equal(resolved.bookKey, 'https://progressme.ru/book/71');
  app.tabs.get(7).url = bookUrl(81);
  const retained = await app.send({ type: 'RESOLVE_WORKSPACE', tabId: 7, selectedWorkspaceId: resolved.workspaceId });
  assert.equal(retained.ok, true, retained.error);
  assert.equal(retained.bookKey, 'https://progressme.ru/book/71');
});

test('resetting an independently selected book never clears the legacy book in the same source tab', async () => {
  const first = { ...createWorkspace(7), collection: { rootUrl: bookUrl(71), title: 'Book A', status: 'finished' }, snapshots: [{ url: bookUrl(71), title: 'Book A' }] };
  const app = fixture({ records: new Map([[7, first]]) });
  await app.resolve(); app.tabs.get(7).url = bookUrl(81);
  const b = await app.resolve();
  const response = await app.send({ type: 'RESET_CAPTURE', tabId: 7, workspaceId: b.workspaceId, book: { title: 'Book B', rootUrl: bookUrl(81) } });
  assert.equal(response.ok, true, response.error);
  assert.deepEqual(app.records.get(7), first);
  assert.equal(response.state.book.rootUrl, bookUrl(81));
});

test('different source books can hold independent leases and a scoped book survives source closure', async () => {
  const app = fixture();
  const a = await app.resolve(7);
  assert.equal((await app.send({ type: 'BEGIN_COLLECTION', tabId: 7, workspaceId: a.workspaceId })).ok, true);
  app.tabs.set(100, { id: 100, url: 'chrome-extension://test-extension/exporter.html?tab=8' });
  const b = await app.send({ type: 'RESOLVE_WORKSPACE', tabId: 8 }, 100);
  app.tabs.get(100).url = dashboardUrl(b.workspaceId, 8);
  assert.equal((await app.send({ type: 'BEGIN_COLLECTION', tabId: 8, workspaceId: b.workspaceId }, 100)).ok, true);
  assert.equal(app.sessions['collection:7'].workspaceId, a.workspaceId);
  assert.equal(app.sessions['collection:8'].workspaceId, b.workspaceId);
  await app.remove(7);
  const retained = await app.send({ type: 'GET_STATE', workspaceId: a.workspaceId, tabId: 7 });
  assert.equal(retained.ok, true, retained.error);
  assert.equal(app.sessions['collection:8'].workspaceId, b.workspaceId);
});

test('repeated extension clicks focus the existing exporter for that book', async () => {
  const app = fixture();
  await app.click(7); await app.click(7);
  assert.equal(app.created.length, 1);
  assert.equal(app.updated.at(-1).id, app.created[0].id);
  assert.equal(app.updated.at(-1).active, true);
});

test('reopening a closed source launches a working exporter page and retains the book', async () => {
  const retained = { ...createWorkspace(7), book: { title: 'Retained book', rootUrl: bookUrl(71) }, snapshots: [{ url: bookUrl(71) }] };
  const app = fixture({ records: new Map([[7, retained]]) });
  await app.click(7);
  const oldPage = app.created[0], workspaceId = new URL(oldPage.url).searchParams.get('workspace');
  await app.remove(7);
  app.tabs.get(8).url = bookUrl(71);
  await app.click(8);
  assert.equal(app.created.length, 2, 'The old exporter still points at the closed source and must not be focused');
  const page = app.created[1], url = new URL(page.url);
  assert.equal(url.searchParams.get('workspace'), workspaceId);
  assert.equal(url.searchParams.get('tab'), '8');
  const state = await app.send({ type: 'GET_STATE', tabId: 8, workspaceId }, page.id);
  assert.equal(state.ok, true, state.error);
  assert.deepEqual(state.state.snapshots, retained.snapshots);
  const run = await app.send({ type: 'BEGIN_COLLECTION', tabId: 8, workspaceId }, page.id);
  assert.equal(run.ok, true, run.error);
});

test('opening another book from the same source tab creates a separate exporter and preserves the first book', async () => {
  const first = { ...createWorkspace(7), collection: { rootUrl: bookUrl(71), title: 'Book A', status: 'finished' }, snapshots: [{ url: bookUrl(71), title: 'Book A' }] };
  const app = fixture({ records: new Map([[7, first]]) });
  await app.click(7);
  const a = app.created[0], aUrl = a.url;
  const aWorkspaceId = new URL(a.url).searchParams.get('workspace');
  app.tabs.get(7).url = bookUrl(81);
  await app.click(7);
  assert.equal(app.created.length, 2);
  const b = app.created[1], bWorkspaceId = new URL(b.url).searchParams.get('workspace');
  assert.notEqual(aWorkspaceId, bWorkspaceId);
  assert.equal(new URL(b.url).searchParams.get('tab'), '7');
  assert.equal(a.url, aUrl);
  const fresh = await app.send({ type: 'GET_STATE', tabId: 7, workspaceId: bWorkspaceId }, b.id);
  assert.equal(fresh.ok, true, fresh.error);
  assert.deepEqual(fresh.state.snapshots, []);
  assert.equal(fresh.state.book.rootUrl, bookUrl(81));
  const retained = await app.send({ type: 'GET_STATE', tabId: 7, workspaceId: aWorkspaceId }, a.id);
  assert.equal(retained.ok, true, retained.error);
  assert.equal(retained.state.book.title, 'Book A');
  assert.deepEqual(retained.state.snapshots, first.snapshots);
  assert.deepEqual(app.records.get(7), first);
});

test('icon clicks in different source tabs open separate exporters that collect independently', async () => {
  const app = fixture();
  await app.click(7);
  await app.click(8);
  assert.equal(app.created.length, 2);
  const [a, b] = app.created;
  const aWorkspaceId = new URL(a.url).searchParams.get('workspace');
  const bWorkspaceId = new URL(b.url).searchParams.get('workspace');
  assert.notEqual(aWorkspaceId, bWorkspaceId);
  assert.equal(new URL(a.url).searchParams.get('tab'), '7');
  assert.equal(new URL(b.url).searchParams.get('tab'), '8');
  const starts = await Promise.all([
    app.send({ type: 'BEGIN_COLLECTION', tabId: 7, workspaceId: aWorkspaceId }, a.id),
    app.send({ type: 'BEGIN_COLLECTION', tabId: 8, workspaceId: bWorkspaceId }, b.id),
  ]);
  for (const result of starts) assert.equal(result.ok, true, result.error);
  assert.equal(app.sessions['collection:7'].workspaceId, aWorkspaceId);
  assert.equal(app.sessions['collection:8'].workspaceId, bWorkspaceId);
  assert.equal(app.sessions['collection:7'].ownerTabId, a.id);
  assert.equal(app.sessions['collection:8'].ownerTabId, b.id);
});

test('the removed book-picker command does not expose a saved-book list', async () => {
  const app = fixture();
  await app.resolve();
  const result = await app.send({ type: 'LIST_WORKSPACES', tabId: 7 });
  assert.equal(result.ok, false);
  assert.equal(result.workspaces, undefined);
});

test('simultaneous icon clicks create only one exporter for a book', async () => {
  const app = fixture();
  await Promise.all([app.click(7), app.click(7)]);
  assert.equal(app.created.length, 1);
});

test('workspace reads reject a dashboard that names a different workspace', async () => {
  const app = fixture();
  const a = await app.resolve(7);
  app.tabs.get(7).url = bookUrl(81);
  const b = await app.resolve(7);
  const response = await app.send({ type: 'GET_STATE', tabId: 7, workspaceId: a.workspaceId });
  assert.equal(response.ok, false);
  assert.notEqual(a.workspaceId, b.workspaceId);
});

test('ZIP handoff persists per book, rejects old revisions, and clearing another book preserves it', async () => {
  const app = fixture();
  const a = await app.resolve(7);
  const state = (await app.send({ type: 'GET_STATE', workspaceId: a.workspaceId, tabId: 7, summary: true })).state;
  const saved = await app.send({ type: 'RECORD_DOWNLOAD_RESULT', workspaceId: a.workspaceId, tabId: 7,
    revision: state.exportRevision, loaded: 3, missing: 0 });
  assert.equal(saved.ok, true, saved.error);
  app.restart();
  const restored = await app.send({ type: 'GET_STATE', workspaceId: a.workspaceId, tabId: 7 });
  assert.equal(restored.state.downloadResult.loaded, 3);
  assert.equal(restored.state.downloadResult.missing, 0);
  const stale = await app.send({ type: 'RECORD_DOWNLOAD_RESULT', workspaceId: a.workspaceId, tabId: 7,
    revision: state.exportRevision, loaded: 1, missing: 1 });
  assert.equal(stale.code, 'export_changed');
  app.tabs.get(7).url = bookUrl(81);
  const b = await app.resolve(7);
  await app.send({ type: 'RESET_CAPTURE', workspaceId: b.workspaceId, tabId: 7 });
  app.tabs.get(99).url = dashboardUrl(a.workspaceId);
  assert.equal((await app.send({ type: 'GET_STATE', workspaceId: a.workspaceId, tabId: 7 })).state.downloadResult.loaded, 3);
});

test('clearing retained A while its former source collects B preserves the active B lease and capture', async () => {
  const first = { ...createWorkspace(7), collection: { rootUrl: bookUrl(71), title: 'Book A', status: 'finished' }, snapshots: [{ url: bookUrl(71), title: 'Book A' }] };
  const app = fixture({ records: new Map([[7, first]]) });
  const a = await app.resolve(7);
  app.tabs.get(7).url = bookUrl(81);
  const b = await app.resolve(7);
  const run = await app.send({ type: 'BEGIN_COLLECTION', tabId: 7, workspaceId: b.workspaceId, requestId: 'book-b-run' });
  assert.equal(run.ok, true, run.error);
  const started = await app.send({ type: 'START_CAPTURE', tabId: 7, workspaceId: b.workspaceId, collectionId: run.collectionId });
  assert.equal(started.ok, true, started.error);
  app.tabs.set(101, { id: 101, url: dashboardUrl(a.workspaceId) });
  const cleared = await app.send({ type: 'RESET_CAPTURE', tabId: 7, workspaceId: a.workspaceId }, 101);
  assert.equal(cleared.ok, true, cleared.error);
  assert.equal(app.sessions['collection:7'].collectionId, run.collectionId);
  assert.equal(app.sessions['capture-id:7'], started.captureId);
  assert.deepEqual(app.records.get(7).snapshots, []);
});

test('a delayed UUID workspace read cannot restore records after scoped reset', async () => {
  let block = false, started, release;
  const reading = new Promise(resolve => { started = resolve; });
  const app = fixture({ beforeRead: async id => {
    if (block && typeof id === 'string') { block = false; started(); await new Promise(resolve => { release = resolve; }); }
  } });
  const selected = await app.resolve(7);
  app.records.set(selected.workspaceId, { ...createWorkspace(selected.workspaceId), snapshots: [{ url: bookUrl(71), title: 'Old data' }] });
  block = true;
  const old = app.send({ type: 'GET_STATE', tabId: 7, workspaceId: selected.workspaceId });
  await reading;
  const reset = await app.send({ type: 'RESET_CAPTURE', tabId: 7, workspaceId: selected.workspaceId });
  assert.equal(reset.ok, true, reset.error);
  release();
  assert.equal((await old).code, 'stale_collection');
  assert.deepEqual((await app.send({ type: 'GET_STATE', tabId: 7, workspaceId: selected.workspaceId })).state.snapshots, []);
});
