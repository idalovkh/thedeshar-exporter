import assert from 'node:assert/strict';
import test from 'node:test';
import { createSourceReplacement } from '../src/ui/source-replacement.js';

test('replacement adopts its new source before commit without replacing the dashboard', async () => {
  let source = 7;
  const calls = [];
  const driver = createSourceReplacement({ getSourceTabId: () => source, adopt: id => { source = id; },
    send: async type => { calls.push({ type, source }); return type === 'PREPARE_SOURCE_REPLACEMENT'
      ? { token: 'token', sourceTabId: 8 } : { transition: { id: 'same-transition' } }; } });
  const result = await driver.replace({ collectionId: 'collection' });
  assert.equal(source, 8);
  assert.equal(calls[1].source, 8);
  assert.equal(result.transition.id, 'same-transition');
  assert.equal(driver.active(), false);
});

test('cancellation while preparing closes a late-created replacement and restores the source', async () => {
  let source = 7, resolve;
  const controller = new AbortController(), calls = [];
  const driver = createSourceReplacement({ signal: controller.signal, getSourceTabId: () => source, adopt: id => { source = id; },
    send: async type => { calls.push(type); return type === 'PREPARE_SOURCE_REPLACEMENT'
      ? new Promise(done => { resolve = done; }) : {}; } });
  const pending = driver.replace({ collectionId: 'collection' });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort(); resolve({ token: 'token', sourceTabId: 8 });
  await rejected;
  assert.equal(source, 7);
  assert.equal(calls.includes('COMMIT_SOURCE_REPLACEMENT'), false);
  assert.ok(calls.includes('ABORT_SOURCE_REPLACEMENT'));
});

test('failed commit restores the old source and requests journal cleanup', async () => {
  let source = 7;
  const calls = [];
  const driver = createSourceReplacement({ getSourceTabId: () => source, adopt: id => { source = id; },
    send: async type => {
      calls.push(type);
      if (type === 'PREPARE_SOURCE_REPLACEMENT') return { token: 'token', sourceTabId: 8 };
      if (type === 'COMMIT_SOURCE_REPLACEMENT') throw new Error('Failed');
      return {};
    } });
  await assert.rejects(driver.replace({ collectionId: 'collection' }), /Failed/);
  assert.equal(source, 7);
  assert.equal(calls.at(-1), 'ABORT_SOURCE_REPLACEMENT');
});
