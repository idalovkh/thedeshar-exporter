import assert from 'node:assert/strict';
import test from 'node:test';
import { collectBook } from '../src/lib/collection.js';
import { withCollectionTransitions } from './collection-transition-fixture.js';

const origin = 'https://progressme.ru';
const bookUrl = `${origin}/cabinet/school/materials/book/71/content`;
const bootstrapUrl = `${origin}/lesson-editor/book/71/lesson/8/section`;
const sectionUrl = `${bootstrapUrl}/9`;

function source(mode) {
  const calls = [], snapshots = [];
  let phase = 'book', document = 1, visit = 1, clock = 0, retries = 0, landingPolls = 0, section = '9', lesson = '8';
  const documentToken = () => `bootstrap-document-${String(document).padStart(8, '0')}`;
  const currentUrl = () => phase === 'book' ? bookUrl : phase === 'bootstrap' ? bootstrapUrl
    : `${origin}/lesson-editor/book/71/lesson/${lesson}/section/${section}`;
  function navigation() {
    if (phase === 'book') return { url: bookUrl, kind: 'book', materialId: '71', ready: true, blocked: false,
      documentToken: documentToken(), contentSignature: 'book', items: [{ key: 'lesson-8', kind: 'lesson', sourceId: '8', title: 'Lesson 8' }] };
    return { url: currentUrl(), kind: 'lesson', materialId: '71', lessonId: lesson, ready: phase === 'section', blocked: false,
      documentToken: documentToken(), contentSignature: phase, exerciseState: { loaderVisible: phase !== 'section', listVisible: phase === 'section', emptyVisible: false },
      network: { pending: 0, idleMs: 10000 }, sectionVisit: { token: `bootstrap-section-visit-${visit}`, revision: phase === 'section' ? 1 : 0,
        received: phase === 'section', idleMs: 10000 }, items: [{ key: 'section-9', kind: 'section', sourceId: '9', title: 'Section 9', active: section === '9' }] };
  }
  const changed = () => Object.assign(new Error('Source page changed'), { code: 'source_changed' });
  function land() { phase = 'section'; visit++; landingPolls = 0; }
  const request = withCollectionTransitions(async (type, message = {}) => {
    calls.push({ type, ...structuredClone(message) });
    if (type === 'GET_NAVIGATION') {
      if (phase === 'bootstrap') {
        if (['recheck', 'wrong-recheck'].includes(mode) && message.expectedDocumentToken) {
          if (mode === 'wrong-recheck') lesson = '9';
          land();
        } else if (mode === 'manual-section' || retries > 0 && ++landingPolls >= 2) land();
      } else if (phase === 'section' && mode === 'manual-section' && ++landingPolls >= 1) { section = '10'; visit++; }
      if (message.expectedDocumentToken && message.expectedDocumentToken !== documentToken()) throw changed();
      if (message.expectedUrl && message.expectedUrl !== currentUrl()) throw changed();
      if (message.expectedVisitToken && message.expectedVisitToken !== navigation().sectionVisit?.token) throw changed();
      return { navigation: navigation() };
    }
    if (type === 'BEGIN_COLLECTION') return { collectionId: 'bootstrap-collection-00000001' };
    if (type === 'NAVIGATE_SOURCE') {
      if (message.expectedUrl !== currentUrl() || message.expectedDocumentToken !== documentToken()) throw changed();
      document++; visit++;
      if (message.url === bookUrl) phase = 'book';
      else {
        assert.equal(message.url, bootstrapUrl);
        assert.equal(phase, 'bootstrap');
        retries++; landingPolls = 0;
      }
      return { ok: true };
    }
    if (type === 'PREPARE_BOOK') return { ok: true, opened: 0, navigation: navigation() };
    if (type === 'OPEN_MATERIAL_ITEM') {
      assert.equal(message.key, 'lesson-8');
      phase = 'bootstrap'; visit++; landingPolls = 0;
      return { ok: true };
    }
    if (type === 'TAKE_SNAPSHOT') {
      assert.equal(message.expectedUrl, currentUrl());
      assert.equal(message.expectedDocumentToken, documentToken());
      if (phase !== 'book') {
        assert.equal(phase, 'section');
        assert.equal(message.expectedVisitToken, navigation().sectionVisit.token);
      }
      snapshots.push(currentUrl());
      return { snapshotUrl: currentUrl(), retained: { dropped: 0, authorData: phase === 'section' } };
    }
    if (type === 'GET_STATE') return { state: { dropped: 0, warnings: [] } };
    return { ok: true };
  }, { getNavigation: navigation, onCommand: (type, message) => calls.push({ type, ...structuredClone(message) }) });
  return { calls, snapshots, run: () => collectBook({ request, now: () => clock, wait: async ms => { clock += ms; },
    retryAfterMs: 8, transitionTimeoutMs: 100, retryDelaysMs: [0, 0], pollMs: 1, fastPollMs: 1, quietMs: 0 }),
    clock: () => clock };
}

test('a lesson bootstrap timeout can reload and land on its first concrete section', async () => {
  const app = source('retry');
  const report = await app.run();
  assert.equal(report.status, 'finished', JSON.stringify(report.failed));
  assert.ok(app.snapshots.includes(sectionUrl));
  assert.equal(app.snapshots.includes(bootstrapUrl), false);
  assert.equal(app.calls.filter(call => call.type === 'RETRY_SOURCE_NAVIGATION').length, 1);
  const guarded = app.calls.find(call => call.type === 'GET_NAVIGATION' && call.expectedDocumentToken && !call.expectedUrl);
  assert.ok(guarded, 'bootstrap recheck keeps its document guard without treating the placeholder URL as final');
  assert.equal(guarded.expectedVisitToken, undefined, 'the placeholder visit is not a confirmed section visit');
  assert.ok(guarded.transitionId);
});

test('a concrete lesson landing arriving at the guarded recheck is observed without resetting its budget', async () => {
  const app = source('recheck');
  const report = await app.run();
  assert.equal(report.status, 'finished', JSON.stringify(report.failed));
  assert.ok(app.snapshots.includes(sectionUrl));
  assert.equal(app.calls.filter(call => call.type === 'RETRY_SOURCE_NAVIGATION').length, 0);
  assert.ok(app.clock() < 100);
});

test('an unconfirmed bootstrap recheck cannot redirect to another lesson in the same book', async () => {
  const app = source('wrong-recheck');
  const report = await app.run();
  assert.equal(report.status, 'failed');
  assert.equal(report.diagnostics.failure.reason, 'source_changed');
  assert.deepEqual(app.snapshots, [bookUrl]);
});

test('a confirmed concrete section remains pinned when its route changes during settling', async () => {
  const app = source('manual-section');
  const report = await app.run();
  assert.equal(report.status, 'failed');
  assert.equal(report.diagnostics.failure.reason, 'source_changed');
  assert.deepEqual(app.snapshots, [bookUrl]);
});
