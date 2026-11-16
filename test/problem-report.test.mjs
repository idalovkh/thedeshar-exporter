import assert from 'node:assert/strict';
import test from 'node:test';
import { createProblemReport, appendProblemEvent, problemReportForDownload, legacyProblemReport,
  MAX_PROBLEM_REPORT_BYTES } from '../src/lib/problem-report.js';

const book = { title: 'Учебник', rootUrl: 'https://progressme.ru/cabinet/school/materials/book/71/content' };
const at = '2026-11-11T20:54:00.000Z';

test('legacy manual cancellation remains cancellation when restored as a problem report', () => {
  const report = legacyProblemReport({ book, collectionDiagnostics: {
    version: 1, events: [], failure: { stage: 'save_page', reason: 'cancelled' },
  } });
  assert.equal(report.status, 'cancelled');
});

test('problem reports retain diagnostic facts and remove credentials, response bodies and private payloads', () => {
  const initial = createProblemReport({ extensionVersion: '0.3.22', browserVersion: 'Chrome/142.0.0.0', book,
    startedAt: at, stage: 'files', status: 'started', headers: { authorization: 'secret' } });
  const report = appendProblemEvent(initial, { at, stage: 'files', status: 'failed', reason: 'unsupported_content_type',
    url: 'https://user:password@cdn.example.org/files/photo.jpg?token=download-secret&size=50#private',
    sourcePage: book.rootUrl + '?session=source-secret', assetId: 'asset-0042', attempt: 1,
    httpStatus: 200, mimeType: 'text/html; charset=UTF-8', declaredBytes: 123, receivedBytes: 0,
    elapsedMs: 12, detectedFormat: 'html', body: '<html>private response</html>',
    headers: { cookie: 'private cookie' }, error: 'secret private error', student: { name: 'Private Student' } });
  assert.equal(initial.events.length, 0, 'Appending cannot mutate a retained report snapshot');
  const clean = problemReportForDownload(report);
  assert.equal(clean.version, 2);
  assert.equal(clean.events[0].url, 'https://cdn.example.org/files/photo.jpg');
  assert.equal(clean.events[0].sourcePage, book.rootUrl);
  assert.equal(clean.events[0].httpStatus, 200);
  assert.equal(clean.events[0].mimeType, 'text/html');
  assert.equal(clean.events[0].detectedFormat, 'html');
  assert.equal(clean.downloadSummary.failed, 1);
  assert.doesNotMatch(JSON.stringify(clean), /password|secret|private|cookie|Student|authorization|<html>/);
});

test('invalid event fields cannot smuggle arbitrary content into a report', () => {
  let report = createProblemReport({ book, extensionVersion: 'Bearer secret', browserVersion: 'full user agent secret', startedAt: at });
  report = appendProblemEvent(report, { at, stage: 'files', status: 'failed', reason: 'my password is secret',
    assetId: 'secret value', httpStatus: 900, mimeType: '<html>secret</html>', detectedFormat: 'secret',
    url: 'https://127.0.0.1/private?secret=1', sourcePage: 'javascript:secret', attempt: -1, receivedBytes: Infinity });
  const clean = problemReportForDownload(report);
  assert.equal(clean.extensionVersion, 'unknown');
  assert.equal(clean.browserVersion, 'unknown');
  assert.deepEqual(clean.events, [{ at, stage: 'files', status: 'failed' }]);
  assert.equal(problemReportForDownload({ version: 1, events: [] }), null);
});

test('bounded reports omit old successes before failures and keep download totals after trimming', () => {
  let report = createProblemReport({ book, startedAt: at, stage: 'files' });
  for (let index = 0; index < 1800; index++) report = appendProblemEvent(report, {
    at, stage: 'files', status: 'downloaded', assetId: `asset-${index}`, attempt: 1, receivedBytes: 5,
    url: `https://cdn.example.org/${'a'.repeat(800)}/${index}.jpg`,
  });
  for (let index = 0; index < 1300; index++) report = appendProblemEvent(report, {
    at, stage: 'files', status: 'failed', reason: 'unsupported_content_type', assetId: `asset-failed-${index}`, attempt: 1,
    url: `https://cdn.example.org/${'b'.repeat(800)}/${index}.jpg`, mimeType: 'text/html',
  });
  report = appendProblemEvent(report, { at, stage: 'zip', status: 'failed', reason: 'incomplete_export' });
  const clean = problemReportForDownload(report);
  assert.ok(new TextEncoder().encode(JSON.stringify(clean)).byteLength <= MAX_PROBLEM_REPORT_BYTES);
  assert.ok(clean.omittedEvents > 0);
  assert.equal(clean.downloadSummary.downloaded, 1800);
  assert.equal(clean.downloadSummary.failed, 1300);
  assert.ok(clean.events.some(event => event.assetId === 'asset-failed-1299'));
  assert.deepEqual(clean.events.at(-1), { at, stage: 'zip', status: 'failed', reason: 'incomplete_export' });
  assert.equal(clean.stage, 'zip');
  assert.equal(clean.status, 'failed');
});

test('legacy collection diagnostics remain a safe fallback and retain their explicit truncation count', () => {
  const collectionDiagnostics = { version: 1, extensionVersion: '0.3.21', omittedEvents: 3225,
    events: [{ at, stage: 'save_page', status: 'saved', url: book.rootUrl + '?token=secret',
      lessonId: '12', sectionId: '13', authorData: 'received', polls: 2,
      network: { pending: 0, idleMs: 100 }, exerciseState: { loaderVisible: false, listVisible: true, emptyVisible: false } }],
    failure: { stage: 'wait_exercises', reason: 'section_loading_timeout', url: book.rootUrl + '?token=secret',
      lessonTitle: 'Lesson', sectionTitle: 'Section', headers: { cookie: 'secret' } } };
  const report = legacyProblemReport({ collectionDiagnostics, browserVersion: 'Chrome/142.0.0.0', book });
  assert.equal(report.extensionVersion, '0.3.21');
  assert.equal(report.collection.omittedEvents, 3225);
  assert.equal(report.omittedEvents, 3225);
  assert.equal(report.events[0].lessonId, '12');
  assert.equal(report.events[0].authorData, 'received');
  assert.equal(report.collection.failure.reason, 'section_loading_timeout');
  assert.doesNotMatch(JSON.stringify(report), /secret|cookie/);
  assert.equal(legacyProblemReport({ collectionDiagnostics: null }), null);
});

test('known file totals survive cancellation and repeated terminal observations do not double count a file', () => {
  let report = createProblemReport({ book, startedAt: at, kind: 'download' });
  report = appendProblemEvent(report, { at, stage: 'files', status: 'started', totalFiles: 2092 });
  report = appendProblemEvent(report, { at, stage: 'files', status: 'retrying', assetId: 'asset-1', reason: 'network_error', attempt: 1 });
  report = appendProblemEvent(report, { at, stage: 'files', status: 'downloaded', assetId: 'asset-1', attempt: 2, receivedBytes: 5 });
  report = appendProblemEvent(report, { at, stage: 'files', status: 'downloaded', assetId: 'asset-1', attempt: 2, receivedBytes: 5 });
  report = appendProblemEvent(report, { at, stage: 'export', status: 'cancelled', reason: 'cancelled' });
  assert.equal(report.downloadSummary.total, 2092);
  assert.equal(report.downloadSummary.downloaded, 1);
  assert.equal(report.downloadSummary.failed, 0);
  assert.equal(report.downloadSummary.receivedBytes, 5);
});
