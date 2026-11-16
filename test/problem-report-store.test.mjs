import assert from 'node:assert/strict';
import test from 'node:test';
import { createProblemReportStore } from '../src/lib/problem-report-store.js';

const at = '2026-11-11T20:54:00.000Z';
const book = { title: 'Учебник', rootUrl: 'https://progressme.ru/cabinet/school/materials/book/71/content' };
function harness() {
  const values = {};
  let sequence = 0;
  const options = { sessionStorage: { get: async key => ({ [key]: structuredClone(values[key]) }),
    set: async value => Object.assign(values, structuredClone(value)), remove: async key => { delete values[key]; } },
  randomUUID: () => `report-token-${++sequence}`, now: () => at };
  return { values, options, store: createProblemReportStore(options) };
}

test('reports survive a store restart, keep collection history and replace the previous download attempt', async () => {
  const app = harness();
  const collection = await app.store.begin(7, { ownerTabId: 99, kind: 'collection', book, extensionVersion: '0.3.22' });
  await app.store.append(7, { ownerTabId: 99, ...collection, events: [{ at, stage: 'save_page', status: 'saved', url: book.rootUrl }] });
  const first = await app.store.begin(7, { ownerTabId: 99, kind: 'download', book });
  assert.equal(first.reportId, collection.reportId);
  assert.notEqual(first.attemptId, collection.attemptId);
  await app.store.append(7, { ownerTabId: 99, ...first, events: [{ at, stage: 'files', status: 'failed', assetId: 'asset-1', reason: 'unsupported_content_type' }] });
  const reopened = createProblemReportStore(app.options);
  assert.equal((await reopened.get(7)).report.downloadSummary.failed, 1);
  const second = await reopened.begin(7, { ownerTabId: 100, kind: 'download', book });
  assert.equal(second.reportId, collection.reportId);
  assert.equal(second.report.events.some(event => event.stage === 'save_page'), true);
  assert.equal(second.report.events.some(event => event.reason === 'unsupported_content_type'), false);
  assert.equal(second.report.downloadSummary.failed, 0);
  assert.equal(await reopened.get(8), null);
});

test('foreign owners and superseded attempts cannot replace the latest report', async () => {
  const app = harness();
  const old = await app.store.begin(7, { ownerTabId: 99, kind: 'download', book });
  const current = await app.store.begin(7, { ownerTabId: 100, kind: 'download', book });
  for (const input of [{ ownerTabId: 99, ...old }, { ownerTabId: 99, ...current },
    { ownerTabId: 100, reportId: 'wrong', attemptId: current.attemptId }]) {
    await assert.rejects(app.store.append(7, { ...input, events: [{ at, stage: 'files', status: 'failed' }] }), { code: 'stale_problem_report' });
  }
  await app.store.clear(7);
  assert.equal(await app.store.get(7), null);
  await assert.rejects(app.store.append(7, { ownerTabId: 100, ...current, events: [] }), { code: 'stale_problem_report' });
});

test('a new collection or book replaces prior events and clears old download counters', async () => {
  const app = harness();
  const first = await app.store.begin(7, { ownerTabId: 99, kind: 'download', book });
  await app.store.append(7, { ownerTabId: 99, ...first, events: [{ at, stage: 'files', status: 'failed', assetId: 'asset-1' }] });
  const next = await app.store.begin(7, { ownerTabId: 99, kind: 'collection', book });
  assert.equal(next.reportId, first.reportId);
  assert.equal(next.report.downloadSummary.failed, 0);
  assert.equal(next.report.events.some(event => event.assetId === 'asset-1'), false);
  const other = await app.store.begin(7, { ownerTabId: 99, kind: 'download', book: { ...book, rootUrl: book.rootUrl.replace('/71/', '/72/') } });
  assert.equal(other.report.book.rootUrl.includes('/72/'), true);
  assert.equal(other.report.events.some(event => event.stage === 'book'), false);
});

test('reset waits for an in-flight session write then removes it before any late callback can restore it', async () => {
  const app = harness();
  const first = await app.store.begin(7, { ownerTabId: 99, kind: 'download', book });
  let release, started;
  const writing = new Promise(resolve => { started = resolve; });
  const originalSet = app.options.sessionStorage.set;
  app.options.sessionStorage.set = async value => {
    started();
    await new Promise(resolve => { release = resolve; });
    await originalSet(value);
  };
  const append = app.store.append(7, { ownerTabId: 99, ...first, events: [{ at, stage: 'files', status: 'failed', assetId: 'asset-1' }] });
  const rejected = assert.rejects(append, { code: 'stale_problem_report' });
  await writing;
  const cleared = app.store.clear(7);
  release();
  await rejected;
  await cleared;
  assert.equal(await app.store.get(7), null);
});

test('a failed diagnostic removal stays cleared in the current worker and refuses old attempt events', async () => {
  const app = harness();
  const first = await app.store.begin(7, { ownerTabId: 99, kind: 'download', book });
  app.options.sessionStorage.remove = async () => { throw new Error('Session storage unavailable'); };
  await assert.rejects(app.store.clear(7), /storage unavailable/);
  assert.equal(await app.store.get(7), null);
  await assert.rejects(app.store.append(7, { ownerTabId: 99, ...first,
    events: [{ at, stage: 'files', status: 'failed' }] }), { code: 'stale_problem_report' });
  const current = await app.store.begin(7, { ownerTabId: 99, kind: 'download', book });
  assert.equal((await app.store.get(7)).attemptId, current.attemptId);
});

test('adopting a legacy report preserves it once and cannot resurrect a cleared workspace report', async () => {
  const app = harness();
  const legacy = await app.store.begin(7, { ownerTabId: 99, kind: 'download', book });
  await app.store.adopt(7, 'workspace-book-71');
  assert.equal((await app.store.get('workspace-book-71')).reportId, legacy.reportId);
  await app.store.clear('workspace-book-71');
  const restarted = createProblemReportStore(app.options);
  await restarted.adopt(7, 'workspace-book-71');
  assert.equal(await restarted.get('workspace-book-71'), null);
  assert.equal((await restarted.get(7)).reportId, legacy.reportId, 'The original record remains intact');
});
