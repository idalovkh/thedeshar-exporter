import assert from 'node:assert/strict';
import test from 'node:test';
import { collectAssets, downloadMediaAssets } from '../src/ui/assets.js';
import { createProblemReporter } from '../src/ui/problem-report.js';
import { createProblemReportStore } from '../src/lib/problem-report-store.js';
import { assertExportFilesReady } from '../src/lib/export-readiness.js';

test('a completed collection followed by truncated PNG rejection produces a persisted report that survives UI reload', async () => {
  const memory = {};
  const sessionStorage = {
    async get(key) { return { [key]: structuredClone(memory[key]) }; },
    async set(values) { Object.assign(memory, structuredClone(values)); },
    async remove(key) { delete memory[key]; },
  };
  let id = 0;
  const store = createProblemReportStore({ sessionStorage, randomUUID: () => `report-test-${++id}` });
  const book = { rootUrl: 'https://progressme.ru/cabinet/school/materials/book/71/content', title: 'Book' };
  const page = 'https://progressme.ru/lesson-editor/book/71/lesson/5/section/6';
  const send = async (tabId, type, payload) => {
    if (type === 'BEGIN_PROBLEM_REPORT') return store.begin(tabId, { ...payload, ownerTabId: 17 });
    if (type === 'APPEND_PROBLEM_EVENTS') return store.append(tabId, { ...payload, ownerTabId: 17 });
    if (type === 'GET_PROBLEM_REPORT') return store.get(tabId);
    throw new Error('Unexpected message');
  };
  const reporter = createProblemReporter({ send, extensionVersion: '0.3.22', browserVersion: 'Chrome/130' });
  reporter.select({ tabId: 7, book });
  const collection = await reporter.begin('collection');
  collection.record({ stage: 'finish', status: 'finished', url: book.rootUrl });
  await collection.flush();
  const download = await reporter.begin('download');
  const assets = collectAssets([{ url: page, assets: ['https://cdn.example.org/broken.png'] }]);
  const files = await downloadMediaAssets(assets, { onDiagnostic: download.record,
    fetchFile: async () => new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      { headers: { 'content-type': 'text/plain', 'content-length': '8' } }) });
  assert.throws(() => assertExportFilesReady(files, assets), /Архив не создан/);
  await download.flush();
  const reloaded = createProblemReporter({ send, extensionVersion: '0.3.22' });
  reloaded.select({ tabId: 7, book: { ...book, rootUrl: `${book.rootUrl}/?view=editor#part` } });
  await reloaded.load();
  const report = await reloaded.snapshot();
  assert.equal(report.persisted, true);
  assert.equal(report.downloadSummary.failed, 1);
  assert.ok(report.events.some(event => event.stage === 'finish' && event.status === 'finished'));
  const failure = report.events.find(event => event.reason === 'invalid_png');
  assert.equal(failure.httpStatus, 200);
  assert.equal(failure.mimeType, 'text/plain');
  assert.equal(failure.detectedFormat, 'png');
  assert.equal(failure.sourcePage, page);
  assert.equal(files[0].status, 'failed');
});
