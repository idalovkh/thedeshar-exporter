import assert from 'node:assert/strict';
import test from 'node:test';
import { exerciseCaptureStatus, hasExerciseCapture } from '../src/lib/exercise-capture.js';

const pageUrl = 'https://progressme.ru/lesson-editor/book/1/lesson/2/section/3';
const rpc = (Items = [], overrides = {}) => ({ Class: 'GetExerciseWsController', Method: 'LoadExercises', IsSuccess: true,
  Value: { Items, SectionId: 3 }, ...overrides });

test('successful nested exercise definitions include an explicitly empty author response', () => {
  for (const data of [rpc(), [rpc()], { result: { batch: [rpc([], { Method: 'LoadExercisesInMaterial' })] } }]) {
    assert.equal(hasExerciseCapture([{ pageUrl, data }], `${pageUrl}?view=preview`), true);
  }
});

test('author status excludes failed, unrelated, malformed and differently bound responses', () => {
  for (const data of [rpc([], { IsSuccess: false }), rpc([], { Class: 'OtherController' }), rpc([], { Method: 'SaveExercise' }),
    rpc([], { Value: { Items: null } }), rpc([], { Value: { Items: [], SectionId: 9 } }), { Items: [] }]) {
    assert.equal(hasExerciseCapture([{ pageUrl, data }], pageUrl), false);
  }
  assert.equal(hasExerciseCapture([{ pageUrl: pageUrl.replace('/section/3', '/section/4'), data: rpc() }], pageUrl), false);
  assert.equal(hasExerciseCapture([{ pageUrl, data: rpc() }], pageUrl.replace('progressme.ru', 'other.example.org')), false);
});

test('definition metadata is cached by immutable capture data instead of repeatedly walking the body', () => {
  let reads = 0;
  const data = { get nested() { reads++; return rpc(); } };
  assert.equal(hasExerciseCapture([{ pageUrl, data }], pageUrl), true);
  assert.equal(hasExerciseCapture([{ pageUrl, data }], pageUrl), true);
  assert.equal(reads, 1);
});

test('explicit item section IDs cannot confirm an unrelated section when the envelope omits its section', () => {
  const capture = Items => [{ pageUrl, data: rpc([], { Value: { Items } }) }];
  assert.equal(hasExerciseCapture(capture([{ SectionId: 4 }]), pageUrl), false);
  assert.equal(hasExerciseCapture(capture([{ LessonSectionId: 4 }]), pageUrl), false);
  assert.equal(hasExerciseCapture(capture([{ SectionId: 4 }, { SectionId: 3 }]), pageUrl), true);
  assert.equal(hasExerciseCapture(capture([{ Id: 10, Type: 2 }]), pageUrl), true);
  assert.equal(hasExerciseCapture([{ pageUrl, data: rpc([{ SectionId: 4 }]) }], pageUrl), false);
});

test('a declared incomplete author response cannot confirm completeness but a later complete response can', () => {
  const incomplete = { pageUrl, data: rpc([], { Value: { Items: [], SectionId: 3, Count: 2 } }) };
  assert.deepEqual(exerciseCaptureStatus([incomplete], pageUrl), { received: false, reason: 'incomplete' });
  assert.equal(hasExerciseCapture([incomplete, { pageUrl, data: rpc() }], pageUrl), true);
  assert.deepEqual(exerciseCaptureStatus([{ pageUrl, data: rpc() }, incomplete], pageUrl), { received: false, reason: 'incomplete' });
  assert.equal(hasExerciseCapture([{ pageUrl, data: rpc([], { Value: { Items: [], Count: 0 } }) }], pageUrl), true);
});

test('author status selects the latest response timestamp even when records arrive out of order', () => {
  const complete = { pageUrl, receivedAt: '2026-10-24T10:00:02Z', data: rpc() };
  const incomplete = { pageUrl, receivedAt: '2026-10-24T10:00:01Z', data: rpc([], { Value: { Items: [], SectionId: 3, Count: 1 } }) };
  assert.equal(hasExerciseCapture([complete, incomplete], pageUrl), true);
  assert.equal(hasExerciseCapture([incomplete, complete], pageUrl), true);
  const latestIncomplete = { ...incomplete, receivedAt: '2026-10-24T10:00:03Z' };
  assert.deepEqual(exerciseCaptureStatus([latestIncomplete, complete], pageUrl), { received: false, reason: 'incomplete' });
  assert.deepEqual(exerciseCaptureStatus([complete, latestIncomplete], pageUrl), { received: false, reason: 'incomplete' });
});

test('equal and invalid timestamps prefer the last matching branch or record', () => {
  const complete = rpc();
  const incomplete = rpc([], { Value: { Items: [], SectionId: 3, Count: 1 } });
  for (const receivedAt of [undefined, 'invalid', '2026-10-24T10:00:02Z']) {
    assert.equal(hasExerciseCapture([{ pageUrl, receivedAt, data: [incomplete, complete] }], pageUrl), true);
    assert.equal(hasExerciseCapture([{ pageUrl, receivedAt, data: [complete, incomplete] }], pageUrl), false);
    assert.equal(hasExerciseCapture([{ pageUrl, receivedAt, data: incomplete }, { pageUrl, receivedAt, data: complete }], pageUrl), true);
    assert.equal(hasExerciseCapture([{ pageUrl, receivedAt, data: complete }, { pageUrl, receivedAt, data: incomplete }], pageUrl), false);
  }
  assert.equal(hasExerciseCapture([{ pageUrl, receivedAt: '2026-10-24T10:00:02Z', data: complete },
    { pageUrl, receivedAt: 'invalid', data: incomplete }], pageUrl), false);
});

test('response timestamps retain nanosecond ordering used by the importer', () => {
  const complete = { pageUrl, receivedAt: '2026-10-24T10:00:02.000000002Z', data: rpc() };
  const incomplete = { pageUrl, receivedAt: '2026-10-24T10:00:02.000000001Z', data: rpc([], { Value: { Items: [], SectionId: 3, Count: 1 } }) };
  assert.equal(hasExerciseCapture([complete, incomplete], pageUrl), true);
});

test('homework retains its numeric section definition through the captured route alias', () => {
  const homework = pageUrl.replace('/section/3', '/section/for-homework');
  assert.equal(hasExerciseCapture([{ pageUrl: homework, data: rpc([{ SectionId: 123 }], { Value: { SectionId: 123, Items: [] } }) }], homework), true);
});

test('a lesson route without an explicit section can retain its current author definitions', () => {
  const lesson = 'https://progressme.ru/lesson-editor/book/1/lesson/2';
  assert.equal(hasExerciseCapture([{ pageUrl: lesson, data: rpc() }], lesson), true);
});

test('deep and cyclic unrecognized input stays bounded', () => {
  const data = {}; data.child = data;
  assert.equal(hasExerciseCapture([{ pageUrl, data }], pageUrl), false);
});
