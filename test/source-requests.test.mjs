import assert from 'node:assert/strict';
import test from 'node:test';
import { requestSource } from '../src/lib/source-requests.js';

test('a silent source times out and does not hold the following queued request', async () => {
  const pending = requestSource(() => new Promise(() => {}), { timeoutMs: 10 });
  const next = pending.catch(() => {}).then(() => requestSource(async () => 'next'));
  await assert.rejects(pending, { code: 'source_timeout' });
  assert.equal(await next, 'next');
});

test('cancellation rejects immediately and ignores a late source reply', async () => {
  const controller = new AbortController();
  let resolve;
  const pending = requestSource(() => new Promise(done => { resolve = done; }), { signal: controller.signal });
  const reason = Object.assign(new Error('Revoked run'), { code: 'stale_collection' });
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  resolve('late');
});

test('an already cancelled request never contacts the source', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(requestSource(() => { called = true; }, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(called, false);
});

test('source deadlines cannot be extended beyond ten seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = requestSource(() => new Promise(() => {}), { timeoutMs: 60000 });
  const rejected = assert.rejects(pending, { code: 'source_timeout' });
  t.mock.timers.tick(10000);
  await rejected;
});

test('source failures and successful responses retain their identity', async () => {
  const response = { ok: true };
  assert.equal(await requestSource(async () => response), response);
  const error = new Error('Source failed');
  await assert.rejects(requestSource(() => { throw error; }), value => value === error);
});
