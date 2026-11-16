import assert from 'node:assert/strict';
import test from 'node:test';
import { collectBook } from '../src/lib/collection.js';
import { createProblemReport } from '../src/lib/problem-report.js';
import { withCollectionTransitions } from './collection-transition-fixture.js';

const url = 'https://progressme.ru/cabinet/school/materials/book/71/content';
const timeout = () => Object.assign(new Error('Transition deadline expired'), { code: 'transition_timeout' });

for (const point of ['request', 'pause', 'status', 'old_document', 'old_document_timeout']) {
  test(`a deadline during ${point} retains only the latest confirmed page readiness`, async () => {
    let generation = 1, reads = 0;
    const oldDocument = point.startsWith('old_document');
    const events = [];
    const before = { visibleLessons: 0, expectedLessons: 2 };
    const after = { visibleLessons: 1, expectedLessons: 2 };
    const readinessReason = 'Загружаем список уроков: 1 из 2.';
    const navigation = () => ({ url, kind: 'book', materialId: '71', lessonId: null,
      documentToken: `source-document-${oldDocument ? 1 : generation}`, ready: generation === 1,
      items: [], warnings: [], readinessReason: 'Раскрываем разделы учебника: осталось 1.', bookState: before,
      network: { pending: 0, idleMs: 10000 } });
    const report = await collectBook({ pollMs: 1, fastPollMs: 1, retryAfterMs: 1,
      transitionTimeoutMs: point === 'old_document_timeout' ? 3 : 100,
      now: () => 0, wait: async () => {
        if (point === 'pause' || point === 'old_document') throw timeout();
      }, onDiagnostic: event => events.push(event),
      request: withCollectionTransitions(async type => {
        if (type === 'GET_NAVIGATION') {
          if (++reads >= 3 && point === 'request') throw timeout();
          return { navigation: navigation() };
        }
        if (type === 'BEGIN_COLLECTION') return { collectionId: 'collection-deadline-0001' };
        if (type === 'NAVIGATE_SOURCE') generation++;
        if (type === 'PREPARE_BOOK') return { opened: 0, navigation: { ...navigation(),
          readinessReason, bookState: after,
          items: [{ key: 'lesson-8', kind: 'lesson', title: 'Lesson', sourceId: '8' }] } };
        return { ok: true };
      }, { sourceStatus: () => { throw timeout(); } }),
    });
    assert.equal(report.status, 'failed');
    assert.equal(report.diagnostics.failure.reason, point === 'old_document_timeout' ? 'document_load_timeout' : 'transition_timeout');
    const downloaded = createProblemReport({ collectionDiagnostics: report.diagnostics });
    for (const failure of [report.diagnostics.failure, events.at(-1), downloaded.collection.failure]) {
      if (oldDocument) {
        assert.equal(failure.readinessReason, undefined, 'an old document cannot supply new-page readiness');
        assert.equal(failure.bookState, undefined);
      } else {
        assert.equal(failure.readinessReason, readinessReason);
        assert.deepEqual(failure.bookState, after);
      }
    }
  });
}
