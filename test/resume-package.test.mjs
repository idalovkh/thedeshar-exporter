import test from 'node:test';
import assert from 'node:assert/strict';
import { createExportPackage } from '../src/lib/package.js';
import { savedResumeState } from './resume-ui-fixture.js';

test('resume checkpoints stay local while saved author definitions remain in the compatible archive', () => {
  const state = savedResumeState();
  const result = createExportPackage(state);
  const report = JSON.parse(result.entries.find(entry => entry.name === 'collection.json').data);
  assert.equal(report.resume, undefined);
  assert.equal(report.startedAt, state.collection.startedAt);
  const captures = result.entries.filter(entry => entry.name.startsWith('originals/responses/')).map(entry => JSON.parse(entry.data));
  assert.equal(captures[0].data.Value.Items[0].Name, 'Saved answer');
  assert.equal(result.manifest.schemaVersion, 1);
  assert.equal(result.manifest.completeness.representation, 'raw-capture');
});
