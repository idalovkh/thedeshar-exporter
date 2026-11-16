import assert from 'node:assert/strict';
import test from 'node:test';
import { collectBook } from '../src/lib/collection.js';
import { createProblemReport } from '../src/lib/problem-report.js';
import { withCollectionTransitions } from './collection-transition-fixture.js';

test('the final failure keeps the latest readiness returned after expanding book groups', async () => {
  const url = 'https://progressme.ru/cabinet/school/materials/book/71/content';
  let generation = 1;
  const before = { visibleLessons: 0, expectedLessons: 2 };
  const after = { visibleLessons: 1, expectedLessons: 2 };
  const readinessReason = 'Загружаем список уроков: 1 из 2.';
  const navigation = () => ({ url, kind: 'book', materialId: '71', lessonId: null,
    documentToken: `source-document-${generation}`, ready: generation === 1, items: [], warnings: [],
    readinessReason: 'Раскрываем разделы учебника: осталось 1.', bookState: before,
    network: { pending: 0, idleMs: 10000 } });
  const report = await collectBook({ pollMs: 10, fastPollMs: 10, transitionTimeoutMs: 10,
    now: () => 0, wait: async () => {},
    request: withCollectionTransitions(async type => {
      if (type === 'GET_NAVIGATION') return { navigation: navigation() };
      if (type === 'BEGIN_COLLECTION') return { collectionId: 'collection-preparation-001' };
      if (type === 'NAVIGATE_SOURCE') generation++;
      if (type === 'PREPARE_BOOK') return { opened: 1, navigation: { ...navigation(),
        readinessReason, bookState: after,
        items: [{ key: 'lesson-8', kind: 'lesson', title: 'Lesson', sourceId: '8' }] } };
      return { ok: true };
    }),
  });
  assert.equal(report.status, 'failed');
  const event = report.diagnostics.events.at(-1);
  assert.equal(event.status, 'failed');
  assert.equal(event.readinessReason, readinessReason);
  assert.deepEqual(event.bookState, after);
  assert.equal(report.diagnostics.failure.readinessReason, readinessReason);
  assert.deepEqual(report.diagnostics.failure.bookState, after);
  const downloaded = createProblemReport({ collectionDiagnostics: report.diagnostics });
  assert.equal(downloaded.collection.failure.readinessReason, readinessReason);
  assert.deepEqual(downloaded.collection.failure.bookState, after);
});
