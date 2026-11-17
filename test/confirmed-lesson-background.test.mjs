import assert from 'node:assert/strict';
import test from 'node:test';
import { installBackground } from '../src/background.js';
import { createWorkspace } from '../src/lib/state.js';
import { createExporterContextFixture } from './exporter-context-fixture.js';

const origin = 'https://progressme.ru';
const contents = `${origin}/cabinet/school/materials/book/71/content`;
const target = `${origin}/lesson-editor/book/71/lesson/8`;
const documentToken = 'confirmed-lesson-document-00001';

function fixture() {
  const sessions = {}, local = {}, commands = [];
  let listener, state = createWorkspace(7), url = contents;
  const owner = { id: 'extension', url: 'chrome-extension://extension/exporter.html?tab=7',
    tab: { id: 99, url: 'chrome-extension://extension/exporter.html?tab=7' } };
  const storage = values => ({ get: async key => key === null ? structuredClone(values) : { [key]: structuredClone(values[key]) },
    set: async value => Object.assign(values, structuredClone(value)), remove: async key => { delete values[key]; } });
  const event = { addListener() {} };
  const chrome = {
    runtime: { id: 'extension', getURL: path => `chrome-extension://extension/${path}`,
      onMessage: { addListener: value => { listener = value; } }, sendMessage: async () => {} },
    action: { onClicked: event }, storage: { session: storage(sessions), local: storage(local) },
    tabs: { onRemoved: event, onUpdated: event, get: async id => id === 7 ? { id, url, status: 'complete' } : { id, url: owner.url },
      sendMessage: async (_id, command) => {
        if (command.type === 'CAPTURE_START') return { ok: true, captureId: command.captureId };
        if (command.type === 'MATERIAL_NAVIGATION') return { ok: true, navigation: { url, kind: 'book', materialId: '71',
          ready: true, documentToken, items: [{ key: 'lesson-8', kind: 'lesson', sourceId: '8' }] } };
        commands.push(command); return { ok: true };
      } },
    webNavigation: { getFrame: async () => ({ url, documentId: 'browser-document-1', errorOccurred: false }),
      onBeforeNavigate: event, onCommitted: event, onHistoryStateUpdated: event, onReferenceFragmentUpdated: event,
      onErrorOccurred: event, onTabReplaced: event },
  };
  const withExporterDocument = createExporterContextFixture(chrome);
  installBackground(chrome, { readWorkspace: async () => state, updateWorkspace: async (_id, update) => { state = update(state); return state; } });
  const send = (message, sender = owner) => new Promise(resolve => listener({ tabId: 7,
    collectionId: sessions['collection:7']?.collectionId, ...message }, withExporterDocument(sender), resolve));
  return { commands, owner, send, move: value => { url = value; },
    async begin() { await send({ type: 'BEGIN_COLLECTION' }); await send({ type: 'START_CAPTURE' }); await send({ type: 'GET_NAVIGATION' }); } };
}

test('background derives the exact confirmed lesson destination instead of accepting a caller URL', async () => {
  const app = fixture(); await app.begin();
  const result = await app.send({ type: 'OPEN_CONFIRMED_LESSON', key: 'lesson-8', expectedUrl: contents, expectedDocumentToken: documentToken });
  assert.equal(result.ok, true, result.error);
  assert.equal(app.commands.at(-1).url, target);
  assert.equal(app.commands.at(-1).type, 'OPEN_CONFIRMED_LESSON');
});

test('background rejects forged destinations, unknown lessons, stale source routes and absent capture', async () => {
  for (const mode of ['url', 'key', 'route', 'capture']) {
    const app = fixture();
    if (mode !== 'capture') await app.begin();
    if (mode === 'route') app.move(contents.replace('/71/', '/72/'));
    const result = await app.send({ type: 'OPEN_CONFIRMED_LESSON', key: mode === 'key' ? 'unknown' : 'lesson-8',
      expectedUrl: contents, expectedDocumentToken: documentToken, ...(mode === 'url' ? { url: 'https://other.example/' } : {}) });
    assert.equal(result.ok, false, mode);
    assert.equal(app.commands.filter(command => command.type === 'OPEN_CONFIRMED_LESSON').length, 0, mode);
  }
});

test('another exporter owner, source script and forged lease cannot use confirmed lesson navigation', async () => {
  const app = fixture(); await app.begin();
  const command = { type: 'OPEN_CONFIRMED_LESSON', key: 'lesson-8', expectedUrl: contents, expectedDocumentToken: documentToken };
  const otherOwner = { ...app.owner, tab: { id: 100, url: app.owner.url } };
  const source = { id: 'extension', frameId: 0, url: contents, tab: { id: 7, url: contents } };
  assert.equal((await app.send(command, otherOwner)).ok, false);
  assert.equal((await app.send(command, source)).ok, false);
  assert.equal((await app.send({ ...command, collectionId: 'another-collection' })).ok, false);
  assert.equal(app.commands.length, 0);
});
