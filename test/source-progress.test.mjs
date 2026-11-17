import assert from 'node:assert/strict';
import test from 'node:test';
import { observeSourceProgress } from '../src/lib/source-progress.js';

test('pending requests and loader oscillation never extend inactivity', () => {
  let progress = observeSourceProgress(null, null, 0);
  const nav = { url: 'https://school.example/lesson-editor/book/1/lesson/2/section/3', documentToken: 'document',
    exerciseState: { loaderVisible: true, listVisible: false }, network: { pending: 1 } };
  progress = observeSourceProgress(progress, nav, 1000);
  for (let time = 2000; time <= 60000; time += 1000) {
    progress = observeSourceProgress(progress, { ...nav, exerciseState: { loaderVisible: time % 2000 === 0 },
      network: { pending: time % 7, idleMs: 0 }, contentSignature: String(time) }, time);
  }
  assert.equal(progress.at, 1000);
});

test('a new route, first rendered content and persisted definitions advance only once', () => {
  const nav = { url: 'https://school.example/lesson-editor/book/1/lesson/2/section/3', documentToken: 'document' };
  let progress = observeSourceProgress(null, nav, 1000);
  progress = observeSourceProgress(progress, { ...nav, ready: true }, 2000);
  assert.equal(progress.at, 2000);
  progress = observeSourceProgress(progress, { ...nav, ready: false }, 3000);
  progress = observeSourceProgress(progress, { ...nav, ready: true }, 4000);
  assert.equal(progress.at, 2000);
  progress = observeSourceProgress(progress, { ...nav, sectionVisit: { received: true, revision: 1 } }, 5000);
  progress = observeSourceProgress(progress, { ...nav, sectionVisit: { received: true, revision: 9 } }, 6000);
  assert.equal(progress.at, 5000);
  assert.equal(observeSourceProgress(structuredClone(progress), nav, 7000).at, 5000);
});

test('growing book inventories advance progress but repeated counts and oscillation do not', () => {
  const nav = { kind: 'book', url: 'https://school.example/cabinet/school/materials/book/1/content', documentToken: 'document' };
  let progress = observeSourceProgress(null, { ...nav, bookState: { visibleLessons: 1 } }, 0);
  progress = observeSourceProgress(progress, { ...nav, bookState: { visibleLessons: 5 } }, 20000);
  assert.equal(progress.at, 20000);
  progress = observeSourceProgress(progress, { ...nav, bookState: { visibleLessons: 1 } }, 40000);
  progress = observeSourceProgress(progress, { ...nav, bookState: { visibleLessons: 5 } }, 50000);
  assert.equal(progress.at, 20000);
  assert.equal(observeSourceProgress(progress, { ...nav, bookState: { visibleLessons: 6 } }, 50000).at, 50000);
});
