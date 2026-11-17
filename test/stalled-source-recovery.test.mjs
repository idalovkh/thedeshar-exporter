import assert from 'node:assert/strict';
import test from 'node:test';
import { createSourceStallRecovery } from '../src/lib/source-stall-recovery.js';

function fixture() {
  const url = 'https://school.example/lesson-editor/book/1/lesson/2/section/3';
  let clock = 0, intent = { id: 'transition', tabId: 7, attempt: 1, maxAttempts: 3, deadlineAt: 180000,
    sourceUrl: url, sourceDocumentToken: 'page-token', sourceBrowserDocumentId: 'document',
    browserDocumentId: 'document', attemptSourceBrowserDocumentId: 'document', observedUrl: url,
    bookKey: 'https://school.example/book/1', progress: { at: 0, seen: [] } };
  let browser = { tab: { id: 7, url, pendingUrl: url, status: 'loading' }, frame: { url, documentId: 'document' } };
  const actions = [];
  const options = { now: () => clock, canonicalUrl: value => value === url ? url : '',
    bookKey: value => value === url ? intent.bookKey : '', targetMatches: (_intent, value) => value === url,
    boundIntent: async () => ({ intent, check() {} }), checkBudget: value => {
      if (clock >= value.deadlineAt) throw Object.assign(new Error('Expired'), { code: 'transition_timeout' });
    }, browserState: async () => browser, save: async (_id, value) => { intent = value; },
    serial: async (_id, operation) => operation(), descriptor: value => ({ id: value.id, attempt: value.attempt, deadlineAt: value.deadlineAt }),
    chrome: { tabs: { update: async (id, patch) => { actions.push({ id, ...patch }); } } },
  };
  return { recovery: createSourceStallRecovery(options), actions, advance: ms => { clock += ms; },
    current: () => intent, setBrowser: value => { browser = value; } };
}

test('a hung browser load recovers after inactivity and retains the original deadline', async () => {
  const app = fixture();
  app.advance(29999);
  await assert.rejects(app.recovery.reload({}, 'transition'), { code: 'source_loading' });
  app.advance(1);
  const result = await app.recovery.reload({}, 'transition');
  assert.equal(result.transition.attempt, 2);
  assert.equal(result.transition.deadlineAt, 180000);
  assert.equal(app.actions.length, 1);
  app.advance(59999);
  await assert.rejects(app.recovery.inspect({}, 'transition'), { code: 'source_loading' });
  app.advance(1);
  assert.equal((await app.recovery.inspect({}, 'transition')).attempt, 2);
});

test('unrecognized destinations and replacement documents cannot obtain recovery', async () => {
  for (const browser of [
    { tab: { url: 'https://school.example/login', status: 'complete' }, frame: { url: 'https://school.example/login', documentId: 'document' } },
    { tab: { status: 'complete' }, frame: { url: 'https://school.example/lesson-editor/book/1/lesson/2/section/3', documentId: 'other' } },
  ]) {
    const app = fixture(); app.advance(30000); app.setBrowser(browser);
    await assert.rejects(app.recovery.reload({}, 'transition'));
    assert.equal(app.actions.length, 0);
  }
});
