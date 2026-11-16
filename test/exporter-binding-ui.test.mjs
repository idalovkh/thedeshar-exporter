import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { isSourceUrl } from '../src/lib/state.js';
import { getView } from '../src/ui/view.js';
import { exportReadiness } from '../src/lib/export-readiness.js';
import { collectionFailureNotice, sourceConnectionView } from '../src/ui/source-status-view.js';
import { navigationErrorCode } from '../src/lib/source-navigation-errors.js';
import { navigationDiagnostic } from '../src/lib/navigation-diagnostics.js';
import { exporterBindingDiagnostic } from '../src/lib/exporter-binding-diagnostics.js';

const source = (await readFile(new URL('../src/ui/exporter.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '');
const html = await readFile(new URL('../exporter.html', import.meta.url), 'utf8');
const dashboardUrl = 'chrome-extension://test-extension/exporter.html';
const bookUrl = 'https://progressme.ru/cabinet/school/materials/book/71/content';
const resolvedWorkspace = { ok: true, workspaceId: 'workspace-71', sourceTabId: 7,
  bookKey: 'https://progressme.ru/book/71', book: { title: 'Book', rootUrl: bookUrl } };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle() { for (let index = 0; index < 5; index++) await tick(); }

class Element {
  constructor(id) {
    this.id = id; this.dataset = {}; this.style = {}; this.children = []; this.attributes = new Map();
    this.classList = { toggle() {} };
  }
  addEventListener() {}
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  toggleAttribute(name, enabled) { if (enabled) this.setAttribute(name, ''); else this.removeAttribute(name); }
  querySelector() { return this.step ||= new Element(); }
  replaceChildren(...children) { this.children = children; }
}

async function dashboard({ href = `${dashboardUrl}?tab=7`, resolved = resolvedWorkspace,
  getCurrent = async () => ({ id: 20 }), onRequest } = {}) {
  const elements = [...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => new Element(id));
  const requests = [], replacements = [], historyChanges = [], tabUpdates = [], events = [];
  const location = { href, replace(url) { replacements.push(String(url)); this.href = String(url); } };
  const chrome = {
    runtime: { getManifest: () => ({ version: '0.3.41' }), onMessage: { addListener() {} },
      async sendMessage(message) {
        requests.push(structuredClone(message));
        const intercepted = onRequest?.(message);
        if (intercepted !== undefined) return intercepted;
        if (message.type === 'RESOLVE_WORKSPACE') return resolved;
        if (message.type === 'GET_STATE') return { ok: true, state: { snapshots: [], captures: [], warnings: [] } };
        if (message.type === 'GET_SOURCE_STATUS') return { ok: true, sourceStatus: { state: 'same_book' } };
        if (message.type === 'GET_SOURCE') return { ok: true, source: { tabId: 7, url: bookUrl } };
        if (message.type === 'GET_NAVIGATION') return { ok: true, navigation: { kind: 'book', url: bookUrl, title: 'Book' } };
        return { ok: true };
      } },
    tabs: { getCurrent, update: async (id, options) => { tabUpdates.push({ id, ...options }); },
      onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
    permissions: { contains: async () => true },
  };
  const context = vm.createContext({ chrome, location, URL, Intl, structuredClone,
    document: { querySelectorAll: () => elements, addEventListener() {} }, window: { addEventListener() {} },
    history: { replaceState(_state, _unused, url) { historyChanges.push(String(url)); location.href = String(url); } },
    setTimeout: () => 1, clearTimeout() {}, hydrateSourceOrigins: async () => {},
    createProblemReporter: () => ({ select() {}, clear() {}, available: () => false, load: async () => {},
      connectionRecovered() {}, record(event) { events.push(structuredClone(event)); } }),
    getView, isSourceUrl, exportReadiness, sourceConnectionView, navigationErrorCode, navigationDiagnostic,
    exporterBindingDiagnostic, collectAssets: () => [], mediaOrigins: () => [],
  });
  vm.runInContext(source, context, { filename: 'exporter.js' });
  await settle();
  return { context, requests, replacements, historyChanges, tabUpdates, events, location };
}

test('legacy dashboard startup replaces the document before any workspace reads', async () => {
  const app = await dashboard();
  assert.deepEqual(app.replacements, [`${dashboardUrl}?tab=7&workspace=workspace-71`]);
  assert.deepEqual(app.requests.map(message => message.type), ['RESOLVE_WORKSPACE']);
  assert.equal(vm.runInContext('selectionGeneration', app.context), 0, 'the old document must not adopt the workspace');
  assert.deepEqual(app.historyChanges, []);
});

test('a canonical dashboard document initializes without reloading or changing history', async () => {
  const app = await dashboard({ href: `${dashboardUrl}?tab=7&workspace=workspace-71` });
  assert.deepEqual(app.replacements, []);
  assert.deepEqual(app.historyChanges, []);
  const read = app.requests.find(message => message.type === 'GET_STATE');
  assert.equal(read.workspaceId, 'workspace-71');
  assert.equal(read.tabId, 7);
});

test('resolved source and workspace replace stale query bindings before reading state', async () => {
  const app = await dashboard({ href: `${dashboardUrl}?workspace=old-workspace&tab=8` });
  assert.deepEqual(app.replacements, [`${dashboardUrl}?workspace=workspace-71&tab=7`]);
  assert.deepEqual(app.requests.map(message => message.type), ['RESOLVE_WORKSPACE']);
});

test('workspace-only startup adds its resolved source while a missing source uses the requested tab', async () => {
  const scoped = await dashboard({ href: `${dashboardUrl}?workspace=workspace-71` });
  assert.deepEqual(scoped.replacements, [`${dashboardUrl}?workspace=workspace-71&tab=7`]);
  const fallback = await dashboard({ resolved: { ...resolvedWorkspace, sourceTabId: undefined } });
  assert.deepEqual(fallback.replacements, [`${dashboardUrl}?tab=7&workspace=workspace-71`]);
});

test('an existing owner receives focus before redirecting or selecting a workspace', async () => {
  const app = await dashboard({ resolved: { ...resolvedWorkspace, ownerTabId: 21 } });
  assert.deepEqual(app.tabUpdates, [{ id: 21, active: true }]);
  assert.deepEqual(app.replacements, []);
  assert.deepEqual(app.requests.map(message => message.type), ['RESOLVE_WORKSPACE']);
});

test('the current owner canonicalizes its own document', async () => {
  const app = await dashboard({ resolved: { ...resolvedWorkspace, ownerTabId: 20 } });
  assert.deepEqual(app.tabUpdates, []);
  assert.deepEqual(app.replacements, [`${dashboardUrl}?tab=7&workspace=workspace-71`]);
});

test('a late owner lookup cannot redirect a newer selection', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const app = await dashboard({ resolved: { ...resolvedWorkspace, ownerTabId: 20 }, getCurrent: () => pending });
  vm.runInContext('selectionGeneration++', app.context);
  finish({ id: 20 });
  await settle();
  assert.deepEqual(app.replacements, []);
  assert.deepEqual(app.requests.map(message => message.type), ['RESOLVE_WORKSPACE']);
});

test('binding mismatches reach connection diagnostics with sanitized background context', async () => {
  const app = await dashboard({ href: `${dashboardUrl}?tab=7&workspace=workspace-71`, onRequest(message) {
    if (message.type === 'GET_STATE') return { ok: false, code: 'exporter_binding_mismatch', error: 'Connection changed',
      binding: { cause: 'workspace_mismatch', operation: 'GET_STATE', url: 'https://private.example?token=secret', workspaceId: 'private' } };
  } });
  assert.equal(app.events.length, 1);
  assert.equal(app.events[0].reason, 'exporter_binding_mismatch');
  assert.deepEqual(app.events[0].binding, { cause: 'workspace_mismatch', operation: 'GET_STATE' });
  assert.doesNotMatch(JSON.stringify(app.events), /private|secret|url|workspaceId/);
  assert.match(collectionFailureNotice({ diagnostics: { failure: { reason: app.events[0].reason } } }),
    /Окно экспортёра потеряло привязку к книге.*снова нажмите значок exporter/);
});

test('invented binding causes never enter UI diagnostics', async () => {
  const app = await dashboard({ href: `${dashboardUrl}?tab=7&workspace=workspace-71`, onRequest(message) {
    if (message.type === 'GET_STATE') return { ok: false, code: 'exporter_binding_mismatch',
      binding: { cause: 'private-cause', operation: 'GET_STATE' } };
  } });
  assert.equal(app.events[0].binding, undefined);
});
