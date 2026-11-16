import assert from 'node:assert/strict';
import test from 'node:test';
import { homeworkSectionId } from '../src/lib/homework-section.js';
import { exerciseCaptureObservation } from '../src/lib/exercise-capture.js';

const url = 'https://progressme.ru/lesson-editor/book/1/lesson/2/section/for-homework';
const alias = (id, receivedAt = '2026-11-15T10:00:00.000Z', pageUrl = url) => ({ pageUrl, receivedAt,
  data: { Class: 'LessonWsController', Method: 'GetLessonWithId', IsSuccess: true,
    Value: { Id: 2, Book: { Id: 1 }, Sections: [], HomeworkSection: { Id: id } } } });

test('only metadata for the same origin, book and lesson establishes the homework alias', () => {
  for (const pageUrl of [url.replace('progressme.ru', 'platform.desharschool.ru'), url.replace('/book/1', '/book/9'), url.replace('/lesson/2', '/lesson/9')]) {
    assert.equal(homeworkSectionId([alias(4, undefined, pageUrl)], url), null);
  }
  for (const change of [value => { value.Id = 9; }, value => { value.Book.Id = 9; }, value => { value.HomeworkSection.Id = -1; }]) {
    const invalid = alias(4); change(invalid.data.Value);
    assert.equal(homeworkSectionId([invalid], url), null);
  }
  assert.equal(homeworkSectionId([alias(4, undefined, 'https://progressme.ru/cabinet/school/materials/book/1/content')], url), '4');
});

test('homework aliases use the same timestamp and tie rules as exercise definitions', () => {
  const newer = alias(4, '2026-11-15T10:00:00.000000002Z');
  const older = alias(5, '2026-11-15T10:00:00.000000001Z');
  assert.equal(homeworkSectionId([newer, older], url), '4');
  assert.equal(homeworkSectionId([older, newer], url), '4');
  assert.equal(homeworkSectionId([alias(4), alias(5)], url), '5');
});

test('ordinary material data and mismatched section replies cannot produce author acknowledgements', () => {
  const data = { Class: 'GetExerciseWsController', Method: 'LoadExercises', IsSuccess: true, Value: { SectionId: 3, Items: [] } };
  assert.equal(exerciseCaptureObservation({ pageUrl: url, data }, url, [alias(4)]), undefined);
  assert.equal(exerciseCaptureObservation({ pageUrl: url, data: { materials: [] } }, url, []), undefined);
  const nested = alias(4); nested.data = { batch: [nested.data] };
  assert.equal(homeworkSectionId([nested], url), '4');
});
