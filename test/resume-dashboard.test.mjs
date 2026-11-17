import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import { getView } from '../src/ui/view.js';
import { isSourceUrl } from '../src/lib/state.js';
import { exportReadiness } from '../src/lib/export-readiness.js';
import { sourceConnectionView, collectionLoadingDetail, collectionFailureNotice, sourceSetupMessage } from '../src/ui/source-status-view.js';
import { navigationErrorCode } from '../src/lib/source-navigation-errors.js';
import { navigationDiagnostic } from '../src/lib/navigation-diagnostics.js';
import { exporterBindingDiagnostic } from '../src/lib/exporter-binding-diagnostics.js';
import { resumeBook, resumeSection, savedResumeState } from './resume-ui-fixture.js';
import { createSourceReplacement } from '../src/ui/source-replacement.js';

const source = (await readFile(new URL('../src/ui/exporter.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
const html = await readFile(new URL('../exporter.html', import.meta.url), 'utf8');
const settle = async () => { for (let count = 0; count < 8; count++) await new Promise(resolve => setImmediate(resolve)); };

async function dashboard({ deniedRestart = false, sourceUrl = resumeBook, sourceStatus = 'same_book', locked = false, sourceError = null, dropped = 0, enabled = false } = {}) {
  class Element {
    constructor(id) { this.id = id; this.dataset = {}; this.style = {}; this.attributes = new Map(); this.listeners = new Map(); this.classList = { toggle() {} }; }
    addEventListener(type, action) { this.listeners.set(type, action); }
    setAttribute(name, value) { this.attributes.set(name, value); }
    removeAttribute(name) { this.attributes.delete(name); }
    hasAttribute(name) { return this.attributes.has(name); }
    toggleAttribute(name, enabled) { if (enabled) this.setAttribute(name, ''); else this.removeAttribute(name); }
    querySelector() { return this.child ||= new Element(); }
    replaceChildren() {}
  }
  const state = savedResumeState(), calls = [], confirmations = [];
  state.collectionLocked = locked;
  state.dropped = dropped;
  state.enabled = enabled;
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new Element(id)]));
  const chrome = {
    runtime: { getManifest: () => ({ version: '0.3.45' }), onMessage: { addListener() {} }, async sendMessage(message) {
      if (message.type === 'RESOLVE_WORKSPACE') return { ok: true, workspaceId: 'workspace-71', sourceTabId: 7,
        bookKey: 'https://progressme.ru/book/71', book: { title: 'Saved book', rootUrl: resumeBook } };
      if (message.type === 'GET_STATE') return { ok: true, state: structuredClone(state) };
      if (message.type === 'GET_SOURCE') return sourceError === 'source_closed' ? { ok: false, code: sourceError } : { ok: true, source: { tabId: 7, url: sourceUrl } };
      if (message.type === 'GET_SOURCE_STATUS') return { ok: true, sourceStatus: { state: sourceStatus } };
      if (message.type === 'GET_NAVIGATION') return sourceError ? { ok: false, code: sourceError } : { ok: true, navigation: { kind: sourceUrl.includes('/lesson-editor/') ? 'lesson' : 'book', url: sourceUrl, title: 'Saved book' } };
      return { ok: true };
    } },
    tabs: { getCurrent: async () => ({ id: 20 }), update: async () => {}, onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
    permissions: { contains: async () => true },
  };
  const context = vm.createContext({ chrome, URL, Intl, structuredClone, AbortController, crypto: webcrypto,
    location: { href: 'chrome-extension://test-extension/exporter.html?tab=7&workspace=workspace-71', replace() { throw new Error('Unexpected redirect'); } },
    document: { querySelectorAll: () => [...elements.values()], addEventListener() {} }, window: { addEventListener() {} },
    setTimeout: () => 1, clearTimeout() {}, hydrateSourceOrigins: async () => {},
    confirm(message) { confirmations.push(message); return !deniedRestart; },
    createProblemReporter: () => ({ select() {}, clear() {}, available: () => false, load: async () => {}, connectionRecovered() {},
      record() {}, begin: async () => ({ record() {}, flush: async () => {} }) }),
    getView, isSourceUrl, exportReadiness, sourceConnectionView, collectionLoadingDetail, collectionFailureNotice, sourceSetupMessage, createSourceReplacement,
    navigationErrorCode, navigationDiagnostic, exporterBindingDiagnostic, collectAssets: () => [], mediaOrigins: () => [],
    async collectBook(options) { calls.push(options); return structuredClone(state.collection); },
  });
  vm.runInContext(source, context, { filename: 'exporter.js' }); await settle();
  const click = async id => { await elements.get(id).listeners.get('click')({ type: 'click' }); await settle(); };
  return { elements, calls, confirmations, click };
}

test('the primary button resumes without asking to replace the saved capture', async () => {
  const app = await dashboard();
  assert.equal(app.elements.get('collect-label').textContent, 'Продолжить сбор');
  assert.equal(app.elements.get('restart-collection').hidden, false);
  await app.click('collect-book');
  assert.equal(app.calls.length, 1); assert.equal(app.calls[0].mode, 'resume'); assert.equal(app.calls[0].reset, false);
  assert.equal(app.calls[0].resumeState.collection.resume.confirmed.length, 1);
  assert.equal(app.confirmations.length, 0);
});

test('the separate fresh-collection button requires replacement confirmation and sets reset', async () => {
  const app = await dashboard(); await app.click('restart-collection');
  assert.equal(app.confirmations.length, 1); assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].mode, 'new'); assert.equal(app.calls[0].reset, true); assert.equal(app.calls[0].resumeState, null);
  const denied = await dashboard({ deniedRestart: true }); await denied.click('restart-collection');
  assert.equal(denied.calls.length, 0);
});

test('a mismatched source cannot start either resume or replacement even through invoked listeners', async () => {
  const app = await dashboard({ sourceUrl: resumeBook.replace('/71/', '/99/') });
  await app.click('collect-book'); await app.click('restart-collection');
  assert.equal(app.calls.length, 0); assert.equal(app.confirmations.length, 0);
});

test('a paused lesson keeps its resume button visible without allowing destructive restart from that page', async () => {
  for (const sourceUrl of [resumeSection, resumeSection.replace('/section/9', '/section/for-homework')]) {
    const app = await dashboard({ sourceUrl });
    assert.equal(app.elements.get('collect-book').hidden, false);
    assert.equal(app.elements.get('collect-book').disabled, false);
    assert.equal(app.elements.get('collect-label').textContent, 'Продолжить сбор');
    assert.equal(app.elements.get('restart-collection').hidden, true);
    await app.click('restart-collection');
    assert.equal(app.calls.length, 0);
    assert.equal(app.confirmations.length, 0);
    await app.click('collect-book');
    assert.equal(app.calls.length, 1);
    assert.equal(app.calls[0].mode, 'resume');
    assert.equal(app.calls[0].reset, false);
    assert.equal(app.calls[0].resumeState.collection.resume.confirmed.length, 1);
    assert.equal(app.confirmations.length, 0);
  }
});

test('resume from a lesson keeps source availability, status and collection lock guards', async () => {
  for (const options of [{ locked: true }, { dropped: 1 }, { enabled: true }, { sourceStatus: 'loading' }, { sourceStatus: 'different_book' },
    { sourceError: 'source_closed' }, { sourceError: 'source_disconnected' }]) {
    const app = await dashboard({ sourceUrl: resumeSection, ...options });
    assert.equal(app.elements.get('collect-book').hidden, true);
    await app.click('collect-book');
    assert.equal(app.calls.length, 0);
    assert.equal(app.confirmations.length, 0);
  }
});
