import assert from 'node:assert/strict';
import test from 'node:test';
import { installBackground } from '../src/background.js';
import { createExporterContextFixture } from './exporter-context-fixture.js';
import { createWorkspace } from '../src/lib/state.js';

const book = 'https://progressme.ru/cabinet/school/materials/book/71/content';
const section = 'https://progressme.ru/lesson-editor/book/71/lesson/8/section/9';
const documentToken = 'source-document-00000001';
function fixture() {
  const sessions = {}, events = {}, actions = [];
  let listener, tab = { id: 7, url: book, status: 'complete' }, frame = { url: book, documentId: 'first-document', errorOccurred: false };
  let state = createWorkspace(7), connected = true, disconnectMessage = 'Could not establish connection. Receiving end does not exist.';
  const owner = { id: 'extension', url: 'chrome-extension://extension/exporter.html?tab=7',
    tab: { id: 99, url: 'chrome-extension://extension/exporter.html?tab=7' } };
  const event = name => ({ addListener: callback => { events[name] = callback; } });
  const chrome = {
    runtime: { id: 'extension', getURL: path => `chrome-extension://extension/${path}`,
      onMessage: { addListener: callback => { listener = callback; } }, sendMessage: async () => {} },
    action: { onClicked: { addListener() {} } },
    storage: { session: { get: async key => ({ [key]: structuredClone(sessions[key]) }),
      set: async values => Object.assign(sessions, structuredClone(values)), remove: async key => { delete sessions[key]; } } },
    tabs: { onRemoved: event('removed'), onUpdated: event('updated'),
      get: async id => id === 7 ? structuredClone(tab) : { id, url: owner.url },
      update: async (id, patch) => { actions.push({ type: 'native', id, ...patch }); },
      sendMessage: async (_id, message) => {
        actions.push(message);
        if (!connected) throw new Error(disconnectMessage);
        if (message.type === 'CAPTURE_START') return { ok: true, captureId: message.captureId };
        if (message.type === 'MATERIAL_NAVIGATION') return { ok: true, navigation: { url: book, kind: 'book', materialId: '71', documentToken,
          items: [{ key: 'lesson-8', kind: 'lesson', sourceId: '8' }] } };
        return { ok: true };
      } },
    webNavigation: { onBeforeNavigate: event('before'), onCommitted: event('committed'), onErrorOccurred: event('error'),
      onHistoryStateUpdated: event('history'), onReferenceFragmentUpdated: event('fragment'), onTabReplaced: event('replaced'),
      getFrame: async () => structuredClone(frame) },
  };
  const withExporterDocument = createExporterContextFixture(chrome);
  installBackground(chrome, { readWorkspace: async () => state, updateWorkspace: async (_id, update) => { state = update(state); return state; } });
  const send = (message, sender = owner) => new Promise(resolve => listener({ tabId: 7, collectionId: sessions['collection:7']?.collectionId, ...message }, withExporterDocument(sender), resolve));
  return { send, sessions, actions, owner,
    emit: (name, details) => events[name]({ tabId: 7, frameId: 0, timeStamp: Date.now(), ...details }),
    disconnect: (message = disconnectMessage) => { connected = false; disconnectMessage = message; },
    setError: () => { tab = { id: 7, status: 'complete' }; frame = { url: section, documentId: 'failed-document', errorOccurred: true }; },
    setPending: value => { tab.pendingUrl = value; tab.status = 'loading'; },
    setFrame: value => { frame = value; }, setTab: value => { tab = value; } };
}

test('browser navigation failure remains retryable while the source content receiver is gone', async () => {
  const app = fixture();
  await app.send({ type: 'BEGIN_COLLECTION' }); await app.send({ type: 'START_CAPTURE' });
  await app.send({ type: 'GET_NAVIGATION' });
  const started = await app.send({ type: 'OPEN_MATERIAL_ITEM', key: 'lesson-8', expectedUrl: book, expectedDocumentToken: documentToken });
  assert.ok(started.transition?.id);
  app.emit('before', { url: section }); app.setError(); app.disconnect();
  app.emit('error', { url: section, documentId: 'failed-document', error: 'net::ERR_TUNNEL_CONNECTION_FAILED' });
  const status = await app.send({ type: 'GET_SOURCE_STATUS', transitionId: started.transition.id });
  assert.equal(status.sourceStatus?.state, 'network_error');
  assert.equal(status.sourceStatus.canRetry, true);
  const retry = await app.send({ type: 'RETRY_SOURCE_NAVIGATION', transitionId: started.transition.id });
  assert.equal(retry.ok, true, retry.error); assert.equal(retry.transition.attempt, 2);
  assert.deepEqual(app.actions.at(-1), { type: 'native', id: 7, url: section });
});

test('loading the selected book stays loading instead of reporting another book', async () => {
  const app = fixture();
  app.setPending(section);
  const result = await app.send({ type: 'GET_SOURCE_STATUS' });
  assert.equal(result.sourceStatus?.state, 'loading');
});

test('a different exporter owner or forged collection cannot inspect or retry a transition', async () => {
  const app = fixture();
  await app.send({ type: 'BEGIN_COLLECTION' }); await app.send({ type: 'START_CAPTURE' });
  const started = await app.send({ type: 'OPEN_MATERIAL_ITEM', key: 'lesson-8', expectedUrl: book, expectedDocumentToken: documentToken });
  for (const type of ['GET_SOURCE_STATUS', 'RETRY_SOURCE_NAVIGATION']) {
    const forged = await app.send({ type, transitionId: started.transition?.id, collectionId: 'other-collection' });
    assert.equal(forged.ok, false, type);
    const alien = await app.send({ type, transitionId: started.transition?.id }, { ...app.owner, tab: { id: 100, url: app.owner.url } });
    assert.equal(alien.ok, false, type);
    const source = await app.send({ type, transitionId: started.transition?.id }, { id: 'extension', frameId: 0, url: book, tab: { id: 7, url: book } });
    assert.equal(source.ok, false, type);
  }
});


test('initial same-URL history reaches the real background without poisoning its reload transition', async () => {
  const app = fixture();
  await app.send({ type: 'BEGIN_COLLECTION' }); await app.send({ type: 'START_CAPTURE' });
  await app.send({ type: 'GET_NAVIGATION' });
  const started = await app.send({ type: 'NAVIGATE_SOURCE', url: book, expectedUrl: book, expectedDocumentToken: documentToken });
  assert.equal(started.ok, true, started.error);
  const before = structuredClone(app.sessions['source-navigation:7']);
  app.emit('history', { url: book, documentId: 'first-document' });
  const waiting = await app.send({ type: 'GET_SOURCE_STATUS', transitionId: started.transition.id });
  assert.equal(waiting.sourceStatus.state, 'same_book');
  assert.deepEqual(app.sessions['source-navigation:7'], before);
  app.emit('before', { url: book });
  const targetDocument = '22222222-2222-4222-8222-222222222222';
  app.emit('committed', { url: book, documentId: targetDocument });
  app.setFrame({ url: book, documentId: targetDocument, errorOccurred: false });
  const status = await app.send({ type: 'GET_SOURCE_STATUS', transitionId: started.transition.id });
  assert.equal(status.sourceStatus.state, 'same_book');
  assert.equal(status.sourceStatus.navigation.cause, 'expected_commit');
});

test('terminal background navigation and retry replies preserve the exact safe stop context', async () => {
  const app = fixture();
  await app.send({ type: 'BEGIN_COLLECTION' }); await app.send({ type: 'START_CAPTURE' });
  await app.send({ type: 'GET_NAVIGATION' });
  const started = await app.send({ type: 'NAVIGATE_SOURCE', url: book, expectedUrl: book, expectedDocumentToken: documentToken });
  app.emit('before', { url: book });
  const targetDocument = '22222222-2222-4222-8222-222222222222';
  app.emit('committed', { url: book, documentId: targetDocument });
  app.setFrame({ url: book, documentId: targetDocument, errorOccurred: false });
  await app.send({ type: 'GET_SOURCE_STATUS', transitionId: started.transition.id });
  app.emit('before', { url: `${book}?token=private-secret#private`, documentId: undefined });
  for (const type of ['GET_NAVIGATION', 'RETRY_SOURCE_NAVIGATION']) {
    const result = await app.send({ type, transitionId: started.transition.id });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'source_left_page');
    assert.match(result.error, /повторно перезагружена/);
    assert.equal(result.navigation.cause, 'navigation_after_commit');
    assert.equal(result.navigation.event, 'onBeforeNavigate');
    assert.equal(result.navigation.documentId, undefined, 'onBeforeNavigate has no document ID');
    assert.equal(result.navigation.currentDocumentId, targetDocument);
    assert.equal(result.navigation.observedUrl, book);
    assert.equal(result.navigation.events.at(-1).cause, 'navigation_after_commit');
    assert.doesNotMatch(JSON.stringify(result), /private-secret|#private|token=/);
  }
  assert.equal(app.actions.filter(action => action.type === 'NAVIGATE_SOURCE').length, 1);
});


test('a Chrome BFCache message-channel closure is a source disconnect rather than an unknown operation failure', async () => {
  const app = fixture();
  app.disconnect('The page keeping the extension port is moved into back/forward cache, so the message channel is closed.');
  const result = await app.send({ type: 'GET_NAVIGATION' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'source_disconnected');
  assert.doesNotMatch(result.error, /back.forward cache|extension port|message channel/i);
});
