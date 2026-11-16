import assert from 'node:assert/strict';
import test from 'node:test';
import { appendCollectionDiagnostic, collectionDiagnosticsForDownload, createCollectionDiagnostics,
  diagnosticPageUrl, recordCollectionFailure } from '../src/lib/collection-diagnostics.js';

const page = 'https://platform.desharschool.ru/lesson-editor/book/856925/lesson/13595255/section/66556573';
const at = '2026-11-05T07:00:00.000Z';

test('diagnostics retain only known source routes without query strings and fragments', () => {
  assert.equal(diagnosticPageUrl(`${page}?token=secret#private`), page);
  assert.equal(diagnosticPageUrl(`${page}/?source=book`), `${page}/`);
  assert.equal(diagnosticPageUrl('https://progressme.ru/cabinet/teacher/materials/book/4/content'), 'https://progressme.ru/cabinet/teacher/materials/book/4/content');
  assert.equal(diagnosticPageUrl('https://progressme.ru/lesson-editor/book/4/lesson/3/section'), 'https://progressme.ru/lesson-editor/book/4/lesson/3/section');
  for (const url of [page.replace('https:', 'http:'), page.replace('https://', 'https://user:secret@'),
    page.replace('platform.desharschool.ru', 'platform.desharschool.ru.evil.test'),
    page.replace('platform.desharschool.ru', 'platform.desharschool.ru:8080'),
    `${page}/account`, 'https://progressme.ru/api/lesson', 'https://progressme.ru/cabinet/school/materials', null]) {
    assert.equal(diagnosticPageUrl(url), '');
  }
});

test('capture and download project only allowlisted diagnostic fields and sanitize titles', () => {
  const diagnostics = createCollectionDiagnostics('0.3.16');
  const input = { at, stage: 'wait_exercises', status: 'failed', url: `${page}?private=one#fragment`,
    lessonId: '13595255', sectionId: '66556573', lastSavedUrl: 'https://example.test/path', elapsedMs: 31500,
    reason: 'section_loading_timeout', attempt: 1, polls: 42, headers: { cookie: 'private' },
    exerciseState: { loaderVisible: true, listVisible: true, emptyVisible: false, html: 'private' },
    network: { pending: 0, idleMs: 4000, body: { exercise: 'private' } }, authorData: 'unobserved' };
  appendCollectionDiagnostic(diagnostics, input);
  assert.deepEqual(diagnostics.events, [{ at, stage: 'wait_exercises', status: 'failed', url: page,
    lessonId: '13595255', sectionId: '66556573', elapsedMs: 31500, reason: 'section_loading_timeout',
    attempt: 1, polls: 42, exerciseState: { loaderVisible: true, listVisible: true, emptyVisible: false },
    network: { pending: 0, idleMs: 4000 }, authorData: 'unobserved' }]);
  recordCollectionFailure(diagnostics, { stage: 'wait_exercises', lessonTitle: ' 4A\tEco-guilt\u0000 ',
    sectionTitle: 'PRONUNCIATION vowel sounds Bearer test-secret', url: page, elapsedMs: 31500,
    reason: 'section_loading_timeout', stack: 'private' });
  assert.deepEqual(diagnostics.failure, { stage: 'wait_exercises', lessonTitle: '4A Eco-guilt',
    sectionTitle: 'PRONUNCIATION vowel sounds Bearer [REDACTED]', url: page, elapsedMs: 31500,
    reason: 'section_loading_timeout' });
  const persisted = structuredClone(diagnostics);
  persisted.events[0].body = 'private';
  persisted.events[0].reason = 'error_secret';
  persisted.events[0].network.cookie = 'private';
  persisted.events[0].lessonId = 'arbitrary';
  persisted.failure.sectionTitle = 'Section https://example.test/private?trace=secret';
  persisted.failure.stack = 'private';
  persisted.capture = 'private';
  const output = collectionDiagnosticsForDownload(persisted);
  assert.equal(output.version, 1);
  assert.equal(output.extensionVersion, '0.3.16');
  assert.equal(output.events[0].reason, undefined);
  assert.equal(output.events[0].lessonId, undefined);
  assert.deepEqual(output.events[0].network, { pending: 0, idleMs: 4000 });
  assert.equal(output.failure.sectionTitle, 'Section [REDACTED]');
  assert.doesNotMatch(JSON.stringify(output), /private|secret|capture|stack/);
  assert.equal(collectionDiagnosticsForDownload(null), null);
  assert.equal(collectionDiagnosticsForDownload({ version: 9, events: [] }), null);
});

test('diagnostics keep the last 200 events and count omitted events', () => {
  const diagnostics = createCollectionDiagnostics('0.3.16');
  for (let polls = 1; polls <= 205; polls++) {
    appendCollectionDiagnostic(diagnostics, { at, stage: 'wait_exercises', status: 'waiting', polls });
  }
  appendCollectionDiagnostic(diagnostics, { at, stage: 'unknown', status: 'waiting' });
  assert.equal(diagnostics.omittedEvents, 5);
  assert.equal(diagnostics.events.length, 200);
  assert.equal(diagnostics.events[0].polls, 6);
  assert.equal(diagnostics.events.at(-1).polls, 205);
  assert.deepEqual(collectionDiagnosticsForDownload(diagnostics), diagnostics);

  const persisted = { ...diagnostics, events: [{ at, stage: 'book', status: 'started' }, ...diagnostics.events] };
  const projected = collectionDiagnosticsForDownload(persisted);
  assert.equal(projected.omittedEvents, 6);
  assert.equal(projected.events.length, 200);
  assert.equal(projected.events[0].polls, 6);
});
