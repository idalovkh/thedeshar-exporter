import assert from 'node:assert/strict';
import test from 'node:test';
import { collectBook } from '../src/lib/collection.js';
import { createProblemReport, problemReportForDownload } from '../src/lib/problem-report.js';
import { refreshResumeCollectionEntry } from '../src/lib/resume-collection-entry.js';
import { withCollectionTransitions } from './collection-transition-fixture.js';

const book = { rootUrl: 'https://progressme.ru/cabinet/school/materials/book/856948/content', title: 'Учебник' };
const at = '2026-11-17T22:51:49.083Z';
const lessonButton = { cardIndex: 4, desktopVisible: 2, mobileVisible: 0, cause: 'multiple' };

test('a blocked contents page retains the specific cause in the downloaded problem report', async () => {
  const operations = [];
  const events = [];
  const collection = await collectBook({
    request: async command => {
      operations.push(command);
      assert.equal(command, 'GET_NAVIGATION');
      return { navigation: {
        url: book.rootUrl, kind: 'book', documentToken: 'test-document-00000001',
        blocked: true, blockedReasonCode: 'lesson_button', lessonButton: { ...lessonButton, title: 'private lesson name' },
        warnings: ['private source warning'],
      } };
    },
    onDiagnostic: event => events.push(event),
  });

  assert.deepEqual(operations, ['GET_NAVIGATION']);
  assert.equal(collection.status, 'failed');
  assert.equal(collection.diagnostics.failure?.blockedReasonCode, 'lesson_button');
  assert.match(collection.failed[0].error, /кнопку «Открыть урок»/);
  const report = problemReportForDownload(createProblemReport({ book, events, collectionDiagnostics: collection.diagnostics }));
  assert.equal(report.events.at(-1).reason, 'navigation_blocked');
  assert.equal(report.events.at(-1).blockedReasonCode, 'lesson_button');
  assert.equal(report.collection.events.at(-1).blockedReasonCode, 'lesson_button');
  assert.equal(report.collection.failure.blockedReasonCode, 'lesson_button');
  assert.deepEqual(report.events.at(-1).lessonButton, lessonButton);
  assert.deepEqual(report.collection.events.at(-1).lessonButton, lessonButton);
  assert.deepEqual(report.collection.failure.lessonButton, lessonButton);
  assert.doesNotMatch(JSON.stringify(report), /private source warning|private lesson name/);
});

test('lesson button diagnostics only accept bounded counts and known causes', () => {
  const event = { at, stage: 'book', status: 'failed', reason: 'navigation_blocked', blockedReasonCode: 'lesson_button' };
  const invalid = [
    { ...event, lessonButton: { ...lessonButton, cardIndex: 0 } },
    { ...event, lessonButton: { ...lessonButton, cardIndex: 1001 } },
    { ...event, lessonButton: { ...lessonButton, desktopVisible: -1 } },
    { ...event, lessonButton: { ...lessonButton, mobileVisible: Number.MAX_SAFE_INTEGER } },
    { ...event, lessonButton: { ...lessonButton, cause: 'private page content' } },
    { ...event, blockedReasonCode: 'search_active', lessonButton },
  ];
  for (const candidate of invalid) {
    const report = problemReportForDownload(createProblemReport({ book, events: [candidate] }));
    assert.equal(report.events.length, 1);
    assert.equal(Object.hasOwn(report.events[0], 'lessonButton'), false);
  }
});

test('problem reports omit unknown navigation block codes and codes outside navigation failures', () => {
  const blocked = { at, stage: 'book', status: 'failed', reason: 'navigation_blocked' };
  const invalid = { ...blocked, blockedReasonCode: 'private source warning' };
  const wrongReason = { ...blocked, reason: 'navigation_timeout', blockedReasonCode: 'search_active' };
  const report = problemReportForDownload(createProblemReport({
    book, events: [invalid, wrongReason],
    collectionDiagnostics: { version: 1, events: [invalid, wrongReason], failure: invalid },
  }));

  assert.doesNotMatch(JSON.stringify(report), /blockedReasonCode|private source warning/);
  assert.equal(report.collection.failure.reason, 'navigation_blocked');
});

test('a new blocker during book preparation is kept in diagnostics before saving any page', async () => {
  let generation = 1;
  const operations = [];
  const request = withCollectionTransitions(async command => {
    operations.push(command);
    switch (command) {
      case 'GET_NAVIGATION':
        return { navigation: {
          url: book.rootUrl, kind: 'book', materialId: '856948', items: [],
          documentToken: `test-document-0000000${generation}`, blocked: false,
        } };
      case 'NAVIGATE_SOURCE':
        generation++;
        return {};
      case 'BEGIN_COLLECTION':
        return { collectionId: 'test-collection-0001' };
      case 'PREPARE_BOOK':
        throw Object.assign(new Error('Кнопка урока заблокировала обход.'), {
          code: 'navigation_blocked', blockedReasonCode: 'lesson_button', lessonButton,
        });
      default:
        return {};
    }
  });
  const collection = await collectBook({ request });
  assert.equal(collection.status, 'failed');
  assert.equal(collection.diagnostics.failure.reason, 'navigation_blocked');
  assert.equal(collection.diagnostics.failure.blockedReasonCode, 'lesson_button');
  assert.deepEqual(collection.diagnostics.failure.lessonButton, lessonButton);
  assert.equal(operations.filter(command => command === 'PREPARE_BOOK').length, 1);
  assert.ok(!operations.includes('TAKE_SNAPSHOT'));
});

test('the resume entry guard returns the blocker from a freshly checked lesson', async () => {
  const initial = {
    url: 'https://progressme.ru/lesson-editor/book/856948/lesson/12/section/34',
    documentToken: 'resume-entry-document-01', kind: 'lesson', materialId: '856948', lessonId: '12',
  };
  await assert.rejects(refreshResumeCollectionEntry(async () => ({
    navigation: { ...initial, blocked: true, blockedReasonCode: 'pagination' },
  }), initial), { code: 'navigation_blocked', blockedReasonCode: 'pagination', url: initial.url });
});
