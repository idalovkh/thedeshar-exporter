import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceBookKey } from '../src/lib/book-workspaces.js';
import { classifySourceNavigation as classify } from '../src/lib/source-navigation-status.js';
import { createCollectionTransition } from '../src/lib/collection-transition.js';
import { bindingBackground, bookUrl, dashboardUrl } from './exporter-binding-background-fixture.js';

const target = bookUrl(71);
const canonicalUrl = value => {
  try { const url = new URL(value); return sourceBookKey(value) ? `${url.origin}${url.pathname}` : ''; }
  catch { return ''; }
};
function replacement() {
  return { tab: { id: 207, url: 'about:blank', pendingUrl: target, status: 'loading' },
    frame: { url: 'about:blank', documentId: 'blank-document', errorOccurred: false },
    intent: { id: 'transition', tabId: 207, attempt: 3, maxAttempts: 3, deadlineAt: 181000,
      phase: 'loading', recovery: 'replace', recoveryUrl: target, sourceUrl: target,
      targetUrl: target, observedUrl: target, bookKey: sourceBookKey(target), attemptMode: 'document',
      attemptSourceUrl: target, attemptSourceBrowserDocumentId: 'blank-document' },
    expectedBookKey: sourceBookKey(target), canonicalUrl, bookKey: sourceBookKey, now: 91000 };
}
for (const phase of ['armed', 'loading']) {
  for (const evidence of ['pending URL', 'tab URL']) {
    test(`replacement ${phase} waits for its blank document with the expected ${evidence}`, async () => {
      const input = replacement();
      input.intent.phase = phase;
      if (evidence === 'tab URL') { input.tab.url = target; delete input.tab.pendingUrl; }
      const before = structuredClone(input.intent);
      const status = classify(input);
      assert.equal(status.state, 'loading');
      assert.equal(status.browserLoading, true);
      assert.equal(status.canRetry, false);
      assert.equal(status.attempt, 3);
      assert.equal(status.deadlineAt, before.deadlineAt);
      assert.equal(status.remainingMs, 90000);
      assert.deepEqual(input.intent, before);
      const transition = createCollectionTransition({ request: async () => ({ sourceStatus: status }),
        now: () => input.now, wait: async () => {} });
      transition.accept({ ...status, id: status.transitionId });
      assert.equal((await transition.status()).state, 'loading', 'the collector must keep waiting');
    });
  }
}

const refusals = [
  ['another book pending', input => { input.tab.pendingUrl = bookUrl(81); }],
  ['another page of the same book pending', input => { input.tab.pendingUrl = 'https://progressme.ru/lesson-editor/book/71/lesson/8/section/9'; }],
  ['a foreign site pending', input => { input.tab.pendingUrl = 'https://example.com/'; }],
  ['a login pending', input => { input.tab.pendingUrl = 'https://progressme.ru/login'; }],
  ['a contradictory tab URL', input => { input.tab.url = bookUrl(81); }],
  ['a different blank document', input => { input.frame.documentId = 'other-document'; }],
  ['an unidentified blank document', input => { delete input.frame.documentId; }],
  ['a different tab', input => { input.tab.id++; }],
  ['a failed frame', input => { input.frame.errorOccurred = true; }],
  ['an expired deadline', input => { input.now = input.intent.deadlineAt; }],
  ['a stopped browser', input => { input.tab.status = 'complete'; delete input.tab.pendingUrl; }],
  ['no destination evidence', input => { delete input.tab.pendingUrl; }],
  ['an ordinary reload', input => { input.intent.recovery = 'reload'; }],
  ['an item attempt', input => { input.intent.attemptMode = 'item'; }],
  ['an already committed transition', input => { input.intent.phase = 'committed'; }],
  ['a failed transition', input => { input.intent.phase = 'failed'; }],
  ['a recorded navigation failure', input => { input.intent.failure = { documentId: 'blank-document', url: target, error: 'net::ERR_CONNECTION_RESET' }; }],
  ['an invalidated transition', input => { input.intent.invalidState = 'source_changed'; }],
  ['a recorded security rejection', input => { input.intent.invalidState = 'security_error'; }],
  ['a missing recovery URL', input => { delete input.intent.recoveryUrl; }],
  ['a recovery URL in another book', input => { input.intent.recoveryUrl = bookUrl(81); }],
  ['a contradictory observed target', input => { input.intent.observedUrl = bookUrl(81); }],
];
for (const [name, change] of refusals) {
  test(`blank replacement does not hide ${name}`, () => {
    const input = replacement();
    change(input);
    assert.notEqual(classify(input).state, 'loading');
  });
}

for (const [name, url, state] of [
  ['another book', bookUrl(81), 'other_book'],
  ['a foreign site', 'https://example.com/', 'source_changed'],
  ['a login', 'https://progressme.ru/login', 'security_error'],
]) {
  test(`a replacement document at ${name} remains terminal while the browser is loading`, () => {
    const input = replacement();
    input.frame.url = url;
    input.tab.url = url;
    assert.equal(classify(input).state, state);
  });
}

test('the real worker waits for the replacement commit with the original collection, storage and deadline', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const app = bindingBackground(), listeners = {};
  const event = name => ({ addListener: callback => { (listeners[name] ||= []).push(callback); } });
  app.chrome.webNavigation = {
    getFrame: async ({ tabId }) => {
      const tab = app.tabs.get(tabId);
      return { url: tab.frameUrl || tab.url, documentId: tab.frameDocumentId || `document-${tabId}`, errorOccurred: false };
    },
    onBeforeNavigate: event('before'), onCommitted: event('committed'),
  };
  app.chrome.tabs.remove = async id => app.remove(id);
  const update = app.chrome.tabs.update;
  app.chrome.tabs.update = async (id, patch) => {
    await update(id, patch);
    if (patch.url && id !== 7) Object.assign(app.tabs.get(id), {
      status: 'loading', pendingUrl: patch.url, frameUrl: 'about:blank',
    });
  };
  app.restart();
  const workspaceId = await app.resolve();
  const send = message => app.send({ workspaceId, ...message });
  const begun = await send({ type: 'BEGIN_COLLECTION' });
  assert.equal(begun.ok, true, begun.error);
  const collectionId = begun.collectionId;
  assert.equal((await send({ type: 'START_CAPTURE', collectionId })).ok, true);
  const saved = await send({ type: 'SAVE_COLLECTION', collectionId, collection: {
    status: 'running', rootUrl: target, title: 'Retained book', items: [], resume: { confirmed: [] },
  } });
  assert.equal(saved.ok, true, saved.error);
  const start = await send({ type: 'NAVIGATE_SOURCE', collectionId, url: target, expectedUrl: target,
    expectedDocumentToken: 'source-document-0001' });
  assert.equal(start.ok, true, start.error);
  t.mock.timers.tick(30000);
  const reload = await send({ type: 'RETRY_SOURCE_NAVIGATION', collectionId, transitionId: start.transition.id, stalled: true });
  assert.equal(reload.ok, true, reload.error);
  t.mock.timers.tick(60000);
  const prepared = await send({ type: 'PREPARE_SOURCE_REPLACEMENT', collectionId, transitionId: start.transition.id });
  assert.equal(prepared.ok, true, prepared.error);
  const tabId = prepared.sourceTabId;
  app.tabs.get(99).url = dashboardUrl(workspaceId, tabId);
  const committed = await send({ type: 'COMMIT_SOURCE_REPLACEMENT', tabId, collectionId, token: prepared.token });
  assert.equal(committed.ok, true, committed.error);
  const emit = name => {
    for (const listener of listeners[name]) listener({ tabId, frameId: 0, url: target,
      documentId: app.tabs.get(tabId).frameDocumentId, timeStamp: Date.now() });
  };
  emit('before');
  const status = () => send({ type: 'GET_SOURCE_STATUS', tabId, collectionId, transitionId: start.transition.id });
  const loading = await status();
  assert.equal(loading.ok, true, loading.error);
  assert.equal(loading.sourceStatus.state, 'loading');
  assert.equal(loading.sourceStatus.transitionId, start.transition.id);
  assert.equal(loading.sourceStatus.attempt, 3);
  assert.equal(loading.sourceStatus.deadlineAt, start.transition.deadlineAt);
  assert.equal(app.sessions[`collection:${tabId}`].collectionId, collectionId);
  assert.equal(app.sessions[`collection:${tabId}`].storageId, workspaceId);
  assert.equal(app.tabs.has(7), true);

  Object.assign(app.tabs.get(tabId), { status: 'complete', pendingUrl: undefined,
    frameUrl: target, frameDocumentId: 'loaded-replacement-document' });
  emit('committed');
  const ready = await status();
  assert.equal(ready.ok, true, ready.error);
  assert.equal(ready.sourceStatus.state, 'same_book');
  assert.equal(ready.sourceStatus.deadlineAt, start.transition.deadlineAt);
  assert.equal(app.sessions[`source-navigation:${tabId}`].phase, 'committed');

  const cancelled = await send({ type: 'CANCEL_COLLECTION', tabId, collectionId });
  assert.equal(cancelled.ok, true, cancelled.error);
  assert.equal(app.tabs.has(7), true);
  assert.equal(app.tabs.has(tabId), false);
  const late = await status();
  assert.equal(late.ok, false, 'a cancelled replacement cannot keep waiting');
});
