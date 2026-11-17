import test from 'node:test';
import assert from 'node:assert/strict';
import { observePreservedCapture } from '../src/lib/resume-capture.js';
import { resumeSection, savedResumeState } from './resume-ui-fixture.js';

function incoming(state) {
  const event = structuredClone(state.captures[0]);
  event.receivedAt = '2026-11-16T12:00:00.000Z';
  event.data.Value.Items[0].Name = 'Freshly edited answer';
  return event;
}

test('resuming acknowledges a fresh response without replacing saved answers or timestamps', () => {
  const state = savedResumeState(), before = structuredClone(state);
  state.collection.status = 'running'; before.collection.status = 'running';
  const observed = observePreservedCapture(state, incoming(state), { resume: true });
  assert.equal(observed.state, state);
  assert.deepEqual(observed.exerciseCapture, { received: true });
  assert.deepEqual(state, before);
  assert.equal(state.captures[0].data.Value.Items[0].Name, 'Saved answer');
});

test('preservation cannot confirm incomplete or wrong-section source replies', () => {
  const state = savedResumeState(), partial = incoming(state);
  partial.data.Value.Count = 2;
  assert.deepEqual(observePreservedCapture(state, partial, { resume: true }).exerciseCapture, { received: false, reason: 'incomplete' });
  const wrong = incoming(state); wrong.data.Value.SectionId = 999;
  assert.equal(observePreservedCapture(state, wrong, { resume: true }).exerciseCapture, undefined);
});

test('new collections, other pages and orphan checkpoints do not suppress capture persistence', () => {
  const state = savedResumeState();
  assert.equal(observePreservedCapture(state, incoming(state), { resume: false }), null);
  for (const pageUrl of [resumeSection.replace('/9', '/10'), resumeSection.replace('progressme.ru', 'foreign.example')]) {
    assert.equal(observePreservedCapture(state, { ...incoming(state), pageUrl }, { resume: true }), null);
  }
  state.snapshots = [];
  assert.equal(observePreservedCapture(state, incoming(state), { resume: true }), null);
});
