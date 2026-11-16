import assert from 'node:assert/strict';
import test from 'node:test';
import { collectBook } from '../src/lib/collection.js';
import { createProblemReport } from '../src/lib/problem-report.js';

const url = 'https://progressme.ru/cabinet/school/materials/book/71/content';
const observedUrl = 'https://progressme.ru/cabinet/school/materials/book/81/content';
const navigation = { event: 'onBeforeNavigate', phase: 'committed', cause: 'unexpected_target',
  sourceDocumentId: '22222222-2222-4222-8222-222222222222', expectedUrl: url, observedUrl };

for (const confirmedAddress of [true, false]) {
  test(`collector retains navigation failure context ${confirmedAddress ? 'with a verified address' : 'without inventing an observed address'}`, async () => {
    let reads = 0;
    const report = await collectBook({ request: async type => {
      if (type === 'GET_NAVIGATION') {
        if (++reads === 1) return { navigation: { url, kind: 'book', materialId: '71', items: [],
          documentToken: 'source-document-00000001' } };
        throw Object.assign(new Error('The source changed'), { code: 'source_left_page', navigation,
          ...(confirmedAddress ? { expectedUrl: url, observedUrl } : {}) });
      }
      if (type === 'BEGIN_COLLECTION') return { collectionId: 'collection-00000001' };
      if (type === 'NAVIGATE_SOURCE') return { transition: { id: 'transition-00000001', attempt: 1,
        maxAttempts: 3, deadlineAt: Date.now() + 180000 } };
      return { ok: true };
    } });
    assert.equal(report.status, 'failed');
    assert.equal(report.diagnostics.failure.reason, 'source_left_page');
    assert.equal(report.diagnostics.failure.navigation?.cause, 'unexpected_target');
    assert.equal(report.diagnostics.failure.observedUrl, confirmedAddress ? observedUrl : undefined);
    assert.equal(report.diagnostics.failure.url, url, 'last known source remains context, not an observed URL');
    const downloadable = createProblemReport({ collectionDiagnostics: report.diagnostics });
    assert.equal(downloadable.collection.failure.navigation?.sourceDocumentId, navigation.sourceDocumentId);
    assert.equal(downloadable.collection.failure.observedUrl, confirmedAddress ? observedUrl : undefined);
  });
}
