import assert from 'node:assert/strict';
import test from 'node:test';
import { collectBook } from '../src/lib/collection.js';
import { createProblemReport, projectProblemEvent } from '../src/lib/problem-report.js';

test('a source RPC timeout retains its cause in collection and downloadable diagnostics', async () => {
  const report = await collectBook({ request: async () => {
    throw Object.assign(new Error('Source did not answer'), { code: 'source_timeout' });
  } });
  assert.equal(report.status, 'failed');
  assert.equal(report.diagnostics.failure.reason, 'source_timeout');
  const downloadable = createProblemReport({ collectionDiagnostics: report.diagnostics });
  assert.equal(downloadable.collection.failure.reason, 'source_timeout');
  assert.equal(projectProblemEvent({ stage: 'connection', status: 'failed', reason: 'source_timeout' }).reason, 'source_timeout');
});
