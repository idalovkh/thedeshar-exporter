import assert from 'node:assert/strict';
import test from 'node:test';
import { collectBook } from '../src/lib/collection.js';
import { withCollectionTransitions } from './collection-transition-fixture.js';

test('slow navigation replies consume the shared section waiting budget', async () => {
  const rootUrl = 'https://progressme.ru/cabinet/school/materials/book/71/content';
  let now = 0, reads = 0;
  const timeouts = [], pauses = [];
  const report = await collectBook({ attempts: 4, pollMs: 100, transitionTimeoutMs: 400, now: () => now,
    wait: async ms => { pauses.push(ms); now += ms; },
    request: withCollectionTransitions(async (type, message = {}) => {
      if (type === 'GET_NAVIGATION') {
        reads++;
        if (reads > 1) { timeouts.push(message.sourceTimeoutMs); now += 150; }
        return { navigation: { kind: 'book', title: 'Book', materialId: '71', url: rootUrl,
          documentToken: reads === 1 ? 'document-before-0001' : 'document-current-0002',
          ready: reads === 1, items: [], warnings: [] } };
      }
      if (type === 'BEGIN_COLLECTION') return { collectionId: 'collection-test-00001' };
      if (type === 'TAKE_SNAPSHOT') throw new Error('An unready page must not be saved');
      return { ok: true };
    }),
  });
  assert.equal(report.status, 'failed');
  assert.equal(report.diagnostics.failure.reason, 'navigation_timeout');
  assert.equal(reads, 3, 'Only two slow polls fit into 400 ms');
  assert.deepEqual(timeouts, [400, 150]);
  assert.deepEqual(pauses, [100], 'The exhausted budget must not start another polling delay');
});
