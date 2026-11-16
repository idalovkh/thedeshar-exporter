import assert from 'node:assert/strict';
import test from 'node:test';
import { appendCollectionDiagnostic, collectionDiagnosticsForDownload, createCollectionDiagnostics,
  recordCollectionFailure } from '../src/lib/collection-diagnostics.js';
import { appendProblemEvent, createProblemReport, legacyProblemReport,
  problemReportForDownload } from '../src/lib/problem-report.js';
import { createProblemReporter } from '../src/ui/problem-report.js';

const at = '2026-11-16T09:23:08.527Z';
const book = { rootUrl: 'https://progressme.ru/cabinet/school/materials/book/71/content', title: 'Book' };
const version = { extensionVersion: '0.3.41', browserVersion: 'Chrome/157.0.0.0' };
const reason = 'exporter_binding_mismatch';
const privateBinding = { documentId: '00000000-1111-2222-3333-444444444444',
  url: 'chrome-extension://private-extension/exporter.html?workspace=private-workspace&tab=7',
  error: 'private-error', headers: { cookie: 'private-cookie' } };

function bindingProjections(binding) {
  const event = { at, stage: 'book', status: 'failed', reason, binding };
  const collection = createCollectionDiagnostics(version.extensionVersion);
  appendCollectionDiagnostic(collection, event);
  recordCollectionFailure(collection, event);
  const stored = collectionDiagnosticsForDownload(JSON.parse(JSON.stringify(collection)));
  const report = problemReportForDownload(appendProblemEvent(createProblemReport({ ...version, startedAt: at,
    collectionDiagnostics: collection }), event));
  const legacy = legacyProblemReport({ ...version, collectionDiagnostics: collection });
  return [collection.events[0], collection.failure, stored.events[0], stored.failure, ...report.events,
    report.collection.events[0], report.collection.failure, ...legacy.events,
    legacy.collection.events[0], legacy.collection.failure];
}

test('exporter binding causes survive collection persistence and every report projection without private context', () => {
  for (const cause of ['context_lookup_failed', 'context_missing', 'context_ambiguous', 'document_mismatch',
    'dashboard_url_mismatch', 'workspace_mismatch', 'source_tab_mismatch']) {
    const expected = { cause, operation: 'GET_NAVIGATION' };
    const projected = bindingProjections({ ...privateBinding, ...expected });
    for (const event of projected) {
      assert.equal(event.reason, reason);
      assert.deepEqual(event.binding, expected);
    }
    assert.doesNotMatch(JSON.stringify(projected), /private|chrome-extension|documentId|00000000|cookie|headers/);
  }
});

test('binding operations retain actual dashboard commands and omit arbitrary operation strings', () => {
  for (const operation of ['GET_NAVIGATION', 'BEGIN_COLLECTION', 'RESOLVE_WORKSPACE', 'CANCEL_COLLECTION',
    'BEGIN_PROBLEM_REPORT', 'APPEND_PROBLEM_EVENTS', 'GET_PROBLEM_REPORT']) {
    for (const event of bindingProjections({ cause: 'context_missing', operation })) {
      assert.deepEqual(event.binding, { cause: 'context_missing', operation });
    }
  }
  for (const operation of [undefined, null, {}, 'private-command', 'GET_NAVIGATION private',
    'chrome-extension://private-extension/exporter.html', '00000000-1111-2222-3333-444444444444']) {
    for (const event of bindingProjections({ cause: 'context_missing', operation })) {
      assert.deepEqual(event.binding, { cause: 'context_missing' });
    }
  }
});

test('invented binding causes and malformed contexts never enter diagnostic reports', () => {
  for (const binding of [undefined, null, [], 'context_missing', {}, { cause: 'private-error', operation: 'GET_NAVIGATION' },
    { cause: privateBinding.url }, { cause: 'document_mismatch private' }, { cause: 1 }]) {
    for (const event of bindingProjections(binding)) assert.equal(event.binding, undefined);
  }
});

test('binding failure remains downloadable locally when diagnostic persistence fails', async () => {
  for (const failAt of ['BEGIN_PROBLEM_REPORT', 'APPEND_PROBLEM_EVENTS']) {
    const queued = [];
    const reporter = createProblemReporter({ ...version, send: async (_tabId, type, payload) => {
      if (type === 'APPEND_PROBLEM_EVENTS') queued.push(...payload.events);
      if (type === failAt) throw new Error(privateBinding.error);
      return type === 'BEGIN_PROBLEM_REPORT' ? { reportId: 'report-1', attemptId: 'attempt-1',
        report: createProblemReport({ ...version, book, kind: 'collection' }) } : {};
    } });
    reporter.select({ tabId: 7, book });
    const attempt = await reporter.begin('collection');
    attempt.record({ stage: 'book', status: 'failed', reason,
      binding: { ...privateBinding, cause: 'document_mismatch', operation: 'GET_NAVIGATION' } });
    await attempt.flush();
    assert.equal(reporter.available(), true);
    const report = await reporter.snapshot();
    assert.equal(report.persisted, false);
    assert.equal(report.storageError, true);
    assert.equal(report.events.at(-1).reason, reason);
    assert.deepEqual(report.events.at(-1).binding, { cause: 'document_mismatch', operation: 'GET_NAVIGATION' });
    assert.doesNotMatch(JSON.stringify({ report, queued }), /private|chrome-extension|documentId|00000000|cookie|headers/);
    reporter.clear();
  }
});
