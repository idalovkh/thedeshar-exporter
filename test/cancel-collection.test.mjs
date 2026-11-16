import assert from 'node:assert/strict';
import test from 'node:test';
import { installBackground } from '../src/background.js';
import { createExporterContextFixture } from './exporter-context-fixture.js';
import { createWorkspace } from '../src/lib/state.js';

const rootUrl = 'https://progressme.ru/cabinet/school/materials/book/71/content';
const dashboardUrl = (id, tabId = 7) => `chrome-extension://extension/exporter.html?workspace=${id}&tab=${tabId}`;
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const sessions = {}, records = new Map(), replies = new Map();
  const tabs = new Map([[7, { id: 7, url: rootUrl }], [8, { id: 8, url: rootUrl }],
    [99, { id: 99, url: 'chrome-extension://extension/exporter.html?tab=7' }],
    [100, { id: 100, url: 'chrome-extension://extension/exporter.html?tab=8' }]]);
  let listener;
  const chrome = {
    runtime: { id: 'extension', getURL: path => `chrome-extension://extension/${path}`, sendMessage: async () => {},
      onMessage: { addListener: callback => { listener = callback; } } },
    action: { onClicked: { addListener() {} } },
    storage: { session: { get: async key => ({ [key]: sessions[key] }),
      set: async values => Object.assign(sessions, structuredClone(values)), remove: async key => { delete sessions[key]; } } },
    tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} }, create: async () => {},
      get: async id => { if (!tabs.has(id)) throw new Error('Closed'); return tabs.get(id); },
      sendMessage: async (_id, message) => replies.has(message.type) ? replies.get(message.type)(message) : { ok: true, captureId: message.captureId },
    },
  };
  const withExporterDocument = createExporterContextFixture(chrome);
  installBackground(chrome, {
    readWorkspace: async id => records.get(id) || createWorkspace(id),
    updateWorkspace: async (id, update) => { const result = update(records.get(id) || createWorkspace(id)); records.set(id, result); return result; },
  });
  const send = (message, senderId = 99) => new Promise(resolve => {
    const tab = tabs.get(senderId);
    listener({ tabId: 7, ...message }, withExporterDocument({ id: 'extension', url: tab.url, frameId: 0, tab }), resolve);
  });
  return { send, sessions, records, replies, tabs, async resolve(tabId = 7, senderId = 99) {
    const result = await send({ type: 'RESOLVE_WORKSPACE', tabId }, senderId);
    assert.equal(result.ok, true, result.error);
    tabs.get(senderId).url = dashboardUrl(result.workspaceId, tabId);
    return result.workspaceId;
  } };
}
async function promptly(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Cancellation waited for source')), 300); })]); }
  finally { clearTimeout(timer); }
}

test('cancel bypasses a silent source and preserves snapshots while rejecting old run writes', async () => {
  const app = fixture(), workspaceId = await app.resolve();
  const snapshots = [{ url: rootUrl, title: 'Retained', blocks: [], assets: [] }];
  app.records.set(workspaceId, { ...createWorkspace(workspaceId), snapshots,
    collection: { title: 'Retained', rootUrl, status: 'running', items: [{ kind: 'lesson', status: 'running' }] } });
  const run = await app.send({ type: 'BEGIN_COLLECTION', workspaceId, requestId: 'first-request' });
  assert.equal(run.ok, true, run.error);
  assert.equal((await app.send({ type: 'START_CAPTURE', workspaceId, collectionId: run.collectionId })).ok, true);
  app.replies.set('MATERIAL_NAVIGATION', () => new Promise(() => {}));
  app.replies.set('CAPTURE_STOP', () => new Promise(() => {}));
  const stalled = app.send({ type: 'GET_NAVIGATION', workspaceId });
  await tick();
  const cancelled = await promptly(app.send({ type: 'CANCEL_COLLECTION', workspaceId, collectionId: run.collectionId }));
  assert.equal(cancelled.ok, true, cancelled.error);
  assert.equal((await stalled).code, 'stale_collection');
  assert.deepEqual(app.records.get(workspaceId).snapshots, snapshots);
  assert.equal(app.records.get(workspaceId).collection.status, 'cancelled');
  assert.equal(app.sessions['collection:7'], undefined);
  assert.equal(app.sessions['capture-id:7'], undefined);
  const late = await app.send({ type: 'SAVE_COLLECTION', workspaceId, collectionId: run.collectionId,
    collection: { title: 'Old late report', rootUrl, status: 'running' } });
  assert.equal(late.code, 'stale_collection');
});

test('cancel interrupts the initial book probe before collection acquisition', async () => {
  const app = fixture(), workspaceId = await app.resolve();
  const snapshots = [{ url: rootUrl, title: 'Previous result', blocks: [], assets: [] }];
  app.records.set(workspaceId, { ...createWorkspace(workspaceId), snapshots,
    collection: { title: 'Previous result', rootUrl, status: 'finished', items: [] } });
  app.replies.set('MATERIAL_NAVIGATION', () => new Promise(() => {}));
  const probe = app.send({ type: 'GET_NAVIGATION', workspaceId, requestId: 'initial-probe-request' });
  await tick();
  const cancelled = await promptly(app.send({ type: 'CANCEL_COLLECTION', workspaceId, requestId: 'initial-probe-request' }));
  assert.equal(cancelled.ok, true, cancelled.error);
  assert.equal(cancelled.cancelled, true, 'A preflight probe is cancellable before BEGIN_COLLECTION');
  assert.equal((await promptly(probe)).code, 'stale_collection');
  assert.deepEqual(app.records.get(workspaceId).snapshots, snapshots);
  assert.equal(app.records.get(workspaceId).collection.status, 'finished', 'Cancellation preserves the previous completed result');
  const next = await promptly(app.send({ type: 'BEGIN_COLLECTION', workspaceId, requestId: 'next-request' }));
  assert.equal(next.ok, true, next.error);
});

test('a rejected book preflight cannot prevent cancellation of the next attempt', async () => {
  const app = fixture(), workspaceId = await app.resolve();
  app.replies.set('MATERIAL_NAVIGATION', () => ({ ok: true, navigation: { kind: 'book', url: rootUrl, blocked: true } }));
  const old = await app.send({ type: 'GET_NAVIGATION', workspaceId, requestId: 'rejected-preflight' });
  assert.equal(old.ok, true);
  // collectBook rejects this blocked page locally, before BEGIN_COLLECTION.
  app.replies.set('MATERIAL_NAVIGATION', () => new Promise(() => {}));
  const probe = app.send({ type: 'GET_NAVIGATION', workspaceId, requestId: 'next-preflight' });
  await tick();
  const cancelled = await promptly(app.send({ type: 'CANCEL_COLLECTION', workspaceId, requestId: 'next-preflight' }));
  assert.equal(cancelled.ok, true, cancelled.error);
  assert.equal(cancelled.cancelled, true);
  assert.equal((await promptly(probe)).code, 'stale_collection');
});

test('late cancellation and another dashboard cannot stop the next collection', async () => {
  const app = fixture(), workspaceId = await app.resolve();
  const old = await app.send({ type: 'BEGIN_COLLECTION', workspaceId, requestId: 'first-request' });
  assert.equal((await app.send({ type: 'CANCEL_COLLECTION', workspaceId, collectionId: old.collectionId })).ok, true);
  const current = await app.send({ type: 'BEGIN_COLLECTION', workspaceId, requestId: 'next-request' });
  assert.equal(current.ok, true, current.error);
  assert.equal((await app.send({ type: 'CANCEL_COLLECTION', workspaceId, requestId: 'first-request' })).code, 'stale_collection');
  app.tabs.get(100).url = dashboardUrl(workspaceId);
  assert.equal((await app.send({ type: 'CANCEL_COLLECTION', workspaceId, collectionId: current.collectionId }, 100)).ok, false);
  assert.equal((await app.send({ type: 'CANCEL_COLLECTION', workspaceId, collectionId: current.collectionId }, 7)).ok, false);
  assert.equal(app.sessions['collection:7'].collectionId, current.collectionId);
});

test('a rebound book cannot collect into one workspace from two source tabs', async () => {
  const app = fixture(), workspaceId = await app.resolve();
  assert.equal(await app.resolve(8, 100), workspaceId);
  const oldTab = await app.send({ type: 'BEGIN_COLLECTION', workspaceId, requestId: 'old-binding' });
  assert.equal(oldTab.ok, false);
  const current = await app.send({ type: 'BEGIN_COLLECTION', tabId: 8, workspaceId, requestId: 'new-binding' }, 100);
  assert.equal(current.ok, true, current.error);
  assert.equal((await app.send({ type: 'BEGIN_COLLECTION', tabId: 8, workspaceId, requestId: 'competing' })).ok, false);
  assert.equal(app.sessions['collection:8'].collectionId, current.collectionId);
  assert.equal(app.sessions['collection:7'], undefined);
});

test('a source switched to another book still permits scoped failure checkpoint and cleanup', async () => {
  const app = fixture(), workspaceId = await app.resolve();
  const run = await app.send({ type: 'BEGIN_COLLECTION', workspaceId, requestId: 'first-request' });
  assert.equal(run.ok, true, run.error);
  app.tabs.get(7).url = rootUrl.replace('/71/', '/81/');
  const saved = await app.send({ type: 'SAVE_COLLECTION', workspaceId, collectionId: run.collectionId,
    collection: { title: 'Original book', rootUrl, status: 'failed', items: [] } });
  assert.equal(saved.ok, true, saved.error);
  assert.equal((await app.send({ type: 'STOP_CAPTURE', workspaceId, collectionId: run.collectionId })).ok, true);
  assert.equal((await app.send({ type: 'END_COLLECTION', workspaceId, collectionId: run.collectionId })).ok, true);
  assert.equal(app.records.get(workspaceId).collection.status, 'failed');
  assert.equal(app.sessions['collection:7'], undefined);
});

test('a foreign source probe cannot reserve another books cancellation intent', async () => {
  const app = fixture(), workspaceId = await app.resolve();
  await app.send({ type: 'GET_NAVIGATION', requestId: 'foreign-probe' }, 100);
  app.replies.set('MATERIAL_NAVIGATION', () => new Promise(() => {}));
  const probe = app.send({ type: 'GET_NAVIGATION', workspaceId, requestId: 'own-probe' });
  await tick();
  const cancelled = await promptly(app.send({ type: 'CANCEL_COLLECTION', workspaceId, requestId: 'own-probe' }));
  assert.equal(cancelled.ok, true, cancelled.error);
  assert.equal(cancelled.cancelled, true);
  assert.equal((await promptly(probe)).code, 'stale_collection');
});
