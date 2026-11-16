import assert from 'node:assert/strict';
import test from 'node:test';
import { createSourceNavigation } from '../src/lib/source-navigation.js';
import { navigationErrorCode, navigationErrorState } from '../src/lib/source-navigation-errors.js';

const origin = 'https://school.example';
const contents = `${origin}/cabinet/school/materials/book/71/content`;
const section = `${origin}/lesson-editor/book/71/lesson/8/section/9`;
const otherSection = `${origin}/lesson-editor/book/71/lesson/8/section/10`;
const token = 'source-document-00000001';
const binding = { tabId: 7, ownerTabId: 99, workspaceId: 'workspace-a', collectionId: 'collection-a', bookKey: `${origin}/book/71` };
const canonicalUrl = value => {
  try { const url = new URL(value); return url.origin === origin && /^(?:\/cabinet\/school\/materials\/book\/\d+\/content|\/lesson-editor\/book\/\d+\/lesson\/\d+(?:\/section\/\d+)?)\/?$/.test(url.pathname) ? `${url.origin}${url.pathname}` : ''; }
  catch { return ''; }
};
const bookKey = value => canonicalUrl(value) ? `${origin}/book/${new URL(value).pathname.match(/\/book\/(\d+)/)[1]}` : '';

function fixture() {
  const sessions = {}, callbacks = {}, actions = [], statistics = { reads: 0, writes: 0, changes: 0 };
  let clock = 1000, currentBinding = binding, frame = { url: contents, documentId: 'browser-document-1', errorOccurred: false, documentLifecycle: 'active' };
  let tab = { id: 7, url: contents, status: 'complete' };
  let navigation = { url: contents, kind: 'book', materialId: '71', documentToken: token,
    items: [{ key: 'lesson-8', kind: 'lesson', sourceId: '8' }] };
  const event = name => ({ addListener: callback => { callbacks[name] = callback; } });
  const chrome = {
    storage: { session: { get: async key => { statistics.reads++; return key === null ? structuredClone(sessions) : { [key]: structuredClone(sessions[key]) }; },
      set: async values => { statistics.writes++; Object.assign(sessions, structuredClone(values)); }, remove: async key => { statistics.writes++; delete sessions[key]; } } },
    tabs: { get: async () => structuredClone(tab), update: async (id, patch) => { actions.push({ type: 'native', id, ...patch }); } },
    webNavigation: { onBeforeNavigate: event('before'), onCommitted: event('committed'), onCompleted: event('completed'),
      onErrorOccurred: event('error'), onHistoryStateUpdated: event('history'), onReferenceFragmentUpdated: event('fragment'), onTabReplaced: event('replaced'),
      getFrame: async () => structuredClone(frame) },
  };
  const options = { chrome, canonicalUrl, bookKey, now: () => clock, randomUUID: () => `transition-${clock}`, onChange: () => { statistics.changes++; },
    authorize: async candidate => {
      if (!currentBinding || Object.keys(binding).some(key => candidate[key] !== currentBinding[key])) throw Object.assign(new Error('Stale collection'), { code: 'stale_collection' });
      return () => { if (!currentBinding) throw Object.assign(new Error('Cancelled'), { code: 'stale_collection' }); };
    },
    sendSource: async (_id, message) => {
      if (message.type === 'MATERIAL_NAVIGATION') return { ok: true, navigation: structuredClone(navigation) };
      actions.push(structuredClone(message)); return { ok: true };
    } };
  let manager = createSourceNavigation(options);
  manager.remember(7, navigation);
  return { manager, sessions, actions, statistics, setClock: value => { clock = value; }, setTab: value => { tab = value; },
    setFrame: value => { frame = value; }, setNavigation: value => { navigation = value; }, cancel: () => { currentBinding = null; },
    restart: () => { manager = createSourceNavigation(options); return manager; },
    emit: (name, value) => callbacks[name]({ tabId: 7, frameId: 0, timeStamp: clock++, ...value }) };
}

const open = app => app.manager.navigate(binding, { type: 'OPEN_MATERIAL_ITEM', key: 'lesson-8', expectedUrl: contents, expectedDocumentToken: token });
async function failNavigation(app) {
  const started = await open(app);
  app.emit('before', { url: section });
  app.setTab({ id: 7, status: 'complete' });
  app.setFrame({ url: section, documentId: 'failed-document', errorOccurred: true, documentLifecycle: 'active' });
  app.emit('error', { url: section, documentId: 'failed-document', error: 'net::ERR_TUNNEL_CONNECTION_FAILED' });
  return started.transition;
}

test('a failed native same-book navigation can retry the browser-confirmed URL without a content receiver', async () => {
  const app = fixture(), transition = await failNavigation(app);
  const status = await app.manager.status(binding, transition.id);
  assert.equal(status.state, 'network_error');
  assert.equal(status.canRetry, true);
  const retry = await app.manager.retry(binding, transition.id);
  assert.equal(retry.transition.attempt, 2);
  assert.equal(retry.transition.deadlineAt, transition.deadlineAt);
  assert.deepEqual(app.actions.at(-1), { type: 'native', id: 7, url: section });
});

test('a later other-book navigation revokes native recovery even before it commits', async () => {
  const app = fixture(), transition = await failNavigation(app);
  app.emit('before', { url: `${origin}/lesson-editor/book/81/lesson/8/section/9` });
  await assert.rejects(app.manager.retry(binding, transition.id), { code: 'source_changed' });
  assert.equal(app.actions.some(action => action.type === 'native'), false);
});

test('native errors retain the exact diagnostic code through service-worker suspension', async () => {
  const app = fixture(), transition = await failNavigation(app);
  await app.manager.status(binding, transition.id);
  const restored = app.restart();
  const status = await restored.status(binding, transition.id);
  assert.equal(status.networkError, 'net::ERR_TUNNEL_CONNECTION_FAILED');
  assert.equal(status.state, 'network_error');
  assert.equal((await restored.retry(binding, transition.id)).transition.attempt, 2);
});

test('unknown URL and unrelated subframe failures are not classified as another book', async () => {
  const app = fixture();
  app.setTab({ id: 7, status: 'complete' }); app.setFrame(null);
  app.emit('error', { frameId: 4, url: section, error: 'net::ERR_CONNECTION_RESET' });
  assert.equal((await app.manager.status(binding)).state, 'unavailable');
});

test('one transition retains its 180-second deadline and has only two shared retries', async () => {
  const app = fixture(), started = await open(app);
  const second = await app.manager.retry(binding, started.transition.id);
  const third = await app.manager.retry(binding, started.transition.id);
  assert.equal(second.transition.attempt, 2); assert.equal(third.transition.attempt, 3);
  assert.equal(third.transition.deadlineAt, 181000);
  await assert.rejects(app.manager.retry(binding, started.transition.id), { code: 'retry_exhausted' });
  app.setClock(181001);
  await assert.rejects(app.manager.retry(binding, started.transition.id), { code: 'transition_timeout' });
});

test('a replacement document, cancellation, or forged collection cannot acquire native recovery', async () => {
  for (const mode of ['document', 'cancel', 'collection']) {
    const app = fixture(), transition = await failNavigation(app);
    if (mode === 'document') app.setFrame({ url: section, documentId: 'replacement', errorOccurred: true });
    if (mode === 'cancel') app.cancel();
    const candidate = mode === 'collection' ? { ...binding, collectionId: 'other' } : binding;
    await assert.rejects(app.manager.retry(candidate, transition.id));
    assert.equal(app.actions.some(action => action.type === 'native'), false);
  }
});

test('a same-book SPA change away from the failed target revokes its native retry', async () => {
  const app = fixture(), transition = await failNavigation(app);
  app.emit('history', { url: otherSection, documentId: 'replacement' });
  await assert.rejects(app.manager.retry(binding, transition.id), { code: 'source_left_page' });
});

test('unrelated tabs and subframes cause no reads, writes, or notifications after hydration', async () => {
  const app = fixture();
  await app.manager.status(binding);
  const before = { ...app.statistics };
  app.emit('before', { tabId: 18, url: 'https://unrelated.example/private' });
  app.emit('error', { tabId: 18, url: 'https://unrelated.example/private', error: 'net::ERR_CONNECTION_RESET' });
  app.emit('before', { frameId: 5, url: section });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(app.statistics, before);
});

test('a native target without a confirmed source identity receives no recovery grant', async () => {
  const app = fixture();
  app.manager.remember(7, { url: contents, kind: 'book', documentToken: token,
    items: [{ key: 'lesson-8', kind: 'lesson' }] });
  const transition = await failNavigation(app);
  const status = await app.manager.status(binding, transition.id);
  assert.equal(status.state, 'unavailable'); assert.equal(status.canRetry, false);
  await assert.rejects(app.manager.retry(binding, transition.id));
  assert.equal(app.actions.some(action => action.type === 'native'), false);
});

for (const code of ['ERR_FAILED', 'ERR_HTTP_RESPONSE_CODE_FAILURE', 'ERR_CERT_DATE_INVALID', 'ERR_ABORTED']) {
  test(`${code} is reported without automatically retrying`, async () => {
    const app = fixture(), started = await open(app);
    app.emit('before', { url: section });
    app.setTab({ id: 7, status: 'complete' });
    app.setFrame({ url: section, documentId: 'failed-document', errorOccurred: true });
    app.emit('error', { url: section, documentId: 'failed-document', error: `net::${code}` });
    const status = await app.manager.status(binding, started.transition.id);
    assert.equal(status.networkError, `net::${code}`);
    assert.equal(status.canRetry, false);
    await assert.rejects(app.manager.retry(binding, started.transition.id));
    assert.equal(app.actions.some(action => action.type === 'native'), false);
  });
}

test('an in-flight browser load is not interrupted by a retry', async () => {
  const app = fixture(), started = await open(app);
  app.setTab({ id: 7, url: contents, status: 'loading', pendingUrl: section });
  await assert.rejects(app.manager.retry(binding, started.transition.id), { code: 'source_loading' });
  assert.equal(app.actions.filter(action => action.type === 'OPEN_MATERIAL_ITEM').length, 1);
});

test('retry requires the capability identifier and ignores any caller URL', async () => {
  const app = fixture(), transition = await failNavigation(app);
  await assert.rejects(app.manager.retry(binding, undefined), { code: 'stale_collection' });
  await app.manager.retry(binding, transition.id, 'https://unrelated.example');
  assert.equal(app.actions.at(-1).url, section);
});

test('resending the original guarded operation cannot reset its deadline or restart count', async () => {
  const app = fixture(), first = await open(app);
  await app.manager.retry(binding, first.transition.id);
  app.setClock(12000);
  const repeated = await open(app);
  assert.deepEqual(repeated.transition, { ...first.transition, attempt: 2 });
  assert.equal(app.actions.filter(action => action.type === 'OPEN_MATERIAL_ITEM').length, 2);
});

test('live author/render recovery reloads only the exact verified current document', async () => {
  const app = fixture(), first = await open(app);
  app.emit('before', { url: section });
  app.emit('committed', { url: section, documentId: 'target-browser-document' });
  app.setTab({ id: 7, url: section, status: 'complete' });
  app.setFrame({ url: section, documentId: 'target-browser-document', errorOccurred: false });
  app.setNavigation({ url: section, kind: 'lesson', lessonId: '8', documentToken: 'target-content-document',
    sectionVisit: { token: 'target-section-visit' } });
  const retry = await app.manager.retry(binding, first.transition.id);
  assert.equal(retry.reloaded, true); assert.equal(retry.previousDocumentToken, 'target-content-document');
  assert.deepEqual(app.actions.at(-1), { type: 'NAVIGATE_SOURCE', expectedUrl: section, url: section,
    expectedDocumentToken: 'target-content-document', expectedVisitToken: 'target-section-visit', reload: true });
  assert.equal(retry.transition.deadlineAt, first.transition.deadlineAt);
});

test('a manual same-URL replacement after commit cannot be reloaded by the old transition', async () => {
  const app = fixture(), first = await open(app);
  app.emit('before', { url: section });
  app.emit('committed', { url: section, documentId: 'target-browser-document' });
  await app.manager.status(binding, first.transition.id);
  app.emit('before', { url: section });
  app.emit('committed', { url: section, documentId: 'manual-replacement' });
  await assert.rejects(app.manager.retry(binding, first.transition.id), { code: 'source_left_page' });
  assert.equal(app.actions.filter(action => action.type === 'NAVIGATE_SOURCE').length, 0);
});

test('Chrome provisional same-target automatic retry preserves a confirmed failure across the two-second backoff', async () => {
  const app = fixture(), transition = await failNavigation(app);
  await app.manager.status(binding, transition.id);
  app.setClock(2000);
  app.emit('before', { url: section });
  app.emit('error', { url: section, documentId: '00000000-0000-0000-0000-000000000000', error: 'net::ERR_ABORTED' });
  const status = await app.manager.status(binding, transition.id);
  assert.equal(status.state, 'network_error');
  assert.equal(status.networkError, 'net::ERR_TUNNEL_CONNECTION_FAILED');
  assert.equal(status.canRetry, true);
  app.setClock(3000);
  const retry = await app.manager.retry(binding, transition.id);
  assert.equal(retry.transition.attempt, 2);
  assert.equal(retry.transition.deadlineAt, transition.deadlineAt);
  assert.equal(app.actions.at(-1).url, section);
});

test('stopping an initial provisional navigation is interrupted rather than reissuing the source click', async () => {
  const app = fixture(), first = await open(app);
  app.emit('before', { url: section });
  app.emit('error', { url: section, documentId: '00000000-0000-0000-0000-000000000000', error: 'net::ERR_ABORTED' });
  const status = await app.manager.status(binding, first.transition.id);
  assert.equal(status.state, 'interrupted'); assert.equal(status.canRetry, false);
  await assert.rejects(app.manager.retry(binding, first.transition.id), { code: 'source_interrupted' });
  assert.equal(app.actions.filter(action => action.type === 'OPEN_MATERIAL_ITEM').length, 1);
});

test('a connection abort is a transient network failure while a navigation abort remains interrupted', () => {
  assert.equal(navigationErrorCode('ERR_CONNECTION_ABORTED'), 'net::ERR_CONNECTION_ABORTED');
  assert.equal(navigationErrorState('ERR_CONNECTION_ABORTED'), 'network_error');
  assert.equal(navigationErrorState('ERR_ABORTED'), 'interrupted');
  assert.equal(navigationErrorCode('ERR_PRIVATE_TOKEN_SECRET'), undefined);
});

test('a fresh post-retry document cannot create a new same-target reload budget', async () => {
  const app = fixture(), first = await open(app);
  app.emit('before', { url: section }); app.emit('committed', { url: section, documentId: 'target-browser-document' });
  app.setTab({ id: 7, url: section, status: 'complete' });
  app.setFrame({ url: section, documentId: 'target-browser-document', errorOccurred: false });
  app.setNavigation({ url: section, kind: 'lesson', lessonId: '8', documentToken: 'target-content-document' });
  await app.manager.retry(binding, first.transition.id);
  app.setNavigation({ url: section, kind: 'lesson', lessonId: '8', documentToken: 'fresh-post-retry-document' });
  app.setFrame({ url: section, documentId: 'fresh-post-retry-browser-document', errorOccurred: false });
  await assert.rejects(app.manager.navigate(binding, { type: 'NAVIGATE_SOURCE', url: section, expectedUrl: section,
    expectedDocumentToken: 'fresh-post-retry-document', reload: true }), { code: 'stale_collection' });
  const status = await app.manager.status(binding, first.transition.id);
  assert.equal(status.attempt, 2); assert.equal(status.deadlineAt, first.transition.deadlineAt);
});

test('only a verified matching snapshot ends the old transition and permits a fresh one', async () => {
  const app = fixture(), first = await open(app);
  app.emit('before', { url: section }); app.emit('committed', { url: section, documentId: 'target-browser-document' });
  app.setTab({ id: 7, url: section, status: 'complete' });
  app.setFrame({ url: section, documentId: 'target-browser-document', errorOccurred: false });
  await app.manager.complete(7, `${origin}/lesson-editor/book/81/lesson/8/section/9`);
  assert.equal((await app.manager.status(binding, first.transition.id)).transitionId, first.transition.id);
  await app.manager.complete(7, section);
  await assert.rejects(app.manager.status(binding, first.transition.id), { code: 'stale_collection' });
  app.setClock(5000);
  const fresh = await app.manager.navigate(binding, { type: 'NAVIGATE_SOURCE', url: section, expectedUrl: section,
    expectedDocumentToken: 'verified-target-document', reload: true });
  assert.notEqual(fresh.transition.id, first.transition.id);
  assert.equal(fresh.transition.attempt, 1);
});
