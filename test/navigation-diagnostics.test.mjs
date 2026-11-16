import test from 'node:test';
import assert from 'node:assert/strict';
import { appendCollectionDiagnostic, createCollectionDiagnostics, collectionDiagnosticsForDownload,
  recordCollectionFailure } from '../src/lib/collection-diagnostics.js';
import { createProblemReport, appendProblemEvent, problemReportForDownload } from '../src/lib/problem-report.js';

const at = '2026-11-16T00:00:00.000Z';
const url = 'https://progressme.ru/lesson-editor/book/1/lesson/2/section/3';

test('navigation failure diagnostics keep verified causes, attempts and sanitized addresses', () => {
  const event = { at, stage: 'open_section', status: 'failed', reason: 'source_network_error',
    networkError: 'net::ERR_TIMED_OUT', attempt: 3, elapsedMs: 180000, remainingMs: 0,
    expectedUrl: `${url}?token=secret`, observedUrl: `${url}#private`, browserLoading: false,
    headers: { cookie: 'secret' }, body: 'private' };
  const collection = createCollectionDiagnostics('0.3.39');
  appendCollectionDiagnostic(collection, event);
  recordCollectionFailure(collection, event);
  const clean = collectionDiagnosticsForDownload(collection);
  assert.equal(clean.events[0].networkError, 'net::ERR_TIMED_OUT');
  assert.equal(clean.failure.attempt, 3);
  assert.equal(clean.failure.reason, 'source_network_error');
  assert.equal(clean.events[0].expectedUrl, url);
  assert.equal(clean.events[0].observedUrl, url);
  const report = problemReportForDownload(appendProblemEvent(createProblemReport({ startedAt: at, kind: 'collection' }), event));
  assert.equal(report.events[0].networkError, 'net::ERR_TIMED_OUT');
  assert.equal(report.events[0].attempt, 3);
  assert.doesNotMatch(JSON.stringify({ clean, report }), /secret|private|cookie|headers|body/);
});

test('unknown browser error strings cannot enter either diagnostic format', () => {
  const event = { at, stage: 'open_section', status: 'failed', reason: 'source_unavailable',
    networkError: 'net::ERR_MY_PASSWORD_SECRET', expectedUrl: 'https://evil.example/private?secret=1' };
  const collection = createCollectionDiagnostics('0.3.39');
  appendCollectionDiagnostic(collection, event);
  const report = appendProblemEvent(createProblemReport({ startedAt: at, kind: 'collection' }), event);
  assert.equal(collection.events[0].networkError, undefined);
  assert.equal(report.events[0].networkError, undefined);
  assert.equal(collection.events[0].expectedUrl, undefined);
  assert.equal(report.events[0].expectedUrl, undefined);
});

test('navigation document context survives both report projections with a bounded sanitized trace', () => {
  const sourceDocumentId = '22222222-2222-4222-8222-222222222222';
  const documentId = '33333333-3333-4333-8333-333333333333';
  const navigation = { event: 'onBeforeNavigate', phase: 'committed', cause: 'navigation_after_commit',
    sourceDocumentId, documentId, currentDocumentId: documentId, expectedUrl: `${url}?token=private`, observedUrl: `${url}#private`,
    attempt: 2, timeStamp: 1794780000000.5, headers: { cookie: 'private' }, events: Array.from({ length: 40 }, (_, index) => ({
      event: 'onHistoryStateUpdated', phase: 'loading', cause: 'same_url_history_ignored', sourceDocumentId,
      documentId, timeStamp: index, expectedUrl: `${url}?secret=private`, observedUrl: `${url}#private`,
      body: 'private', events: [{ body: 'private' }],
    })) };
  const event = { at, stage: 'book', status: 'failed', reason: 'source_left_page', navigation };
  const collection = createCollectionDiagnostics('0.3.40');
  appendCollectionDiagnostic(collection, event);
  recordCollectionFailure(collection, event);
  const clean = collectionDiagnosticsForDownload(collection);
  const report = problemReportForDownload(appendProblemEvent(createProblemReport({ startedAt: at, kind: 'collection',
    collectionDiagnostics: collection }), event));
  for (const projected of [clean.events[0].navigation, clean.failure.navigation, report.events[0].navigation,
    report.collection.events[0].navigation, report.collection.failure.navigation]) {
    assert.ok(projected, 'navigation context must survive every projection');
    assert.equal(projected.cause, 'navigation_after_commit');
    assert.equal(projected.documentId, documentId);
    assert.equal(projected.currentDocumentId, documentId);
    assert.equal(projected.sourceDocumentId, sourceDocumentId);
    assert.equal(projected.expectedUrl, url);
    assert.equal(projected.observedUrl, url);
    assert.equal(projected.events.length, 32);
    assert.equal(projected.events[0].timeStamp, 8);
    assert.equal(projected.events[0].events, undefined);
  }
  assert.doesNotMatch(JSON.stringify({ clean, report }), /private|cookie|headers|body/);
});

test('navigation projections reject invented event details and non-browser document identifiers', () => {
  const event = { at, stage: 'book', status: 'failed', navigation: { event: 'private-message', phase: 'private-phase',
    cause: 'private-cause', sourceDocumentId: 'private-token', documentId: 'private-token', currentDocumentId: 'private-token', timeStamp: Infinity,
    attempt: 999, observedUrl: 'https://evil.example/private?token=secret', body: 'private' } };
  const collection = createCollectionDiagnostics('0.3.40');
  appendCollectionDiagnostic(collection, event);
  const report = appendProblemEvent(createProblemReport({ startedAt: at, kind: 'collection' }), event);
  assert.equal(collection.events[0].navigation, undefined);
  assert.equal(report.events[0].navigation, undefined);
});

test('navigation projections retain the compact document IDs supplied by Chrome webNavigation', () => {
  const compact = '48232C4DDFEDD506C6751D8907330311';
  const canonical = '33333333-3333-4333-8333-333333333333';
  const event = { at, stage: 'book', status: 'failed', reason: 'source_left_page', navigation: {
    event: 'onCommitted', phase: 'committed', cause: 'unexpected_document',
    sourceDocumentId: compact, documentId: canonical, currentDocumentId: compact,
    events: [{ event: 'onHistoryStateUpdated', phase: 'loading', cause: 'old_document_ignored', documentId: compact }],
  } };
  const collection = createCollectionDiagnostics('0.3.40');
  appendCollectionDiagnostic(collection, event);
  recordCollectionFailure(collection, event);
  const report = problemReportForDownload(appendProblemEvent(createProblemReport({ startedAt: at, kind: 'collection',
    collectionDiagnostics: collection }), event));
  for (const value of [report.events[0].navigation, report.collection.events[0].navigation, report.collection.failure.navigation]) {
    assert.equal(value.sourceDocumentId, compact);
    assert.equal(value.documentId, canonical);
    assert.equal(value.currentDocumentId, compact);
    assert.equal(value.events[0].documentId, compact);
  }
});

test('a non-network browser navigation error retains its distinct diagnostic cause', () => {
  const event = { at, stage: 'book', status: 'failed', reason: 'source_security_error',
    networkError: 'net::ERR_CERT_DATE_INVALID', navigation: { event: 'onErrorOccurred', phase: 'failed', cause: 'navigation_error' } };
  const collection = createCollectionDiagnostics('0.3.40');
  appendCollectionDiagnostic(collection, event);
  recordCollectionFailure(collection, event);
  const report = problemReportForDownload(appendProblemEvent(createProblemReport({ startedAt: at, kind: 'collection',
    collectionDiagnostics: collection }), event));
  assert.equal(report.events[0].navigation.cause, 'navigation_error');
  assert.equal(report.collection.failure.navigation.cause, 'navigation_error');
  assert.equal(report.events[0].networkError, 'net::ERR_CERT_DATE_INVALID');
});
