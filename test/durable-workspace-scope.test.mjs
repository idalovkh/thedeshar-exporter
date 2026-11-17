import assert from 'node:assert/strict';
import test from 'node:test';
import { createDurableWorkspaceScope } from '../src/lib/durable-workspace-scope.js';

function storage(values = {}) {
  return { values, get: async key => ({ [key]: values[key] }), set: async update => Object.assign(values, update) };
}

test('durable scope adopts the supported session key and survives a browser restart without recreating data', async () => {
  const local = storage(), session = storage({ 'workspace-session-scope': 'existing-session-000001' });
  const first = createDurableWorkspaceScope({ localStorage: local, sessionStorage: session, randomUUID: () => 'unexpected-new-scope' });
  assert.equal(await first(), 'existing-session-000001');
  assert.equal(local.values['workspace-durable-scope'], 'existing-session-000001');
  const restartedSession = storage();
  const second = createDurableWorkspaceScope({ localStorage: local, sessionStorage: restartedSession, randomUUID: () => 'unexpected-new-scope' });
  assert.equal(await second(), 'existing-session-000001');
  assert.deepEqual(restartedSession.values, {}, 'Persistent records must not resurrect a session or tab binding');
});

test('failed durable scope writes retry the same supported scope without publishing a replacement', async () => {
  const local = storage(), session = storage({ 'workspace-session-scope': 'existing-session-000001' });
  const set = local.set;
  let attempts = 0;
  local.set = async update => { if (++attempts === 1) throw Error('disk unavailable'); await set(update); };
  const scope = createDurableWorkspaceScope({ localStorage: local, sessionStorage: session });
  await assert.rejects(scope(), /disk unavailable/);
  assert.equal(await scope(), 'existing-session-000001');
});

test('scope fallback keeps session isolation when local storage is intentionally unavailable', async () => {
  const session = storage();
  const scope = createDurableWorkspaceScope({ sessionStorage: session, randomUUID: () => 'new-session-00000001' });
  assert.equal(await scope(), 'new-session-00000001');
  assert.equal(session.values['workspace-session-scope'], 'new-session-00000001');
});
