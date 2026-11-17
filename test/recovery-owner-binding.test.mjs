import assert from 'node:assert/strict';
import test from 'node:test';
import { createExporterBinding } from '../src/lib/exporter-binding.js';
import { createSourceTabRecovery } from '../src/lib/source-tab-recovery.js';

test('authorized history changes retain the owner but a real navigation revokes its document', async () => {
  let url = 'chrome-extension://extension/exporter.html?workspace=workspace&tab=7';
  const journal = { oldTabId: 7, newTabId: 8, workspaceId: 'workspace', ownerTabId: 99,
    phase: 'prepared', lease: { ownerDocumentId: 'owner-document' } };
  const chrome = { runtime: { id: 'extension', getURL: value => `chrome-extension://extension/${value}`,
    getContexts: async () => [{ contextType: 'TAB', frameId: 0, tabId: 99, documentId: 'owner-document', documentUrl: url }] },
    storage: { session: { get: async key => ({ [key]: journal }) } } };
  const binding = createExporterBinding(chrome);
  const recovery = createSourceTabRecovery({ chrome, exporterBinding: binding });
  await binding.requireOwner(99, 7, 'workspace');
  url = url.replace('tab=7', 'tab=8');
  assert.equal(await recovery.acceptsOwnerUrl(99, { status: 'loading', url }), true);
  await binding.requireOwner(99, 8, 'workspace');
  binding.navigationStarted(99);
  assert.equal(await recovery.acceptsOwnerUrl(99, { status: 'loading', url }), false);
  await assert.rejects(binding.requireOwner(99, 8, 'workspace'), { code: 'exporter_binding_mismatch' });
});
