import assert from 'node:assert/strict';
import test from 'node:test';
import { bindingBackground, bookUrl, dashboardUrl, deferred, tick } from './exporter-binding-background-fixture.js';

test('hidden extension tab URLs do not prevent scoped reads, collection, reports or reopening', async () => {
  const app = bindingBackground(), workspaceId = await app.resolve();
  const state = await app.send({ type: 'GET_STATE', workspaceId });
  assert.equal(state.ok, true, state.error);
  const run = await app.send({ type: 'BEGIN_COLLECTION', workspaceId, requestId: 'first-run' });
  assert.equal(run.ok, true, run.error);
  assert.equal((await app.send({ type: 'START_CAPTURE', workspaceId, collectionId: run.collectionId })).ok, true);
  const report = await app.send({ type: 'BEGIN_PROBLEM_REPORT', workspaceId, kind: 'connection',
    book: { rootUrl: bookUrl(71), title: 'Book' }, extensionVersion: '0.3.43' });
  assert.equal(report.ok, true, report.error);
  assert.ok(report.reportId);
  app.restart();
  assert.equal((await app.send({ type: 'GET_STATE', workspaceId })).ok, true, 'Live owner survives a service-worker restart');
  assert.equal((await app.send({ type: 'END_COLLECTION', workspaceId, collectionId: run.collectionId })).ok, true);
  await app.click(7);
  await app.click(7);
  assert.ok(app.calls.some(call => call.type === 'update' && call.active));
});

test('another workspace is refused with a specific safe binding diagnostic', async () => {
  const app = bindingBackground();
  await app.resolve();
  const other = await app.resolve(8, 100);
  const result = await app.send({ type: 'GET_STATE', workspaceId: other });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'exporter_binding_mismatch');
  assert.deepEqual(result.binding, { cause: 'workspace_mismatch', operation: 'GET_STATE' });
  assert.equal(result.state, undefined);
});

for (const [cause, lookup] of [
  ['context_missing', () => []],
  ['context_ambiguous', (_filter, contexts) => [...contexts, { ...contexts[0], documentId: 'another-document' }]],
  ['context_lookup_failed', () => { throw new Error('private-api-error'); }],
]) {
  test(`${cause} does not authorize a scoped command`, async () => {
    const app = bindingBackground(), workspaceId = await app.resolve();
    app.setLookup(lookup);
    const result = await app.send({ type: 'GET_STATE', workspaceId });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'exporter_binding_mismatch');
    assert.deepEqual(result.binding, { cause, operation: 'GET_STATE' });
    assert.doesNotMatch(JSON.stringify(result), /private-api-error|owner-document|chrome-extension:/);
  });
}

test('a document replaced at the same exporter URL cannot use old queued messages or its lease', async () => {
  const app = bindingBackground(), workspaceId = await app.resolve();
  const old = app.sender(99);
  const run = await app.send({ type: 'BEGIN_COLLECTION', workspaceId, requestId: 'old-run' });
  assert.equal(run.ok, true, run.error);
  app.navigate(99, dashboardUrl(workspaceId), 'replacement-document');
  const result = await app.send({ type: 'GET_STATE', workspaceId }, 99, old);
  assert.equal(result.ok, false);
  assert.equal(result.binding?.cause, 'document_mismatch');
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(app.sessions['collection:7'], undefined);
});

test('cancellation bypasses a pending owner lookup and late success cannot revive the old start', { timeout: 2000 }, async () => {
  const app = bindingBackground(), workspaceId = await app.resolve();
  const entered = deferred(), release = deferred();
  let hold = true;
  app.setLookup(async (_filter, contexts) => {
    if (hold) { hold = false; entered.resolve(); await release.promise; }
    return contexts;
  });
  const starting = app.send({ type: 'BEGIN_COLLECTION', workspaceId, requestId: 'old-request' });
  await entered.promise;
  const cancelled = await Promise.race([app.send({ type: 'CANCEL_COLLECTION', workspaceId, requestId: 'old-request' }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('Cancellation waited for owner lookup')), 300); timer.unref(); })]);
  assert.equal(cancelled.ok, true, cancelled.error);
  assert.equal(cancelled.cancelled, true);
  const next = await app.send({ type: 'BEGIN_COLLECTION', workspaceId, requestId: 'next-request' });
  assert.equal(next.ok, true, next.error);
  release.resolve();
  assert.equal((await starting).code, 'stale_collection');
  assert.equal(app.sessions['collection:7'].collectionId, next.collectionId);
});

test('a different window or document cannot cancel another pending owner lookup', { timeout: 2000 }, async () => {
  const app = bindingBackground(), workspaceId = await app.resolve();
  app.tabs.get(100).url = dashboardUrl(workspaceId);
  const entered = deferred(), release = deferred();
  let hold = true;
  app.setLookup(async (_filter, contexts) => {
    if (hold) { hold = false; entered.resolve(); await release.promise; }
    return contexts;
  });
  const starting = app.send({ type: 'BEGIN_COLLECTION', workspaceId, requestId: 'pending-request' });
  await entered.promise;
  assert.equal((await app.send({ type: 'CANCEL_COLLECTION', workspaceId, requestId: 'pending-request' }, 100)).ok, false);
  assert.equal((await app.send({ type: 'CANCEL_COLLECTION', workspaceId, requestId: 'pending-request' }, 99,
    { documentId: 'foreign-document' })).ok, false);
  release.resolve();
  assert.equal((await starting).ok, true);
});

test('a delayed cancellation cannot delete the next preflight marker', { timeout: 2000 }, async () => {
  const app = bindingBackground(), workspaceId = await app.resolve();
  const entered = deferred(), release = deferred(), leaseEntered = deferred(), leaseRelease = deferred();
  let holdContext = true, holdLease = false;
  app.setLookup(async (_filter, contexts) => {
    if (holdContext) { holdContext = false; entered.resolve(); await release.promise; }
    return contexts;
  });
  const originalGet = app.chrome.storage.session.get;
  app.chrome.storage.session.get = async key => {
    if (holdLease && key === 'collection:7') { holdLease = false; leaseEntered.resolve(); await leaseRelease.promise; }
    return originalGet(key);
  };
  const starting = app.send({ type: 'BEGIN_COLLECTION', workspaceId, requestId: 'old-request' });
  await entered.promise;
  holdLease = true;
  const oldCancel = app.send({ type: 'CANCEL_COLLECTION', workspaceId, requestId: 'old-request' });
  await leaseEntered.promise;
  const next = app.send({ type: 'GET_NAVIGATION', workspaceId, requestId: 'next-request' });
  await tick();
  leaseRelease.resolve();
  const refused = await oldCancel;
  assert.equal(refused.ok, false, 'The old marker changed while cancellation was waiting');
  assert.equal(refused.code, 'stale_collection');
  const cancelled = await app.send({ type: 'CANCEL_COLLECTION', workspaceId, requestId: 'next-request' });
  assert.equal(cancelled.cancelled, true, 'The next marker remains independently cancellable');
  release.resolve();
  assert.equal((await starting).code, 'stale_collection');
  assert.equal((await next).code, 'stale_collection');
  assert.equal(app.sessions['collection:7'], undefined);
});

test('scoped source reads cannot point at another tab', async () => {
  const app = bindingBackground(), workspaceId = await app.resolve();
  const refused = await app.send({ type: 'GET_SOURCE', tabId: 8, workspaceId });
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.binding, { cause: 'source_tab_mismatch', operation: 'GET_SOURCE' });
});

test('a replaced preflight cannot acquire a lease after its owner lookup completes', { timeout: 2000 }, async () => {
  const app = bindingBackground(), workspaceId = await app.resolve();
  const entered = deferred(), release = deferred();
  let hold = true;
  app.setLookup(async (_filter, contexts) => {
    if (hold) { hold = false; entered.resolve(); await release.promise; }
    return contexts;
  });
  const old = app.send({ type: 'BEGIN_COLLECTION', workspaceId, requestId: 'old-request' });
  await entered.promise;
  const current = app.send({ type: 'GET_NAVIGATION', workspaceId, requestId: 'next-request' });
  await tick();
  release.resolve();
  assert.equal((await old).code, 'stale_collection');
  assert.equal((await current).ok, true);
  assert.equal(app.sessions['collection:7'], undefined, 'A superseded reservation cannot become a collection');
  assert.equal((await app.send({ type: 'CANCEL_COLLECTION', workspaceId, requestId: 'next-request' })).cancelled, true);
});
