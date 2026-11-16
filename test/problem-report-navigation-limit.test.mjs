import assert from 'node:assert/strict';
import test from 'node:test';
import { appendCollectionDiagnostic, createCollectionDiagnostics, recordCollectionFailure } from '../src/lib/collection-diagnostics.js';
import { appendProblemEvent, createProblemReport, MAX_PROBLEM_REPORT_BYTES, problemReportForDownload } from '../src/lib/problem-report.js';

const at = '2026-11-16T00:00:00.000Z';
const url = 'https://progressme.ru/lesson-editor/book/1234567890/lesson/1234567890/section/1234567890';
const step = { event: 'onBeforeNavigate', phase: 'committed', cause: 'navigation_after_commit',
  sourceDocumentId: '22222222-2222-4222-8222-222222222222', documentId: '33333333-3333-4333-8333-333333333333',
  currentDocumentId: '33333333-3333-4333-8333-333333333333', expectedUrl: url, observedUrl: url,
  attempt: 1, timeStamp: 1794780000000 };
const navigation = { ...step, events: Array.from({ length: 32 }, () => step) };
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;

test('nested navigation history cannot bypass the report byte limit or lose its final failure', () => {
  const collection = createCollectionDiagnostics('0.3.40');
  collection.omittedEvents = 3;
  const earlierFailure = { at, stage: 'book', status: 'failed', reason: 'source_network_error',
    url: url.replace('/section/1234567890', '/section/2'), navigation };
  appendCollectionDiagnostic(collection, earlierFailure);
  for (let index = 0; index < 198; index++) appendCollectionDiagnostic(collection, {
    at, stage: 'book', status: 'waiting', url, navigation,
  });
  const failure = { at, stage: 'book', status: 'failed', reason: 'source_left_page', url, navigation };
  appendCollectionDiagnostic(collection, failure);
  recordCollectionFailure(collection, failure);
  const original = JSON.stringify(collection);
  let report = createProblemReport({ startedAt: at, collectionDiagnostics: collection });
  assert.ok(bytes(report) <= MAX_PROBLEM_REPORT_BYTES, 'nested collection metadata must fit the whole report limit');
  assert.ok(report.collection.omittedEvents > 3);
  assert.equal(report.collection.omittedEvents + report.collection.events.length, 203);
  assert.equal(report.collection.failure.navigation.events.length, 32);
  assert.equal(report.collection.failure.navigation.cause, 'navigation_after_commit');
  assert.equal(report.collection.events.at(-1).reason, 'source_left_page');
  assert.ok(report.collection.events.some(event => event.url === earlierFailure.url && event.status === 'failed'),
    'a unique earlier failure is retained before successful/repeated observations');
  assert.equal(JSON.stringify(collection), original, 'report compaction cannot mutate retained collection diagnostics');
  for (let index = 0; index < 40; index++) {
    report = appendProblemEvent(report, { at, stage: 'files', status: index % 2 ? 'downloaded' : 'started',
      assetId: `asset-${Math.floor(index / 2)}`, declaredBytes: 10, receivedBytes: 10 });
    assert.ok(bytes(report) <= MAX_PROBLEM_REPORT_BYTES, 'cached sizes must remain correct after compaction');
  }
  report = problemReportForDownload(JSON.parse(JSON.stringify(report)));
  assert.ok(bytes(report) <= MAX_PROBLEM_REPORT_BYTES);
  assert.equal(report.downloadSummary.downloaded, 20);
  assert.equal(report.downloadSummary.attempts, 20);
  assert.equal(report.collection.failure.navigation.events.length, 32);
});
