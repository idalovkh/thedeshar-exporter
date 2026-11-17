import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createWorkspace, isSourceUrl } from '../src/lib/state.js';
import { buildCoverage } from '../src/lib/coverage.js';
import { collectAssets, mediaOrigins, downloadMediaAssets } from '../src/ui/assets.js';
import { getView } from '../src/ui/view.js';
import { archiveFilename } from '../src/lib/download-name.js';
import { createExportPackage, replacePackageAssets, assertAssetCapacity, MAX_ASSETS } from '../src/lib/package.js';
import { buildZipBlob, MAX_ARCHIVE_BYTES } from '../src/lib/archive.js';
import { prepareDiskExport } from '../src/ui/export-record-stream.js';
import { writeZipFile } from '../src/lib/archive-stream.js';
import { memoryExportSpool, memorySavePicker } from './export-file-fixture.js';
import { createExportResources } from '../src/lib/export-resources.js';
import { exportReadiness, assertExportReady, assertExportFilesReady } from '../src/lib/export-readiness.js';
import { exportFileProblems } from '../src/lib/export-file-problems.js';
import { appendProblemEvent, createProblemReport, legacyProblemReport, problemReportForDownload, problemReportUrl, projectProblemEvent } from '../src/lib/problem-report.js';
import { sourceConnectionView, collectionLoadingDetail, collectionFailureNotice, sourceSetupMessage } from '../src/ui/source-status-view.js';
import { diagnosticPageUrl } from '../src/lib/collection-diagnostics.js';
import { navigationErrorCode } from '../src/lib/source-navigation-errors.js';
import { navigationDiagnostic } from '../src/lib/navigation-diagnostics.js';
import { exporterBindingDiagnostic } from '../src/lib/exporter-binding-diagnostics.js';
import { createSourceReplacement } from '../src/ui/source-replacement.js';

// Execute the shipping dashboard code. Only the browser/extension boundary is
// faked, so these tests exercise its listeners, rendered state and async guards.
const dashboardSource = (await readFile(new URL('../src/ui/exporter.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
const problemReportSource = (await readFile(new URL('../src/ui/problem-report.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const dashboardHtml = await readFile(new URL('../exporter.html', import.meta.url), 'utf8');
const bookUrl = id => `https://progressme.ru/cabinet/school/materials/book/${id}/content`;
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle() { for (let i = 0; i < 5; i++) await tick(); }
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class Element {
  constructor(id = '') {
    this.id = id; this.children = []; this.hidden = false; this.disabled = false; this.open = false; this.modalCount = 0;
    this.textContent = ''; this.dataset = {}; this.style = {}; this.attributes = new Map(); this.listeners = new Map();
    const classes = new Set();
    this.classList = { toggle(name, force) { if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); }, contains(name) { return classes.has(name); } };
  }
  addEventListener(type, callback) { this.listeners.set(type, [...(this.listeners.get(type) || []), callback]); }
  removeEventListener(type, callback) { this.listeners.set(type, (this.listeners.get(type) || []).filter(value => value !== callback)); }
  async click() { if (!this.disabled && !this.hidden) await Promise.all((this.listeners.get('click') || []).map(callback => callback({ target: this }))); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  querySelector(selector) { if (selector === '.step-number') return this.stepNumber ||= new Element(); return null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  toggleAttribute(name, force) { if (force ?? !this.hasAttribute(name)) this.setAttribute(name, ''); else this.removeAttribute(name); }
  showModal() { this.open = true; this.modalCount++; queueMicrotask(() => this.close()); }
  close() { this.open = false; for (const callback of [...(this.listeners.get('close') || [])]) callback(); }
  focus() {}
  remove() {}
}

function failedWorkspace() {
  return { ...createWorkspace(7),
    snapshots: [{ url: bookUrl(71), title: 'Old textbook', route: { kind: 'material' }, assets: [], warnings: [] }],
    captures: [], warnings: ['Old capture warning'], dropped: 3,
    collection: { status: 'failed', rootUrl: bookUrl(71), title: 'Old textbook', items: [], failed: [{ error: 'Old source failure' }], warnings: [] } };
}

function finishedWorkspace() {
  const state = failedWorkspace();
  const url = 'https://progressme.ru/lesson-editor/book/71/lesson/5/section/6';
  state.dropped = 0;
  state.warnings = [];
  state.snapshots.push({ url, title: 'First section', route: { kind: 'lesson' }, blocks: [{ type: 'dom', text: 'Exercise' }], assets: [], warnings: [] });
  state.captures = [{ kind: 'websocket', url: 'wss://proxy.progressme.ru/websocket', pageUrl: url, data: {
    Class: 'GetExerciseWsController', Method: 'LoadExercises', IsSuccess: true, Value: { SectionId: 6, Items: [] },
  } }];
  state.collection = { status: 'finished', rootUrl: bookUrl(71), title: 'Old textbook',
    expected: [bookUrl(71), url], visited: [bookUrl(71), url], failed: [], warnings: [], items: [
      { key: 'lesson-5', kind: 'lesson', lessonId: '5', url, status: 'visited' },
      { key: 'section-6', kind: 'section', lessonId: '5', url, status: 'visited' },
    ] };
  return state;
}

async function dashboard({ state = failedWorkspace(), selectedTabId = 7, workspaceId = null, confirm = true, onRequest, collectBook = async () => { throw new Error('Unexpected collection'); }, permission, allowDownload = false, makeFilename = archiveFilename, downloadFiles = downloadMediaAssets, sourceUrl = bookUrl(71) } = {}) {
  const elements = Object.fromEntries([...dashboardHtml.matchAll(/<[a-z][^>]*\bid="([^"]+)"[^>]*>/gi)].map(([tag, id]) => {
    const element = new Element(id);
    element.hidden = /\shidden(?:\s|=|>)/.test(tag);
    element.disabled = /\sdisabled(?:\s|=|>)/.test(tag);
    return [id, element];
  }));
  const location = { href: `chrome-extension://test-extension/exporter.html${selectedTabId === null ? '' : `?tab=${selectedTabId}`}` };
  if (workspaceId) { const url = new URL(location.href); url.searchParams.set('workspace', workspaceId); location.href = url.href; }
  const requests = [], confirmations = [], permissionRequests = [], downloads = [], tabUpdates = [], tabQueries = [], timers = new Map(), listeners = new Map(), records = new Map([[7, structuredClone(state)]]);
  const tabs = [
    { id: 7, title: 'Old textbook — ProgressMe', url: sourceUrl },
    { id: 8, title: 'New textbook — ProgressMe', url: bookUrl(81) },
    { id: 9, title: 'Unrelated', url: 'https://progressme.ru/cabinet/school/students' },
    { id: 10, title: 'Wrong host', url: 'https://progressme.ru.evil.example/cabinet/school/materials/book/12/content' },
    { id: 11, title: 'Non-book materials', url: 'https://progressme.ru/cabinet/school/materials' },
    { id: 12, title: 'Credentials', url: 'https://user:password@progressme.ru/cabinet/school/materials/book/12/content' },
  ];
  const runtimeListeners = [], sourceUpdates = [], sourceRemovals = [];
  let timerId = 0;
  const chrome = {
    runtime: { getManifest: () => ({ version: '0.3.16' }), onMessage: { addListener(callback) { runtimeListeners.push(callback); } }, async sendMessage(message) {
      requests.push(structuredClone(message));
      const intercepted = onRequest?.(message, { records, requests, tabs });
      if (intercepted !== undefined) return intercepted;
      const id = message.tabId;
      const current = () => records.get(id) || createWorkspace(id);
      if (message.type === 'GET_STATE') return { ok: true, state: { ...structuredClone(current()), exportRevision: current().exportRevision ?? 0, enabled: Boolean(current().enabled), collectionLocked: Boolean(current().collectionLocked) } };
      if (message.type === 'GET_EXPORT_INFO') return { ok: true, revision: current().exportRevision ?? 0,
        snapshotCount: current().snapshots.length, captureCount: current().captures.length };
      if (message.type === 'GET_EXPORT_RECORDS') {
        const state = current(), revision = state.exportRevision ?? 0;
        if (message.revision !== revision) return { ok: false, code: 'export_changed', error: 'Fixture source changed' };
        const records = state[message.kind], batch = records.slice(message.offset, message.offset + message.limit);
        return { ok: true, revision, total: records.length, records: structuredClone(batch), nextOffset: message.offset + batch.length };
      }
      if (message.type === 'GET_SOURCE') {
        const tab = tabs.find(tab => tab.id === id);
        return tab ? { ok: true, source: { tabId: id, url: tab.url, title: tab.title } } : { ok: false, code: 'source_closed', error: 'Closed source' };
      }
      if (message.type === 'GET_NAVIGATION') {
        const tab = tabs.find(tab => tab.id === id);
        const page = value => { const url = new URL(value); return url.origin + url.pathname; };
        if (message.expectedUrl && page(message.expectedUrl) !== page(tab.url)) return { ok: false, code: 'source_changed', error: 'Source changed' };
        return { ok: true, navigation: { kind: tab.url.includes('/lesson-editor/') ? 'lesson' : 'book', url: tab.url,
          title: tab.bookTitle || (id === 7 ? 'Old textbook' : 'New textbook') } };
      }
      if (message.type === 'CLEAR_CAPTURE') records.set(id, createWorkspace(id));
      else if (message.type === 'SAVE_COLLECTION') records.set(id, { ...current(), collection: structuredClone(message.collection) });
      else if (message.type === 'START_CAPTURE') records.set(id, { ...current(), enabled: true });
      else if (message.type === 'STOP_CAPTURE' || message.type === 'END_COLLECTION') records.set(id, { ...current(), enabled: false });
      return { ok: true };
    } },
    tabs: { onRemoved: { addListener: callback => sourceRemovals.push(callback) }, onUpdated: { addListener: callback => sourceUpdates.push(callback) }, query: async options => { tabQueries.push(options); return tabs.map(tab => ({ ...tab })); }, update: async (id, options) => { tabUpdates.push({ id, ...options }); if (options.url) tabs.find(tab => tab.id === id).url = options.url; } },
    permissions: { request: request => { permissionRequests.push(request); return permission || Promise.resolve(true); }, contains: async () => !permission },
  };
  const context = vm.createContext({
    document: { querySelectorAll: () => Object.values(elements), createElement(tag) {
      const element = new Element();
      if (tag === 'a') downloads.push(element);
      return element;
    }, body: new Element(), addEventListener() {}, hidden: false },
    window: { addEventListener(type, callback) { listeners.set(type, callback); } },
    chrome, location, history: { replaceState(_state, _unused, url) { location.href = String(url); } },
    confirm(message) { confirmations.push(message); return confirm; },
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); },
    URL, Intl, AbortController, DOMException, structuredClone, Blob, crypto: globalThis.crypto, createSourceReplacement,
    showSaveFilePicker: memorySavePicker(downloads), createExportSpool: async () => memoryExportSpool(), prepareDiskExport, writeZipFile, createExportResources,
    appendProblemEvent, createProblemReport, legacyProblemReport, problemReportForDownload, problemReportUrl, projectProblemEvent,
    getView, isSourceUrl, buildCoverage, exportReadiness, assertExportReady, assertExportFilesReady, exportFileProblems, collectAssets, mediaOrigins, collectBook, archiveFilename: makeFilename, assertAssetCapacity, downloadExportMedia: downloadFiles, MAX_ARCHIVE_BYTES, replacePackageAssets,
    sourceConnectionView, collectionLoadingDetail, collectionFailureNotice, sourceSetupMessage, diagnosticPageUrl, navigationErrorCode, navigationDiagnostic, exporterBindingDiagnostic, hydrateSourceOrigins: async () => {},
    createExportPackage: allowDownload ? createExportPackage : () => { throw new Error('An aborted download must not assemble an archive'); },
    buildZipBlob: allowDownload ? buildZipBlob : () => { throw new Error('An aborted download must not assemble an archive'); },
  });
  vm.runInContext(problemReportSource, context, { filename: 'problem-report.js' });
  vm.runInContext(dashboardSource, context, { filename: 'exporter.js' });
  await settle();
  return {
    elements, records, requests, confirmations, permissionRequests, downloads, tabUpdates, tabQueries, location,
    async forceExportClick() {
      await Promise.all((elements.export.listeners.get('click') || []).map(callback => callback({ target: elements.export })));
      await settle();
    },
    changeSource(id, update) {
      const tab = tabs.find(item => item.id === id); Object.assign(tab, update);
      sourceUpdates.forEach(callback => callback(id, { url: tab.url, title: tab.title }, { ...tab }));
    },
    closeSource(id = selectedTabId) {
      const index = tabs.findIndex(tab => tab.id === id);
      if (index >= 0) tabs.splice(index, 1);
      sourceRemovals.forEach(callback => callback(id));
    },
    async refresh() {
      listeners.get('focus')?.();
      for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
      await settle();
    },
    notify() { runtimeListeners.forEach(callback => callback({ type: 'STATE_CHANGED', tabId: selectedTabId })); },
  };
}

test('the page has only collection, download, cancellation and error report controls', async () => {
  const app = await dashboard({ state: createWorkspace(7) });
  for (const id of ['open-source', 'return-to-book', 'reconnect-source', 'reset-book', 'repeat-collection', 'additional-actions']) {
    assert.equal(app.elements[id], undefined, `${id} is no longer a user action`);
  }
  assert.equal(app.elements['collect-book'].hidden, false);
  assert.equal(app.elements['download-diagnostics'].hidden, true);
});

test('a blocked book shows its reason and offers a report before collection starts', async () => {
  let blocked = true;
  const app = await dashboard({ state: createWorkspace(7), onRequest(message) {
    if (message.type === 'GET_NAVIGATION') return { ok: true, navigation: {
      kind: 'book', url: bookUrl(71), title: 'Old textbook', blocked, blockedReasonCode: blocked ? 'search_active' : undefined,
    } };
  } });

  assert.equal(app.elements['collection-title'].textContent, 'Сбор книги заблокирован');
  assert.match(app.elements['collection-status'].textContent, /Очистите фильтр/);
  assert.equal(app.elements['collect-book'].disabled, true);
  assert.equal(app.elements['download-diagnostics'].hidden, false);
  await app.refresh();
  await app.elements['download-diagnostics'].click();
  const reportUrl = app.downloads[0].href;
  try {
    const report = await (await fetch(reportUrl)).json();
    const failures = report.events.filter(event => event.reason === 'navigation_blocked');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].stage, 'book');
    assert.equal(failures[0].blockedReasonCode, 'search_active');
  } finally {
    URL.revokeObjectURL(reportUrl);
  }

  blocked = false;
  await app.refresh();
  assert.equal(app.elements['collection-title'].textContent, 'Книга готова к сбору');
  assert.equal(app.elements['collect-book'].disabled, false);
});

test('a lesson button blocker includes the card position and candidate counts in its report', async () => {
  const lessonButton = { cardIndex: 6, desktopVisible: 0, mobileVisible: 1, cause: 'icon' };
  const app = await dashboard({ state: createWorkspace(7), onRequest(message) {
    if (message.type === 'GET_NAVIGATION') return { ok: true, navigation: {
      kind: 'book', url: bookUrl(71), title: 'Old textbook', blocked: true, blockedReasonCode: 'lesson_button', lessonButton,
    } };
  } });
  await app.elements['download-diagnostics'].click();
  const reportUrl = app.downloads[0].href;
  try {
    const report = await (await fetch(reportUrl)).json();
    assert.deepEqual(report.events.at(-1).lessonButton, lessonButton);
  } finally {
    URL.revokeObjectURL(reportUrl);
  }
});

test('closing the source explains restarting from the book without losing its title or retained data', async () => {
  const app = await dashboard({ state: { ...createWorkspace(7), book: { title: 'Known book', rootUrl: bookUrl(71) } } });
  const before = structuredClone(app.records.get(7));
  app.closeSource();
  assert.equal(app.elements['collection-title'].textContent, 'Связь с книгой потеряна');
  await app.refresh();
  assert.equal(app.elements['source-name'].textContent, 'Known book');
  assert.match(app.elements['collection-status'].textContent, /вкладка.*закрыта/i);
  assert.match(app.elements['collection-status'].textContent, /Откройте книгу повторно.*нажмите значок exporter/);
  assert.match(app.elements['action-hint'].textContent, /Эту страницу.*закройте/);
  assert.equal(app.elements['collect-book'].hidden, true);
  assert.equal(app.elements['download-diagnostics'].hidden, true, 'Closing an idle source is not a failed collection');
  assert.doesNotMatch(app.elements['action-hint'].textContent, /Вернитесь сюда/);
  assert.deepEqual(app.records.get(7), before);
});

test('a closed source still permits downloading a completed book before closing the exporter', async () => {
  const app = await dashboard({ state: finishedWorkspace(), allowDownload: true });
  app.closeSource(); await app.refresh();
  assert.equal(app.elements['collection-title'].textContent, 'Связь с книгой потеряна');
  assert.equal(app.elements.export.hidden, false);
  assert.match(app.elements['action-hint'].textContent, /скачать.*перед закрытием/i);
  await app.elements.export.click(); await settle(); await app.refresh();
  assert.equal(app.downloads.length, 1);
  URL.revokeObjectURL(app.downloads[0].href);
});

test('unrelated tab closure does not disconnect the current book', async () => {
  const app = await dashboard({ state: createWorkspace(7) });
  app.closeSource(8); await app.refresh();
  assert.equal(app.elements['collection-title'].textContent, 'Книга готова к сбору');
  assert.equal(app.elements['collect-book'].disabled, false);
});

test('a closed source detected on initial load shows the same recovery instructions', async () => {
  const app = await dashboard({ state: createWorkspace(7), onRequest(message) {
    if (message.type === 'GET_SOURCE') return { ok: false, code: 'source_closed', error: 'Closed source' };
  } });
  assert.equal(app.elements['collection-title'].textContent, 'Связь с книгой потеряна');
  assert.match(app.elements['collection-status'].textContent, /Вкладка с книгой была закрыта/);
  assert.equal(app.elements['collect-book'].hidden, true);
  assert.equal(app.elements['download-diagnostics'].hidden, true);
});

test('a late source response cannot undo a tab closure', async () => {
  const pending = deferred();
  let hold = false;
  const app = await dashboard({ state: createWorkspace(7), onRequest(message) {
    if (hold && message.type === 'GET_SOURCE') { hold = false; return pending.promise; }
    if (message.type === 'GET_NAVIGATION') return { ok: true, navigation: { kind: 'book', title: 'Known book', url: bookUrl(71) } };
  } });
  hold = true; await app.refresh();
  app.closeSource();
  pending.resolve({ ok: true, source: { tabId: 7, url: bookUrl(71) } });
  await settle(); await app.refresh();
  assert.equal(app.elements['collection-title'].textContent, 'Связь с книгой потеряна');
  assert.equal(app.elements['collect-book'].hidden, true);
  assert.equal(app.elements['collect-book'].disabled, true);
});

test('the shipping download button names its ZIP after the collected book', async () => {
  const state = finishedWorkspace();
  state.collection.title = 'Учебник английского — 5 класс';
  const app = await dashboard({ state, allowDownload: true });
  assert.equal(app.elements.export.hidden, false);
  assert.equal(app.elements.export.disabled, false);
  await app.elements.export.click();
  await settle();
  await app.refresh(); // Advance the dashboard's short archive-preparation timer.
  assert.equal(app.downloads.length, 1, app.elements.message.textContent);
  const download = app.downloads[0];
  assert.match(download.download, /^Учебник английского — 5 класс-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.zip$/);
  const response = await fetch(download.href);
  const zip = new DataView(await response.arrayBuffer());
  assert.equal(zip.getUint32(0, true), 0x04034b50, 'The name belongs to an assembled ZIP, not just a label');
  URL.revokeObjectURL(download.href);
  assert.equal(app.elements.message.classList.contains('error'), false);
  assert.equal(app.elements['download-diagnostics'].hidden, true, 'A successful ZIP does not offer an error report');
});

test('the error report stays hidden while a book is ready without a failed operation', async () => {
  for (const state of [createWorkspace(7), finishedWorkspace()]) {
    const app = await dashboard({ state });
    assert.equal(app.elements['download-diagnostics'].hidden, true);
    await app.refresh();
    assert.equal(app.elements['download-diagnostics'].hidden, true, 'A connection refresh is not a failure');
  }
});

test('the error report stays hidden after a successful collection', async () => {
  const app = await dashboard({ state: createWorkspace(7), async collectBook({ request, onDiagnostic, onProgress }) {
    await request('BEGIN_COLLECTION');
    const collection = finishedWorkspace().collection;
    onDiagnostic({ stage: 'finish', status: 'finished' });
    await request('SAVE_COLLECTION', { collection });
    onProgress(collection);
    return collection;
  } });
  await app.elements['collect-book'].click();
  await app.refresh();
  assert.equal(app.records.get(7).collection.status, 'finished');
  assert.equal(app.elements['download-diagnostics'].hidden, true);
});

test('the error report stays hidden after manually cancelling collection', async () => {
  const started = deferred();
  const app = await dashboard({ state: createWorkspace(7), async collectBook({ request, signal, onDiagnostic, onProgress }) {
    await request('BEGIN_COLLECTION');
    started.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    const collection = { status: 'cancelled', rootUrl: bookUrl(71), title: 'Old textbook', items: [], failed: [], warnings: [],
      diagnostics: { version: 1, events: [{ stage: 'save_page', status: 'cancelled', reason: 'cancelled' }],
        failure: { stage: 'save_page', reason: 'cancelled' } } };
    onDiagnostic({ stage: 'save_page', status: 'cancelled', reason: 'cancelled' });
    await request('SAVE_COLLECTION', { collection });
    onProgress(collection);
    return collection;
  } });
  const collecting = app.elements['collect-book'].click();
  await started.promise;
  await app.elements['cancel-collection'].click();
  await collecting;
  await app.refresh();
  assert.equal(app.records.get(7).collection.status, 'cancelled');
  assert.equal(app.elements['download-diagnostics'].hidden, true);
});

test('the error report stays hidden after manually cancelling a download', async () => {
  const permission = deferred();
  const state = finishedWorkspace();
  state.snapshots[0].assets = ['https://cdn.example.org/picture.png'];
  const app = await dashboard({ state, permission: permission.promise });
  await app.elements.export.click();
  await settle();
  assert.equal(app.elements.cancel.hidden, false);
  await app.elements.cancel.click();
  await settle();
  assert.match(app.elements.message.textContent, /Скачивание отменено/);
  assert.equal(app.downloads.length, 0);
  assert.equal(app.elements['download-diagnostics'].hidden, true);
  permission.resolve(true);
  await settle();
  assert.equal(app.elements['download-diagnostics'].hidden, true, 'A late permission response does not turn cancellation into a failure');
});

test('the error report stays hidden when scoped collection cancellation aborts its pending work', async () => {
  const started = deferred();
  const app = await dashboard({ state: createWorkspace(7), workspaceId: 'cancelled-book', onRequest(message, { records }) {
    if (message.type === 'RESOLVE_WORKSPACE') return { ok: true, workspaceId: 'cancelled-book', sourceTabId: 7,
      bookKey: 'https://progressme.ru/book/71', book: { title: 'Old textbook', rootUrl: bookUrl(71) } };
    if (message.type === 'CANCEL_COLLECTION') {
      const current = records.get(7);
      records.set(7, { ...current, collection: { ...current.collection, status: 'cancelled' } });
      return { ok: true };
    }
  }, async collectBook({ request, signal, onProgress }) {
    await request('BEGIN_COLLECTION');
    const collection = { status: 'running', rootUrl: bookUrl(71), title: 'Old textbook', items: [], failed: [], warnings: [] };
    await request('SAVE_COLLECTION', { collection });
    onProgress(collection);
    started.resolve();
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      reject(new DOMException('Pending collection work cancelled', 'AbortError'));
    }, { once: true }));
  } });
  const collecting = app.elements['collect-book'].click();
  await started.promise;
  await app.elements['cancel-collection'].click();
  await collecting;
  await app.refresh();
  assert.equal(app.records.get(7).collection.status, 'cancelled');
  assert.equal(app.requests.filter(message => message.type === 'CANCEL_COLLECTION').length, 1);
  assert.equal(app.elements['download-diagnostics'].hidden, true, 'AbortError from cancelled work must not expose a failure report');
  assert.equal(app.elements.message.classList.contains('error'), false);
});

test('a failed collection can download sanitized diagnostics before any page is retained', async () => {
  const url = 'https://progressme.ru/lesson-editor/book/71/lesson/5/section/6';
  const state = createWorkspace(7);
  state.collection = { status: 'failed', rootUrl: bookUrl(71), diagnostics: {
    version: 1, extensionVersion: '0.3.15', omittedEvents: 0, events: [],
    failure: { stage: 'wait_exercises', lessonTitle: '4A Eco-guilt', sectionTitle: 'PRONUNCIATION vowel sounds',
      url: `${url}?token=session-fixture`, elapsedMs: 31500, cookie: 'secret-fixture' },
  } };
  const app = await dashboard({ state, onRequest(message) {
    if (message.type === 'GET_SOURCE') return { ok: false, error: 'Closed source' };
  } });
  assert.equal(app.elements.export.hidden, true);
  assert.equal(app.elements['download-diagnostics'].hidden, false);
  await app.elements['download-diagnostics'].click();
  assert.equal(app.downloads.length, 1);
  assert.match(app.downloads[0].download, /\.json$/);
  const raw = await (await fetch(app.downloads[0].href)).text();
  URL.revokeObjectURL(app.downloads[0].href);
  assert.doesNotMatch(raw, /session-fixture|secret-fixture/);
  assert.equal(JSON.parse(raw).collection.failure.url, url);
  assert.deepEqual(app.permissionRequests, []);
});

test('the current attempt keeps its own diagnostic when collection fails before the first checkpoint', async () => {
  const state = failedWorkspace();
  state.collection.diagnostics = { version: 1, extensionVersion: '0.3.15', omittedEvents: 0, events: [],
    failure: { stage: 'save_page', lessonTitle: 'Previous collection', lastSavedUrl: bookUrl(71) } };
  const app = await dashboard({ state, collectBook: async ({ extensionVersion }) => {
    assert.equal(extensionVersion, '0.3.16');
    return { status: 'failed', failed: [{ error: 'Не удалось начать сбор.' }], diagnostics: {
      version: 1, extensionVersion, omittedEvents: 0, events: [], failure: { stage: 'book', url: bookUrl(71) },
    } };
  } });
  await app.elements['collect-book'].click();
  await app.refresh();
  assert.equal(app.elements.message.textContent, collectionFailureNotice({ status: 'failed' }));
  assert.equal(app.elements['download-diagnostics'].hidden, false);
});

test('media capacity is refused before requesting host permissions or preparing a download', async () => {
  const state = finishedWorkspace();
  state.snapshots[0].assets = Array.from({ length: MAX_ASSETS + 1 }, (_, index) => `https://cdn.example.org/${index}.png`);
  const app = await dashboard({ state, allowDownload: true });
  await app.elements.export.click();
  await settle();
  assert.equal(app.permissionRequests.length, 0);
  assert.equal(app.downloads.length, 0);
  assert.match(app.elements.message.textContent, new RegExp(`${MAX_ASSETS + 1}.*${MAX_ASSETS}`));
  assert.equal(app.elements.export.hidden, false);
  assert.equal(app.elements['collect-book'].disabled, false);
  assert.equal(app.records.get(7).snapshots[0].assets.length, MAX_ASSETS + 1);
});

test('denied media permission allows choosing a ZIP on the next click without another prompt', async () => {
  const state = finishedWorkspace();
  state.snapshots[0].assets = ['https://cdn.example.org/picture.png'];
  const app = await dashboard({ state, allowDownload: true, permission: Promise.resolve(false) });
  const retained = structuredClone(app.records.get(7));
  await app.elements.export.click();
  await settle();
  assert.equal(app.elements['without-files'], undefined, 'There is no escape hatch for a partial archive');
  assert.equal(app.permissionRequests.length, 1);
  assert.equal(app.downloads.length, 0);
  assert.match(app.elements.message.textContent, /не разрешил.*файл|разрешите доступ/i);
  assert.doesNotMatch(app.elements.message.textContent, /сохраните архив без файлов/i);
  assert.deepEqual(app.records.get(7), retained);
  assert.equal(app.elements.export.disabled, false, 'ZIP can be selected after denial');
  assert.equal(app.elements['collect-book'].disabled, false);
  assert.equal(app.elements.cancel.hidden, true);
  await app.elements.export.click(); await settle();
  assert.equal(app.permissionRequests.length, 1);
  assert.equal(app.downloads.length, 1);
});

test('a failed archive preparation releases busy controls and allows a successful retry', async () => {
  let fail = true;
  const app = await dashboard({ state: finishedWorkspace(), allowDownload: true, makeFilename(...args) {
    if (fail) { fail = false; throw new Error('Preparation failed'); }
    return archiveFilename(...args);
  } });
  await app.elements.export.click();
  await settle();
  assert.match(app.elements.message.textContent, /Не удалось выбрать файл ZIP/);
  assert.doesNotMatch(app.elements.message.textContent, /Preparation failed/);
  assert.equal(app.elements.export.hidden, false);
  assert.equal(app.elements['collect-book'].disabled, false);
  assert.equal(app.elements.cancel.hidden, true);
  assert.equal(app.elements['download-diagnostics'].hidden, false, 'A failed archive preparation offers its diagnostic');
  await app.elements.export.click();
  await settle();
  assert.equal(app.elements['download-diagnostics'].hidden, true, 'A new download attempt hides the previous error report');
  await app.refresh();
  assert.equal(app.downloads.length, 1);
  URL.revokeObjectURL(app.downloads[0].href);
  assert.equal(app.elements.message.classList.contains('error'), false);
  assert.equal(app.elements['download-diagnostics'].hidden, true, 'A successful retry no longer offers the previous failure');
});

test('a captured attachment with an object filename can be downloaded in a complete archive', async () => {
  const state = finishedWorkspace();
  state.captures.push({ kind: 'fetch', url: 'https://progressme.ru/api/materials/71', pageUrl: state.snapshots[1].url, data: {
    attachment: { url: 'https://cdn.example.org/picture.png', mimeType: 'image/png', name: { en: 'Picture' } },
  } });
  const app = await dashboard({ state, allowDownload: true, downloadFiles(candidates, options) {
    return downloadMediaAssets(candidates, { ...options, fetchFile: async () =>
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }) });
  } });
  assert.equal(app.elements.message.classList.contains('error'), false);
  await app.elements.export.click();
  await settle();
  await app.refresh();
  assert.equal(app.downloads.length, 1, app.elements.message.textContent);
  URL.revokeObjectURL(app.downloads[0].href);
  assert.equal(app.elements.message.classList.contains('error'), false);
  assert.equal(app.elements.cancel.hidden, true);
});

for (const outcome of ['resolve', 'reject']) test(`cancellation ignores a pending media permission prompt and its late ${outcome}`, async () => {
  const permission = deferred();
  const state = finishedWorkspace();
  state.snapshots[0].assets = [{ url: 'https://cdn.progressme.ru/textbook-image.png', kind: 'image', name: 'Textbook image' }];
  const app = await dashboard({ state, permission: permission.promise });
  await app.elements.export.click();
  await settle();
  assert.equal(app.permissionRequests.length, 1);
  assert.equal(app.elements.cancel.hidden, false);
  assert.equal(app.elements['collection-title'].textContent, 'Архив книги');
  assert.equal(app.elements['collection-body'].attributes.get('aria-busy'), 'true');
  assert.equal(app.elements['progress-title'].textContent, 'Файлы книги');
  assert.equal(app.elements.progress.hasAttribute('value'), false, 'Unknown totals have no invented percentage');
  assert.doesNotMatch(app.elements['collection-status'].textContent, /готовим|подождите|проверяем|загружаем/iu);
  const cancelling = app.elements.cancel.click();
  let cancelFinished = false;
  cancelling.then(() => { cancelFinished = true; });
  await settle();
  assert.equal(cancelFinished, true, 'Cancellation must finish without a response to the Chrome permission prompt');
  await cancelling;
  const message = app.elements.message.textContent;
  if (outcome === 'resolve') permission.resolve(true);
  else permission.reject(new Error('Late permission error'));
  await settle();
  assert.equal(app.elements['source-name'].textContent, 'Old textbook');
  assert.equal(app.elements.message.textContent, message);
  assert.equal(app.elements.message.classList.contains('error'), false);
  assert.equal(app.elements.cancel.hidden, true);
  assert.equal(app.elements['work-progress'].hidden, true);
});

function disconnectedSource() {
  return { ok: false, code: 'source_disconnected', error: 'Нет связи с книгой. Обновите вкладку и снова нажмите значок exporter.' };
}

test('a missing receiver explains restarting without claiming the source tab was closed', async () => {
  const app = await dashboard({ state: createWorkspace(7), onRequest(message) {
    if (message.type === 'GET_NAVIGATION') return disconnectedSource();
  } });
  assert.equal(app.elements['collect-book'].hidden, true);
  assert.equal(app.elements['collection-title'].textContent, 'Связь с книгой потеряна');
  assert.match(app.elements['collection-status'].textContent, /Книга не отвечает/);
  assert.doesNotMatch(app.elements['collection-status'].textContent, /была закрыта/);
  assert.equal(app.elements['download-diagnostics'].hidden, false);
  assert.equal(app.requests.some(message => message.type === 'RECONNECT_SOURCE'), false);
});

test('an unreachable extension worker shows Russian recovery instructions instead of raw Chrome errors', async () => {
  const app = await dashboard({ onRequest(message) {
    if (message.type === 'GET_STATE') throw new Error('Could not establish connection. Receiving end does not exist.');
  } });
  assert.match(app.elements.message.textContent, /Окно расширения потеряло связь/);
  assert.match(app.elements.message.textContent, /Закройте его и снова нажмите значок exporter/);
  assert.doesNotMatch(app.elements.message.textContent, /Receiving end|establish connection/);
  assert.equal(app.elements.message.classList.contains('error'), true);
  assert.equal(app.elements['reset-book'], undefined);
});

test('a failed file from paged raw definitions automatically saves an archive with warnings', async () => {
  const state = finishedWorkspace();
  state.dropped = 0; state.warnings = []; state.exportRevision = 42;
  const rawCapture = { kind: 'fetch', url: 'https://progressme.ru/api/materials/71', data: {
    Items: [{ Id: 12, Type: 4, Answers: ['native-answer'], Audios: [{ Url: 'https://cdn.example.org/sound-opaque' }] }],
    imageUrl: 'https://cdn.example.org/not-found.png',
  } };
  state.captures = [{ kind: rawCapture.kind, url: rawCapture.url, data: true }];
  state.assetInventory = collectAssets(state.snapshots, [rawCapture]);
  const app = await dashboard({
    state, allowDownload: true,
    onRequest(message) {
      if (message.type === 'GET_EXPORT_INFO') return { ok: true, revision: 42, snapshotCount: state.snapshots.length, captureCount: 1 };
      if (message.type === 'GET_EXPORT_RECORDS') {
        const rows = message.kind === 'snapshots' ? state.snapshots : [rawCapture];
        return { ok: true, revision: 42, total: rows.length, nextOffset: message.offset + 1, records: rows.slice(message.offset, message.offset + 1) };
      }
    },
    downloadFiles(candidates, options) {
      return downloadMediaAssets(candidates, { ...options, fetchFile: async url => url.endsWith('not-found.png')
        ? new Response('', { status: 404 }) : new Response(new Uint8Array([0, 255, 5]), { headers: { 'content-type': 'audio/mpeg' } }) });
    },
  });
  assert.ok(app.requests.filter(item => item.type === 'GET_STATE').every(item => item.summary === true));
  await app.elements.export.click();
  await settle(); await app.refresh();
  assert.equal(app.downloads.length, 1);
  assert.equal(app.elements.message.classList.contains('error'), false);
  assert.equal(app.elements['partial-export-dialog'], undefined);
  assert.equal(app.elements['download-diagnostics'].hidden, false);
  assert.match(app.elements['file-results'].children[0].children[1].textContent, /не найден/);
  assert.equal(app.records.get(7).exportRevision, 42, 'Failure retains the complete capture for retry');
  assert.ok(app.requests.some(item => item.type === 'GET_EXPORT_RECORDS'));

});

test('capture loss displays its actual fixed diagnostic rather than always blaming book size', async () => {
  const state = failedWorkspace();
  state.warnings = ['Ответ содержит слишком сложную структуру; часть исходных данных не сохранена.'];
  const app = await dashboard({ state });
  assert.match(app.elements['review-text'].textContent, /слишком сложную структуру/);
  assert.doesNotMatch(app.elements['review-text'].textContent, /Книга оказалась слишком большой/);
});


test('the page keeps collected materials without offering in-app book selection', async () => {
  const app = await dashboard();
  const before = structuredClone(app.records.get(7));
  await app.refresh();
  for (const id of ['change-book', 'next-book', 'source-picker', 'source-options', 'refresh-sources', 'saved-books']) {
    assert.equal(app.elements[id], undefined, `${id} must not offer another way to switch books`);
  }
  assert.equal(app.elements['source-name'].textContent, 'Old textbook');
  assert.deepEqual(app.records.get(7), before);
  assert.equal(app.tabQueries.length, 0);
  assert.equal(app.requests.some(item => ['RESET_CAPTURE', 'CLEAR_CAPTURE', 'LIST_WORKSPACES'].includes(item.type)), false);
});

test('a page opened without a source explains launching from the book and never scans tabs', async () => {
  const app = await dashboard({ selectedTabId: null, onRequest(message) {
    if (message.type === 'GET_NAVIGATION') return new Promise(() => {});
  } });
  assert.equal(app.tabQueries.length, 0, 'Other tabs, including frozen ones, are irrelevant to this page');
  assert.equal(app.requests.length, 0, 'No source is read or selected implicitly');
  assert.equal(new URL(app.location.href).searchParams.get('tab'), null);
  assert.equal(app.elements['source-picker'], undefined);
  assert.equal(app.elements['collect-book'].hidden, true);
  assert.match(app.elements['collection-status'].textContent, /Откройте.*книг[уи].*значок/i);
});

test('a late cancelled collector cannot stop a new scoped collection', async () => {
  const checkpoints = [deferred(), deferred()], starts = [deferred(), deferred()];
  let runs = 0;
  const app = await dashboard({ state: createWorkspace(7), workspaceId: 'scoped-book', onRequest(message) {
    if (message.type === 'RESOLVE_WORKSPACE') return { ok: true, workspaceId: 'scoped-book', sourceTabId: 7, book: { title: 'Old textbook', rootUrl: bookUrl(71) } };
  }, async collectBook({ onProgress, signal }) {
    const index = runs++;
    onProgress({ status: 'running', title: 'Run ' + index, rootUrl: bookUrl(71), items: [], failed: [], warnings: [] });
    starts[index].resolve();
    await checkpoints[index].promise;
    if (signal.aborted) {
      onProgress({ status: 'failed', title: 'Old stale title', items: [], failed: [], warnings: [] });
      throw new Error('Old stale failure');
    }
    return { status: 'finished' };
  } });
  const old = app.elements['collect-book'].click();
  await starts[0].promise;
  await app.elements['cancel-collection'].click();
  const next = app.elements['collect-book'].click();
  await starts[1].promise;
  checkpoints[0].resolve(); await old;
  assert.equal(app.elements['source-name'].textContent, 'Old textbook', 'The verified book title survives late callbacks');
  assert.equal(app.elements['cancel-collection'].hidden, false);
  assert.equal(app.elements['collect-book'].hidden, true);
  assert.doesNotMatch(app.elements.message.textContent, /Old stale/);
  checkpoints[1].resolve(); await next;
});

test('late media progress and completion cannot restore a cancelled download', async () => {
  const pending = deferred(), started = deferred();
  let progress;
  const state = finishedWorkspace();
  state.snapshots[0].assets = ['https://cdn.example.org/picture.png'];
  const app = await dashboard({ state, allowDownload: true, downloadFiles: async (_assets, options) => {
    progress = options.onProgress; started.resolve(); return pending.promise;
  } });
  await app.elements.export.click(); await started.promise;
  await app.elements.cancel.click(); await settle();
  progress({ completed: 1, total: 1, loadedBytes: 100, active: [] });
  pending.resolve([]); await settle();
  assert.equal(app.elements['work-progress'].hidden, true);
  assert.equal(app.elements.export.hidden, false);
  assert.match(app.elements.message.textContent, /Скачивание отменено/);
  assert.equal(app.downloads.length, 0);
});


test('a reused source tab shows the live book title and URL instead of the old saved book', async () => {
  const currentUrl = bookUrl(857133);
  const app = await dashboard({ sourceUrl: currentUrl, onRequest(message, { tabs }) {
    tabs[0].bookTitle = 'AEF elementary (2nd edition)';
  } });
  const before = structuredClone(app.records.get(7));
  assert.equal(app.elements['source-name'].textContent, 'AEF elementary (2nd edition)');
  assert.match(app.elements['review-text'].textContent, /Old textbook/);
  assert.equal(app.elements['export-label'].textContent, 'Скачать «Old textbook»');
  assert.equal(app.elements['change-book'], undefined);
  assert.deepEqual(app.tabUpdates, []);
  assert.deepEqual(app.records.get(7), before, 'Changing the displayed source never rewrites the saved book');
});

test('the current book is probed again after a same-URL rename', async () => {
  let title = 'Old textbook';
  const app = await dashboard({ onRequest(message) {
    if (message.type === 'GET_NAVIGATION') return { ok: true, navigation: { kind: 'book', url: bookUrl(message.tabId === 7 ? 71 : 81), title } };
  } });
  title = 'Renamed textbook';
  await app.refresh();
  assert.equal(app.elements['source-name'].textContent, title);
  assert.equal(app.elements['source-meta'].textContent.startsWith('ProgressMe'), true);
});

test('missing or mismatched live navigation never labels another book with the saved title', async () => {
  for (const reply of [{ ok: false, error: 'Source loading' }, { ok: true, navigation: { kind: 'book', url: bookUrl(71), title: 'Old textbook' } }]) {
    const app = await dashboard({ sourceUrl: bookUrl(81), onRequest(message) {
      if (message.type === 'GET_NAVIGATION') return reply;
    } });
    assert.equal(app.elements['source-name'].textContent, 'Учебник 81');
    assert.equal(app.tabQueries.length, 0);
  }
});

test('source navigation updates the card without switching or reading other tabs', async () => {
  const app = await dashboard();
  const before = structuredClone(app.records.get(7));
  app.changeSource(7, { url: bookUrl(81), bookTitle: 'New source book', title: 'Deshar School' });
  assert.equal(app.elements['source-name'].textContent, 'Учебник 81', 'An unread book is identified by its own URL until its title is verified');
  await settle(); await app.refresh();
  assert.equal(app.elements['source-name'].textContent, 'New source book');
  assert.equal(new URL(app.location.href).searchParams.get('tab'), '7');
  assert.equal(app.tabQueries.length, 0);
  assert.equal(app.requests.some(item => item.tabId && item.tabId !== 7), false);
  assert.deepEqual(app.records.get(7), before, 'Source navigation keeps the previously collected result intact');
});

test('a separate page for another source reads only that book and preserves the first result', async () => {
  const first = await dashboard({ state: finishedWorkspace() });
  const before = structuredClone(first.records.get(7));
  const second = await dashboard({ state: before, selectedTabId: 8 });
  assert.equal(new URL(first.location.href).searchParams.get('tab'), '7');
  assert.equal(new URL(second.location.href).searchParams.get('tab'), '8');
  assert.equal(first.elements['source-name'].textContent, 'Old textbook');
  assert.equal(second.elements['source-name'].textContent, 'New textbook');
  assert.equal(first.elements.export.disabled, false);
  assert.equal(second.elements.export.hidden, true);
  assert.equal(second.elements['collect-book'].disabled, false);
  assert.equal(second.requests.some(item => item.tabId && item.tabId !== 8), false);
  assert.equal(second.tabQueries.length, 0);
  assert.equal(second.requests.some(item => ['RESET_CAPTURE', 'CLEAR_CAPTURE'].includes(item.type)), false);
  assert.deepEqual(first.records.get(7), before);
  assert.deepEqual(second.records.get(7), before, 'Opening another source leaves the retained first-book state untouched');
});

test('download after navigating to another book still contains and names the saved book', async () => {
  const app = await dashboard({ state: finishedWorkspace(), sourceUrl: bookUrl(81), allowDownload: true });
  await app.elements.export.click(); await settle(); await app.refresh();
  assert.equal(app.downloads.length, 1);
  assert.match(app.downloads[0].download, /^Old textbook-/);
  const bytes = new TextDecoder().decode(await (await fetch(app.downloads[0].href)).arrayBuffer());
  assert.doesNotMatch(bytes, /New textbook/);
  URL.revokeObjectURL(app.downloads[0].href);
});


test('an old refresh delivered after a source-update event cannot restore the previous title', async () => {
  const pending = deferred(); let block = false;
  const app = await dashboard({ onRequest(message) {
    if (block && message.type === 'GET_NAVIGATION' && message.expectedUrl === bookUrl(71)) return pending.promise;
  } });
  block = true;
  await app.refresh();
  app.changeSource(7, { url: bookUrl(81), bookTitle: 'Latest textbook' });
  pending.resolve({ ok: true, navigation: { kind: 'book', url: bookUrl(71), title: 'Late stale title' } });
  await settle();
  assert.equal(app.elements['source-name'].textContent, 'Учебник 81');
  await app.refresh();
  assert.equal(app.elements['source-name'].textContent, 'Latest textbook');
});


test('unsupported material routes and a temporarily stale DOM do not start an automatic refresh loop', async () => {
  const unsupported = await dashboard({ sourceUrl: bookUrl(71).replace('/content', '') });
  assert.equal(unsupported.requests.some(item => item.type === 'GET_NAVIGATION'), false);
  assert.equal(unsupported.tabQueries.length, 0, 'An unsupported source does not select another open textbook');
  const app = await dashboard({ sourceUrl: bookUrl(81), onRequest(message) {
    if (message.type === 'GET_NAVIGATION') return { ok: false, code: 'source_changed', error: 'DOM is still loading' };
  } });
  const queries = app.requests.filter(item => item.type === 'GET_NAVIGATION').length;
  await settle();
  assert.equal(app.requests.filter(item => item.type === 'GET_NAVIGATION').length, queries);
  assert.equal(app.elements['source-name'].textContent, 'Учебник 81');
});

for (const condition of ['manual', 'failed', 'cancelled', 'running', 'capture-loss', 'missing-page', 'pending-item', 'failed-route', 'other-window', 'capture-enabled']) {
  test(`partial export is blocked before permissions even when the disabled click listener is invoked: ${condition}`, async () => {
    const state = finishedWorkspace();
    state.snapshots[0].assets = ['https://cdn.example.org/picture.png'];
    if (condition === 'manual') delete state.collection;
    else if (['failed', 'cancelled', 'running'].includes(condition)) state.collection.status = condition;
    else if (condition === 'capture-loss') state.dropped = 1;
    else if (condition === 'missing-page') state.snapshots.pop();
    else if (condition === 'pending-item') state.collection.items[1].status = 'pending';
    else if (condition === 'failed-route') state.collection.failed.push({ url: state.snapshots[1].url, error: 'Source request failed' });
    else if (condition === 'other-window') state.collectionLocked = true;
    else if (condition === 'capture-enabled') state.enabled = true;
    const app = await dashboard({ state, allowDownload: true });
    const retained = structuredClone(app.records.get(7));
    assert.equal(app.elements.export.disabled, true);
    await app.forceExportClick();
    await app.refresh();
    assert.equal(app.permissionRequests.length, 0, 'Partial captures must not trigger a permission prompt');
    assert.equal(app.downloads.length, 0);
    assert.deepEqual(app.records.get(7), retained, 'The source capture remains available for repair');
  });
}

test('hydrated records are checked again when summary looked ready but a retained page is missing', async () => {
  const state = finishedWorkspace();
  state.exportRevision = 73;
  let fetchedFiles = false;
  const app = await dashboard({ state, allowDownload: true,
    onRequest(message) {
      if (message.type === 'GET_EXPORT_INFO') return { ok: true, revision: 73, snapshotCount: 1, captureCount: 0 };
      if (message.type === 'GET_EXPORT_RECORDS') return { ok: true, revision: 73, total: 1, nextOffset: 1, records: [state.snapshots[0]] };
    },
    downloadFiles() { fetchedFiles = true; throw new Error('Incomplete raw data must not start media requests'); },
  });
  assert.equal(app.elements.export.disabled, false);
  await app.elements.export.click();
  await settle(); await app.refresh();
  assert.equal(fetchedFiles, false);
  assert.equal(app.downloads.length, 0);
  assert.match(app.elements.message.textContent, /не все|не полностью|частичный/i);
});

test('raw records retain missing-file warnings despite an empty cached inventory', async () => {
  const state = finishedWorkspace();
  state.exportRevision = 74;
  state.assetInventory = [];
  const raw = structuredClone(state.snapshots);
  raw[1].assets = ['https://cdn.example.org/missing-in-summary.png'];
  let requested = [];
  const app = await dashboard({ state, allowDownload: true,
    onRequest(message) {
      if (message.type === 'GET_EXPORT_INFO') return { ok: true, revision: 74, snapshotCount: raw.length, captureCount: 0 };
      if (message.type === 'GET_EXPORT_RECORDS') return { ok: true, revision: 74, total: raw.length, nextOffset: message.offset + 1, records: raw.slice(message.offset, message.offset + 1) };
    },
    downloadFiles(candidates, options) {
      requested = candidates.map(asset => asset.url);
      return downloadMediaAssets(candidates, { ...options, fetchFile: async () => new Response('', { status: 404 }) });
    },
  });
  await app.elements.export.click();
  await settle(); await app.refresh();
  assert.deepEqual(requested, ['https://cdn.example.org/missing-in-summary.png']);
  assert.equal(app.downloads.length, 1);
  assert.equal(app.elements['partial-export-dialog'], undefined);
  assert.equal(app.elements['download-diagnostics'].hidden, false);
});

for (const status of ['failed', 'skipped', 'unavailable', 'empty-downloaded']) {
  test(`terminal file failures save automatically while invalid downloaded bytes still block: ${status}`, async () => {
    const state = finishedWorkspace();
    state.snapshots[1].assets = ['https://cdn.example.org/required.mp3'];
    const app = await dashboard({ state, allowDownload: true, downloadFiles: async (candidates, options) => candidates.map(asset => {
      options.onDiagnostic?.({ stage: 'files', assetId: asset.id, url: asset.url, status: status === 'empty-downloaded' ? 'downloaded' : status });
      return { ...asset, status: status === 'empty-downloaded' ? 'downloaded' : status,
        ...(status === 'empty-downloaded' ? { data: new Blob() } : {}), error: 'Required file was not retained' };
    }) });
    const retained = structuredClone(app.records.get(7));
    await app.elements.export.click();
    await settle(); await app.refresh();
    const invalidDownloaded = status === 'empty-downloaded';
    assert.equal(app.downloads.length, invalidDownloaded ? 0 : 1);
    if (invalidDownloaded) assert.match(app.elements.message.textContent, /все файлы|не создан/i);
    else assert.equal(app.elements['download-diagnostics'].hidden, false);
    assert.equal(app.elements['partial-export-dialog'], undefined);
    assert.equal(app.elements.message.classList.contains('error'), invalidDownloaded);
    assert.equal(app.elements.export.disabled, false, 'Media can be retried without recollecting the source');
    assert.deepEqual(app.records.get(7), retained);
  });
}

test('temporary private file references are recorded as missing in the saved archive', async () => {
  const state = finishedWorkspace();
  state.snapshots[1].assets = [{ url: 'https://cdn.example.org/required.mp3?token=secret', kind: 'audio' }];
  let fetched = false;
  const app = await dashboard({ state, allowDownload: true, downloadFiles(candidates, options) {
    return downloadMediaAssets(candidates, { ...options, fetchFile() { fetched = true; throw new Error('Private URL must not be fetched'); } });
  } });
  await app.elements.export.click();
  await settle(); await app.refresh();
  assert.equal(fetched, false);
  assert.equal(app.downloads.length, 1);
  assert.equal(app.elements['partial-export-dialog'], undefined);
  assert.equal(app.elements['download-diagnostics'].hidden, false);
  assert.equal(app.elements['without-files'], undefined);
});

test('all required media permits a complete ZIP while supported external embeds remain links', async () => {
  const state = finishedWorkspace();
  const embeds = ['https://view.genially.com/abc-123/interactive-lesson', 'https://quizlet.com/12345/lesson-flash-cards/',
    'https://www.youtube.com/watch?v=example'];
  state.snapshots[1].assets = [...embeds.map(url => ({ url, kind: 'embed' })), { url: 'https://cdn.example.org/required.mp3', kind: 'audio' }];
  state.warnings = ['Обход охватывает только загруженные элементы страницы; отсутствие других уроков и разделов не подтверждается.'];
  let requested = [];
  const app = await dashboard({ state, allowDownload: true, downloadFiles(candidates, options) {
    requested = candidates.map(asset => asset.url);
    return downloadMediaAssets(candidates, { ...options, fetchFile: async () =>
      new Response(new Uint8Array([0, 255, 5]), { headers: { 'content-type': 'audio/mpeg' } }) });
  } });
  await app.elements.export.click();
  await settle(); await app.refresh();
  assert.deepEqual(requested, ['https://cdn.example.org/required.mp3']);
  assert.equal(app.downloads.length, 1, app.elements.message.textContent);
  const data = new TextDecoder().decode(await (await fetch(app.downloads[0].href)).arrayBuffer());
  for (const url of embeds) assert.ok(data.includes(url), 'External embed source remains in raw records');
  assert.match(data, /"downloadedAssets":1/);
  assert.match(data, /"missingAssets":0/);
  assert.match(data, /"status":"partial"/, 'Raw representation metadata must not prohibit a complete crawl');
  URL.revokeObjectURL(app.downloads[0].href);
});

for (const missing of [3, 20, 21]) {
  test(`the dashboard automatically saves and offers the report with ${missing} missing media`, async () => {
    const state = finishedWorkspace();
    state.snapshots[1].assets = Array.from({ length: 21 }, (_, i) => `https://cdn.example.org/${i}.mp3`);
    const app = await dashboard({ state, allowDownload: true, downloadFiles(candidates, options) {
      return downloadMediaAssets(candidates, { ...options, fetchFile: async url => Number(new URL(url).pathname.slice(1).split('.')[0]) < missing
        ? new Response('Denied', { status: 403 }) : new Response('ID3audio', { headers: { 'content-type': 'audio/mpeg' } }) });
    } });
    await app.elements.export.click(); await settle(); await app.refresh();
    assert.equal(app.downloads.length, 1);
    assert.equal(app.elements['partial-export-dialog'], undefined);
    assert.equal(app.elements['download-diagnostics'].hidden, false);
    assert.match(app.elements['capture-status'].textContent, /проблемами/);
    const zip = new TextDecoder().decode(await (await fetch(app.downloads[0].href)).arrayBuffer());
    assert.match(zip, new RegExp(`"missingAssets":${missing}`));
    assert.match(zip, new RegExp(`"downloadedAssets":${21 - missing}`));
    URL.revokeObjectURL(app.downloads[0].href);
    await app.elements['download-diagnostics'].click(); await settle();
    assert.equal(app.downloads.length, 2);
    const report = await (await fetch(app.downloads[1].href)).json();
    assert.equal(report.downloadSummary.failed, missing);
    assert.equal(report.downloadSummary.total, 21);
    URL.revokeObjectURL(app.downloads[1].href);
  });
}

for (const declaredSize of [2, 7]) {
  test(`a rejected truncated or mismatched media body is omitted and reported: length=${declaredSize}`, async () => {
    const state = finishedWorkspace();
    state.snapshots[1].assets = ['https://cdn.example.org/required.mp3'];
    const app = await dashboard({ state, allowDownload: true, downloadFiles(candidates, options) {
      return downloadMediaAssets(candidates, { ...options, fetchFile: async () =>
        new Response(new Uint8Array(4), { headers: { 'content-type': 'audio/mpeg', 'content-length': String(declaredSize) } }) });
    } });
    await app.elements.export.click();
    await settle(); await app.refresh();
    assert.equal(app.downloads.length, 1);
    assert.equal(app.elements['partial-export-dialog'], undefined);
    assert.equal(app.elements['download-diagnostics'].hidden, false);
    assert.match(app.elements['file-results'].children[0].children[1].textContent, /размер файла не совпадает/);
    assert.equal(app.records.get(7).collection.status, 'finished', 'Source data remains available for media retry');
  });
}

for (const status of [200, 206]) {
  test(`a rejected range response is omitted and reported: HTTP ${status}`, async () => {
    const state = finishedWorkspace();
    state.snapshots[1].assets = ['https://cdn.example.org/required.mp3'];
    let cancelled = false;
    const app = await dashboard({ state, allowDownload: true, downloadFiles(candidates, options) {
      return downloadMediaAssets(candidates, { ...options, fetchFile: async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array([1, 2])); },
        cancel() { cancelled = true; },
      }), { status, headers: { 'content-type': 'audio/mpeg', 'content-length': '2', 'content-range': 'bytes 0-1/10' } }) });
    } });
    const retained = structuredClone(app.records.get(7));
    await app.elements.export.click();
    await settle(); await app.refresh();
    assert.equal(cancelled, true);
    assert.equal(app.downloads.length, 1);
    assert.equal(app.elements['partial-export-dialog'], undefined);
    assert.equal(app.elements['download-diagnostics'].hidden, false);
    assert.match(app.elements['file-results'].children[0].children[1].textContent, /только часть файла/);
    assert.equal(app.elements.export.disabled, false, 'The complete file can be requested again');
    assert.deepEqual(app.records.get(7), retained);
  });
}


test('a temporary navigation failure retains the verified live title', async () => {
  let fail = false;
  const app = await dashboard({ sourceUrl: bookUrl(81), onRequest(message) {
    if (message.type === 'GET_NAVIGATION') return fail
      ? { ok: false, error: 'Source loading' }
      : { ok: true, navigation: { kind: 'book', url: bookUrl(81), title: 'Verified second book' } };
  } });
  assert.equal(app.elements['source-name'].textContent, 'Verified second book');
  fail = true;
  await app.refresh();
  assert.equal(app.elements['source-name'].textContent, 'Verified second book');
});


test('a page launched from a lesson can collect after its source opens the book contents', async () => {
  let collections = 0;
  const app = await dashboard({ state: createWorkspace(7), workspaceId: 'fresh-lesson-book', sourceUrl: 'https://progressme.ru/lesson-editor/book/71/lesson/5/section/6',
    onRequest(message) {
      if (message.type === 'RESOLVE_WORKSPACE') return { ok: true, workspaceId: 'fresh-lesson-book', sourceTabId: 7, book: null, bookKey: 'https://progressme.ru/book/71' };
    },
    async collectBook() {
      collections++;
      return { status: 'finished', rootUrl: bookUrl(71), title: 'Old textbook', items: [], failed: [], warnings: [] };
    },
  });
  assert.equal(app.elements['collect-book'].disabled, true, 'Collection starts only from the book contents');
  app.changeSource(7, { url: bookUrl(71), bookTitle: 'Old textbook' });
  await app.refresh();
  assert.equal(app.elements['source-name'].textContent, 'Old textbook');
  assert.equal(app.elements['collect-book'].hidden, false, 'The verified book contents make this first workspace usable');
  assert.equal(app.elements['collect-book'].disabled, false);
  assert.equal(app.elements['open-source'], undefined);
  await app.elements['collect-book'].click();
  assert.equal(collections, 1, 'A workspace without a previously bound book can start its first collection');
  assert.equal(app.tabQueries.length, 0);
});

test('a page launched from a lesson cannot adopt another book when its source changes', async () => {
  let collections = 0;
  const app = await dashboard({ state: createWorkspace(7), workspaceId: 'fresh-lesson-book', sourceUrl: 'https://progressme.ru/lesson-editor/book/71/lesson/5/section/6',
    onRequest(message) {
      if (message.type === 'RESOLVE_WORKSPACE') return { ok: true, workspaceId: 'fresh-lesson-book', sourceTabId: 7, book: null, bookKey: 'https://progressme.ru/book/71' };
    },
    async collectBook() { collections++; },
  });
  const originalTitle = app.elements['source-name'].textContent;
  const before = structuredClone(app.records.get(7));
  app.changeSource(7, { url: bookUrl(81), bookTitle: 'Different textbook' });
  await app.refresh();
  assert.equal(app.elements['source-name'].textContent, originalTitle, 'Another book cannot supply this workspace title');
  assert.equal(new URL(app.location.href).searchParams.get('workspace'), 'fresh-lesson-book');
  assert.equal(app.elements['collect-book'].hidden, true);
  assert.equal(app.elements['collect-book'].disabled, true);
  assert.equal(app.elements['open-source'], undefined);
  await Promise.all((app.elements['collect-book'].listeners.get('click') || []).map(callback => callback()));
  assert.equal(collections, 0, 'Collection also rejects the mismatched book when called beyond its disabled button');
  assert.deepEqual(app.records.get(7), before);
});

test('a workspace keeps its book while the source switches and offers no cross-book collection', async () => {
  const app = await dashboard({ state: finishedWorkspace(), workspaceId: 'saved-A', onRequest(message) {
    if (message.type === 'RESOLVE_WORKSPACE') return { ok: true, workspaceId: 'saved-A', sourceTabId: 7, book: { title: 'Old textbook', rootUrl: bookUrl(71) } };
  } });
  app.changeSource(7, { url: bookUrl(81), bookTitle: 'Second book' });
  await app.refresh();
  assert.equal(app.elements['source-name'].textContent, 'Old textbook');
  assert.equal(app.elements['collect-book'].hidden, true);
  assert.equal(app.elements.export.disabled, false);
  assert.equal(app.elements['open-source'], undefined);
  assert.equal(app.records.get(7).collection.title, 'Old textbook');
});

test('finished collection offers download without service actions', async () => {
  const app = await dashboard({ state: finishedWorkspace() });
  assert.equal(app.elements.export.hidden, false);
  assert.equal(app.elements['collect-book'].hidden, true);
  assert.equal(app.elements['repeat-collection'], undefined);
  assert.equal(app.elements['additional-actions'], undefined);
  assert.equal(app.elements['next-book'], undefined);
});

test('after ZIP handoff the result stays downloadable and explains launching another book', async () => {
  const app = await dashboard({ state: finishedWorkspace(), allowDownload: true });
  const before = structuredClone(app.records.get(7));
  await app.elements.export.click(); await settle(); await app.refresh();
  assert.equal(app.downloads.length, 1);
  assert.equal(app.elements['next-book'], undefined);
  assert.equal(app.elements['change-book'], undefined);
  assert.equal(app.elements['source-picker'], undefined);
  assert.equal(app.elements.export.hidden, false);
  assert.equal(app.elements.export.disabled, false);
  assert.equal(app.elements['export-label'].textContent, 'Скачать ещё раз');
  assert.equal(app.elements.export.classList.contains('button-primary'), true);
  assert.equal(app.elements['action-hint'].textContent, 'Для следующей книги откройте её на платформе и снова нажмите значок exporter.');
  assert.deepEqual(app.records.get(7), before);
  URL.revokeObjectURL(app.downloads[0].href);
});

test('reopening a handed-off workspace restores the downloadable result', async () => {
  const state = finishedWorkspace();
  state.downloadResult = { loaded: 3, missing: 0 };
  const app = await dashboard({ state, workspaceId: 'finished-book', onRequest(message) {
    if (message.type === 'RESOLVE_WORKSPACE') return { ok: true, workspaceId: 'finished-book', sourceTabId: 7, book: { title: 'Old textbook', rootUrl: bookUrl(71) } };
  } });
  assert.equal(app.elements['next-book'], undefined);
  assert.equal(app.elements.export.hidden, false);
  assert.equal(app.elements.export.disabled, false);
  assert.equal(app.elements['export-label'].textContent, 'Скачать ещё раз');
  assert.equal(app.elements['collection-title'].textContent, 'Архив передан браузеру');
});

test('an unrecognized page after a failed load is not labeled as another book', async () => {
  const app = await dashboard({ workspaceId: 'failed-page-book', sourceUrl: 'https://progressme.ru/cabinet/school/materials', onRequest(message) {
    if (message.type === 'RESOLVE_WORKSPACE') return { ok: true, workspaceId: 'failed-page-book', sourceTabId: 7,
      book: { title: 'Old textbook', rootUrl: bookUrl(71) } };
  } });
  assert.doesNotMatch(app.elements['collection-status'].textContent, /открыта другая книга/);
  assert.equal(app.elements.export.hidden, true, 'The failed collection remains unavailable for download');
});

test('a verified network failure uses its cause instead of another-book or missing-receiver text', async () => {
  const app = await dashboard({ onRequest(message) {
    if (message.type === 'GET_SOURCE_STATUS') return { ok: true, sourceStatus: { state: 'network_error', networkError: 'net::ERR_TIMED_OUT' } };
    if (message.type === 'GET_NAVIGATION') return disconnectedSource();
  } });
  assert.equal(app.elements['collection-title'].textContent, 'Не удалось загрузить страницу книги');
  assert.equal(app.elements['capture-status'].dataset.mode, 'error');
  assert.doesNotMatch(app.elements['collection-status'].textContent, /другая книга|ERR_TIMED_OUT/);
});

test('capture-state restoration waits before enabling collection and does not advertise a failure report', async () => {
  let ready = false;
  const app = await dashboard({ state: createWorkspace(7), onRequest(message) {
    if (message.type === 'GET_SOURCE_STATUS') return { ok: true, sourceStatus: { state: 'same_book' } };
    if (message.type === 'GET_NAVIGATION' && !ready) return { ok: false, code: 'source_loading', error: 'Capture state is restoring' };
  } });
  assert.equal(app.elements['collection-title'].textContent, 'Книга загружается');
  assert.equal(app.elements['collect-book'].disabled, true);
  assert.equal(app.elements['download-diagnostics'].hidden, true);
  ready = true;
  await app.refresh();
  assert.equal(app.elements['collect-book'].disabled, false);
  assert.equal(app.elements['collect-book'].hidden, false);
  assert.equal(app.elements['download-diagnostics'].hidden, true);
});

test('collection displays slow loading and retry events without starting a new collection', async () => {
  const started = deferred(), released = deferred();
  let emit;
  const app = await dashboard({ state: createWorkspace(7), async collectBook({ onDiagnostic }) {
    emit = onDiagnostic; started.resolve();
    await released.promise;
    return { status: 'cancelled', diagnostics: { version: 1, events: [] } };
  } });
  const collecting = app.elements['collect-book'].click();
  await started.promise;
  emit({ stage: 'wait_exercises', status: 'waiting', elapsedMs: 61000, attempt: 1 });
  assert.equal(app.elements['progress-detail'].textContent, 'Страница загружается дольше обычного.');
  emit({ stage: 'reload_section', status: 'retrying', attempt: 2 });
  assert.equal(app.elements['progress-detail'].textContent, 'Повторная загрузка раздела. Попытка 2 из 3.');
  assert.equal(app.requests.filter(message => message.type === 'CLEAR_CAPTURE').length, 0);
  released.resolve(); await collecting;
});

test('the UI request bridge preserves a known browser cause and removes URL secrets', async () => {
  let observed;
  const app = await dashboard({ state: createWorkspace(7), onRequest(message) {
    if (message.type === 'PROBE_SOURCE_FAILURE') return { ok: false, code: 'source_security_error',
      error: 'Browser blocked the page', networkError: 'net::ERR_CERT_DATE_INVALID',
      expectedUrl: `${bookUrl(71)}?token=secret`, observedUrl: `${bookUrl(71)}#private`, attempt: 2 };
  }, async collectBook({ request }) {
    try { await request('PROBE_SOURCE_FAILURE'); } catch (error) { observed = error; }
    return { status: 'cancelled', diagnostics: { version: 1, events: [] } };
  } });
  await app.elements['collect-book'].click();
  assert.equal(observed.networkError, 'net::ERR_CERT_DATE_INVALID');
  assert.equal(observed.expectedUrl, bookUrl(71));
  assert.equal(observed.observedUrl, bookUrl(71));
  assert.equal(observed.attempt, 2);
});

test('the UI request bridge preserves sanitized navigation document context', async () => {
  let observed;
  const navigation = { event: 'onCommitted', phase: 'committed', cause: 'unexpected_document',
    sourceDocumentId: '22222222-2222-4222-8222-222222222222', documentId: '33333333-3333-4333-8333-333333333333',
    expectedUrl: `${bookUrl(71)}?token=private`, observedUrl: `${bookUrl(71)}#private`, body: 'private' };
  const app = await dashboard({ state: createWorkspace(7), onRequest(message) {
    if (message.type === 'PROBE_NAVIGATION_FAILURE') return { ok: false, code: 'source_left_page',
      error: 'The source document changed', navigation };
  }, async collectBook({ request }) {
    try { await request('PROBE_NAVIGATION_FAILURE'); } catch (error) { observed = error; }
    return { status: 'cancelled', diagnostics: { version: 1, events: [] } };
  } });
  await app.elements['collect-book'].click();
  assert.equal(observed.navigation?.cause, 'unexpected_document');
  assert.equal(observed.navigation?.documentId, navigation.documentId);
  assert.equal(observed.navigation?.observedUrl, bookUrl(71));
  assert.doesNotMatch(JSON.stringify(observed.navigation), /private|body/);
});

test('a connection failure downloads its navigation decision before collection starts', async () => {
  const navigation = { event: 'onBeforeNavigate', phase: 'committed', cause: 'navigation_after_commit',
    sourceDocumentId: '22222222-2222-4222-8222-222222222222', expectedUrl: `${bookUrl(71)}?token=private` };
  const app = await dashboard({ state: createWorkspace(7), onRequest(message) {
    if (message.type === 'GET_SOURCE_STATUS') return { ok: true, sourceStatus: { state: 'source_changed', navigation } };
    if (message.type === 'GET_NAVIGATION') return { ok: false, code: 'source_left_page', error: 'The source reloaded', navigation };
  } });
  assert.equal(app.elements['download-diagnostics'].hidden, false);
  await app.elements['download-diagnostics'].click();
  const raw = await (await fetch(app.downloads[0].href)).text();
  URL.revokeObjectURL(app.downloads[0].href);
  const event = JSON.parse(raw).events.find(event => event.reason === 'source_left_page');
  assert.equal(event.navigation?.cause, 'navigation_after_commit');
  assert.equal(event.navigation?.sourceDocumentId, navigation.sourceDocumentId);
  assert.equal(event.observedUrl, undefined, 'an unobserved page must not receive the last known source URL');
  assert.doesNotMatch(raw, /private/);
});

test('a collector boundary failure keeps navigation context in the downloadable report', async () => {
  const navigation = { event: 'onCommitted', phase: 'committed', cause: 'unexpected_document',
    sourceDocumentId: '22222222-2222-4222-8222-222222222222', documentId: '33333333-3333-4333-8333-333333333333' };
  const app = await dashboard({ state: createWorkspace(7), async collectBook() {
    throw Object.assign(new Error('Document changed before collection'), { code: 'source_left_page', navigation });
  } });
  await app.elements['collect-book'].click();
  assert.equal(app.elements['download-diagnostics'].hidden, false);
  await app.elements['download-diagnostics'].click();
  const raw = await (await fetch(app.downloads[0].href)).text();
  URL.revokeObjectURL(app.downloads[0].href);
  const event = JSON.parse(raw).events.find(event => event.reason === 'source_left_page');
  assert.equal(event.navigation?.cause, 'unexpected_document');
  assert.equal(event.navigation?.documentId, navigation.documentId);
});

test('a source timeout explains restarting while keeping the last verified title', async () => {
  let timeout = false;
  const app = await dashboard({ onRequest(message) {
    if (message.type === 'GET_NAVIGATION' && timeout) return { ok: false, code: 'source_timeout', error: 'Учебник не отвечает.' };
  } });
  timeout = true; await app.refresh();
  assert.equal(app.elements['source-name'].textContent, 'Old textbook');
  assert.equal(app.elements['reconnect-source'], undefined);
  assert.match(app.elements['collection-status'].textContent, /снова нажмите значок exporter/);
  assert.equal(app.elements['collect-book'].hidden, true);
});


test('cancelling a new preflight uses its request identity rather than the previous collection', async () => {
  const state = failedWorkspace(); state.collectionId = 'previous-run';
  const pending = deferred(), started = deferred();
  const app = await dashboard({ state, workspaceId: 'saved-book', onRequest(message) {
    if (message.type === 'RESOLVE_WORKSPACE') return { ok: true, workspaceId: 'saved-book', sourceTabId: 7, book: { title: 'Old textbook', rootUrl: bookUrl(71) } };
  }, async collectBook() { started.resolve(); await pending.promise; return { status: 'cancelled' }; } });
  const running = app.elements['collect-book'].click();
  await started.promise;
  await app.elements['cancel-collection'].click();
  const cancelled = app.requests.find(message => message.type === 'CANCEL_COLLECTION');
  assert.equal(cancelled.collectionId, undefined);
  assert.match(cancelled.requestId, /^[a-f0-9-]{36}$/);
  pending.resolve(); await running;
});
