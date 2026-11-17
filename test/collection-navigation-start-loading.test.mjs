import assert from 'node:assert/strict';
import test from 'node:test';
import { collectBook } from '../src/lib/collection.js';
import { withCollectionTransitions } from './collection-transition-fixture.js';
import { bindingBackground, bookUrl } from './exporter-binding-background-fixture.js';
import { startCollectionNavigation } from '../src/lib/start-collection-navigation.js';
import { createCollectionTransition } from '../src/lib/collection-transition.js';

const rootUrl = bookUrl(71);
const homework = 'https://progressme.ru/lesson-editor/book/71/lesson/8/section/for-homework';
const transient = code => Object.assign(new Error('The source is still settling'), { code });

function source({ code = 'source_loading', forever = false, changedDocument = false, cancelled = false } = {}) {
  let clock = 0, generation = 1, position = 'book', rejected = false, waiting = false, statusReads = 0;
  const calls = [], saved = [];
  const controller = new AbortController();
  const navigation = () => ({ documentToken: `loading-start-document-${generation}`, materialId: '71',
    ready: true, contentSignature: position, network: { pending: 0, idleMs: 10000 }, warnings: [],
    ...(position === 'book' ? { kind: 'book', url: rootUrl, title: 'Book',
      items: [{ kind: 'lesson', key: 'lesson-8', title: 'Lesson' }] }
      : { kind: 'lesson', url: homework, lessonId: '8', title: 'Lesson',
        items: [{ kind: 'homework', key: 'homework', title: 'Homework', active: true }],
        sectionVisit: { token: 'loading-start-homework-visit', revision: 1, received: true, idleMs: 10000 } }) });
  const normal = withCollectionTransitions(async (type, payload) => {
    if (type === 'BEGIN_COLLECTION') return { collectionId: 'loading-start-collection' };
    if (type === 'GET_NAVIGATION' || type === 'PREPARE_BOOK') return { ok: true, navigation: navigation(), opened: 0 };
    if (type === 'NAVIGATE_SOURCE') {
      if (payload.expectedDocumentToken !== navigation().documentToken) throw transient('source_changed');
      position = 'book'; generation++; return { ok: true };
    }
    if (type === 'OPEN_MATERIAL_ITEM') { position = 'homework'; return { ok: true }; }
    if (type === 'TAKE_SNAPSHOT') {
      saved.push(payload.expectedUrl);
      return { ok: true, snapshotUrl: payload.expectedUrl, retained: { dropped: 0, authorData: true,
        capturedAt: '2026-11-17T09:16:02.859Z' } };
    }
    if (type === 'GET_STATE') return { state: { dropped: 0 } };
    return { ok: true };
  });
  const request = async (type, payload = {}) => {
    calls.push({ type, ...structuredClone(payload), at: clock });
    if (type === 'NAVIGATE_SOURCE' && payload.expectedUrl === homework && (!rejected || forever)) {
      rejected = true; waiting = true;
      throw transient(code);
    }
    if (type === 'GET_SOURCE_STATUS' && waiting) {
      statusReads++;
      if (cancelled) controller.abort();
      const state = statusReads === 1 ? 'loading' : 'same_book';
      if (changedDocument && state === 'same_book') generation++;
      if (state === 'same_book') waiting = false;
      return { sourceStatus: { state, browserLoading: state === 'loading', canRetry: false, url: homework } };
    }
    return normal(type, payload);
  };
  return { calls, saved, controller, request, now: () => clock, wait: async ms => { clock += ms; } };
}
const collect = app => collectBook({ request: app.request, now: app.now, wait: app.wait, signal: app.controller.signal,
  pollMs: 10, transitionTimeoutMs: 120, quietMs: 0, retryDelaysMs: [0, 0] });

for (const code of ['source_loading', 'source_disconnected', 'source_timeout', 'source_network_error']) {
  test(`${code} before a return-to-contents grant waits and retries the same guarded command`, async () => {
    const app = source({ code });
    const report = await collect(app);
    assert.equal(report.status, 'finished', JSON.stringify(report.failed));
    assert.deepEqual(app.saved, [rootUrl, homework]);
    const returns = app.calls.filter(call => call.type === 'NAVIGATE_SOURCE' && call.expectedUrl === homework);
    assert.equal(returns.length, 2);
    assert.equal(returns[1].expectedDocumentToken, returns[0].expectedDocumentToken);
    assert.equal(returns[1].expectedVisitToken, returns[0].expectedVisitToken);
    assert.equal(returns[1].collectionId, returns[0].collectionId);
    assert.ok(returns[1].sourceTimeoutMs < returns[0].sourceTimeoutMs);
    assert.ok(returns[1].at > returns[0].at);
    assert.ok(app.calls.some(call => call.type === 'GET_SOURCE_STATUS' && call.at < returns[1].at));
    assert.equal(app.calls.some(call => call.type === 'RETRY_SOURCE_NAVIGATION' || call.type === 'REPLACE_SOURCE_TAB'), false);
  });
}

test('repeated pre-grant loading cannot reset the return-to-contents deadline', async () => {
  const app = source({ forever: true });
  const report = await collect(app);
  const first = app.calls.find(call => call.type === 'NAVIGATE_SOURCE' && call.expectedUrl === homework);
  assert.equal(report.status, 'failed');
  assert.equal(report.diagnostics.failure.reason, 'transition_timeout');
  assert.equal(app.now() - first.at, 120);
  assert.deepEqual(app.saved, [rootUrl, homework]);
});

test('a new document cannot receive the guarded command retried after pre-grant loading', async () => {
  const app = source({ changedDocument: true });
  const report = await collect(app);
  assert.equal(report.status, 'failed');
  assert.equal(report.diagnostics.failure.reason, 'source_changed');
  assert.deepEqual(app.saved, [rootUrl, homework]);
});

test('cancellation during pre-grant waiting prevents another source command', async () => {
  const app = source({ cancelled: true });
  const report = await collect(app);
  assert.equal(report.status, 'cancelled');
  assert.equal(app.calls.filter(call => call.type === 'NAVIGATE_SOURCE' && call.expectedUrl === homework).length, 1);
  assert.deepEqual(app.saved, [rootUrl, homework]);
});

test('the real worker exposes no navigation grant after a source barrier refuses the command', async () => {
  const app = bindingBackground();
  app.chrome.webNavigation = { getFrame: async () => ({ url: app.tabs.get(7).url, documentId: 'browser-document' }) };
  const workspaceId = await app.resolve();
  app.tabs.get(7).url = homework;
  const send = message => app.send({ workspaceId, ...message });
  const begun = await send({ type: 'BEGIN_COLLECTION' });
  assert.equal(begun.ok, true, begun.error);
  const collectionId = begun.collectionId;
  assert.equal((await send({ type: 'START_CAPTURE', collectionId })).ok, true);
  const original = app.chrome.tabs.sendMessage;
  let refused = false;
  app.chrome.tabs.sendMessage = async (id, message) => {
    if (message.type === 'NAVIGATE_SOURCE' && !refused) {
      refused = true;
      return { ok: false, code: 'source_loading', error: 'The page changed during the barrier' };
    }
    return original(id, message);
  };
  const command = { type: 'NAVIGATE_SOURCE', collectionId, url: rootUrl, expectedUrl: homework,
    expectedDocumentToken: 'source-document-0001' };
  assert.equal((await send(command)).code, 'source_loading');
  const status = await send({ type: 'GET_SOURCE_STATUS', collectionId });
  assert.equal(status.ok, true, status.error);
  assert.equal(status.sourceStatus.state, 'same_book');
  assert.equal(status.sourceStatus.transitionId, undefined);
  const retry = await send(command);
  assert.equal(retry.ok, true, retry.error);
  assert.equal(typeof retry.transition.id, 'string');
  assert.equal(app.sessions['collection:7'].collectionId, collectionId);
});

test('an existing navigation grant after a lost reply is resumed without resending its command', async () => {
  const calls = [];
  const request = async type => {
    calls.push(type);
    if (type === 'NAVIGATE_SOURCE') throw transient('source_disconnected');
    return { sourceStatus: { state: 'loading', transitionId: 'already-dispatched',
      deadlineAt: 180000, attempt: 1, maxAttempts: 3, browserLoading: true, canRetry: false } };
  };
  const transition = createCollectionTransition({ request, now: () => 0, wait: async () => {} });
  await startCollectionNavigation({ transition, request, type: 'NAVIGATE_SOURCE', pollMs: 10,
    payload: { expectedUrl: homework, expectedDocumentToken: 'source-document-0001', url: rootUrl } });
  assert.equal(transition.id(), 'already-dispatched');
  assert.equal(transition.attempt(), 1);
  assert.deepEqual(calls, ['NAVIGATE_SOURCE', 'GET_SOURCE_STATUS']);
});

for (const state of ['other_book', 'source_changed', 'security_error', 'interrupted', 'closed']) {
  test(`${state} while waiting for a navigation grant remains terminal`, async () => {
    const calls = [];
    const request = async type => {
      calls.push(type);
      if (type === 'NAVIGATE_SOURCE') throw transient('source_loading');
      return { sourceStatus: { state } };
    };
    const transition = createCollectionTransition({ request, now: () => 0, wait: async () => {} });
    await assert.rejects(startCollectionNavigation({ transition, request, type: 'NAVIGATE_SOURCE', pollMs: 10,
      payload: { expectedUrl: homework, expectedDocumentToken: 'source-document-0001', url: rootUrl } }));
    assert.deepEqual(calls, ['NAVIGATE_SOURCE', 'GET_SOURCE_STATUS']);
  });
}

test('a successful reply with an unsupported navigation descriptor still requires an update', async () => {
  const calls = [];
  const request = async type => { calls.push(type); return { ok: true }; };
  const transition = createCollectionTransition({ request, now: () => 0, wait: async () => {} });
  await assert.rejects(startCollectionNavigation({ transition, request, type: 'NAVIGATE_SOURCE', pollMs: 10,
    payload: { expectedUrl: homework, expectedDocumentToken: 'source-document-0001', url: rootUrl } }),
  { code: 'source_update_required' });
  assert.deepEqual(calls, ['NAVIGATE_SOURCE']);
});
