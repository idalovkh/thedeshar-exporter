import assert from 'node:assert/strict';
import test from 'node:test';
import { collectionResumeInfo, confirmedResumePage, createCollectionResume } from '../src/lib/collection-resume.js';

const rootUrl = 'https://progressme.ru/cabinet/school/materials/book/1/content';
const url = 'https://progressme.ru/lesson-editor/book/1/lesson/2/section/3';
const capturedAt = '2026-11-16T10:00:00.000Z';
const lessons = [{ key: 'lesson-2', title: 'Lesson', kind: 'lesson', sourceId: '2' }];
const sections = [{ key: 'section-3', title: 'Section', kind: 'section', sourceId: '3' }];
function saved() {
  const tracker = createCollectionResume(null, rootUrl);
  tracker.book(lessons); tracker.lesson(lessons[0], '2', sections); tracker.confirm(url, '2', 'section-3', capturedAt);
  return { collection: { rootUrl, startedAt: capturedAt, status: 'failed', resume: tracker.checkpoint }, snapshots: [{ url, capturedAt }] };
}

test('resume eligibility requires a committed matching snapshot and never treats legacy visited flags as proof', () => {
  assert.deepEqual(collectionResumeInfo(saved()), { available: true, confirmedSections: 1, startedAt: capturedAt });
  for (const state of [null, { collection: { visited: [url] }, snapshots: [{ url, capturedAt }] },
    { ...saved(), snapshots: [] }, { ...saved(), snapshots: [{ url, capturedAt: '2026-11-16T11:00:00Z' }] }]) {
    assert.equal(collectionResumeInfo(state).available, false);
  }
  const state = saved(); state.collection.status = 'running';
  assert.equal(confirmedResumePage(state, url).capturedAt, capturedAt);
  assert.equal(confirmedResumePage(state, url.replace('book/1', 'book/9')), null);
  assert.equal(confirmedResumePage(state, url.replace('progressme.ru', 'platform.desharschool.ru')), null);
});

test('resume validates fresh book and lesson inventories while preserving the original confirmed timestamp', () => {
  const state = saved(), tracker = createCollectionResume(state, rootUrl);
  tracker.book(lessons); tracker.lesson(lessons[0], '2', sections);
  assert.equal(tracker.confirmed(url, 'section-3'), true);
  assert.equal(tracker.confirmed(url, 'section-4'), false);
  assert.equal(tracker.checkpoint.confirmed[0].capturedAt, capturedAt);
  assert.throws(() => tracker.book([...lessons, { ...lessons[0], key: 'another' }]), error => error.code === 'resume_structure_changed');
  assert.throws(() => tracker.lesson(lessons[0], '2', [...sections, { ...sections[0], key: 'new' }]), error => error.code === 'resume_structure_changed');
  assert.deepEqual(state, saved(), 'Validation must never mutate the old saved collection');
});

test('unavailable and mismatched source books cannot be resumed', () => {
  assert.throws(() => createCollectionResume({ snapshots: [] }, rootUrl), error => error.code === 'resume_unavailable');
  assert.throws(() => createCollectionResume(saved(), rootUrl.replace('book/1', 'book/9')), error => error.code === 'resume_unavailable');
});
