import test from 'node:test';
import assert from 'node:assert/strict';
import { collectBook } from '../src/lib/collection.js';
import { createProblemReport } from '../src/lib/problem-report.js';

test('an unavailable document keeps its verified context through the shared deadline without navigating', async () => {
  const url = 'https://progressme.ru/cabinet/school/materials/book/71/content';
  const navigation = { cause: 'unexpected_document', phase: 'loading', event: 'onHistoryStateUpdated',
    sourceDocumentId: '11111111-1111-4111-8111-111111111111', expectedUrl: url };
  let now = 0, reads = 0;
  const commands = [];
  const report = await collectBook({ now: () => now, transitionTimeoutMs: 300, retryAfterMs: 100, pollMs: 100,
    wait: async ms => { now += ms; }, request: async type => {
      commands.push(type);
      if (type === 'GET_NAVIGATION') {
        if (++reads === 1) return { navigation: { url, kind: 'book', materialId: '71', items: [],
          documentToken: 'source-document-00000001' } };
        throw Object.assign(new Error('Document could not be confirmed'), { code: 'source_unavailable', navigation });
      }
      if (type === 'GET_SOURCE_STATUS') return { sourceStatus: { state: 'unavailable', canRetry: false, navigation } };
      if (type === 'BEGIN_COLLECTION') return { collectionId: 'collection-00000001' };
      if (type === 'NAVIGATE_SOURCE') return { transition: { id: 'transition-00000001', attempt: 1, maxAttempts: 3, deadlineAt: 1000 } };
      return { ok: true };
    } });
  assert.equal(report.status, 'failed');
  assert.equal(now, 300);
  assert.equal(commands.filter(type => type === 'NAVIGATE_SOURCE').length, 1);
  assert.equal(commands.includes('RETRY_SOURCE_NAVIGATION'), false);
  assert.equal(commands.includes('TAKE_SNAPSHOT'), false);
  assert.equal(report.diagnostics.failure.reason, 'document_load_timeout');
  assert.equal(report.diagnostics.failure.navigation?.cause, 'unexpected_document');
  assert.equal(report.diagnostics.failure.observedUrl, undefined);
  const downloaded = createProblemReport({ collectionDiagnostics: report.diagnostics });
  assert.equal(downloaded.collection.failure.navigation?.cause, 'unexpected_document');
});
