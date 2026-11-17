import assert from 'node:assert/strict';
import test from 'node:test';
import { createProblemReporter } from '../src/ui/problem-report.js';
import { projectProblemEvent } from '../src/lib/problem-report.js';
import { collectionLoadingDetail } from '../src/ui/source-status-view.js';

test('recovery diagnostics retain the method/budget without admitting arbitrary request data', () => {
  const event = projectProblemEvent({ at: '2026-11-17T00:00:00.000Z', stage: 'replace_source', status: 'retrying',
    reason: 'author_data_missing', recovery: 'replace', idleMs: 60000, remainingMs: 90000, definitionRetrySkipped: true,
    request: { token: 'private-token' } });
  assert.equal(event.recovery, 'replace');
  assert.equal(event.idleMs, 60000);
  assert.equal(event.definitionRetrySkipped, true);
  assert.doesNotMatch(JSON.stringify(event), /private-token|request/);
  assert.equal(collectionLoadingDetail(event), 'Продолжаем в новой вкладке.');
});

test('a retained diagnostic attempt follows its workspace into the new source tab', async () => {
  const calls = [];
  const reporter = createProblemReporter({ send: async (tabId, type) => {
    calls.push({ tabId, type }); return { reportId: 'report', attemptId: 'attempt' };
  } });
  const book = { rootUrl: 'https://progressme.ru/cabinet/school/materials/book/71/content', title: 'Book' };
  reporter.select({ tabId: 7, workspaceId: 'workspace', book });
  const attempt = await reporter.begin('collection');
  reporter.select({ tabId: 8, workspaceId: 'workspace', book });
  attempt.record({ stage: 'replace_source', status: 'retrying', recovery: 'replace', attempt: 3 });
  await attempt.flush();
  assert.deepEqual(calls, [{ tabId: 7, type: 'BEGIN_PROBLEM_REPORT' }, { tabId: 8, type: 'APPEND_PROBLEM_EVENTS' }]);
  reporter.clear();
});
