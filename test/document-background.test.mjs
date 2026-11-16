import assert from 'node:assert/strict';
import test from 'node:test';
import { installBackground } from '../src/background.js';
import { createExporterContextFixture } from './exporter-context-fixture.js';
import { createWorkspace } from '../src/lib/state.js';

const bookUrl = 'https://progressme.ru/cabinet/school/materials/book/867169/content';
const sectionUrl = 'https://progressme.ru/lesson-editor/book/867169/lesson/13794943/section/67546487';
const firstDocument = 'source-document-00000001';
const secondDocument = 'source-document-00000002';

function sourceDocument({ url = sectionUrl, replaceBeforeNavigation = false } = {}) {
  let listener;
  let documentToken = firstDocument;
  let browserDocument = 1;
  let state = createWorkspace(7);
  const sessions = {};
  const actions = [];
  const dashboard = { id: 'extension', url: 'chrome-extension://extension/exporter.html?tab=7',
    tab: { id: 99, url: 'chrome-extension://extension/exporter.html?tab=7' } };
  const chrome = {
    runtime: { id: 'extension', getURL: path => `chrome-extension://extension/${path}`,
      onMessage: { addListener: callback => { listener = callback; } }, sendMessage: async () => {} },
    action: { onClicked: { addListener() {} } },
    storage: { session: { get: async key => ({ [key]: sessions[key] }),
      set: async value => Object.assign(sessions, value), remove: async key => { delete sessions[key]; } } },
    webNavigation: { getFrame: async () => ({ url, documentId: `browser-document-${browserDocument}`,
      errorOccurred: false, documentLifecycle: 'active' }) },
    tabs: {
      onRemoved: { addListener() {} },
      get: async id => ({ id, url: id === 7 ? url : dashboard.url }),
      reload: async id => { actions.push({ type: 'reload', id }); },
      update: async (id, value) => { actions.push({ type: 'navigate', id, ...value }); url = value.url; },
      sendMessage: async (_id, message) => {
        actions.push(message);
        if (message.type === 'CAPTURE_START') return { ok: true, captureId: message.captureId };
        if (message.type === 'NAVIGATE_SOURCE' && replaceBeforeNavigation) { documentToken = secondDocument; browserDocument++; }
        if (documentToken && message.expectedDocumentToken && message.expectedDocumentToken !== documentToken)
          return { ok: false, code: 'source_changed', error: 'Документ изменился.' };
        if (message.type === 'NAVIGATE_SOURCE') {
          if (!documentToken) return { ok: false, code: 'source_update_required', error: 'Обновите вкладку.' };
          if (message.reload) actions.push({ type: 'reload', id: 7 });
          else { actions.push({ type: 'navigate', id: 7, url: message.url }); url = message.url; }
          return { ok: true };
        }
        if (message.type === 'PAGE_SNAPSHOT') return { ok: true, snapshot: { url, blocks: [], title: 'Saved section' } };
        return { ok: true, navigation: { url, ...(documentToken ? { documentToken } : {}) } };
      },
    },
  };
  const withExporterDocument = createExporterContextFixture(chrome);
  installBackground(chrome, { readWorkspace: async () => state,
    updateWorkspace: async (_id, update) => { state = update(state); return state; } });
  const send = message => new Promise(resolve => listener({ tabId: 7,
    collectionId: sessions['collection:7']?.collectionId, ...message }, withExporterDocument(dashboard), resolve));
  return { send, actions, get state() { return state; }, setDocument: token => { documentToken = token; browserDocument++; } };
}

async function start(app) {
  assert.equal((await app.send({ type: 'BEGIN_COLLECTION' })).ok, true);
  assert.equal((await app.send({ type: 'START_CAPTURE' })).ok, true);
}

test('a same-URL document replacement is rejected before the worker reloads the source', async () => {
  const app = sourceDocument();
  await start(app);
  app.setDocument(secondDocument);
  const result = await app.send({ type: 'NAVIGATE_SOURCE', url: sectionUrl, expectedUrl: sectionUrl,
    expectedDocumentToken: firstDocument });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'source_changed');
  assert.equal(app.actions.some(action => action.type === 'reload' || action.type === 'navigate'), false);
});

test('a document replaced before receiving the navigation command cannot reload the replacement', async () => {
  const app = sourceDocument({ replaceBeforeNavigation: true });
  await start(app);
  const result = await app.send({ type: 'NAVIGATE_SOURCE', url: sectionUrl, expectedUrl: sectionUrl,
    expectedDocumentToken: firstDocument });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'source_changed');
  assert.equal(app.actions.some(action => action.type === 'reload' || action.type === 'navigate'), false);
});

test('a reload requires document identity from both the collector and the source', async () => {
  const app = sourceDocument();
  await start(app);
  const navigate = token => app.send({ type: 'NAVIGATE_SOURCE', url: sectionUrl, expectedUrl: sectionUrl,
    expectedDocumentToken: token });
  assert.equal((await navigate(undefined)).code, 'source_update_required');
  app.setDocument(undefined);
  assert.equal((await navigate(firstDocument)).code, 'source_update_required');
  assert.equal(app.actions.some(action => action.type === 'reload'), false);
});

test('guarded source operations receive the expected document and preserve its rejection code', async () => {
  for (const [url, type, sourceType] of [[bookUrl, 'PREPARE_BOOK', 'PREPARE_BOOK'],
    [sectionUrl, 'GET_NAVIGATION', 'MATERIAL_NAVIGATION'], [sectionUrl, 'OPEN_MATERIAL_ITEM', 'OPEN_MATERIAL_ITEM'],
    [sectionUrl, 'TAKE_SNAPSHOT', 'PAGE_SNAPSHOT']]) {
    const app = sourceDocument({ url });
    await start(app);
    app.setDocument(secondDocument);
    const result = await app.send({ type, expectedUrl: url, key: 'section', expectedDocumentToken: firstDocument });
    assert.equal(result.ok, false, type);
    assert.equal(result.code, 'source_changed', type);
    assert.equal(app.actions.at(-1).type, sourceType, type);
    assert.equal(app.actions.at(-1).expectedDocumentToken, firstDocument, type);
    assert.deepEqual(app.state.snapshots, [], type);
  }
});

test('document verification preserves canonical book navigation with query and fragment', async () => {
  for (const suffix of ['?view=preview#contents', '#contents']) {
    const app = sourceDocument({ url: `${bookUrl}${suffix}` });
    await start(app);
    const result = await app.send({ type: 'NAVIGATE_SOURCE', url: bookUrl, expectedUrl: bookUrl,
      expectedDocumentToken: firstDocument });
    assert.equal(result.ok, true);
    const verified = app.actions.find(action => action.type === 'NAVIGATE_SOURCE');
    assert.equal(verified.expectedDocumentToken, firstDocument);
    assert.deepEqual(app.actions.at(-1), { type: 'navigate', id: 7, url: bookUrl });
  }
});
