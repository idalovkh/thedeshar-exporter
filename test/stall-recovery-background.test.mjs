import assert from 'node:assert/strict';
import test from 'node:test';
import { bindingBackground, dashboardUrl, tick } from './exporter-binding-background-fixture.js';

async function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const app = bindingBackground();
  app.chrome.webNavigation = { getFrame: async ({ tabId }) => ({ url: app.tabs.get(tabId)?.url,
    documentId: `document-${tabId}`, errorOccurred: false }) };
  app.chrome.tabs.remove = async id => app.remove(id);
  const workspaceId = await app.resolve();
  const send = message => app.send({ workspaceId, ...message });
  const begin = await send({ type: 'BEGIN_COLLECTION' });
  assert.equal(begin.ok, true, begin.error);
  const collectionId = begin.collectionId;
  assert.equal((await send({ type: 'START_CAPTURE', collectionId })).ok, true);
  const url = app.tabs.get(7).url;
  await send({ type: 'SAVE_COLLECTION', collectionId, collection: { status: 'running', rootUrl: url,
    title: 'Retained book', items: [], resume: { confirmed: [] } } });
  const start = await send({ type: 'NAVIGATE_SOURCE', collectionId, url, expectedUrl: url, expectedDocumentToken: 'source-document-0001' });
  assert.equal(start.ok, true, start.error);
  t.mock.timers.tick(30000);
  const skipped = await send({ type: 'RETRY_DEFINITION_REQUEST', collectionId, transitionId: start.transition.id });
  assert.equal(skipped.retried, false);
  const reload = await send({ type: 'RETRY_SOURCE_NAVIGATION', collectionId, transitionId: start.transition.id, stalled: true });
  assert.equal(reload.ok, true, reload.error);
  t.mock.timers.tick(60000);
  return { app, workspaceId, collectionId, transition: start.transition, send };
}

test('real worker transfers its lease/capture scope and rejects old source writes', async t => {
  const { app, workspaceId, collectionId, transition, send } = await fixture(t);
  const oldCapture = app.sessions['capture-id:7'];
  const before = JSON.stringify(app.records.get(workspaceId));
  const prepared = await send({ type: 'PREPARE_SOURCE_REPLACEMENT', collectionId, transitionId: transition.id });
  assert.equal(prepared.ok, true, prepared.error);
  app.tabs.get(99).url = dashboardUrl(workspaceId, prepared.sourceTabId);
  const committed = await send({ type: 'COMMIT_SOURCE_REPLACEMENT', tabId: prepared.sourceTabId, collectionId, token: prepared.token });
  assert.equal(committed.ok, true, committed.error);
  assert.equal(committed.transition.deadlineAt, transition.deadlineAt);
  assert.equal(app.sessions['collection:7'], undefined);
  assert.equal(app.sessions[`collection:${prepared.sourceTabId}`].collectionId, collectionId);
  assert.equal(app.sessions[`collection:${prepared.sourceTabId}`].storageId, workspaceId);
  assert.notEqual(app.sessions[`capture-id:${prepared.sourceTabId}`], oldCapture);
  const late = await app.send({ type: 'CAPTURE_EVENT', captureId: oldCapture, event: { kind: 'fetch',
    url: 'https://progressme.ru/lessons', data: { lesson: { text: 'Late response' } } } }, 7);
  assert.equal(late.ok, false);
  assert.equal(JSON.stringify(app.records.get(workspaceId)), before);
  assert.equal(app.tabs.has(7), true);
  const ended = await send({ type: 'END_COLLECTION', tabId: prepared.sourceTabId, collectionId });
  assert.equal(ended.ok, true, ended.error);
  assert.equal(ended.restoreSourceTabId, 7);
  assert.equal(app.tabs.has(prepared.sourceTabId), false);
});

test('forged replacement messages cannot change a book or another owner scope', async t => {
  const { app, workspaceId, collectionId, transition, send } = await fixture(t);
  const prepared = await send({ type: 'PREPARE_SOURCE_REPLACEMENT', collectionId, transitionId: transition.id });
  assert.equal(prepared.ok, true, prepared.error);
  for (const [owner, override] of [[100, {}], [7, {}], [99, { documentId: 'forged-document' }]]) {
    const result = await app.send({ type: 'COMMIT_SOURCE_REPLACEMENT', tabId: prepared.sourceTabId,
      collectionId, token: prepared.token }, owner, override);
    assert.equal(result.ok, false);
  }
  assert.equal(app.sessions['collection:7'].collectionId, collectionId);
  assert.equal(app.calls.some(call => call.type === 'update' && call.id === prepared.sourceTabId), false);
  await tick();
});

test('cancelling a prepared replacement revokes the original capture and preserves the book', async t => {
  const { app, collectionId, transition, send } = await fixture(t);
  const token = app.sessions['capture-id:7'];
  const prepared = await send({ type: 'PREPARE_SOURCE_REPLACEMENT', collectionId, transitionId: transition.id });
  const journal = app.sessions['source-tab-recovery:99'];
  app.tabs.get(99).url = dashboardUrl(journal.workspaceId, prepared.sourceTabId);
  const result = await app.send({ type: 'CANCEL_COLLECTION', tabId: prepared.sourceTabId, collectionId });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.restoreSourceTabId, 7);
  assert.equal(app.tabs.has(prepared.sourceTabId), false);
  assert.equal(app.sessions['capture-id:7'], undefined);
  const late = await app.send({ type: 'CAPTURE_EVENT', captureId: token, event: { kind: 'fetch',
    url: 'https://progressme.ru/lessons', data: { lesson: 'Late' } } }, 7);
  assert.equal(late.ok, false);
  assert.equal(app.records.get(journal.workspaceId).collection.status, 'cancelled');
});

test('worker suspension between prepare and commit preserves the transfer journal', async t => {
  const { app, workspaceId, collectionId, transition, send } = await fixture(t);
  const prepared = await send({ type: 'PREPARE_SOURCE_REPLACEMENT', collectionId, transitionId: transition.id });
  app.tabs.get(99).url = dashboardUrl(workspaceId, prepared.sourceTabId);
  const get = app.chrome.storage.session.get;
  app.chrome.storage.session.get = key => key === null ? Promise.resolve(structuredClone(app.sessions)) : get(key);
  app.restart();
  const result = await send({ type: 'COMMIT_SOURCE_REPLACEMENT', tabId: prepared.sourceTabId, collectionId, token: prepared.token });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.transition.deadlineAt, transition.deadlineAt);
  assert.equal(app.sessions[`collection:${prepared.sourceTabId}`].storageId, workspaceId);
});
