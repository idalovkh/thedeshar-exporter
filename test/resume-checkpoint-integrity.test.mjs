import assert from 'node:assert/strict';
import test from 'node:test';
import { collectionResumeInfo, confirmedResumePage } from '../src/lib/collection-resume.js';
import { resumeSection, savedResumeState } from './resume-ui-fixture.js';

test('malformed local checkpoint outlines are ignored without crashing the recovery screen', () => {
  for (const change of [state => { state.collection.resume.lessons = [null]; },
    state => { state.collection.resume.lessons[0].sections = {}; },
    state => { state.collection.resume.lessons[0].sections = [null]; },
    state => { state.collection.resume.confirmed = [null]; },
    state => { state.snapshots = null; }]) {
    const state = savedResumeState(); change(state);
    assert.equal(collectionResumeInfo(state).available, false);
    assert.equal(confirmedResumePage(state, resumeSection), null);
  }
});

test('checkpoint indexes cannot borrow a matching snapshot from an unrelated lesson outline', () => {
  const state = savedResumeState();
  state.collection.resume.lessons[0].lessonId = '10';
  assert.equal(collectionResumeInfo(state).available, false);
});
