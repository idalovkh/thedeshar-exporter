import { exporterBindingDiagnostic } from './exporter-binding-diagnostics.js';

export function exporterBindingError(cause, operation) {
  return Object.assign(new Error('Не удалось подтвердить связь окна экспортера с выбранной книгой. Закройте это окно и снова нажмите значок exporter во вкладке книги.'), {
    code: 'exporter_binding_mismatch', binding: exporterBindingDiagnostic({ cause, operation }),
  });
}

/** Read our own documents without depending on permission-filtered tabs.Tab.url. */
export function createExporterBinding(chrome) {
  const expected = new URL(chrome.runtime.getURL('exporter.html'));
  const documents = new Map(), revoked = new Map(), revisions = new Map(), loading = new Set();
  const revision = tabId => revisions.get(tabId) || 0;
  const dashboardUrl = value => {
    try {
      const url = new URL(value);
      return url.protocol === expected.protocol && url.host === expected.host && url.pathname === expected.pathname ? url : null;
    } catch { return null; }
  };
  const isDashboard = sender => sender?.id === chrome.runtime.id && Number.isSafeInteger(sender.tab?.id) && sender.tab.id > 0 &&
    sender.frameId === 0 && typeof sender.documentId === 'string' && Boolean(sender.documentId) && Boolean(dashboardUrl(sender.url)) &&
    (sender.documentLifecycle === undefined || sender.documentLifecycle === 'active');
  const matches = (value, sourceTabId, workspaceId) => {
    const url = dashboardUrl(value);
    return Boolean(url && (!workspaceId || url.searchParams.get('workspace') === workspaceId) &&
      (sourceTabId === undefined || url.searchParams.get('tab') === String(sourceTabId)));
  };
  async function read(tabId, operation) {
    if (!Number.isSafeInteger(tabId) || tabId <= 0) throw exporterBindingError('context_missing', operation);
    if (loading.has(tabId)) throw exporterBindingError('document_mismatch', operation);
    const before = revision(tabId);
    let contexts;
    try { contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'], tabIds: [tabId], frameIds: [0] }); }
    catch { throw exporterBindingError('context_lookup_failed', operation); }
    if (before !== revision(tabId)) throw exporterBindingError('document_mismatch', operation);
    if (!Array.isArray(contexts)) throw exporterBindingError('context_lookup_failed', operation);
    const current = contexts.filter(context => context.contextType === 'TAB' && context.tabId === tabId && context.frameId === 0);
    if (!current.length) throw exporterBindingError('context_missing', operation);
    if (current.length !== 1) throw exporterBindingError('context_ambiguous', operation);
    const context = current[0];
    if (typeof context.documentId !== 'string' || !context.documentId || revoked.get(tabId) === context.documentId) {
      throw exporterBindingError('document_mismatch', operation);
    }
    documents.set(tabId, { documentId: context.documentId, url: context.documentUrl });
    return context;
  }
  async function requireOwner(tabId, sourceTabId, workspaceId, { sender, documentId, operation } = {}) {
    if (sender && !isDashboard(sender)) throw exporterBindingError('document_mismatch', operation);
    const context = await read(tabId, operation);
    if (sender && (sender.tab.id !== tabId || sender.documentId !== context.documentId) ||
      documentId && documentId !== context.documentId) throw exporterBindingError('document_mismatch', operation);
    const url = dashboardUrl(context.documentUrl);
    if (!url) throw exporterBindingError('dashboard_url_mismatch', operation);
    if (workspaceId && url.searchParams.get('workspace') !== workspaceId) throw exporterBindingError('workspace_mismatch', operation);
    if (sourceTabId !== undefined && url.searchParams.get('tab') !== String(sourceTabId)) throw exporterBindingError('source_tab_mismatch', operation);
    return { id: tabId, url: url.href, documentId: context.documentId, windowId: context.windowId };
  }
  async function isOwner(tabId, sourceTabId, workspaceId, documentId) {
    try { await requireOwner(tabId, sourceTabId, workspaceId, { documentId }); return true; }
    catch { return false; }
  }
  function invalidate(tabId, change = {}) {
    if (change.status === 'complete') { loading.delete(tabId); return; }
    if (change.status === 'loading') loading.add(tabId);
    const known = documents.get(tabId);
    if (change.status !== 'loading' && change.url && known?.url === change.url) return;
    revisions.set(tabId, revision(tabId) + 1);
    if (known) revoked.set(tabId, known.documentId);
    documents.delete(tabId);
  }
  return Object.freeze({ isDashboard, matches, requireOwner, isOwner, invalidate,
    navigationStarted(tabId) { invalidate(tabId, { status: 'loading' }); } });
}
