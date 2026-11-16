import assert from 'node:assert/strict';
import test from 'node:test';
import { collectBook } from '../src/lib/collection.js';
import { withCollectionTransitions } from './collection-transition-fixture.js';

test('the full report observes collection events before the legacy 200-event limit', async () => {
  const url = 'https://progressme.ru/cabinet/school/materials/book/71/content';
  let reloaded = false, reads = 0;
  const events = [];
  const report = await collectBook({ extensionVersion: '0.3.22', pollMs: 1, fastPollMs: 1, quietMs: 0,
    attempts: 400, pendingGraceMs: 1000, wait: async () => {}, onDiagnostic: event => events.push(event),
    request: withCollectionTransitions(async (type) => {
      if (type === 'BEGIN_COLLECTION') return { collectionId: 'collection-test-00000000' };
      if (type === 'NAVIGATE_SOURCE') { reloaded = true; return {}; }
      if (type === 'GET_NAVIGATION' || type === 'PREPARE_BOOK') {
        if (type === 'GET_NAVIGATION' && reloaded) reads++;
        const pending = reloaded && reads < 300 ? 1 : 0;
        return { navigation: { url, kind: 'book', materialId: '71', items: [], ready: true,
          documentToken: reloaded ? 'document-test-00000002' : 'document-test-00000001',
          contentSignature: 'book', exerciseState: { loaderVisible: reads % 2 === 0, listVisible: true, emptyVisible: false },
          network: { pending, idleMs: 500 } } };
      }
      if (type === 'TAKE_SNAPSHOT') return { snapshotUrl: url, savedSnapshotUrl: url };
      if (type === 'GET_STATE') return { state: { dropped: 0 } };
      return {};
    }),
  });
  assert.equal(report.status, 'finished');
  assert.ok(events.length > 200);
  assert.equal(report.diagnostics.events.length, 200);
  assert.equal(report.diagnostics.omittedEvents, events.length - 200);
  assert.equal(events[0].stage, 'book');
  assert.equal(events.at(-1).status, 'finished');
});

test('a diagnostic observer cannot replace the original collection failure', async () => {
  const report = await collectBook({ request: async () => { throw Object.assign(new Error('Original source failure'), { code: 'source_closed' }); },
    onDiagnostic() { throw new Error('Diagnostic failure'); } });
  assert.equal(report.status, 'failed');
  assert.match(report.failed[0].error, /Original source failure/);
  assert.equal(report.diagnostics.failure.reason, 'source_closed');
});
