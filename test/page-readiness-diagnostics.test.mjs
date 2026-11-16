import assert from 'node:assert/strict';
import test from 'node:test';
import { appendCollectionDiagnostic, collectionDiagnosticsForDownload, createCollectionDiagnostics,
  recordCollectionFailure } from '../src/lib/collection-diagnostics.js';
import { appendProblemEvent, createProblemReport, legacyProblemReport,
  problemReportForDownload } from '../src/lib/problem-report.js';

const at = '2026-11-16T09:23:08.527Z';
const url = 'https://platform.desharschool.ru/cabinet/school/materials/book/1153358/content';

function projectedReadiness(details) {
  const event = { at, stage: 'book', status: 'failed', reason: 'navigation_timeout', url, ...details };
  const collection = createCollectionDiagnostics('0.3.41');
  appendCollectionDiagnostic(collection, event);
  recordCollectionFailure(collection, event);
  const stored = collectionDiagnosticsForDownload(JSON.parse(JSON.stringify(collection)));
  const report = problemReportForDownload(appendProblemEvent(createProblemReport({ startedAt: at,
    collectionDiagnostics: collection }), event));
  const legacy = legacyProblemReport({ collectionDiagnostics: collection });
  return [collection.events[0], collection.failure, stored.events[0], stored.failure,
    ...report.events, report.collection.events[0], report.collection.failure,
    legacy.events[0], legacy.collection.events[0], legacy.collection.failure];
}

test('book readiness reason and lesson counts survive collection storage and downloadable reports', () => {
  const readinessReason = 'Загружаем список уроков: 2 из 3.';
  const bookState = { visibleLessons: 2, expectedLessons: 3 };
  for (const projected of projectedReadiness({ readinessReason, bookState })) {
    assert.equal(projected.readinessReason, readinessReason);
    assert.deepEqual(projected.bookState, bookState);
  }
});

test('unknown expected lesson counts remain absent while known zero counts survive projections', () => {
  for (const bookState of [{ visibleLessons: 0 }, { visibleLessons: 0, expectedLessons: 0 }]) {
    for (const projected of projectedReadiness({ bookState })) assert.deepEqual(projected.bookState, bookState);
  }
});

test('readiness diagnostics sanitize bounded reasons and discard unrelated book data', () => {
  const readinessReason = '  Ожидаем\nданные\u0000 https://example.test/private?token=secret user@example.test Bearer private-token ';
  const projected = projectedReadiness({ readinessReason,
    bookState: { visibleLessons: 2, expectedLessons: 3, body: 'private', title: 'private' } });
  for (const value of projected) {
    assert.equal(value.readinessReason, 'Ожидаем данные [REDACTED] [REDACTED] Bearer [REDACTED]');
    assert.deepEqual(value.bookState, { visibleLessons: 2, expectedLessons: 3 });
  }
  assert.doesNotMatch(JSON.stringify(projected), /private|secret|example|body|title/);
  for (const value of projectedReadiness({ readinessReason: 'я'.repeat(2000) })) {
    assert.equal(value.readinessReason.length, 500);
  }
});

test('readiness projections omit malformed reasons and invalid lesson counts', () => {
  for (const readinessReason of [null, 42, {}, ' \n\u0000 ']) {
    for (const projected of projectedReadiness({ readinessReason })) assert.equal(projected.readinessReason, undefined);
  }
  for (const bookState of [null, [], { expectedLessons: 4 }, { visibleLessons: -1 }, { visibleLessons: 1.5 },
    { visibleLessons: Infinity }, { visibleLessons: Number.MAX_SAFE_INTEGER + 1 }, { visibleLessons: '2' }]) {
    for (const projected of projectedReadiness({ bookState })) assert.equal(projected.bookState, undefined);
  }
  for (const expectedLessons of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '3', null]) {
    for (const projected of projectedReadiness({ bookState: { visibleLessons: 2, expectedLessons } })) {
      assert.deepEqual(projected.bookState, { visibleLessons: 2 });
    }
  }
});
