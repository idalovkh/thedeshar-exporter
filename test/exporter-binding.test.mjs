import assert from 'node:assert/strict';
import test from 'node:test';
import { createExporterBinding } from '../src/lib/exporter-binding.js';

const url = 'chrome-extension://extension/exporter.html?workspace=book-A&tab=7';
function fixture() {
  let contexts = [{ contextType: 'TAB', tabId: 99, frameId: 0, documentId: 'current-document', documentUrl: url }];
  let lookup;
  const calls = [];
  const chrome = { runtime: { id: 'extension', getURL: value => `chrome-extension://extension/${value}`,
    getContexts: async filter => { calls.push(filter); return lookup ? lookup() : structuredClone(contexts); } } };
  const binding = createExporterBinding(chrome);
  const sender = { id: 'extension', frameId: 0, documentId: 'current-document', documentLifecycle: 'active', url, tab: { id: 99 } };
  return { binding, sender, calls, setContexts: value => { contexts = value; }, setLookup: value => { lookup = value; },
    require: (options = {}) => binding.requireOwner(99, 7, 'book-A', { sender, operation: 'GET_STATE', ...options }) };
}

test('own context identity is checked without querying tabs metadata and is never cached as permission', async () => {
  const app = fixture();
  const owner = await app.require();
  assert.equal(owner.url, url);
  assert.equal(owner.documentId, app.sender.documentId);
  assert.deepEqual(app.calls[0], { contextTypes: ['TAB'], tabIds: [99], frameIds: [0] });
  app.setContexts([]);
  await assert.rejects(app.require(), { code: 'exporter_binding_mismatch', binding: { cause: 'context_missing', operation: 'GET_STATE' } });
  assert.equal(app.calls.length, 2);
});

for (const patch of [{ id: 'foreign-extension' }, { frameId: 1 }, { documentId: undefined },
  { documentId: 'old-document' }, { documentLifecycle: 'cached' }, { documentLifecycle: 'pending_deletion' },
  { url: url.replace('exporter.html', 'exporter.html-other') }, { url: 'https://example.test/exporter.html' }]) {
  test(`untrusted sender metadata is refused: ${JSON.stringify(patch)}`, async () => {
    const app = fixture();
    await assert.rejects(app.require({ sender: { ...app.sender, ...patch } }), { code: 'exporter_binding_mismatch' });
  });
}

test('a browser context must match the exact extension resource and workspace', async () => {
  for (const [documentUrl, cause] of [[url.replace('extension/', 'foreign/'), 'dashboard_url_mismatch'],
    [url.replace('exporter.html', 'other.html'), 'dashboard_url_mismatch'],
    [url.replace('book-A', 'book-B'), 'workspace_mismatch']]) {
    const app = fixture();
    app.setContexts([{ contextType: 'TAB', tabId: 99, frameId: 0, documentId: 'current-document', documentUrl }]);
    await assert.rejects(app.require(), { binding: { cause, operation: 'GET_STATE' } });
  }
});

test('legacy source-tab binding remains strict and independent of another book workspace', async () => {
  const app = fixture(), legacy = 'chrome-extension://extension/exporter.html?tab=7';
  app.setContexts([{ contextType: 'TAB', tabId: 99, frameId: 0, documentId: 'current-document', documentUrl: legacy }]);
  assert.equal(await app.binding.isOwner(99, 7), true);
  assert.equal(await app.binding.isOwner(99, 8), false);
  assert.equal(await app.binding.isOwner(99, 7, 'book-A'), false);
});

test('navigation revokes an observed document even if Chrome still exposes its old context', async () => {
  const app = fixture();
  await app.require();
  app.binding.invalidate(99, { status: 'loading' });
  await assert.rejects(app.require(), { binding: { cause: 'document_mismatch', operation: 'GET_STATE' } });
  app.setContexts([{ contextType: 'TAB', tabId: 99, frameId: 0, documentId: 'replacement-document', documentUrl: url }]);
  assert.equal(await app.binding.isOwner(99, 7, 'book-A'), false, 'A replacement is not authorized while its navigation is loading');
  app.binding.invalidate(99, { status: 'complete' });
  assert.equal(await app.binding.isOwner(99, 7, 'book-A'), true);
  assert.equal(await app.binding.isOwner(99, 7, 'book-A', 'current-document'), false);
  await assert.rejects(app.require(), { binding: { cause: 'document_mismatch', operation: 'GET_STATE' } });
});

test('navigation during a context lookup rejects its late reply', async () => {
  const app = fixture();
  let release;
  app.setLookup(() => new Promise(resolve => { release = resolve; }));
  const checking = app.require();
  app.binding.invalidate(99, { status: 'loading' });
  release([{ contextType: 'TAB', tabId: 99, frameId: 0, documentId: 'current-document', documentUrl: url }]);
  await assert.rejects(checking, { binding: { cause: 'document_mismatch', operation: 'GET_STATE' } });
});

test('duplicate unchanged URL events do not revoke a live document', async () => {
  const app = fixture();
  await app.require();
  app.binding.invalidate(99, { url });
  assert.equal(await app.binding.isOwner(99, 7, 'book-A'), true);
});

test('navigation before the first context lookup blocks an old document while loading', async () => {
  const app = fixture();
  app.binding.invalidate(99, { status: 'loading' });
  await assert.rejects(app.require(), { binding: { cause: 'document_mismatch', operation: 'GET_STATE' } });
  app.setContexts([{ contextType: 'TAB', tabId: 99, frameId: 0, documentId: 'replacement-document', documentUrl: url }]);
  app.binding.invalidate(99, { status: 'complete' });
  assert.equal(await app.binding.isOwner(99, 7, 'book-A'), true);
});

test('a scoped window cannot substitute another source tab in a request', async () => {
  const app = fixture();
  await assert.rejects(app.binding.requireOwner(99, 8, 'book-A', { sender: app.sender, operation: 'GET_SOURCE' }), {
    binding: { cause: 'source_tab_mismatch', operation: 'GET_SOURCE' },
  });
});
