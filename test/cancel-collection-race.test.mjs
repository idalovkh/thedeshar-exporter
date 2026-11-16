import assert from 'node:assert/strict';
import test from 'node:test';
import { installBackground } from '../src/background.js';
import { createExporterContextFixture } from './exporter-context-fixture.js';
import { createWorkspace } from '../src/lib/state.js';

const rootUrl = 'https://progressme.ru/cabinet/school/materials/book/71/content';
function deferred() {
  let resolve;
  return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('cancelling before lease persistence returns invalidates the pending start without clearing materials', async () => {
  const sessions = {}, records = new Map();
  const tabs = new Map([[7, { id: 7, url: rootUrl }], [99, { id: 99, url: 'chrome-extension://extension/exporter.html?tab=7' }]]);
  let listener, blockLease = false;
  const entered = deferred(), release = deferred();
  const chrome = {
    runtime: { id: 'extension', getURL: path => `chrome-extension://extension/${path}`, sendMessage: async () => {},
      onMessage: { addListener: callback => { listener = callback; } } },
    action: { onClicked: { addListener() {} } },
    storage: { session: {
      get: async key => ({ [key]: sessions[key] }),
      set: async values => {
        if (blockLease && values['collection:7']) { blockLease = false; entered.resolve(); await release.promise; }
        Object.assign(sessions, structuredClone(values));
      },
      remove: async key => { delete sessions[key]; },
    } },
    tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} }, create: async () => {},
      get: async id => { if (!tabs.has(id)) throw new Error('Closed'); return tabs.get(id); },
      sendMessage: async (_id, message) => ({ ok: true, captureId: message.captureId }),
    },
  };
  const withExporterDocument = createExporterContextFixture(chrome);
  installBackground(chrome, {
    readWorkspace: async id => records.get(id) || createWorkspace(id),
    updateWorkspace: async (id, update) => { const result = update(records.get(id) || createWorkspace(id)); records.set(id, result); return result; },
  });
  const sender = () => ({ id: 'extension', url: tabs.get(99).url, tab: tabs.get(99) });
  const send = message => new Promise(resolve => listener({ tabId: 7, ...message }, withExporterDocument(sender()), resolve));
  const selected = await send({ type: 'RESOLVE_WORKSPACE' });
  assert.equal(selected.ok, true);
  const workspaceId = selected.workspaceId;
  tabs.set(99, { id: 99, url: `chrome-extension://extension/exporter.html?workspace=${workspaceId}&tab=7` });
  const preserved = { ...createWorkspace(workspaceId), book: { title: 'Retained book', rootUrl },
    snapshots: [{ url: rootUrl, title: 'Retained book', blocks: [], assets: [] }], captures: [] };
  records.set(workspaceId, structuredClone(preserved));
  blockLease = true;
  const starting = send({ type: 'BEGIN_COLLECTION', workspaceId });
  await entered.promise;
  let cancelled;
  const cancellation = send({ type: 'CANCEL_COLLECTION', workspaceId }).then(result => { cancelled = result; return result; });
  for (let i = 0; i < 20 && !cancelled; i++) await tick();
  assert.equal(cancelled?.ok, true, 'Cancellation must not wait for the pending acquisition');
  release.resolve();
  assert.equal((await starting).code, 'stale_collection');
  await cancellation;
  assert.deepEqual(records.get(workspaceId).snapshots, preserved.snapshots);
  assert.equal(sessions['collection:7'], undefined, 'A delayed session write cannot restore the cancelled lease');
  assert.equal(sessions['collection-owner:99'], undefined);
  const next = await send({ type: 'BEGIN_COLLECTION', workspaceId });
  assert.equal(next.ok, true, next.error);
});
