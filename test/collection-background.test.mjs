import assert from 'node:assert/strict';
import test from 'node:test';
import { installBackground } from '../src/background.js';
import { createExporterContextFixture } from './exporter-context-fixture.js';
import { createWorkspace } from '../src/lib/state.js';

const book = 'https://progressme.ru/cabinet/school/materials/book/867169/content';
const section = 'https://progressme.ru/lesson-editor/book/867169/lesson/13794943/section/67546487';
const documentToken = 'source-document-00000001';
function setup() {
  let listener;
  let url = book;
  let state = createWorkspace(7);
  const sessions = {};
  const actions = [];
  const dashboard = { id: 'extension', url: 'chrome-extension://extension/exporter.html?tab=7', tab: { id: 99, url: 'chrome-extension://extension/exporter.html?tab=7' } };
  const source = () => ({ id: 'extension', url, frameId: 0, tab: { id: 7, url } });
  const chrome = {
    runtime: { id: 'extension', getURL: path => `chrome-extension://extension/${path}`, sendMessage: async () => {}, onMessage: { addListener: fn => { listener = fn; } } },
    action: { onClicked: { addListener() {} } },
    storage: { session: { get: async key => ({ [key]: sessions[key] }), set: async value => Object.assign(sessions, value), remove: async key => { delete sessions[key]; } } },
    webNavigation: { getFrame: async () => ({ url, documentId: '11111111-1111-4111-8111-111111111111',
      errorOccurred: false, documentLifecycle: 'active' }) },
    tabs: {
      onRemoved: { addListener() {} }, get: async id => ({ id, url: id === 7 ? url : 'chrome-extension://extension/exporter.html?tab=7' }),
      reload: async id => actions.push({ type: 'reload', id }),
      update: async (id, value) => { actions.push({ type: 'navigate', id, ...value }); url = value.url; },
      sendMessage: async (id, message) => {
        actions.push(message);
        if (message.type === 'CAPTURE_START') return { ok: true, captureId: message.captureId };
        if (message.type === 'NAVIGATE_SOURCE') {
          if (message.reload) actions.push({ type: 'reload', id });
          else { actions.push({ type: 'navigate', id, url: message.url }); url = message.url; }
          return { ok: true };
        }
        if (message.type === 'PAGE_SNAPSHOT') return { ok: true, snapshot: { url, blocks: [], title: 'Lesson' } };
        return { ok: true, navigation: { url, documentToken } };
      },
    },
  };
  const withExporterDocument = createExporterContextFixture(chrome);
  installBackground(chrome, { readWorkspace: async () => state, updateWorkspace: async (_id, update) => { state = update(state); return state; } });
  const send = (message, sender = dashboard) => new Promise(resolve => {
    const token = sender.tab?.id === 7 ? { captureId: sessions['capture-id:7'] } : { collectionId: sessions['collection:7']?.collectionId };
    const document = ['PREPARE_BOOK', 'OPEN_MATERIAL_ITEM', 'TAKE_SNAPSHOT', 'NAVIGATE_SOURCE'].includes(message.type)
      ? { expectedDocumentToken: documentToken } : {};
    listener({ tabId: 7, ...token, ...document, ...message }, withExporterDocument(sender), resolve);
  });
  return { send, source, actions, get state() { return state; }, setUrl: value => { url = value; } };
}

test('book navigation requires an enabled dashboard and stays inside the current source book', async () => {
  const app = setup();
  assert.equal((await app.send({ type: 'NAVIGATE_SOURCE', url: book, expectedUrl: book })).ok, false);
  await app.send({ type: 'BEGIN_COLLECTION' });
  assert.equal((await app.send({ type: 'START_CAPTURE' })).ok, true);
  assert.equal((await app.send({ type: 'NAVIGATE_SOURCE', url: book, expectedUrl: book }, app.source())).ok, false);
  for (const target of [book.replace('867169', '999'), book.replace('progressme.ru', 'platform.desharschool.ru'), book.replace('https:', 'http:'), 'https://progressme.ru/cabinet/school/students', `${book}?token=secret`]) {
    assert.equal((await app.send({ type: 'NAVIGATE_SOURCE', url: target, expectedUrl: book })).ok, false, target);
  }
  assert.equal((await app.send({ type: 'NAVIGATE_SOURCE', url: book, expectedUrl: book })).ok, true);
  assert.equal(app.actions.at(-1).type, 'reload');
  app.setUrl(section);
  assert.equal((await app.send({ type: 'NAVIGATE_SOURCE', url: book, expectedUrl: section })).ok, true);
  assert.equal(app.actions.at(-1).url, book);
});

test('stale navigation and snapshot commands do not operate on another section', async () => {
  const app = setup();
  await app.send({ type: 'BEGIN_COLLECTION' });
  await app.send({ type: 'START_CAPTURE' });
  app.setUrl(section);
  const count = app.actions.length;
  assert.equal((await app.send({ type: 'OPEN_MATERIAL_ITEM', key: 'section', expectedUrl: book })).ok, false);
  assert.equal((await app.send({ type: 'TAKE_SNAPSHOT', expectedUrl: book })).ok, false);
  assert.equal(app.actions.length, count);
  const result = await app.send({ type: 'TAKE_SNAPSHOT', expectedUrl: section });
  assert.equal(result.snapshotUrl, section);
  assert.deepEqual(result.retained, { dropped: 0 });
});

test('capture page association comes from the current browser tab and collection reports persist without a source', async () => {
  const app = setup();
  await app.send({ type: 'BEGIN_COLLECTION' });
  await app.send({ type: 'START_CAPTURE' });
  app.setUrl(section);
  await app.send({ type: 'CAPTURE_EVENT', event: { kind: 'fetch', url: 'https://progressme.ru/api/lessons/13794943', pageUrl: 'https://evil.example/', data: { lesson: { id: 13794943 } } } }, app.source());
  assert.equal(app.state.captures[0].pageUrl, section);
  app.setUrl('https://progressme.ru/login');
  assert.equal((await app.send({ type: 'SAVE_COLLECTION', collection: { status: 'failed', rootUrl: `${book}?token=secret`, visited: [section] } })).ok, true);
  assert.equal(app.state.collection.rootUrl, book);
  assert.equal((await app.send({ type: 'SAVE_COLLECTION', collection: { status: 'complete' } })).ok, false);
});

test('SPA captures follow the current lesson and section while the document sender stays on book contents', async () => {
  const app = setup();
  const originalDocument = app.source();
  await app.send({ type: 'BEGIN_COLLECTION' });
  await app.send({ type: 'START_CAPTURE' });
  const sections = [section, section.replace('67546487', '67546488'),
    section.replace('13794943', '13794944').replace('67546487', '67546489')];
  const event = { kind: 'websocket', url: 'wss://proxy.progressme.ru/ws', pageUrl: 'https://evil.example/forged',
    data: { Class: 'GetExerciseWsController', Method: 'LoadExercises', IsSuccess: true,
      ProjectName: 'Exercises', Value: { Items: [{ Id: 42, Type: 17, Text: 'Author text' }] } } };
  for (const page of sections) {
    app.setUrl(`${page}?token=discard-this&view=preview`);
    assert.equal((await app.send({ type: 'CAPTURE_EVENT', event }, originalDocument)).ok, true);
  }
  assert.deepEqual(app.state.captures.map(capture => capture.pageUrl), sections.map(page => `${page}?view=preview`));
  assert.equal(app.state.captures.length, 3, 'Equal definitions on different sections remain associated with every section');
  assert.equal(JSON.stringify(app.state).includes('discard-this'), false);
  assert.equal(JSON.stringify(app.state).includes('evil.example'), false);
});

test('identical empty exercise replies survive separately for three SPA homework pages', async () => {
  const app = setup();
  const originalDocument = app.source();
  await app.send({ type: 'BEGIN_COLLECTION' });
  await app.send({ type: 'START_CAPTURE' });
  const pages = [13794943, 13794944, 13794945].map(lesson =>
    `https://progressme.ru/lesson-editor/book/867169/lesson/${lesson}/section/for-homework`);
  const event = { kind: 'websocket', url: 'wss://proxy.progressme.ru/ws', pageUrl: book,
    data: { Class: 'GetExerciseWsController', Method: 'LoadExercises', IsSuccess: true,
      ProjectName: 'Exercises', Value: { Items: [], Count: 0 } } };
  for (const page of pages) {
    app.setUrl(page);
    assert.equal((await app.send({ type: 'CAPTURE_EVENT', event }, originalDocument)).ok, true);
    // Repeating the reply within one page should still deduplicate.
    await app.send({ type: 'CAPTURE_EVENT', event }, originalDocument);
  }
  assert.deepEqual(app.state.captures.map(capture => capture.pageUrl), pages);
  assert.equal(app.state.captures.length, 3);
  assert.ok(app.state.captures.every(capture => capture.data.Value.Items.length === 0));
});

test('a stale document sender cannot associate responses with another origin or nonmaterial page', async () => {
  const app = setup();
  const originalDocument = app.source();
  await app.send({ type: 'BEGIN_COLLECTION' });
  await app.send({ type: 'START_CAPTURE' });
  const event = { kind: 'fetch', url: 'https://progressme.ru/api/lessons/13794943', pageUrl: section,
    data: { lesson: { id: 13794943 } } };
  for (const page of [section.replace('progressme.ru', 'platform.desharschool.ru'),
    'https://evil.example/lesson-editor/book/867169/lesson/1/section/1', 'https://progressme.ru/login',
    'https://progressme.ru/cabinet/school/students']) {
    app.setUrl(page);
    assert.equal((await app.send({ type: 'CAPTURE_EVENT', event }, originalDocument)).ok, false, page);
  }
  app.setUrl(section);
  for (const sender of [{ ...originalDocument, frameId: 1 }, { ...originalDocument, id: 'other-extension' }]) {
    assert.equal((await app.send({ type: 'CAPTURE_EVENT', event }, sender)).ok, false);
  }
  assert.equal(app.state.captures.length, 0);
  assert.equal((await app.send({ type: 'CAPTURE_EVENT', event }, originalDocument)).ok, true);
  assert.equal(app.state.captures[0].pageUrl, section);
});

test('manual capture can follow a different SPA book without reloading the original document', async () => {
  const app = setup();
  const originalDocument = app.source();
  const nextBookSection = section.replace('867169', '999');
  app.setUrl(nextBookSection);
  await app.send({ type: 'BEGIN_COLLECTION' });
  await app.send({ type: 'START_CAPTURE' });
  const result = await app.send({ type: 'CAPTURE_EVENT', event: { kind: 'fetch',
    url: 'https://progressme.ru/api/lessons/13794943', pageUrl: book, data: { lesson: { id: 13794943 } } } }, originalDocument);
  assert.equal(result.ok, true);
  assert.equal(app.state.captures[0].pageUrl, nextBookSection);
});

test('collection capture checks the selected book report rather than the stale document book', async () => {
  const app = setup();
  const originalDocument = app.source();
  const selectedBook = book.replace('867169', '999');
  const selectedSection = section.replace('867169', '999');
  app.setUrl(selectedBook);
  const owner = { id: 'extension', url: 'chrome-extension://extension/exporter.html?tab=7',
    tab: { id: 99, url: 'chrome-extension://extension/exporter.html?tab=7' } };
  assert.equal((await app.send({ type: 'BEGIN_COLLECTION' }, owner)).ok, true);
  assert.equal((await app.send({ type: 'SAVE_COLLECTION', collection: { status: 'running', rootUrl: selectedBook } }, owner)).ok, true);
  await app.send({ type: 'START_CAPTURE' }, owner);
  const event = { kind: 'fetch', url: 'https://progressme.ru/api/lessons/13794943', pageUrl: selectedSection,
    data: { lesson: { id: 13794943 } } };
  app.setUrl(selectedSection);
  assert.equal((await app.send({ type: 'CAPTURE_EVENT', event }, originalDocument)).ok, true);
  for (const page of [section, 'https://progressme.ru/cabinet/school/materials/personal']) {
    app.setUrl(page);
    assert.equal((await app.send({ type: 'CAPTURE_EVENT', event }, originalDocument)).ok, false, page);
  }
  assert.deepEqual(app.state.captures.map(capture => capture.pageUrl), [selectedSection]);
});

test('view and tracking parameters do not break canonical navigation guards or alter saved references', async () => {
  const app = setup();
  const owner = { id: 'extension', url: 'chrome-extension://extension/exporter.html?tab=7',
    tab: { id: 99, url: 'chrome-extension://extension/exporter.html?tab=7' } };
  app.setUrl(`${book}?view=preview&utm_source=teacher#contents`);
  assert.equal((await app.send({ type: 'BEGIN_COLLECTION' }, owner)).ok, true);
  await app.send({ type: 'START_CAPTURE' }, owner);
  assert.equal((await app.send({ type: 'PREPARE_BOOK', expectedUrl: book }, owner)).ok, true);
  assert.equal(app.actions.at(-1).expectedUrl, book);
  assert.equal((await app.send({ type: 'GET_SOURCE' }, owner)).source.url, `${book}?view=preview&utm_source=teacher#contents`);
  assert.equal((await app.send({ type: 'NAVIGATE_SOURCE', url: book, expectedUrl: book }, owner)).ok, true);
  assert.equal(app.actions.at(-1).type, 'navigate', 'The tour normalizes its root to the canonical path before saving');
  assert.equal(app.actions.at(-1).url, book);
  assert.equal((await app.send({ type: 'GET_SOURCE' }, owner)).source.url, book);
  const decoratedSection = `${section}?view=preview#exercise`;
  app.setUrl(decoratedSection);
  const saved = await app.send({ type: 'TAKE_SNAPSHOT', expectedUrl: section }, owner);
  assert.equal(saved.snapshotUrl, section);
  assert.equal(saved.savedSnapshotUrl, decoratedSection);
  assert.equal(app.state.snapshots[0].url, decoratedSection);
  assert.equal((await app.send({ type: 'OPEN_MATERIAL_ITEM', expectedUrl: section, key: 'section' }, owner)).ok, true);
  assert.equal(app.actions.at(-1).expectedUrl, section);
  const before = app.actions.length;
  for (const expectedUrl of [section.replace('867169', '999'), section.replace('67546487', '67546488'),
    section.replace('progressme.ru', 'platform.desharschool.ru'), 'https://progressme.ru/cabinet/school/materials/personal']) {
    for (const type of ['TAKE_SNAPSHOT', 'OPEN_MATERIAL_ITEM']) {
      assert.equal((await app.send({ type, expectedUrl, key: 'section' }, owner)).ok, false, `${type}: ${expectedUrl}`);
    }
  }
  assert.equal(app.actions.length, before);
});
