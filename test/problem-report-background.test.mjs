import assert from 'node:assert/strict';
import test from 'node:test';
import { installBackground } from '../src/background.js';
import { createExporterContextFixture } from './exporter-context-fixture.js';
import { createWorkspace } from '../src/lib/state.js';

const at = '2026-11-11T20:54:00.000Z';
const book = { title: 'Учебник', rootUrl: 'https://progressme.ru/cabinet/school/materials/book/71/content' };
const owner = id => ({ id: 'extension', url: 'chrome-extension://extension/exporter.html?tab=7',
  tab: { id, url: 'chrome-extension://extension/exporter.html?tab=7' } });
const sourceSender = { id: 'extension', url: book.rootUrl, frameId: 0, tab: { id: 7, url: book.rootUrl } };
function harness() {
  const sessions = {};
  const records = new Map([[7, { ...createWorkspace(7), exportRevision: 42,
    collection: { status: 'finished', title: book.title, rootUrl: book.rootUrl,
      diagnostics: { version: 1, extensionVersion: '0.3.21', omittedEvents: 3,
        events: [{ at, stage: 'finish', status: 'finished' }] } } }]]);
  const tabs = new Map([[7, { id: 7, url: book.rootUrl }], [99, owner(99).tab], [100, owner(100).tab]]);
  let listener, writes = 0, failReportRemoval = false;
  const chrome = {
    runtime: { id: 'extension', getURL: path => `chrome-extension://extension/${path}`,
      onMessage: { addListener: callback => { listener = callback; } }, sendMessage: async () => {} },
    storage: { session: { get: async key => ({ [key]: structuredClone(sessions[key]) }),
      set: async value => Object.assign(sessions, structuredClone(value)), remove: async key => {
        if (failReportRemoval && key.startsWith('problem-report:')) throw new Error('Session storage unavailable');
        delete sessions[key];
      } } },
    action: { onClicked: { addListener() {} } },
    tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
      get: async id => { if (!tabs.has(id)) throw new Error('Closed'); return tabs.get(id); },
      create: async () => {}, sendMessage: async (_id, message) => ({ ok: true, captureId: message.captureId }) },
  };
  const withExporterDocument = createExporterContextFixture(chrome);
  const install = () => installBackground(chrome, {
    readWorkspace: async id => records.get(id) || createWorkspace(id),
    updateWorkspace: async (id, updater) => { writes++; const state = updater(records.get(id) || createWorkspace(id)); records.set(id, state); return state; },
  });
  install();
  return { records, sessions, tabs, restart: install, failReportRemoval: () => { failReportRemoval = true; }, get writes() { return writes; },
    send: (message, sender = owner(99)) => new Promise(resolve => {
      const pending = listener({ tabId: 7, ...message }, withExporterDocument(sender), resolve);
      if (!pending) resolve(undefined);
    }) };
}

test('diagnostic messages persist safe facts without touching capture revisions and remain readable after source closure', async () => {
  const app = harness();
  const begun = await app.send({ type: 'BEGIN_PROBLEM_REPORT', kind: 'download', book, extensionVersion: '0.3.22', browserVersion: 'Chrome/142.0.0.0' });
  assert.equal(begun.ok, true);
  assert.equal(begun.report.events.some(event => event.stage === 'finish' && event.status === 'finished'), true,
    'A first v2 archive attempt retains the legacy collector diagnostics already committed with the book');
  const saved = await app.send({ type: 'APPEND_PROBLEM_EVENTS', reportId: begun.reportId, attemptId: begun.attemptId,
    events: [{ at, stage: 'files', status: 'failed', assetId: 'asset-0001', reason: 'unsupported_content_type',
      url: 'https://cdn.example.org/file.jpg?token=secret', mimeType: 'text/html', body: 'private body' }] });
  assert.equal(saved.ok, true);
  assert.equal(app.writes, 0, 'Diagnostic writes cannot invalidate an export revision');
  assert.equal(app.records.get(7).exportRevision, 42);
  app.tabs.delete(7);
  app.restart();
  const read = await app.send({ type: 'GET_PROBLEM_REPORT' });
  assert.equal(read.reportId, begun.reportId);
  assert.equal(read.attemptId, begun.attemptId);
  assert.equal(read.report.downloadSummary.failed, 1);
  assert.equal(read.report.collection.omittedEvents, 3);
  assert.doesNotMatch(JSON.stringify(read.report), /secret|private body/);
});

test('source scripts, foreign extensions, moved exporter tabs and another collection owner cannot write reports', async () => {
  const app = harness();
  for (const sender of [sourceSender, { ...owner(99), id: 'foreign-extension' }]) {
    const result = await app.send({ type: 'BEGIN_PROBLEM_REPORT', kind: 'download', book }, sender);
    assert.equal(result.ok, false);
  }
  app.tabs.set(99, { id: 99, url: 'chrome-extension://extension/exporter.html?tab=8' });
  assert.equal((await app.send({ type: 'BEGIN_PROBLEM_REPORT', kind: 'download', book })).ok, false);
  app.tabs.set(99, owner(99).tab);
  assert.equal((await app.send({ type: 'BEGIN_PROBLEM_REPORT', kind: 'collection', book })).ok, false,
    'A collection report cannot overwrite a report without an accepted collector lease');
  const lease = await app.send({ type: 'BEGIN_COLLECTION' });
  assert.equal(lease.ok, true);
  assert.equal((await app.send({ type: 'BEGIN_PROBLEM_REPORT', kind: 'collection', book }, owner(100))).ok, false);
});

test('stale attempts and mismatched books are refused while a saved old book remains reportable', async () => {
  const app = harness();
  const first = await app.send({ type: 'BEGIN_PROBLEM_REPORT', kind: 'download', book });
  const second = await app.send({ type: 'BEGIN_PROBLEM_REPORT', kind: 'download', book }, owner(100));
  assert.equal((await app.send({ type: 'APPEND_PROBLEM_EVENTS', reportId: first.reportId, attemptId: first.attemptId,
    events: [{ at, stage: 'files', status: 'failed' }] })).code, 'stale_problem_report');
  const otherBook = { ...book, rootUrl: book.rootUrl.replace('/71/', '/72/') };
  assert.equal((await app.send({ type: 'BEGIN_PROBLEM_REPORT', kind: 'download', book: otherBook })).ok, false);
  app.tabs.set(7, { id: 7, url: otherBook.rootUrl });
  assert.equal((await app.send({ type: 'APPEND_PROBLEM_EVENTS', reportId: second.reportId, attemptId: second.attemptId,
    events: [{ at, stage: 'files', status: 'failed', assetId: 'asset-1' }] }, owner(100))).ok, true);
});

test('accepted collection clear keeps its new report, but user reset removes it and rejects late events', async () => {
  const app = harness();
  const lease = await app.send({ type: 'BEGIN_COLLECTION' });
  const report = await app.send({ type: 'BEGIN_PROBLEM_REPORT', kind: 'collection', book });
  assert.equal(report.ok, true);
  assert.equal((await app.send({ type: 'CLEAR_CAPTURE', collectionId: lease.collectionId })).ok, true);
  assert.equal((await app.send({ type: 'GET_PROBLEM_REPORT' })).reportId, report.reportId);
  assert.equal((await app.send({ type: 'RESET_CAPTURE', book })).ok, true);
  assert.equal((await app.send({ type: 'GET_PROBLEM_REPORT' })).report, null);
  assert.equal((await app.send({ type: 'APPEND_PROBLEM_EVENTS', reportId: report.reportId, attemptId: report.attemptId,
    events: [{ at, stage: 'files', status: 'failed' }] })).code, 'stale_problem_report');
});

test('a diagnostic cleanup failure cannot turn a committed capture reset into a failed reset', async () => {
  const app = harness();
  assert.equal((await app.send({ type: 'BEGIN_PROBLEM_REPORT', kind: 'download', book })).ok, true);
  app.failReportRemoval();
  const reset = await app.send({ type: 'RESET_CAPTURE', book });
  assert.equal(reset.ok, true);
  assert.equal(reset.diagnosticStorageError, true);
  assert.equal(reset.state.collection, undefined);
  assert.equal((await app.send({ type: 'GET_PROBLEM_REPORT' })).report, null);
});
