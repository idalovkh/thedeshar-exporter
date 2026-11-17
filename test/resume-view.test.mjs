import test from 'node:test';
import assert from 'node:assert/strict';
import { getView } from '../src/ui/view.js';
import { resumeBook, resumeSection, savedResumeState } from './resume-ui-fixture.js';

test('a retained checkpoint offers continuation and its original collection date', () => {
  const state = savedResumeState(), before = structuredClone(state);
  const result = getView({ state, sourceAvailable: true, source: { url: resumeBook } });
  assert.equal(result.canResume, true);
  assert.equal(result.collectLabel, 'Продолжить сбор');
  assert.equal(result.confirmedSections, 1);
  assert.equal(result.startedAt, state.collection.startedAt);
  assert.match(result.description, /подтвержд|продолж/i);
  assert.equal(result.canExport, false);
  assert.deepEqual(state, before);
});

test('continuation never bypasses missing source, wrong book, a running operation or dropped data', () => {
  for (const options of [{ sourceAvailable: false }, { source: { url: resumeBook.replace('71', '99') } },
    { source: { url: `${resumeSection}/invalid` } }, { busy: true }, { collecting: true }, { downloading: true }]) {
    assert.equal(getView({ state: savedResumeState(), sourceAvailable: true, source: { url: resumeBook }, ...options }).canResume, false);
  }
  const state = savedResumeState(); state.dropped = 1;
  assert.equal(getView({ state, sourceAvailable: true, source: { url: resumeBook } }).canResume, false);
});

test('a paused collection can continue from a lesson or homework in the same book', () => {
  for (const url of [resumeSection, resumeSection.replace('/section/9', '/section/for-homework'),
    resumeSection.replace('/section/9', '/section'), resumeSection.replace('/section/9', '')]) {
    const result = getView({ state: savedResumeState(), sourceAvailable: true, source: { url } });
    assert.equal(result.canResume, true);
    assert.equal(result.canCollect, true);
    assert.equal(result.collectLabel, 'Продолжить сбор');
    assert.match(result.description, /верн[её]мся к содержанию/i);
  }
});

test('orphan and completed checkpoints do not offer continuation', () => {
  const orphan = savedResumeState(); orphan.snapshots = [{ url: resumeBook }];
  const finished = savedResumeState(); finished.collection.status = 'finished';
  for (const state of [orphan, finished]) {
    const result = getView({ state, sourceAvailable: true, source: { url: resumeBook } });
    assert.equal(result.canResume, false);
    assert.notEqual(result.collectLabel, 'Продолжить сбор');
  }
});

test('a confirmed structure mismatch offers a fresh collection while retaining the saved section count', () => {
  const state = savedResumeState();
  state.collection.status = 'failed';
  state.collection.diagnostics = { failure: { reason: 'resume_structure_changed' } };
  const result = getView({ state, sourceAvailable: true, source: { url: resumeBook } });
  assert.equal(result.canResume, false);
  assert.equal(result.collectLabel, 'Собрать заново');
  assert.equal(result.confirmedSections, 1);
  assert.match(result.title, /Структура книги изменилась/);
  assert.match(result.description, /Собрать заново/);
});
