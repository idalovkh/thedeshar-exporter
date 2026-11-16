/** Model Chrome's live extension documents independently of cached MessageSender URLs. */
export function createExporterContextFixture(chrome) {
  const documents = new Map();
  const origin = chrome.runtime.getURL('');
  const documentIdFor = tab => {
    if (tab.documentId) return tab.documentId;
    let document = documents.get(tab.id);
    if (!document || document.url !== tab.url) {
      document = { url: tab.url, generation: (document?.generation || 0) + 1 };
      documents.set(tab.id, document);
    }
    return `exporter-document-${tab.id}-${document.generation}`;
  };
  chrome.runtime.getContexts = async ({ contextTypes, tabIds = [], frameIds } = {}) => {
    if (contextTypes && !contextTypes.includes('TAB') || frameIds && !frameIds.includes(0)) return [];
    const contexts = [];
    for (const tabId of tabIds) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab || !tab.url?.startsWith(origin)) continue;
      contexts.push({ contextType: 'TAB', tabId, frameId: 0, documentId: documentIdFor(tab),
        documentUrl: tab.url, ...(tab.windowId !== undefined ? { windowId: tab.windowId } : {}) });
    }
    return contexts;
  };
  return sender => {
    if (!Number.isInteger(sender?.tab?.id) || !sender.url?.startsWith('chrome-extension://')) return sender;
    return { frameId: 0, documentId: documentIdFor(sender.tab), ...sender };
  };
}
