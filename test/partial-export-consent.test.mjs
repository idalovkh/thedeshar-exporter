import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { buildZipBlob, MAX_ARCHIVE_BYTES } from '../src/lib/archive.js';
import { buildCoverage } from '../src/lib/coverage.js';
import { archiveFilename } from '../src/lib/download-name.js';
import { exportReadiness, assertExportReady, assertExportFilesReady } from '../src/lib/export-readiness.js';
import { exportFileProblems } from '../src/lib/export-file-problems.js';
import { createExportPackage, replacePackageAssets, assertAssetCapacity } from '../src/lib/package.js';
import { createProblemReportStore } from '../src/lib/problem-report-store.js';
import { createWorkspace, isSourceUrl } from '../src/lib/state.js';
import { collectAssets, mediaOrigins, downloadMediaAssets } from '../src/ui/assets.js';
import { createProblemReporter } from '../src/ui/problem-report.js';
import { getView } from '../src/ui/view.js';
import { prepareDiskExport } from '../src/ui/export-record-stream.js';
import { writeZipFile } from '../src/lib/archive-stream.js';
import { memoryExportSpool, memorySavePicker } from './export-file-fixture.js';
import { createExportResources } from '../src/lib/export-resources.js';
import { sourceConnectionView, collectionLoadingDetail, collectionFailureNotice, sourceSetupMessage } from '../src/ui/source-status-view.js';
import { navigationErrorCode } from '../src/lib/source-navigation-errors.js';
import { navigationDiagnostic } from '../src/lib/navigation-diagnostics.js';
import { exporterBindingDiagnostic } from '../src/lib/exporter-binding-diagnostics.js';

const shippingSource = (await readFile(new URL('../src/ui/exporter.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
const consentSource = (await readFile(new URL('../src/ui/partial-export-consent.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const html = await readFile(new URL('../exporter.html', import.meta.url), 'utf8');
const root = 'https://progressme.ru/cabinet/school/materials/book/71/content';
const section = 'https://progressme.ru/lesson-editor/book/71/lesson/5/section/6';
const broken = 'https://cdn.example.org/broken.jpg';
const healthy = 'https://cdn.example.org/listen.mp3';
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle() { for (let index = 0; index < 8; index++) await tick(); }
async function waitFor(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'The shipping UI did not reach its expected asynchronous boundary');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  await settle();
}

class Element {
  constructor(id = '') {
    this.id = id; this.children = []; this.hidden = false; this.disabled = false; this.open = false; this.returnValue = '';
    this.textContent = ''; this.dataset = {}; this.style = {}; this.attributes = new Map(); this.listeners = new Map();
    this.modalCount = 0;
    const classes = new Set();
    this.classList = { toggle(name, force) { if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) };
  }
  addEventListener(type, callback) { this.listeners.set(type, [...(this.listeners.get(type) || []), callback]); }
  removeEventListener(type, callback) { this.listeners.set(type, (this.listeners.get(type) || []).filter(value => value !== callback)); }
  async dispatch(type, extra = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (const callback of [...(this.listeners.get(type) || [])]) await callback(event);
    if (type === 'cancel' && !event.defaultPrevented) this.close();
    return event;
  }
  async click() { if (!this.hidden && !this.disabled) await this.dispatch('click'); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  querySelector() { return this.step ||= new Element(); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  toggleAttribute(name, force) { if (force ?? !this.hasAttribute(name)) this.setAttribute(name, ''); else this.removeAttribute(name); }
  showModal() { this.open = true; this.modalCount++; }
  close(value = '') { this.returnValue = value; this.open = false; void this.dispatch('close'); }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  remove() {}
}

function workspace(urls) {
  return { ...createWorkspace(7), exportRevision: 0, enabled: false,
    snapshots: [{ url: root, title: 'Consent book', assets: [], warnings: [] },
      { url: section, title: 'Section', blocks: [{ type: 'dom', text: 'Retained source exercise' }], assets: urls, warnings: [] }],
    captures: [{ kind: 'websocket', url: 'wss://proxy.progressme.ru/websocket', pageUrl: section, data: {
      Class: 'GetExerciseWsController', Method: 'LoadExercises', IsSuccess: true, Value: { SectionId: 6, Items: [] },
    } }],
    collection: { rootUrl: root, title: 'Consent book', status: 'finished', failed: [], warnings: [],
      expected: [root, section], visited: [root, section], items: [
        { key: 'lesson-5', kind: 'lesson', lessonId: '5', url: section, status: 'visited' },
        { key: 'section-6', kind: 'section', lessonId: '5', url: section, status: 'visited' },
      ] },
  };
}

// Execute shipping dashboard and consent dialog together. Only Chrome, DOM and
// remote HTTP are fake; downloads, raw hydration, manifests, ZIP and reports are real.
async function dashboard(t, { urls = [broken, healthy], failing = new Set([broken]), downloadFiles, savePicker,
  resourceFactory = createExportResources } = {}) {
  let state = workspace(urls), reporter, timerId = 0;
  const elements = Object.fromEntries([...html.matchAll(/<[a-z][^>]*\bid="([^"]+)"[^>]*>/gi)].map(([tag, id]) => {
    const element = new Element(id);
    element.hidden = /\shidden(?:\s|=|>)/.test(tag);
    element.disabled = /\sdisabled(?:\s|=|>)/.test(tag);
    return [id, element];
  }));
  const requests = [], downloads = [], reported = [], timers = new Map(), attempts = new Map(), memory = {};
  const store = createProblemReportStore({ sessionStorage: {
    async get(key) { return { [key]: structuredClone(memory[key]) }; },
    async set(values) { Object.assign(memory, structuredClone(values)); },
    async remove(key) { delete memory[key]; },
  }, randomUUID: () => `consent-${++timerId}` });
  const document = {
    activeElement: null, hidden: false, body: new Element(), addEventListener() {},
    getElementById: id => elements[id], querySelectorAll: () => Object.values(elements),
    createElement(tag) { const element = new Element(); element.ownerDocument = document; if (tag === 'a') downloads.push(element); return element; },
  };
  for (const element of Object.values(elements)) element.ownerDocument = document;
  const location = { href: 'chrome-extension://test-extension/exporter.html?tab=7&workspace=consent-book' };
  const chrome = {
    runtime: { getManifest: () => ({ version: '0.3.31' }), onMessage: { addListener() {} }, async sendMessage(message) {
      requests.push(structuredClone(message));
      if (message.type === 'RESOLVE_WORKSPACE') return { ok: true, workspaceId: 'consent-book', sourceTabId: 7, book: { title: 'Consent book', rootUrl: root } };
      if (message.type === 'RECORD_DOWNLOAD_RESULT') { state.downloadResult = { loaded: message.loaded, missing: message.missing }; return { ok: true }; }
      if (message.type === 'GET_STATE') return { ok: true, state: structuredClone(state) };
      if (message.type === 'GET_SOURCE') return { ok: true, source: { tabId: 7, url: root, title: 'Consent book' } };
      if (message.type === 'GET_NAVIGATION') return { ok: true, navigation: { kind: 'book', url: root, title: 'Consent book' } };
      if (message.type === 'GET_EXPORT_INFO') return { ok: true, revision: 0, snapshotCount: state.snapshots.length, captureCount: state.captures.length };
      if (message.type === 'GET_EXPORT_RECORDS') {
        const rows = state[message.kind], records = rows.slice(message.offset, message.offset + message.limit);
        return { ok: true, revision: 0, total: rows.length, records: structuredClone(records), nextOffset: message.offset + records.length };
      }
      if (message.type === 'GET_PROBLEM_REPORT') return { ok: true, ...await store.get(7) };
      if (message.type === 'BEGIN_PROBLEM_REPORT') return { ok: true, ...await store.begin(7, { ...message, ownerTabId: 17 }) };
      if (message.type === 'APPEND_PROBLEM_EVENTS') return { ok: true, ...await store.append(7, { ...message, ownerTabId: 17 }) };
      throw new Error(`Unexpected Chrome request: ${message.type}`);
    } },
    tabs: { onUpdated: { addListener() {} }, query: async () => [{ id: 7, url: root, title: 'Consent book' }] },
    permissions: { request: async () => true, contains: async () => true },
  };
  const context = vm.createContext({
    document, chrome, location, history: { replaceState(_state, _unused, value) { location.href = String(value); } },
    window: { addEventListener() {} }, confirm: () => true,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id),
    URL, Intl, AbortController, DOMException, structuredClone, Blob, Uint8Array, crypto: globalThis.crypto,
    showSaveFilePicker: savePicker || memorySavePicker(downloads), createExportSpool: async () => memoryExportSpool(), prepareDiskExport, writeZipFile, createExportResources: resourceFactory,
    getView, isSourceUrl, buildCoverage, exportReadiness, assertExportReady, assertExportFilesReady, exportFileProblems,
    sourceConnectionView, collectionLoadingDetail, collectionFailureNotice, sourceSetupMessage, navigationErrorCode, navigationDiagnostic, exporterBindingDiagnostic, hydrateSourceOrigins: async () => {},
    collectAssets, mediaOrigins, archiveFilename, assertAssetCapacity,
    createExportPackage, replacePackageAssets, MAX_ARCHIVE_BYTES, buildZipBlob,
    collectBook: async () => { throw new Error('Consent must not recollect source pages'); },
    createProblemReporter(options) { reporter = createProblemReporter(options); return reporter; },
    downloadProblemReport(report) { reported.push(report); },
    downloadExportMedia: downloadFiles || ((candidates, options) => downloadMediaAssets(candidates, { ...options, retryDelayMs: 0,
      fetchFile: async url => {
        attempts.set(url, (attempts.get(url) || 0) + 1);
        return failing.has(url) ? new Response('<Error/>', { status: 500, headers: { 'content-type': 'application/xml' } })
          : new Response('retained audio bytes', { headers: { 'content-type': 'audio/mpeg' } });
      },
    })),
  });
  vm.runInContext(consentSource, context, { filename: 'partial-export-consent.js' });
  vm.runInContext(shippingSource, context, { filename: 'exporter.js' });
  await settle();
  t.after(() => { reporter?.clear(); for (const file of downloads) if (file.href) URL.revokeObjectURL(file.href); });
  return { elements, requests, downloads, reported, attempts, document,
    state: () => structuredClone(state), report: () => reporter.snapshot(),
    async refresh() {
      for (const [id, timer] of [...timers]) if (timer.delay < 1000) { timers.delete(id); timer.callback(); }
      await waitFor(() => elements['partial-export-dialog'].open || !elements['pending-status'].textContent);
    },
    async start() {
      await elements.export.click();
      await waitFor(() => elements['partial-export-dialog'].open || !elements['pending-status'].textContent ||
        [...timers.values()].some(timer => timer.delay === 0));
    },
  };
}

async function zipEntries(download) {
  const bytes = new Uint8Array(await (await fetch(download.href)).arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), entries = new Map();
  for (let at = 0; view.getUint32(at, true) === 0x04034b50;) {
    const size = view.getUint32(at + 18, true), nameLength = view.getUint16(at + 26, true), extraLength = view.getUint16(at + 28, true);
    const start = at + 30 + nameLength + extraLength;
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLength));
    entries.set(name, bytes.subarray(start, start + size));
    at = start + size;
  }
  return entries;
}

test('three missing files fail without a consent override or saved ZIP', async t => {
  const urls = ['a', 'b', 'c'].map(name => `https://cdn.example.org/${name}.jpg`);
  const app = await dashboard(t, { urls, failing: new Set(urls) });
  await app.start();
  assert.equal(app.elements['partial-export-dialog'].modalCount, 0);
  assert.equal(app.downloads.length, 0);
  assert.equal(app.elements.message.classList.contains('error'), true);
  assert.match(app.elements.message.textContent, /не более двух/);
  assert.equal(app.elements['download-diagnostics'].hidden, false);
  await app.elements['partial-export-accept'].click();
  assert.equal(app.downloads.length, 0);
});

test('a failed ZIP commit gives a Russian error and never records a completed download', async t => {
  const app = await dashboard(t, { urls: [healthy], failing: new Set(), savePicker: async () => ({
    getFile() { throw Error('Uncommitted file must not be read'); },
    async createWritable() { return { async write() {}, async seek() {}, async abort() {},
      async close() { throw new DOMException('Native quota details', 'QuotaExceededError'); } }; },
  }) });
  await app.start();
  assert.equal(app.downloads.length, 0);
  assert.equal(app.requests.some(request => request.type === 'RECORD_DOWNLOAD_RESULT'), false);
  assert.match(app.elements.message.textContent, /Не удалось сохранить ZIP/);
  assert.doesNotMatch(app.elements.message.textContent, /Native quota/);
  assert.equal((await app.report()).events.at(-1).reason, 'zip_write');
});

test('critical memory pressure is an error rather than a manual cancellation', async t => {
  const failure = Object.assign(new Error('Компьютеру не хватает свободной памяти.'), { code: 'export_resources' });
  const app = await dashboard(t, { resourceFactory(options) {
    options.onPressure(failure);
    return { async sample() { throw failure; }, close() {} };
  } });
  await app.start();
  assert.equal(app.downloads.length, 0);
  assert.equal(app.elements.message.classList.contains('error'), true);
  assert.match(app.elements.message.textContent, /не хватает свободной памяти/);
  assert.doesNotMatch(app.elements.message.textContent, /Скачивание отменено/);
  assert.equal((await app.report()).events.at(-1).reason, 'export_resources');
});

test('native save-picker failures are understandable and happen before downloading media', async t => {
  const app = await dashboard(t, { savePicker: async () => { throw new DOMException('Native permission policy details', 'SecurityError'); } });
  await app.start();
  assert.match(app.elements.message.textContent, /Не удалось выбрать файл ZIP/);
  assert.doesNotMatch(app.elements.message.textContent, /Native permission/);
  assert.equal(app.requests.some(request => request.type === 'GET_EXPORT_RECORDS'), false);
  assert.equal(app.attempts.size, 0);
  assert.equal((await app.report()).events.at(-1).reason, 'file_save_unavailable');
});

test('failed file waits for explicit consent, offers a problem report, then packages retained files with a warning', async t => {
  const app = await dashboard(t);
  await app.start();
  const dialog = app.elements['partial-export-dialog'];
  assert.equal(app.attempts.get(broken), 3);
  assert.equal(dialog.open, true);
  assert.equal(app.downloads.length, 0, 'A ZIP must not be created before agreement');
  const modalHtml = html.match(/<dialog\b[^>]*id="partial-export-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
  assert.match(modalHtml, /Не все файлы удалось получить из исходной книги\. Архив сохранится без них\./);
  assert.doesNotMatch(modalHtml, /partial-export-files|HTTP|JSON|Full HD/);
  assert.match(modalHtml, /id="partial-export-accept"[^>]*>Скачать<\/button>/);
  assert.match(modalHtml, /сообщ|поддержк|переда/i);
  assert.match(modalHtml, /После переноса рекомендуем проверить книгу\./, 'The notice recommends reviewing the transferred book');
  assert.equal(app.elements['partial-export-files'], undefined, 'Technical file details belong in the report');
  await app.elements['partial-export-report'].click();
  assert.equal(app.reported.length, 1);
  assert.equal(app.reported[0].downloadSummary.failed, 1);
  const failure = app.reported[0].events.find(event => event.assetId && event.status === 'failed');
  assert.equal(failure.url, broken);
  assert.equal(failure.sourcePage, section);
  assert.equal(failure.reason, 'http_error');
  assert.equal(failure.httpStatus, 500);
  assert.equal(failure.mimeType, 'application/xml');
  assert.equal(failure.attempt, 3);
  assert.equal(failure.receivedBytes, 0);
  assert.ok(failure.elapsedMs >= 0);
  assert.equal(dialog.open, true, 'Saving the problem report does not consent to missing files');
  assert.equal(app.downloads.length, 0);
  await app.elements['partial-export-accept'].click();
  await app.refresh();
  assert.equal(dialog.open, false);
  assert.equal(app.downloads.length, 1);
  const entries = await zipEntries(app.downloads[0]);
  const manifest = JSON.parse(new TextDecoder().decode(entries.get('manifest.json')));
  const missing = manifest.inventory.assets.find(asset => asset.url === broken);
  const retained = manifest.inventory.assets.find(asset => asset.url === healthy);
  assert.equal(missing.file, null);
  assert.equal(missing.status, 'failed');
  assert.match(missing.error, /сервер|недоступен/i);
  assert.equal(manifest.completeness.missingAssets, 1);
  assert.equal(manifest.counts.downloadedAssets, 1);
  assert.equal(new TextDecoder().decode(entries.get(retained.file)), 'retained audio bytes');
  assert.equal(app.elements['missing-files'].hidden, false);
  assert.match(app.elements['capture-status'].textContent, /проблем|пропуск/i);
  const report = await app.report();
  assert.equal(report.status, 'finished');
  assert.equal(report.stage, 'export');
  assert.equal(report.downloadSummary.failed, 1);
});

for (const dismissal of ['partial-export-cancel', 'escape']) {
  test(`declining partial export preserves collected materials and permits retry: ${dismissal}`, async t => {
    const app = await dashboard(t), before = app.state();
    await app.start();
    if (dismissal === 'escape') await app.elements['partial-export-dialog'].dispatch('cancel');
    else await app.elements[dismissal].click();
    await app.refresh();
    assert.equal(app.elements['partial-export-dialog'].open, false);
    assert.equal(app.downloads.length, 0);
    assert.deepEqual(app.state(), before);
    assert.equal(app.elements.export.disabled, false);
    await app.start();
    assert.equal(app.elements['partial-export-dialog'].open, true, 'Every retry requires fresh consent');
    await app.elements['partial-export-cancel'].click();
  });
}

test('aborting while the modal is open prevents a late consent from saving a ZIP', async t => {
  const app = await dashboard(t);
  await app.start();
  await app.elements.cancel.click();
  await app.refresh();
  assert.equal(app.elements['partial-export-dialog'].open, false);
  await app.elements['partial-export-accept'].dispatch('click');
  await app.refresh();
  assert.equal(app.downloads.length, 0);
  assert.equal(app.state().snapshots.length, 2);
});


for (const kind of ['omitted-result', 'duplicate-result', 'empty-downloaded']) {
  test(`invalid downloader output cannot be approved as an ordinary missing file: ${kind}`, async t => {
    const app = await dashboard(t, { downloadFiles: async candidates => {
      const valid = candidates.map(asset => ({ ...asset, status: 'downloaded', data: new Blob(['valid']) }));
      if (kind === 'omitted-result') return valid.slice(1);
      if (kind === 'duplicate-result') return [valid[0], valid[0]];
      return valid.map(asset => ({ ...asset, data: new Blob() }));
    } });
    await app.start(); await app.refresh();
    assert.equal(app.downloads.length, 0);
    assert.equal(app.elements['partial-export-dialog'].modalCount, 0);
    assert.equal(app.elements.message.classList.contains('error'), true);
  });
}

test('a complete download saves the archive without asking to accept missing files', async t => {
  const app = await dashboard(t, { urls: [healthy], failing: new Set() });
  await app.start(); await app.refresh();
  assert.equal(app.elements['partial-export-dialog'].modalCount, 0);
  assert.equal(app.downloads.length, 1);
  assert.equal(app.elements['missing-files'].hidden, true);
});

test('failure to open the consent dialog is reported as an error and cannot save a ZIP', async t => {
  const app = await dashboard(t);
  app.elements['partial-export-dialog'].showModal = () => { throw new Error('Native dialog unavailable'); };
  await app.start(); await app.refresh();
  assert.equal(app.downloads.length, 0);
  assert.equal(app.elements.message.classList.contains('error'), true);
  assert.match(app.elements.message.textContent, /Native dialog unavailable/);
  assert.equal(app.elements.export.disabled, false);
  assert.equal((await app.report()).status, 'failed');
  await app.elements['partial-export-accept'].dispatch('click');
  await app.refresh();
  assert.equal(app.downloads.length, 0, 'A failed dialog must release its approval handler');
});

test('declining the consent dialog restores keyboard focus to the control that opened it', async t => {
  const app = await dashboard(t);
  app.elements.export.focus();
  await app.start();
  assert.equal(app.document.activeElement, app.elements['partial-export-cancel']);
  await app.elements['partial-export-cancel'].click();
  await app.refresh();
  assert.equal(app.downloads.length, 0);
  assert.equal(app.document.activeElement, app.elements.export);
});
