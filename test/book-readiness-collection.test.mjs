import assert from 'node:assert/strict';
import test from 'node:test';
import { collectBook } from '../src/lib/collection.js';
import { appendProblemEvent, createProblemReport, problemReportForDownload } from '../src/lib/problem-report.js';
import { withCollectionTransitions } from './collection-transition-fixture.js';

const bookUrl = 'https://progressme.ru/cabinet/school/materials/book/71/content';
const sectionUrl = 'https://progressme.ru/lesson-editor/book/71/lesson/8/section/9';

test('a stalled return to contents reports readiness and changing lesson counts through retries and download', async () => {
  let position = 'book', generation = 1, returning = false, bookReads = 0;
  const snapshots = [], events = [], checkpoints = [];
  const readinessReason = 'Ожидаем полный список уроков.';
  const navigation = () => {
    const book = position === 'book';
    const visibleLessons = returning && bookReads === 1 ? 0 : 1;
    return {
      url: book ? bookUrl : sectionUrl, kind: book ? 'book' : 'lesson', materialId: '71', lessonId: book ? null : '8',
      documentToken: `source-document-${generation}`, title: 'Book', ready: !book || !returning,
      contentSignature: position, warnings: [], network: { pending: 0, idleMs: 10000 },
      ...(book ? { readinessReason: returning ? readinessReason : '',
        bookState: { visibleLessons, expectedLessons: returning ? 2 : 1 } }
        : { sectionVisit: { token: 'section-visit-00000001', revision: 1, received: true, idleMs: 10000 } }),
      items: book ? (visibleLessons ? [{ key: 'lesson-8', kind: 'lesson', title: 'Lesson', sourceId: '8' }] : [])
        : [{ key: 'section-9', kind: 'section', title: 'Section', sourceId: '9', active: true }],
    };
  };
  const report = await collectBook({ pollMs: 1, fastPollMs: 1, quietMs: 0, retryAfterMs: 4,
    transitionTimeoutMs: 12, retryDelaysMs: [0, 0], now: () => 0, wait: async () => {},
    onDiagnostic: event => events.push(event),
    request: withCollectionTransitions(async (type, payload = {}) => {
      if (type === 'BEGIN_COLLECTION') return { collectionId: 'collection-readiness-00001' };
      if (type === 'GET_NAVIGATION') {
        if (returning && position === 'book') bookReads++;
        return { navigation: navigation() };
      }
      if (type === 'PREPARE_BOOK') return { opened: 0, navigation: navigation() };
      if (type === 'NAVIGATE_SOURCE') {
        position = 'book'; generation++;
      }
      if (type === 'OPEN_MATERIAL_ITEM') position = 'lesson';
      if (type === 'TAKE_SNAPSHOT') {
        const nav = navigation();
        snapshots.push(nav.url);
        if (position === 'lesson') returning = true;
        return { snapshotUrl: nav.url, retained: { dropped: 0, authorData: true } };
      }
      if (type === 'SAVE_COLLECTION') checkpoints.push(structuredClone(payload.collection));
      return { ok: true };
    }),
  });
  assert.equal(report.status, 'failed');
  assert.deepEqual(snapshots, [bookUrl, sectionUrl]);
  assert.equal(report.diagnostics.failure.reason, 'navigation_timeout');
  assert.equal(report.diagnostics.failure.attempt, 3);
  assert.equal(report.diagnostics.failure.readinessReason, readinessReason);
  assert.deepEqual(report.diagnostics.failure.bookState, { visibleLessons: 1, expectedLessons: 2 });
  const waiting = events.filter(event => event.stage === 'book' && event.status === 'waiting' && event.readinessReason);
  assert.ok(waiting.some(event => event.bookState.visibleLessons === 0), 'the first incomplete list must be logged');
  assert.ok(waiting.some(event => event.bookState.visibleLessons === 1), 'changed counts must be logged even with the same reason');
  const failures = events.filter(event => event.stage === 'book' && event.status === 'failed');
  assert.equal(failures.length, 3);
  assert.ok(failures.every(event => event.readinessReason === readinessReason && event.bookState.expectedLessons === 2));
  assert.deepEqual(checkpoints.at(-1).diagnostics.failure.bookState, report.diagnostics.failure.bookState);
  let problem = createProblemReport({ collectionDiagnostics: report.diagnostics });
  for (const event of events) problem = appendProblemEvent(problem, event);
  const downloaded = problemReportForDownload(problem);
  assert.equal(downloaded.events.at(-1).readinessReason, readinessReason);
  assert.deepEqual(downloaded.events.at(-1).bookState, { visibleLessons: 1, expectedLessons: 2 });
  assert.equal(downloaded.collection.failure.readinessReason, readinessReason);
  assert.deepEqual(downloaded.collection.failure.bookState, { visibleLessons: 1, expectedLessons: 2 });
});
