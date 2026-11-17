import assert from 'node:assert/strict';
import test from 'node:test';
import { createCollectionTransition } from '../src/lib/collection-transition.js';

function fixture({ retried = false } = {}) {
  let clock = 0, attempt = 1;
  const calls = [];
  const descriptor = () => ({ id: 'same', attempt, maxAttempts: 3, deadlineAt: 180000 });
  const transition = createCollectionTransition({ now: () => clock, wait: async ms => { clock += ms; },
    request: async type => {
      calls.push(type);
      if (type === 'GET_SOURCE_STATUS') return { sourceStatus: { state: 'loading', browserLoading: true, canRetry: false } };
      if (type === 'RETRY_DEFINITION_REQUEST') return { retried };
      attempt++;
      return { transition: descriptor(), reloaded: true };
    } });
  transition.accept(descriptor());
  return { transition, calls, time: () => clock };
}

test('unverified requests immediately fall through to reload, then replacement, within one budget', async () => {
  const app = fixture();
  await app.transition.pause(30000);
  assert.equal(app.transition.attemptRemaining(), 0);
  assert.equal((await app.transition.recover('author_data_missing')).recovery, 'reload');
  assert.equal(app.time(), 30000);
  await app.transition.pause(60000);
  assert.equal((await app.transition.recover('author_data_missing')).recovery, 'replace');
  assert.equal(app.transition.remaining(), 90000);
  assert.equal(await app.transition.recover('author_data_missing'), null);
  assert.equal(app.calls.filter(type => type === 'RETRY_DEFINITION_REQUEST').length, 1);
});

test('a verified request receives fifteen seconds without consuming a page recovery attempt', async () => {
  const app = fixture({ retried: true });
  await app.transition.pause(30000);
  assert.equal((await app.transition.recover('author_data_missing')).recovery, 'request');
  assert.equal(app.transition.attempt(), 1);
  await app.transition.pause(14999);
  assert.equal(app.transition.attemptRemaining(), 1);
  await app.transition.pause(1);
  assert.equal((await app.transition.recover('author_data_missing')).recovery, 'reload');
  assert.equal(app.time(), 45000);
});
