import assert from 'node:assert/strict';
import { installBackground } from '../src/background.js';
import { createWorkspace } from '../src/lib/state.js';

export const bookUrl = id => `https://progressme.ru/cabinet/school/materials/book/${id}/content`;
export const dashboardUrl = (workspace, tab = 7) => `chrome-extension://extension/exporter.html?workspace=${workspace}&tab=${tab}`;
export const tick = () => new Promise(resolve => setImmediate(resolve));
export function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

export function bindingBackground() {
  const sessions = {}, records = new Map(), calls = [];
  const tabs = new Map([[7, { id: 7, url: bookUrl(71) }], [8, { id: 8, url: bookUrl(81) }],
    [99, { id: 99, url: 'chrome-extension://extension/exporter.html?tab=7', documentId: 'owner-document-99' }],
    [100, { id: 100, url: 'chrome-extension://extension/exporter.html?tab=8', documentId: 'owner-document-100' }]]);
  let listener, lookup, updated, removed, clicked;
  const contexts = ({ tabIds = [] } = {}) => [...tabs.values()]
    .filter(tab => tabIds.includes(tab.id) && tab.url.startsWith('chrome-extension://extension/'))
    .map(tab => ({ contextType: 'TAB', tabId: tab.id, frameId: 0, documentId: tab.documentId,
      documentUrl: tab.url, windowId: 1 }));
  const chrome = {
    runtime: { id: 'extension', getURL: value => `chrome-extension://extension/${value}`,
      getContexts: async filter => lookup ? lookup(filter, contexts(filter)) : contexts(filter),
      onMessage: { addListener: callback => { listener = callback; } }, sendMessage: async () => {} },
    storage: { session: { get: async key => ({ [key]: sessions[key] }),
      set: async value => Object.assign(sessions, structuredClone(value)), remove: async key => { delete sessions[key]; } } },
    action: { onClicked: { addListener: callback => { clicked = callback; } } },
    tabs: { onUpdated: { addListener: callback => { updated = callback; } }, onRemoved: { addListener: callback => { removed = callback; } },
      get: async id => {
        const tab = tabs.get(id);
        if (!tab) throw new Error('Closed');
        // Chrome 148 hides metadata for extension pages without the tabs permission.
        return tab.url.startsWith('chrome-extension:') ? { id, windowId: 1 } : { ...tab };
      },
      update: async (id, patch) => { calls.push({ type: 'update', id, ...patch }); Object.assign(tabs.get(id), patch); },
      create: async ({ url }) => { const tab = { id: 200 + tabs.size, url, documentId: 'created-owner-document' }; tabs.set(tab.id, tab); return tab; },
      sendMessage: async (id, message) => { calls.push({ id, ...message }); return { ok: true, captureId: message.captureId,
        navigation: { kind: 'book', url: tabs.get(id)?.url, documentToken: 'source-document-0001' } }; } },
  };
  const install = () => installBackground(chrome, {
    readWorkspace: async id => structuredClone(records.get(id) || createWorkspace(id)),
    updateWorkspace: async (id, updater) => { const state = updater(structuredClone(records.get(id) || createWorkspace(id))); records.set(id, state); return state; },
  });
  install();
  const sender = id => {
    const tab = tabs.get(id);
    return { id: 'extension', url: tab.url, documentId: tab.documentId, documentLifecycle: 'active', frameId: 0, tab: { id } };
  };
  const send = (message, id = 99, override = {}) => new Promise(resolve => {
    const pending = listener({ tabId: 7, ...message }, { ...sender(id), ...override }, resolve);
    if (!pending) resolve(undefined);
  });
  return { chrome, tabs, sessions, records, calls, contexts, send, sender, restart: install,
    setLookup: value => { lookup = value; }, click: id => clicked(tabs.get(id)),
    async resolve(tabId = 7, id = 99) {
      const result = await send({ type: 'RESOLVE_WORKSPACE', tabId }, id);
      assert.equal(result.ok, true, result.error);
      tabs.get(id).url = dashboardUrl(result.workspaceId, result.sourceTabId);
      return result.workspaceId;
    },
    navigate(id, url, documentId) {
      updated(id, { status: 'loading' }, { id });
      Object.assign(tabs.get(id), { url, documentId });
      updated(id, { status: 'complete' }, { id });
    },
    remove(id) { removed(id); tabs.delete(id); },
  };
}
