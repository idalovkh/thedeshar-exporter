import { prepareSourceSite } from './src/lib/source-site-registration.js';
import { hydrateSourceOrigins, isTrustedSourceOrigin } from './src/lib/source-origins.js';
import { createSourceNavigation } from './src/lib/source-navigation.js';
import { sourceBookKey } from './src/lib/book-workspaces.js';

const events = [];
let manager, binding;
const canonicalUrl = value => {
  try {
    const url = new URL(value);
    return sourceBookKey(url.href) ? `${url.origin}${url.pathname}` : '';
  } catch { return ''; }
};
for (const name of ['onBeforeNavigate', 'onCommitted', 'onCompleted', 'onErrorOccurred', 'onTabReplaced']) {
  chrome.webNavigation[name].addListener(value => { if (binding?.tabId === value.tabId && value.frameId === 0) events.push({ name, ...value }); });
}
globalThis.sourceNavigationQa = {
  ready: true,
  async connect(tabId) {
    const tab = await chrome.tabs.get(tabId);
    const result = await prepareSourceSite(chrome, tab);
    await hydrateSourceOrigins(chrome);
    return { ...result, otherSiteTrusted: isTrustedSourceOrigin('https://school-two.example'),
      scripts: await chrome.scripting.getRegisteredContentScripts() };
  },
  async start(tabId) {
    await chrome.tabs.sendMessage(tabId, { type: 'CAPTURE_START', captureId: 'fixture-capture-00000001' });
    const { navigation } = await chrome.tabs.sendMessage(tabId, { type: 'MATERIAL_NAVIGATION' });
    if (!navigation?.items?.length) throw Error('The real content adapter did not expose its lesson');
    binding = { tabId, ownerTabId: (await chrome.tabs.getCurrent()).id, workspaceId: 'fixture-workspace',
      collectionId: 'fixture-collection', bookKey: sourceBookKey(navigation.url) };
    manager ||= createSourceNavigation({ chrome, canonicalUrl, bookKey: sourceBookKey,
      authorize: async candidate => {
        if (!binding || candidate.collectionId !== binding.collectionId || candidate.tabId !== binding.tabId) throw Error('Stale fixture collection');
        return () => { if (!binding) throw Error('Cancelled fixture collection'); };
      },
      sendSource: (id, message) => chrome.tabs.sendMessage(id, message),
    });
    manager.remember(tabId, navigation);
    const result = await manager.navigate(binding, { type: 'OPEN_MATERIAL_ITEM', key: navigation.items[0].key,
      expectedUrl: navigation.url, expectedDocumentToken: navigation.documentToken });
    return { ...result, fixtureSessions: await chrome.storage.session.get(null) };
  },
  async status(id) {
    try { return await manager.status(binding, id); }
    catch (error) {
      error.message += JSON.stringify({ binding, sessions: await chrome.storage.session.get(null), events });
      throw error;
    }
  },
  retry: id => manager.retry(binding, id),
  async frame() { return chrome.webNavigation.getFrame({ tabId: binding.tabId, frameId: 0 }); },
  events: () => structuredClone(events),
  async clear() { if (binding) await manager.clear(binding.tabId); binding = null; },
};
