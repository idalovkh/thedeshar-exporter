import assert from 'node:assert/strict';
import test from 'node:test';
import { createSourceTabRecovery } from '../src/lib/source-tab-recovery.js';

function fixture() {
  const sessions = {}, actions = [], leases = new Map();
  const url = 'https://school.example/lesson-editor/book/1/lesson/2/section/3';
  const binding = { tabId: 7, ownerTabId: 99, workspaceId: 'workspace', collectionId: 'collection', bookKey: 'https://school.example/book/1' };
  const lease = { ...binding, ownerDocumentId: 'owner-document', storageId: 'unchanged-storage' };
  leases.set(7, lease);
  let ownerSource = 7, ownerDocument = 'owner-document', clock = 90000, createError, activateWait, nextOwnerWait;
  const tabs = new Map([[7, { url }]]);
  const sender = { id: 'extension', documentId: 'owner-document', tab: { id: 99 } };
  const options = {
    now: () => clock, randomUUID: () => `id-${Object.keys(sessions).length}`,
    chrome: { storage: { session: {
      get: async key => ({ [key]: structuredClone(sessions[key]) }),
      set: async value => Object.assign(sessions, structuredClone(value)), remove: async key => { delete sessions[key]; },
    } }, tabs: {
      create: async () => { if (createError) throw createError; tabs.set(8, { url: 'about:blank' }); actions.push('create'); return { id: 8 }; },
      get: async id => tabs.get(id), update: async (id, patch) => { actions.push('navigate'); Object.assign(tabs.get(id), patch); },
      remove: async id => { actions.push(`close:${id}`); tabs.delete(id); },
    }, webNavigation: { getFrame: async () => ({ documentId: 'new-document' }) } },
    exporterBinding: {
      requireOwner: async (id, source, workspace, { sender: candidate, documentId } = {}) => {
        if (id !== 99 || source !== ownerSource || workspace !== 'workspace' ||
          candidate && candidate.documentId !== ownerDocument || documentId && documentId !== ownerDocument) throw new Error('Wrong owner');
        const waiting = nextOwnerWait; nextOwnerWait = null;
        if (waiting) await waiting;
      },
      isOwner: async (id, source, workspace, documentId) => id === 99 && source === ownerSource && workspace === 'workspace' && documentId === ownerDocument,
    },
    navigation: {
      recoveryIntent: async () => {
        if (!leases.has(7)) throw new Error('Revoked');
        return { ...binding, id: 'transition', attempt: 2, deadlineAt: 180000, recoveryUrl: url };
      },
      installReplacement: async intent => ({ ok: true, transition: { id: intent.id, attempt: 3, maxAttempts: 3, deadlineAt: intent.deadlineAt } }),
      clear: async id => { actions.push(`clear:${id}`); },
    },
    catalogue: { update: async (_workspace, patch) => { actions.push({ catalogue: patch }); } },
    readLease: async id => leases.get(id),
    revoke: async id => { actions.push(`revoke:${id}`); },
    activate: async record => { if (activateWait) await activateWait; leases.set(record.newTabId, record.lease); leases.delete(record.oldTabId); },
    rollback: async () => { actions.push('rollback'); leases.clear(); },
  };
  let recovery = createSourceTabRecovery(options);
  return { binding, sender, actions, sessions, tabs, leases,
    get recovery() { return recovery; }, restart() { recovery = createSourceTabRecovery(options); },
    source: value => { ownerSource = value; }, document: value => { ownerDocument = value; },
    time: value => { clock = value; }, failCreation: () => { createError = new Error('Cannot create'); },
    waitActivation: promise => { activateWait = promise; },
    waitNextOwner: promise => { nextOwnerWait = promise; } };
}

async function prepare(app) {
  const result = await app.recovery.prepare(app.binding, app.sender, 'transition');
  app.source(result.sourceTabId);
  return { ...result, tabId: result.sourceTabId, collectionId: 'collection' };
}

test('handoff keeps the deadline/storage and closes the old tab only after a saved section', async () => {
  const app = fixture(), prepared = await prepare(app);
  const result = await app.recovery.commit(prepared, app.sender);
  assert.equal(result.transition.deadlineAt, 180000);
  assert.equal(app.leases.get(8).storageId, 'unchanged-storage');
  assert.equal(app.tabs.has(7), true);
  assert.equal(app.tabs.get(8).url.endsWith('/section/3'), true);
  await app.recovery.finish(8, 'collection', app.sender);
  assert.equal(app.tabs.has(7), false);
  assert.equal(app.tabs.has(8), true);
});

test('a prepared handoff survives worker suspension and recognizes only the same dashboard document', async () => {
  const app = fixture(), prepared = await prepare(app);
  app.restart();
  assert.equal(await app.recovery.alternateOwner(99, 7, 'workspace', 'owner-document'), true);
  assert.equal(await app.recovery.alternateOwner(99, 7, 'other', 'owner-document'), false);
  assert.equal(await app.recovery.alternateOwner(99, 7, 'workspace', 'other-document'), false);
  assert.equal((await app.recovery.commit(prepared, app.sender)).transition.attempt, 3);
});

test('cancelled, expired and wrong-token handoffs cannot navigate a replacement', async () => {
  for (const mode of ['cancelled', 'expired', 'token', 'owner']) {
    const app = fixture(), prepared = await prepare(app);
    if (mode === 'cancelled') await app.recovery.abort(prepared, app.sender);
    if (mode === 'expired') app.time(180000);
    if (mode === 'token') prepared.token = 'forged';
    if (mode === 'owner') app.document('different-document');
    await assert.rejects(app.recovery.commit(prepared, app.sender));
    assert.equal(app.actions.includes('navigate'), false);
    assert.equal(app.tabs.has(7), true);
  }
});

test('failed creation and failed replacement retain the original tab', async () => {
  const failed = fixture(); failed.failCreation();
  await assert.rejects(failed.recovery.prepare(failed.binding, failed.sender, 'transition'));
  assert.equal(failed.tabs.has(7), true);
  const app = fixture(), prepared = await prepare(app);
  await app.recovery.commit(prepared, app.sender);
  const result = await app.recovery.abort(prepared, app.sender);
  assert.equal(result.restoreSourceTabId, 7);
  assert.equal(app.tabs.has(8), false);
  assert.equal(app.tabs.has(7), true);
});

test('cancellation wins over a delayed saved-section confirmation without closing both tabs', async () => {
  const app = fixture(), prepared = await prepare(app);
  await app.recovery.commit(prepared, app.sender);
  let release;
  app.waitNextOwner(new Promise(resolve => { release = resolve; }));
  const saved = app.recovery.finish(8, 'collection', app.sender);
  await new Promise(resolve => setImmediate(resolve));
  await app.recovery.abort(prepared, app.sender);
  release(); await saved;
  assert.equal(app.tabs.has(7), true);
  assert.equal(app.tabs.has(8), false);
  assert.equal(app.actions.includes('close:7'), false);
});

test('dashboard navigation discards a replacement before a delayed save can close the original', async () => {
  const app = fixture(), prepared = await prepare(app);
  await app.recovery.commit(prepared, app.sender);
  let release;
  app.waitNextOwner(new Promise(resolve => { release = resolve; }));
  const saved = app.recovery.finish(8, 'collection', app.sender);
  await new Promise(resolve => setImmediate(resolve));
  app.document('another-dashboard-document');
  await app.recovery.discard(99);
  release(); await saved;
  assert.equal(app.tabs.has(7), true);
  assert.equal(app.tabs.has(8), false);
  assert.equal(app.leases.size, 0);
});

test('cancellation during lease activation leaves no active replacement after a late completion', async () => {
  const app = fixture(), prepared = await prepare(app);
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  app.waitActivation(new Promise(resolve => { release = resolve; }));
  const pending = app.recovery.commit(prepared, app.sender);
  const rejected = assert.rejects(pending);
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  started(); await entered;
  await app.recovery.abort(prepared, app.sender);
  release(); await rejected;
  assert.equal(app.leases.has(8), false);
  assert.equal(app.actions.includes('navigate'), false);
});
