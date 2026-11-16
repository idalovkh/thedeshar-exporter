import assert from 'node:assert/strict';
import test from 'node:test';
import { installBackground } from '../src/background.js';
import { createExporterContextFixture } from './exporter-context-fixture.js';
import { createWorkspace } from '../src/lib/state.js';
import { buildCoverage } from '../src/lib/coverage.js';

const sourceUrl = 'https://platform.desharschool.ru/lesson-editor/book/1/lesson/2/section/3';
const sourceSender = { id: 'test-extension', url: sourceUrl, frameId: 0, tab: { id: 7, url: sourceUrl } };
const dashboardSender = { id: 'test-extension', url: 'chrome-extension://test-extension/exporter.html?tab=7', tab: { id: 99, url: 'chrome-extension://test-extension/exporter.html?tab=7' } };
const documentToken = 'source-document-00000001';

function harness({ sessions = {}, records = new Map(), beforeUpdate = async () => {}, afterUpdate = async () => {}, cloneStorage = false,
  sourceResponse = message => message.type === 'MATERIAL_NAVIGATION' ? { ok: true, navigation: { url: sourceUrl, documentToken } } : { ok: true } } = {}) {
  let onMessage;
  let sourceConnected = true;
  let sourceOpen = true;
  let currentSourceUrl = sourceUrl;
  let connectionError = new Error('Could not establish connection. Receiving end does not exist.');
  const actions = [];
  let reads = 0;
  const chrome = {
    runtime: { id: 'test-extension', getURL: value => `chrome-extension://test-extension/${value}`, onMessage: { addListener: listener => { onMessage = listener; } }, sendMessage: async () => {} },
    action: { onClicked: { addListener: () => {} } },
    storage: { session: {
      get: async key => ({ [key]: sessions[key] }),
      set: async value => Object.assign(sessions, value),
      remove: async key => { delete sessions[key]; },
    } },
    webNavigation: { getFrame: async () => sourceOpen ? { url: currentSourceUrl,
      documentId: '11111111-1111-4111-8111-111111111111', errorOccurred: false, documentLifecycle: 'active' } : null },
    tabs: {
      onRemoved: { addListener: () => {} }, create: async () => {},
      get: async id => { if (id === 7 && !sourceOpen) throw new Error('No tab with id: 7.'); return { id, url: id === 7 ? currentSourceUrl : dashboardSender.url, title: 'Урок' }; },
      reload: async id => { actions.push({ type: 'reload', id }); },
      sendMessage: async (id, message) => {
        actions.push({ id, ...message }); if (!sourceConnected) throw connectionError;
        const response = await sourceResponse(message);
        return message.type === 'CAPTURE_START' && response?.ok ? { ...response, captureId: message.captureId } : response;
      },
    },
  };
  const withExporterDocument = createExporterContextFixture(chrome);
  installBackground(chrome, {
    readWorkspace: async id => { reads++; return records.get(id) || createWorkspace(id); },
    updateWorkspace: async (id, updater) => {
      await beforeUpdate();
      const previous = records.get(id) || createWorkspace(id);
      const state = updater(cloneStorage ? structuredClone(previous) : previous);
      await afterUpdate(); records.set(id, state); return state;
    },
  });
  return {
    sessions, records, actions,
    get reads() { return reads; },
    disconnect: (error = connectionError) => { sourceConnected = false; connectionError = error; },
    closeSource: () => { sourceOpen = false; },
    setSourceUrl: url => { currentSourceUrl = url; },
    send: (message, sender = dashboardSender) => new Promise(resolve => {
      const token = sender.tab?.id === 7 ? { captureId: sessions['capture-id:7'] } : { collectionId: sessions['collection:7']?.collectionId };
      const document = ['PREPARE_BOOK', 'OPEN_MATERIAL_ITEM', 'TAKE_SNAPSHOT', 'NAVIGATE_SOURCE'].includes(message.type)
        ? { expectedDocumentToken: documentToken } : {};
      const pending = onMessage({ ...token, ...document, ...message }, withExporterDocument(sender), resolve); if (!pending) resolve(undefined);
    }),
  };
}

test('page scripts cannot invoke dashboard management commands or spoof another extension', async () => {
  const app = harness();
  assert.equal((await app.send({ type: 'START_CAPTURE', tabId: 7 }, sourceSender)).ok, false);
  assert.equal((await app.send({ type: 'RESET_CAPTURE', tabId: 7 }, sourceSender)).ok, false);
  assert.equal((await app.send({ type: 'RECONNECT_SOURCE', tabId: 7 }, sourceSender)).ok, false);
  assert.equal((await app.send({ type: 'START_CAPTURE', tabId: 7 }, { ...dashboardSender, id: 'other-extension' })).ok, false);
  assert.equal((await app.send({ type: 'CAPTURE_READY' }, { ...sourceSender, frameId: 2 })).enabled, false);
});

test('large workspaces use lightweight summaries and bounded revision-checked export pages', async () => {
  const text = 'x'.repeat(7 * 1024 * 1024);
  const state = { ...createWorkspace(7), exportRevision: 12,
    snapshots: [{ url: sourceUrl, title: 'Large textbook', blocks: [{ text }], links: [], route: { kind: 'section' },
      assets: [{ url: 'https://files.example/picture.png' }] }],
    captures: Array.from({ length: 10 }, (_, index) => ({ kind: 'fetch', url: `https://progressme.ru/lessons/${index}`,
      pageUrl: sourceUrl, data: { exercises: [{ text, AudioUrl: `https://files.example/${index}.mp3` }] } })) };
  const app = harness({ records: new Map([[7, state]]) });
  const summary = (await app.send({ type: 'GET_STATE', tabId: 7, summary: true })).state;
  assert.ok(JSON.stringify(summary).length < 20000, 'The progress view never transfers the 77 MiB of raw records');
  assert.equal(summary.snapshots[0].blocks, undefined);
  assert.equal(summary.captures[0].data, true);
  assert.equal(summary.assetInventory.length, 11);
  assert.deepEqual(buildCoverage(summary), buildCoverage(state));
  const info = await app.send({ type: 'GET_EXPORT_INFO', tabId: 7 });
  assert.deepEqual(info, { ok: true, revision: 12, snapshotCount: 1, captureCount: 10 });
  const captures = [];
  let offset = 0;
  while (offset < info.captureCount) {
    const page = await app.send({ type: 'GET_EXPORT_RECORDS', tabId: 7, kind: 'captures', offset, limit: 4, revision: info.revision });
    assert.equal(page.ok, true);
    assert.equal(page.records.length, 1, 'Two 7 MiB records must not share one runtime message');
    captures.push(...page.records); offset = page.nextOffset;
    assert.equal(page.total, 10);
  }
  assert.equal(captures.length, state.captures.length);
  assert.equal(captures[9].data.exercises[0].text, text);
  assert.equal(app.reads, 1, 'Progress refresh and export pages share the retained worker read');
  await app.send({ type: 'BEGIN_COLLECTION', tabId: 7 });
  await app.send({ type: 'SAVE_COLLECTION', tabId: 7, collection: { status: 'finished', rootUrl: sourceUrl } });
  const stale = await app.send({ type: 'GET_EXPORT_RECORDS', tabId: 7, kind: 'snapshots', offset: 0, limit: 4, revision: 12 });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'export_changed');
});

test('summary media inventory follows capture append, snapshot replacement, and reset', async () => {
  let currentSnapshot = { url: sourceUrl, assets: [{ url: 'https://files.example/first.png' }] };
  const app = harness({ sourceResponse: message => message.type === 'PAGE_SNAPSHOT' ? { ok: true, snapshot: currentSnapshot } : { ok: true } });
  const summary = async () => (await app.send({ type: 'GET_STATE', tabId: 7, summary: true })).state;
  await app.send({ type: 'BEGIN_COLLECTION', tabId: 7 });
  await app.send({ type: 'START_CAPTURE', tabId: 7 });
  await app.send({ type: 'TAKE_SNAPSHOT', tabId: 7 });
  assert.equal((await summary()).assetInventory.length, 1);
  const event = { kind: 'fetch', url: 'https://progressme.ru/lessons/2', data: { exercises: [{ AudioUrl: 'https://files.example/audio.mp3' }] } };
  await app.send({ type: 'CAPTURE_EVENT', event }, sourceSender);
  const first = await summary();
  assert.equal(first.assetInventory.length, 2);
  await app.send({ type: 'CAPTURE_EVENT', event }, sourceSender);
  assert.equal((await summary()).exportRevision, first.exportRevision, 'A duplicate response does not restart an export');
  currentSnapshot = { ...currentSnapshot, assets: [{ url: 'https://files.example/second.png' }] };
  await app.send({ type: 'TAKE_SNAPSHOT', tabId: 7 });
  assert.deepEqual((await summary()).assetInventory.map(asset => asset.url), ['https://files.example/second.png', 'https://files.example/audio.mp3']);
  await app.send({ type: 'RESET_CAPTURE', tabId: 7 });
  assert.deepEqual((await summary()).assetInventory, []);
});

test('export paging rejects malformed or foreign requests before exposing records', async () => {
  const app = harness();
  for (const payload of [{ kind: 'unknown', offset: 0, limit: 4 }, { kind: 'snapshots', offset: -1, limit: 4 },
    { kind: 'snapshots', offset: 0, limit: 33 }, { kind: 'snapshots', offset: 1, limit: 4 }]) {
    assert.equal((await app.send({ type: 'GET_EXPORT_RECORDS', tabId: 7, revision: 0, ...payload })).ok, false);
  }
  assert.equal((await app.send({ type: 'GET_EXPORT_INFO', tabId: 7 }, sourceSender)).ok, false);
  assert.equal((await app.send({ type: 'GET_EXPORT_RECORDS', tabId: 7, kind: 'captures', offset: 0, limit: 4, revision: 0 }, sourceSender)).ok, false);
});

test('current visit status is guarded and archived author data cannot manufacture a fresh acknowledgement', async () => {
  const data = { Class: 'GetExerciseWsController', Method: 'LoadExercises', IsSuccess: true, Value: { SectionId: 3, Items: [] } };
  const state = { ...createWorkspace(7), captures: [{ pageUrl: sourceUrl, data: { batch: [data] } }] };
  const sectionVisit = { token: 'current-section-visit-0000', revision: 0, received: false, idleMs: 0 };
  const app = harness({ records: new Map([[7, state]]), sourceResponse: () => ({ ok: true, navigation: { url: sourceUrl, documentToken, sectionVisit } }) });
  const navigation = await app.send({ type: 'GET_NAVIGATION', tabId: 7, expectedUrl: sourceUrl, expectedDocumentToken: documentToken });
  assert.equal(navigation.ok, true);
  assert.equal(navigation.navigation.sectionVisit.received, false);
  assert.equal((await app.send({ type: 'GET_NAVIGATION', tabId: 7, expectedUrl: sourceUrl.replace('/section/3', '/section/4') })).ok, false);
  assert.equal((await app.send({ type: 'GET_NAVIGATION', tabId: 7, expectedUrl: sourceUrl }, sourceSender)).ok, false);
});

test('lesson snapshots require author definitions even when the rendered page is empty', async () => {
  let blocks = [{ type: 'dom', text: 'Nonempty exercise' }];
  const app = harness({ sourceResponse: message => message.type === 'PAGE_SNAPSHOT'
    ? { ok: true, snapshot: { url: sourceUrl, route: { kind: 'lesson' }, blocks } } : { ok: true } });
  await app.send({ type: 'BEGIN_COLLECTION', tabId: 7 });
  const missing = await app.send({ type: 'TAKE_SNAPSHOT', tabId: 7, expectedUrl: sourceUrl });
  assert.equal(missing.retained.authorData, false);
  blocks = [];
  const empty = await app.send({ type: 'TAKE_SNAPSHOT', tabId: 7, expectedUrl: sourceUrl });
  assert.equal(empty.retained.authorData, false);
  await app.send({ type: 'BEGIN_COLLECTION', tabId: 7 });
  await app.send({ type: 'START_CAPTURE', tabId: 7 });
  await app.send({ type: 'CAPTURE_EVENT', event: { kind: 'websocket', url: 'wss://proxy.progressme.ru/websocket',
    data: { Class: 'GetExerciseWsController', Method: 'LoadExercises', IsSuccess: true, Value: { SectionId: 3, Items: [] } } } }, sourceSender);
  assert.equal((await app.send({ type: 'TAKE_SNAPSHOT', tabId: 7, expectedUrl: sourceUrl })).retained.authorData, true);
});

test('source navigation can reload only the guarded current lesson while capture is enabled', async () => {
  const app = harness();
  assert.equal((await app.send({ type: 'NAVIGATE_SOURCE', tabId: 7, url: sourceUrl, expectedUrl: sourceUrl })).ok, false);
  await app.send({ type: 'BEGIN_COLLECTION', tabId: 7 });
  await app.send({ type: 'START_CAPTURE', tabId: 7 });
  assert.equal((await app.send({ type: 'NAVIGATE_SOURCE', tabId: 7, url: sourceUrl, expectedUrl: sourceUrl })).ok, true);
  assert.deepEqual(app.actions.filter(action => action.type === 'NAVIGATE_SOURCE'), [{ id: 7, type: 'NAVIGATE_SOURCE',
    expectedUrl: sourceUrl, expectedDocumentToken: documentToken, url: sourceUrl, reload: true }]);
  assert.equal((await app.send({ type: 'NAVIGATE_SOURCE', tabId: 7, url: sourceUrl.replace('/section/3', '/section/4'), expectedUrl: sourceUrl })).ok, false);
  assert.equal((await app.send({ type: 'NAVIGATE_SOURCE', tabId: 7, url: sourceUrl, expectedUrl: sourceUrl.replace('/lesson/2', '/lesson/9') })).ok, false);
  assert.equal(app.actions.filter(action => action.type === 'NAVIGATE_SOURCE').length, 1);
});

test('a failed commit discards prepared worker caches and retries from committed records', async () => {
  let fail = false;
  const app = harness({ cloneStorage: true, afterUpdate: async () => { if (fail) throw new Error('Local disk temporarily unavailable'); } });
  const summary = async () => (await app.send({ type: 'GET_STATE', tabId: 7, summary: true })).state;
  await app.send({ type: 'BEGIN_COLLECTION', tabId: 7 });
  await app.send({ type: 'START_CAPTURE', tabId: 7 });
  const original = await summary();
  fail = true;
  const event = { kind: 'fetch', url: 'https://progressme.ru/lessons/2', data: { exercises: [{ AudioUrl: 'https://files.example/audio.mp3' }] } };
  assert.equal((await app.send({ type: 'CAPTURE_EVENT', event }, sourceSender)).ok, false);
  fail = false;
  const restored = await summary();
  assert.equal(restored.captures.length, 0);
  assert.deepEqual(restored.assetInventory, []);
  assert.equal(restored.exportRevision, original.exportRevision);
  assert.equal((await app.send({ type: 'CAPTURE_EVENT', event }, sourceSender)).ok, true);
  assert.equal((await summary()).captures.length, 1);
  assert.equal((await summary()).assetInventory.length, 1);
});

test('collection resumes after worker restart but not after the browser session ends', async () => {
  const sessions = {};
  const app = harness({ sessions });
  await app.send({ type: 'BEGIN_COLLECTION', tabId: 7 });
  assert.equal((await app.send({ type: 'START_CAPTURE', tabId: 7 })).ok, true);
  assert.equal((await harness({ sessions }).send({ type: 'CAPTURE_READY' }, sourceSender)).enabled, true);
  assert.equal((await harness().send({ type: 'CAPTURE_READY' }, sourceSender)).enabled, false);
});

for (const command of ['CLEAR_CAPTURE', 'RESET_CAPTURE']) test(`${command} serializes after in-flight source writes`, async () => {
  let unblock;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { unblock = resolve; });
  let updates = 0;
  const app = harness({ beforeUpdate: async () => { if (++updates === 1) { entered(); await blocked; } } });
  await app.send({ type: 'BEGIN_COLLECTION', tabId: 7 });
  await app.send({ type: 'START_CAPTURE', tabId: 7 });
  const event = app.send({ type: 'CAPTURE_EVENT', event: { kind: 'fetch', url: 'https://platform.desharschool.ru/lessons/2', data: { lesson: { id: 2 } } } }, sourceSender);
  await started;
  const clearing = app.send({ type: command, tabId: 7 });
  unblock();
  await Promise.all([event, clearing]);
  assert.equal(app.records.get(7).captures.length, 0);
  assert.equal((await app.send({ type: 'GET_STATE', tabId: 7 })).state.enabled, false);
});

test('failed connection does not leave collection enabled; stop works after source closes', async () => {
  const app = harness();
  await app.send({ type: 'BEGIN_COLLECTION', tabId: 7 });
  app.disconnect();
  assert.equal((await app.send({ type: 'START_CAPTURE', tabId: 7 })).ok, false);
  assert.equal((await app.send({ type: 'CAPTURE_READY' }, sourceSender)).enabled, false);
  assert.equal((await app.send({ type: 'STOP_CAPTURE', tabId: 7 })).ok, true);
});

for (const type of ['GET_NAVIGATION', 'OPEN_MATERIAL_ITEM', 'TAKE_SNAPSHOT', 'START_CAPTURE']) test(`${type} turns a missing content receiver into an actionable connection error`, async () => {
  const app = harness();
  await app.send({ type: 'BEGIN_COLLECTION', tabId: 7 });
  if (type === 'OPEN_MATERIAL_ITEM') await app.send({ type: 'START_CAPTURE', tabId: 7 });
  app.disconnect();
  const response = await app.send({ type, tabId: 7, expectedUrl: sourceUrl, key: 'section' });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'source_disconnected');
  assert.match(response.error, /Нет связи с книгой/);
  assert.match(response.error, /Обновите вкладку книги.*нажмите значок exporter/);
  assert.doesNotMatch(response.error, /Receiving end|establish connection/);
  assert.equal(app.records.size, 0, 'A failed connection must not alter collected material');
  if (type === 'START_CAPTURE') assert.equal(app.sessions['capture:7'], undefined);
});

test('closed message ports and an empty content reply use the same recovery error', async () => {
  const app = harness();
  app.disconnect(new Error('The message port closed before a response was received.'));
  assert.equal((await app.send({ type: 'GET_NAVIGATION', tabId: 7 })).code, 'source_disconnected');
  const empty = harness({ sourceResponse: () => undefined });
  assert.equal((await empty.send({ type: 'GET_NAVIGATION', tabId: 7 })).code, 'source_disconnected');
});

test('connection handling preserves specific source errors instead of suggesting a reload', async () => {
  const message = 'В списке разделов есть одинаковые названия.';
  const app = harness({ sourceResponse: () => ({ ok: false, error: message }) });
  assert.equal((await app.send({ type: 'GET_NAVIGATION', tabId: 7 })).error, message);
  await app.send({ type: 'BEGIN_COLLECTION', tabId: 7 });
  assert.equal((await app.send({ type: 'START_CAPTURE', tabId: 7 })).error, message);
  assert.equal(app.sessions['capture:7'], undefined);
  app.disconnect(new Error(message));
  const response = await app.send({ type: 'GET_NAVIGATION', tabId: 7 });
  assert.equal(response.error, message);
  assert.equal(response.code, undefined);
});

test('guarded navigation returns titles only for the requested material page', async () => {
  const app = harness({ sourceResponse: () => ({ ok: true, navigation: { url: sourceUrl, title: 'Current section' } }) });
  const result = await app.send({ type: 'GET_NAVIGATION', tabId: 7, expectedUrl: `${sourceUrl}?view=teacher#content` });
  assert.equal(result.ok, true, 'View and tracking parameters do not change material identity');
  assert.equal(result.navigation.title, 'Current section');

  for (const expectedUrl of [sourceUrl.replace('/book/1/', '/book/9/'), sourceUrl.replace('/section/3', '/section/4'), 'https://example.com/book/1']) {
    const rejected = await app.send({ type: 'GET_NAVIGATION', tabId: 7, expectedUrl });
    assert.equal(rejected.code, 'source_changed');
    assert.equal(rejected.navigation, undefined);
  }
  assert.equal(app.actions.filter(action => action.type === 'MATERIAL_NAVIGATION').length, 1, 'Mismatched requests must not read source navigation');
});

test('guarded navigation rejects a reply after the source tab changes books', async () => {
  let resolveReply, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const reply = new Promise(resolve => { resolveReply = resolve; });
  const app = harness({ sourceResponse: () => { entered(); return reply; } });
  const pending = app.send({ type: 'GET_NAVIGATION', tabId: 7, expectedUrl: sourceUrl });
  await started;
  app.setSourceUrl(sourceUrl.replace('/book/1/', '/book/9/'));
  resolveReply({ ok: true, navigation: { url: sourceUrl, title: 'Previous book' } });
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'source_changed');
  assert.equal(result.navigation, undefined, 'The previous title cannot escape with a newly navigated tab');
});

test('guarded navigation rejects stale content URLs and preserves source errors', async () => {
  let response = { ok: true, navigation: { url: sourceUrl.replace('/book/1/', '/book/9/'), title: 'Unrelated book' } };
  const app = harness({ sourceResponse: () => response });
  const guarded = () => app.send({ type: 'GET_NAVIGATION', tabId: 7, expectedUrl: sourceUrl });
  assert.equal((await guarded()).code, 'source_changed');
  response = { ok: true, navigation: { title: 'Title without a material URL' } };
  assert.equal((await guarded()).code, 'source_changed');
  response = { ok: false, error: 'The source is still loading' };
  assert.deepEqual(await guarded(), response);
});

test('unscoped collector navigation keeps its existing polling behavior', async () => {
  const response = { ok: true, navigation: { url: sourceUrl.replace('/section/3', '/section/4'), title: 'Next section' } };
  const app = harness({ sourceResponse: () => response });
  assert.deepEqual(await app.send({ type: 'GET_NAVIGATION', tabId: 7 }), response);
});

test('a closed source produces a separate friendly error and can still be reset', async () => {
  const app = harness();
  await app.send({ type: 'BEGIN_COLLECTION', tabId: 7 });
  app.closeSource();
  for (const type of ['GET_SOURCE', 'GET_NAVIGATION', 'TAKE_SNAPSHOT', 'START_CAPTURE', 'RECONNECT_SOURCE']) {
    if (type === 'RECONNECT_SOURCE') await app.send({ type: 'END_COLLECTION', tabId: 7 });
    const response = await app.send({ type, tabId: 7 });
    assert.equal(response.code, 'source_closed', type);
    assert.match(response.error, /Вкладка с учебником закрыта/, type);
    assert.doesNotMatch(response.error, /No tab with id/, type);
  }
  assert.equal((await app.send({ type: 'RESET_CAPTURE', tabId: 7 })).ok, true);
  assert.equal(app.actions.some(action => action.type === 'reload'), false);
});

test('explicit reconnect stops capture and reloads only the selected source without changing its archive', async () => {
  const state = { ...createWorkspace(7),
    snapshots: [{ url: sourceUrl, blocks: [{ text: 'Retained page' }] }],
    captures: [{ kind: 'fetch', data: { lesson: { id: 2 } } }],
    warnings: ['Retained warning'], dropped: 3, bytes: 120,
    collection: { status: 'failed', rootUrl: sourceUrl, title: 'Retained textbook', failed: [{ error: 'Previous failure' }] } };
  const original = structuredClone(state);
  const app = harness({ records: new Map([[7, state]]), sessions: { 'capture:7': true } });
  app.disconnect();
  assert.equal((await app.send({ type: 'RECONNECT_SOURCE', tabId: 7 })).ok, true);
  assert.deepEqual(app.records.get(7), original);
  assert.equal(app.sessions['capture:7'], undefined);
  assert.deepEqual(app.actions, [{ id: 7, type: 'CAPTURE_STOP', captureId: null }, { type: 'reload', id: 7 }]);
});

test('reconnect refuses to reload during the owner collection or after the source leaves materials', async () => {
  const app = harness();
  await app.send({ type: 'BEGIN_COLLECTION', tabId: 7 });
  await app.send({ type: 'BEGIN_COLLECTION', tabId: 7 });
  await app.send({ type: 'START_CAPTURE', tabId: 7 });
  const response = await app.send({ type: 'RECONNECT_SOURCE', tabId: 7 });
  assert.equal(response.ok, false);
  assert.match(response.error, /Сначала остановите сбор/);
  assert.equal(app.sessions['capture:7'], true);
  assert.equal(app.sessions['collection:7'].ownerTabId, 99);
  assert.equal(app.actions.some(action => action.type === 'reload'), false);
  const other = harness();
  other.setSourceUrl('https://progressme.ru/cabinet/school/students');
  assert.equal((await other.send({ type: 'RECONNECT_SOURCE', tabId: 7 })).ok, false);
  assert.deepEqual(other.actions, []);
});

test('capture loss diagnostics require an enabled source and retain only fixed warnings', async () => {
  const app = harness();
  assert.equal((await app.send({ type: 'CAPTURE_ISSUE', code: 'response_too_large' }, sourceSender)).ok, false);
  await app.send({ type: 'BEGIN_COLLECTION', tabId: 7 });
  await app.send({ type: 'START_CAPTURE', tabId: 7 });
  for (const code of ['response_too_large', 'response_too_complex', 'bootstrap_overflow', 'bootstrap_navigation_changed']) {
    assert.equal((await app.send({ type: 'CAPTURE_ISSUE', code, error: 'page supplied private text' }, sourceSender)).ok, true);
  }
  const state = app.records.get(7);
  assert.equal(state.dropped, 4);
  assert.equal(state.warnings.length, 4);
  assert.deepEqual(state.captures, []);
  assert.equal(JSON.stringify(state).includes('page supplied'), false);
  for (const sender of [dashboardSender, { ...sourceSender, frameId: 1 }, { ...sourceSender, id: 'other-extension' }]) {
    assert.equal((await app.send({ type: 'CAPTURE_ISSUE', code: 'response_too_large' }, sender)).ok, false);
  }
  assert.equal((await app.send({ type: 'CAPTURE_ISSUE', code: '__proto__' }, sourceSender)).ok, false);
  assert.equal(state.dropped, 4);
  await app.send({ type: 'STOP_CAPTURE', tabId: 7 });
  assert.equal((await app.send({ type: 'CAPTURE_ISSUE', code: 'response_too_large' }, sourceSender)).ok, false);
  assert.equal(state.dropped, 4);
});
