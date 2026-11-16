import assert from 'node:assert/strict';
import test from 'node:test';
import { createSourceNavigation } from '../src/lib/source-navigation.js';

const origin = 'https://progressme.ru';
const contents = `${origin}/cabinet/school/materials/book/71/content`;
const section = `${origin}/lesson-editor/book/71/lesson/8/section/9`;
const otherSection = `${origin}/lesson-editor/book/71/lesson/8/section/10`;
const sourceDocument = '11111111-1111-4111-8111-111111111111';
const targetDocument = '22222222-2222-4222-8222-222222222222';
const replacementDocument = '33333333-3333-4333-8333-333333333333';
const token = 'source-content-document-00001';
const binding = { tabId: 7, ownerTabId: 99, workspaceId: 'workspace-a', collectionId: 'collection-a', bookKey: `${origin}/book/71` };
const canonicalUrl = value => {
  try { const url = new URL(value); return url.origin === origin && /^(?:\/cabinet\/school\/materials\/book\/\d+\/content|\/lesson-editor\/book\/\d+\/lesson\/\d+(?:\/section\/\d+)?)\/?$/.test(url.pathname) ? `${url.origin}${url.pathname}` : ''; }
  catch { return ''; }
};
const bookKey = value => canonicalUrl(value) ? `${origin}/book/${new URL(value).pathname.match(/\/book\/(\d+)/)[1]}` : '';

function fixture() {
  const sessions = {}, callbacks = {}, actions = [], statistics = { writes: 0, changes: 0 };
  let clock = 1000, currentBinding = binding, frame = { url: contents, documentId: sourceDocument, errorOccurred: false };
  let tab = { id: 7, url: contents, status: 'complete' }, onRead;
  let navigation = { url: contents, kind: 'book', materialId: '71', documentToken: token,
    items: [{ key: 'lesson-8', kind: 'lesson', sourceId: '8' }] };
  const event = name => ({ addListener: callback => { callbacks[name] = callback; } });
  const chrome = {
    storage: { session: { get: async () => structuredClone(sessions),
      set: async values => { statistics.writes++; Object.assign(sessions, structuredClone(values)); },
      remove: async key => { statistics.writes++; delete sessions[key]; } } },
    tabs: { get: async () => structuredClone(tab), update: async (id, patch) => { actions.push({ type: 'native', id, ...patch }); } },
    webNavigation: { onBeforeNavigate: event('before'), onCommitted: event('committed'), onErrorOccurred: event('error'),
      onHistoryStateUpdated: event('history'), onReferenceFragmentUpdated: event('fragment'), onTabReplaced: event('replaced'),
      getFrame: async () => structuredClone(frame) },
  };
  const options = { chrome, canonicalUrl, bookKey, now: () => clock, randomUUID: () => `transition-${clock}`, onChange: () => { statistics.changes++; },
    authorize: async candidate => {
      if (!currentBinding || Object.keys(binding).some(key => candidate[key] !== currentBinding[key])) throw Object.assign(new Error('Stale collection'), { code: 'stale_collection' });
      return () => { if (!currentBinding) throw Object.assign(new Error('Cancelled'), { code: 'stale_collection' }); };
    },
    sendSource: async (_id, message) => {
      if (message.type === 'MATERIAL_NAVIGATION') { await onRead?.(); return { ok: true, navigation: structuredClone(navigation) }; }
      actions.push(structuredClone(message)); return { ok: true };
    } };
  let manager = createSourceNavigation(options);
  manager.remember(7, navigation);
  return { get manager() { return manager; }, sessions, actions, statistics,
    setClock: value => { clock = value; }, setFrame: value => { frame = value; }, setTab: value => { tab = value; },
    setNavigation: value => { navigation = value; }, onRead: value => { onRead = value; }, cancel: () => { currentBinding = null; },
    restart: () => { manager = createSourceNavigation(options); },
    emit: (name, value) => callbacks[name]({ tabId: 7, frameId: 0, timeStamp: clock++, ...value }) };
}
const reload = app => app.manager.navigate(binding, { type: 'NAVIGATE_SOURCE', url: contents, expectedUrl: contents, expectedDocumentToken: token, reload: false });
const open = app => app.manager.navigate(binding, { type: 'OPEN_MATERIAL_ITEM', key: 'lesson-8', expectedUrl: contents, expectedDocumentToken: token });
const record = app => app.sessions['source-navigation:7'];
const target = (app, url = section) => {
  app.setFrame({ url, documentId: targetDocument, errorOccurred: false });
  app.setTab({ id: 7, url, status: 'complete' });
  app.setNavigation({ url, kind: url === contents ? 'book' : 'lesson', lessonId: '8', documentToken: 'target-content-document-00001' });
};

for (const when of ['before', 'between']) {
  test(`old same-URL history ${when} the expected initial reload does not commit its old document`, async () => {
    const app = fixture(), started = await reload(app);
    if (when === 'between') { app.emit('before', { url: contents }); await app.manager.status(binding, started.transition.id); }
    const saved = structuredClone(record(app)), statistics = { ...app.statistics };
    app.emit('history', { url: contents, documentId: sourceDocument });
    await app.manager.status(binding, started.transition.id);
    assert.deepEqual(record(app), saved, 'ignored history does not persist or advance lastEventAt');
    assert.deepEqual(app.statistics, statistics, 'ignored history does not notify or write');
    if (when === 'before') app.emit('before', { url: contents });
    app.emit('committed', { url: contents, documentId: targetDocument });
    target(app, contents);
    assert.equal((await app.manager.status(binding, started.transition.id)).state, 'same_book');
  });
}

test('opening an item accepts a same-document SPA target and ignores a same-URL history no-op', async () => {
  const app = fixture(), started = await open(app), saved = structuredClone(record(app));
  app.emit('history', { url: contents, documentId: sourceDocument });
  await app.manager.status(binding, started.transition.id);
  assert.deepEqual(record(app), saved);
  app.emit('history', { url: section, documentId: sourceDocument });
  app.setTab({ id: 7, url: section, status: 'complete' });
  app.setFrame({ url: section, documentId: sourceDocument, errorOccurred: false });
  const status = await app.manager.status(binding, started.transition.id);
  assert.equal(status.state, 'same_book');
  assert.equal(record(app).phase, 'committed');
  assert.equal(record(app).browserDocumentId, sourceDocument);
  assert.equal(status.navigation.cause, 'expected_spa');
});

test('history from an old document after commit does not advance timestamp or roll back document identity', async () => {
  const app = fixture(), started = await reload(app);
  app.emit('before', { url: contents }); app.emit('committed', { url: contents, documentId: targetDocument }); target(app, contents);
  await app.manager.status(binding, started.transition.id);
  const saved = structuredClone(record(app)), statistics = { ...app.statistics };
  app.emit('history', { url: otherSection, documentId: sourceDocument, timeStamp: 900000 });
  await app.manager.status(binding, started.transition.id);
  assert.deepEqual(record(app), saved);
  assert.deepEqual(app.statistics, statistics);
  app.emit('before', { url: contents, timeStamp: 2000 });
  const status = await app.manager.status(binding, started.transition.id);
  assert.equal(status.state, 'source_changed');
  assert.equal(status.navigation.cause, 'navigation_after_commit');
  assert.equal(status.navigation.events.at(-2).cause, 'old_document_ignored');
  await assert.rejects(app.manager.retry(binding, started.transition.id), { code: 'source_left_page' });
});

test('a real source-document route change while waiting for a full reload remains terminal', async () => {
  const app = fixture(), started = await reload(app);
  app.emit('history', { url: otherSection, documentId: sourceDocument });
  const status = await app.manager.status(binding, started.transition.id);
  assert.equal(status.state, 'source_changed');
  assert.equal(status.navigation.cause, 'unexpected_target');
  await assert.rejects(app.manager.validate(binding, started.transition.id), { code: 'source_left_page' });
});

test('retry after a SPA target records a full reload from the current document and survives suspension', async () => {
  const app = fixture(), started = await open(app);
  app.emit('history', { url: section, documentId: sourceDocument });
  app.setTab({ id: 7, url: section, status: 'complete' });
  app.setFrame({ url: section, documentId: sourceDocument, errorOccurred: false });
  app.setNavigation({ url: section, kind: 'lesson', lessonId: '8', documentToken: token });
  await app.manager.status(binding, started.transition.id);
  const retry = await app.manager.retry(binding, started.transition.id);
  assert.equal(retry.transition.attempt, 2);
  assert.equal(retry.transition.id, started.transition.id);
  assert.equal(retry.transition.deadlineAt, started.transition.deadlineAt);
  assert.equal(record(app).attemptMode, 'document');
  assert.equal(record(app).attemptSourceUrl, section);
  assert.equal(record(app).attemptSourceBrowserDocumentId, sourceDocument);
  assert.equal(record(app).command.type, 'OPEN_MATERIAL_ITEM', 'idempotent original command is preserved');
  assert.equal(app.actions.at(-1).reload, true);
  app.restart();
  await app.manager.status(binding, started.transition.id);
  const saved = structuredClone(record(app)), statistics = { ...app.statistics };
  app.emit('history', { url: section, documentId: sourceDocument });
  await app.manager.status(binding, started.transition.id);
  assert.deepEqual(record(app), saved);
  assert.deepEqual(app.statistics, statistics);
  app.emit('before', { url: section }); app.emit('committed', { url: section, documentId: targetDocument }); target(app);
  assert.equal((await app.manager.status(binding, started.transition.id)).state, 'same_book');
});

test('native retry snapshots the failed current document instead of the initial contents document', async () => {
  const app = fixture(), started = await open(app);
  app.emit('before', { url: section });
  app.setTab({ id: 7, url: section, status: 'complete' });
  app.setFrame({ url: section, documentId: targetDocument, errorOccurred: true });
  app.emit('error', { url: section, documentId: targetDocument, error: 'net::ERR_CONNECTION_RESET' });
  await app.manager.status(binding, started.transition.id);
  const retry = await app.manager.retry(binding, started.transition.id);
  assert.equal(retry.transition.attempt, 2);
  assert.equal(record(app).attemptMode, 'document');
  assert.equal(record(app).attemptSourceBrowserDocumentId, targetDocument);
  assert.equal(record(app).attemptSourceUrl, section);
  assert.equal(record(app).sourceBrowserDocumentId, sourceDocument);
  const saved = structuredClone(record(app));
  app.emit('history', { url: section, documentId: targetDocument });
  await app.manager.status(binding, started.transition.id);
  assert.deepEqual(record(app), saved);
  app.emit('before', { url: section }); app.emit('committed', { url: section, documentId: replacementDocument });
  app.setFrame({ url: section, documentId: replacementDocument, errorOccurred: false });
  assert.equal((await app.manager.status(binding, started.transition.id)).state, 'same_book');
});

test('an ignored history during the asynchronous retry gate does not revoke the command', async () => {
  const app = fixture(), started = await open(app);
  app.onRead(async () => {
    app.emit('history', { url: contents, documentId: sourceDocument });
    await new Promise(resolve => setImmediate(resolve));
  });
  const result = await app.manager.retry(binding, started.transition.id);
  assert.equal(result.transition.attempt, 2);
  assert.equal(app.actions.filter(action => action.type === 'OPEN_MATERIAL_ITEM').length, 2);
});

for (const stoppedBy of ['navigation', 'owner']) {
  test(`an actual ${stoppedBy} change during the asynchronous retry gate revokes the command`, async () => {
    const app = fixture(), started = await open(app);
    app.onRead(async () => {
      if (stoppedBy === 'owner') app.cancel();
      else app.emit('history', { url: `${origin}/lesson-editor/book/81/lesson/8/section/9`, documentId: sourceDocument });
      await new Promise(resolve => setImmediate(resolve));
    });
    await assert.rejects(app.manager.retry(binding, started.transition.id));
    assert.equal(app.actions.filter(action => action.type === 'OPEN_MATERIAL_ITEM').length, 1);
  });
}

test('pre-fix persisted transitions are rejected without deleting captures or overwriting their record', async () => {
  const app = fixture(), started = await reload(app);
  delete record(app).attemptMode; delete record(app).attemptSourceBrowserDocumentId; delete record(app).attemptSourceUrl;
  const saved = structuredClone(record(app));
  app.restart();
  const status = await app.manager.status(binding, started.transition.id);
  assert.equal(status.state, 'unavailable'); assert.equal(status.canRetry, false);
  assert.equal(status.navigation.cause, 'legacy_transition');
  await assert.rejects(app.manager.validate(binding, started.transition.id), { code: 'source_update_required' });
  await assert.rejects(app.manager.retry(binding, started.transition.id), { code: 'source_update_required' });
  await assert.rejects(reload(app), { code: 'source_update_required' });
  await assert.rejects(open(app), { code: 'source_update_required' });
  assert.deepEqual(record(app), saved);
  assert.equal(app.actions.length, 1);
});

test('missing browser document identity is unavailable rather than proof of another page', async () => {
  const app = fixture(); app.setFrame({ url: contents, errorOccurred: false });
  await assert.rejects(reload(app), error => {
    assert.equal(error.code, 'source_unavailable'); assert.equal(error.navigation.cause, 'unexpected_document');
    assert.equal(error.navigation.documentId, undefined); return true;
  });
  assert.equal(app.actions.length, 0);
});

test('navigation trace is bounded while ignored events leave persistent state unchanged', async () => {
  const app = fixture(), started = await reload(app), saved = structuredClone(record(app));
  for (let index = 0; index < 40; index++) app.emit('history', { url: contents, documentId: sourceDocument });
  const status = await app.manager.status(binding, started.transition.id);
  assert.equal(status.navigation.events.length, 32);
  assert.equal(status.navigation.events.at(-1).cause, 'same_url_history_ignored');
  assert.deepEqual(record(app), saved);
  assert.equal(app.statistics.changes, 0);
});


test('a full return to contents cannot be confirmed by a changed route in its old document', async () => {
  const app = fixture();
  target(app);
  app.setNavigation({ url: section, kind: 'lesson', lessonId: '8', documentToken: token });
  app.manager.remember(7, { url: section, kind: 'lesson', lessonId: '8', documentToken: token });
  const started = await app.manager.navigate(binding, { type: 'NAVIGATE_SOURCE', url: contents, expectedUrl: section, expectedDocumentToken: token, reload: false });
  app.emit('history', { url: contents, documentId: targetDocument });
  const status = await app.manager.status(binding, started.transition.id);
  assert.equal(status.state, 'source_changed');
  assert.equal(status.navigation.cause, 'unexpected_target');
});


test('a confirmed replacement commit is not ignored merely because its document was seen before', async () => {
  const app = fixture(), started = await reload(app);
  app.emit('before', { url: contents }); app.emit('committed', { url: contents, documentId: targetDocument }); target(app, contents);
  await app.manager.status(binding, started.transition.id);
  app.emit('committed', { url: contents, documentId: sourceDocument });
  const status = await app.manager.status(binding, started.transition.id);
  assert.equal(status.state, 'source_changed');
  assert.equal(status.navigation.cause, 'unexpected_document');
  await assert.rejects(app.manager.validate(binding, started.transition.id), { code: 'source_left_page' });
});


test('a provisional abort cannot relabel an earlier certificate rejection as a network error', async () => {
  const app = fixture(), started = await open(app);
  app.emit('before', { url: section });
  app.setTab({ id: 7, url: section, status: 'complete' });
  app.setFrame({ url: section, documentId: targetDocument, errorOccurred: true });
  app.emit('error', { url: section, documentId: targetDocument, error: 'net::ERR_CERT_AUTHORITY_INVALID' });
  await app.manager.status(binding, started.transition.id);
  app.emit('before', { url: section });
  app.emit('error', { url: section, documentId: '00000000-0000-0000-0000-000000000000', error: 'net::ERR_ABORTED' });
  const status = await app.manager.status(binding, started.transition.id);
  assert.equal(status.state, 'security_error');
  assert.equal(status.navigation.cause, 'navigation_error');
  assert.equal(status.networkError, 'net::ERR_CERT_AUTHORITY_INVALID');
  assert.equal(status.canRetry, false);
});
