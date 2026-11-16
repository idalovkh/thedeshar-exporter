import assert from 'node:assert/strict';
import test from 'node:test';
import { collectBook } from '../src/lib/collection.js';
import { createProblemReport } from '../src/lib/problem-report.js';
import { withCollectionTransitions } from './collection-transition-fixture.js';

for (const phase of ['initial', 'settling']) {
  test(`a binding refusal during ${phase} keeps its safe cause in collection failure and report`, async () => {
    let reads = 0;
    const events = [];
    const report = await collectBook({ onDiagnostic: event => events.push(event),
      request: withCollectionTransitions(async type => {
        if (type === 'GET_NAVIGATION') {
          if (++reads > 1 || phase === 'initial') throw Object.assign(new Error('Owner binding mismatch'), {
            code: 'exporter_binding_mismatch', binding: { cause: 'workspace_mismatch', operation: 'GET_NAVIGATION', documentId: 'private-document' },
          });
          return { navigation: { kind: 'book', url: 'https://progressme.ru/cabinet/school/materials/book/71/content',
            materialId: '71', documentToken: 'initial-document-0001', items: [], ready: true } };
        }
        if (type === 'BEGIN_COLLECTION') return { collectionId: 'binding-collection-0001' };
        return { ok: true };
      }),
    });
    const binding = { cause: 'workspace_mismatch', operation: 'GET_NAVIGATION' };
    assert.equal(report.status, 'failed');
    assert.equal(report.diagnostics.failure.reason, 'exporter_binding_mismatch');
    assert.deepEqual(report.diagnostics.failure.binding, binding);
    assert.deepEqual(events.at(-1).binding, binding);
    const downloaded = createProblemReport({ collectionDiagnostics: report.diagnostics });
    assert.deepEqual(downloaded.collection.failure.binding, binding);
    assert.deepEqual(downloaded.events.at(-1).binding, binding);
    assert.doesNotMatch(JSON.stringify(downloaded), /private-document|documentId/);
  });
}
