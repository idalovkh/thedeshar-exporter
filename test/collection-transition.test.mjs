import assert from 'node:assert/strict';
import test from 'node:test';
import { createCollectionTransition } from '../src/lib/collection-transition.js';

function fixture({ signal, wait, state = 'same_book', canRetry = true, retryError } = {}) {
  let clock = 0, attempt = 1;
  const calls = [], pauses = [];
  const descriptor = () => ({ id: 'transition-one', attempt, maxAttempts: 3, deadlineAt: 180000 });
  const transition = createCollectionTransition({ now: () => clock, signal,
    wait: wait || (async ms => { pauses.push(ms); clock += ms; }),
    request: async (type, payload) => {
      calls.push({ type, ...payload });
      if (type === 'GET_SOURCE_STATUS') return { sourceStatus: { state, browserLoading: state === 'loading', canRetry,
        transitionId: 'transition-one', remainingMs: 180000 - clock } };
      assert.equal(type, 'RETRY_SOURCE_NAVIGATION');
      if (retryError) throw retryError;
      return { transition: { ...descriptor(), attempt: ++attempt }, reloaded: true, previousDocumentToken: 'document-one' };
    },
  });
  transition.accept(descriptor());
  return { transition, calls, pauses, advance: ms => { clock += ms; }, now: () => clock };
}

test('one deadline includes navigation RPC time and the two backoff delays', async () => {
  const app = fixture();
  await app.transition.run(async () => { app.advance(172000); });
  assert.equal(app.transition.remaining(), 8000);
  assert.equal((await app.transition.retry('source_network_error')).transition.attempt, 2);
  assert.equal(app.transition.remaining(), 6000);
  assert.equal((await app.transition.retry('author_data_missing')).transition.attempt, 3);
  assert.equal(app.transition.remaining(), 1000);
  assert.deepEqual(app.pauses, [2000, 5000]);
  assert.equal(await app.transition.retry('section_render_timeout'), null);
  assert.equal(app.calls.filter(call => call.type === 'RETRY_SOURCE_NAVIGATION').length, 2);
  await app.transition.pause(10000);
  assert.equal(app.now(), 180000);
  assert.equal(app.transition.remaining(), 0);
  await assert.rejects(app.transition.run(async () => {}), { code: 'transition_timeout' });
});

test('a confirmed browser load is never restarted at the soft deadline', async () => {
  const app = fixture({ state: 'loading', canRetry: false });
  await app.transition.pause(61000);
  assert.equal(app.transition.attemptRemaining(), 0);
  assert.equal(await app.transition.retry('source_timeout'), null);
  assert.equal(app.transition.remaining(), 119000);
  assert.equal(app.calls.some(call => call.type === 'RETRY_SOURCE_NAVIGATION'), false);
});

test('a retry is refused when the worker cannot confirm recovery authority', async () => {
  const app = fixture({ canRetry: false });
  assert.equal(await app.transition.retry('source_unavailable'), null);
  assert.deepEqual(app.pauses, []);
});

test('a source-loading race at the final worker check leaves the attempt available for bounded observation', async () => {
  const app = fixture({ retryError: Object.assign(new Error('Chrome is retrying the page'), { code: 'source_loading' }) });
  assert.equal(await app.transition.retry('source_network_error'), null);
  assert.equal(app.transition.attempt(), 1);
  assert.equal(app.transition.remaining(), 178000);
});

test('cancelling during backoff prevents a later navigation command', async () => {
  const controller = new AbortController();
  let finishWait;
  const app = fixture({ signal: controller.signal, wait: () => new Promise(resolve => { finishWait = resolve; }) });
  const pending = app.transition.retry('source_network_error');
  while (!finishWait) await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  finishWait();
  await Promise.resolve();
  assert.equal(app.calls.some(call => call.type === 'RETRY_SOURCE_NAVIGATION'), false);
});

test('cancelling before the queued request starts never invokes it', async () => {
  const controller = new AbortController();
  const app = fixture({ signal: controller.signal });
  let called = false;
  const pending = app.transition.run(async () => { called = true; });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(called, false);
});

test('the overall deadline also bounds a silent browser command', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const app = fixture();
  const pending = app.transition.run(() => new Promise(() => {}));
  const rejected = assert.rejects(pending, { code: 'transition_timeout' });
  t.mock.timers.tick(180000);
  await rejected;
});

for (const [state, code] of [['other_book', 'source_changed'], ['source_changed', 'source_left_page'],
  ['security_error', 'source_security_error'], ['interrupted', 'source_interrupted'], ['closed', 'source_closed']]) {
  test(`${state} ends recovery without a reload`, async () => {
    const app = fixture({ state });
    await assert.rejects(app.transition.status(), { code });
    assert.equal(app.calls.some(call => call.type === 'RETRY_SOURCE_NAVIGATION'), false);
  });
}
