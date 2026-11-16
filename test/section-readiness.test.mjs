import assert from 'node:assert/strict';
import test from 'node:test';
import { collectBook } from '../src/lib/collection.js';
import { collectionDiagnosticsForDownload } from '../src/lib/collection-diagnostics.js';
import { projectProblemEvent } from '../src/lib/problem-report.js';
import { withCollectionTransitions } from './collection-transition-fixture.js';

const bookUrl = 'https://platform.desharschool.ru/cabinet/school/materials/book/1/content';
const sectionUrl = id => `https://platform.desharschool.ru/lesson-editor/book/1/lesson/2/section/${id}`;

function source({ delay = 4, renderDelay = 3, failure = '', identical = false, reloadFailure = '', incomplete = false, recoverAfter = Infinity } = {}) {
  let position = 'book', generation = 1, visit = 1, polls = 0, reloads = 0;
  const calls = [], snapshots = [], checkpoints = [];
  const token = () => `source-document-${String(generation).padStart(8, '0')}`;
  const visitToken = () => `section-visit-${String(visit).padStart(8, '0')}`;
  function navigation() {
    const target = position === 12;
    const missing = target && (failure === 'missing' && reloads < recoverAfter || incomplete || polls < delay);
    const blank = target && (failure === 'blank' || reloads && reloadFailure === 'blank' && reloads < recoverAfter);
    const loader = target && (failure === 'loader' || !blank && polls >= delay && polls < delay + renderDelay);
    const old = target && polls < delay + renderDelay;
    return {
      url: position === 'book' ? bookUrl : sectionUrl(position), documentToken: token(),
      materialId: '1', lessonId: position === 'book' ? null : '2', kind: position === 'book' ? 'book' : 'lesson',
      title: 'Book', ready: !loader && !blank, warnings: [],
      contentSignature: identical || old ? 'same-content' : String(position),
      network: { pending: 0, idleMs: 10000 },
      sectionVisit: { token: visitToken(), revision: missing ? 0 : 1, received: !missing,
        ...(incomplete && target ? { reason: 'incomplete' } : {}), idleMs: missing ? 0 : 10000 },
      ...(position === 'book' ? {} : { exerciseState: { loaderVisible: loader, listVisible: !blank && !loader, emptyVisible: false } }),
      items: blank && reloads ? [] : position === 'book' ? [{ key: 'lesson', kind: 'lesson', title: 'Lesson', sourceId: '2' }]
        : [11, 12, 13].map(id => ({ key: `section-${id}`, kind: 'section', title: `Section ${id}`, sourceId: String(id), active: position === id })),
    };
  }
  async function request(type, payload = {}) {
    calls.push({ type, ...payload });
    if (type === 'BEGIN_COLLECTION') return { collectionId: 'collection-section-readiness' };
    if (type === 'GET_NAVIGATION' || type === 'PREPARE_BOOK') {
      if (type === 'GET_NAVIGATION') polls++;
      return { ok: true, opened: 0, navigation: navigation() };
    }
    if (type === 'OPEN_MATERIAL_ITEM') {
      position = payload.key === 'lesson' ? 11 : Number(payload.key.replace('section-', ''));
      polls = 0; visit++;
    }
    if (type === 'NAVIGATE_SOURCE') {
      if (payload.url === bookUrl) position = 'book';
      else reloads++;
      generation++; visit++; polls = 0;
    }
    if (type === 'TAKE_SNAPSHOT') {
      const nav = navigation();
      snapshots.push({ url: nav.url, confirmed: nav.sectionVisit.received, old: position === 12 && polls < delay + renderDelay });
      return { snapshotUrl: nav.url, retained: { dropped: 0, ...(position === 'book' ? {} : { authorData: nav.sectionVisit.received }) } };
    }
    if (type === 'GET_STATE') return { state: { dropped: 0 } };
    if (type === 'SAVE_COLLECTION') checkpoints.push(structuredClone(payload.collection));
    return { ok: true };
  }
  return { request: withCollectionTransitions(request), calls, snapshots, checkpoints, get reloads() { return reloads; } };
}

const collect = (app, extra = {}) => collectBook({ request: app.request, wait: async () => {}, attempts: 20, pollMs: 1,
  fastPollMs: 1, quietMs: 1, transitionTimeoutMs: 70, retryDelaysMs: [0, 0], now: () => 0, ...extra });

test('a changed URL with old DOM and quiet HTTP waits for persisted WebSocket data and the new render', async () => {
  const app = source();
  const report = await collect(app);
  assert.equal(report.status, 'finished', JSON.stringify(report.failed));
  assert.equal(app.reloads, 0);
  assert.ok(app.snapshots.every(snapshot => snapshot.confirmed && !snapshot.old), JSON.stringify(app.snapshots));
  assert.equal(app.snapshots.filter(snapshot => snapshot.url === sectionUrl(12)).length, 1);
});

test('identical exercise text in adjacent sections does not require a changed content signature', async () => {
  const app = source({ identical: true });
  const report = await collect(app);
  assert.equal(report.status, 'finished', JSON.stringify(report.failed));
  assert.ok(app.snapshots.every(snapshot => !snapshot.old));
});

for (const [failure, incomplete, expected] of [
  ['missing', false, 'author_data_missing'], ['', true, 'author_data_incomplete'],
  ['blank', false, 'section_render_timeout'], ['loader', false, 'section_loading_timeout'],
]) {
  test(`${expected} shares a two-reload budget, preserves previous pages and stops later sections`, async () => {
    const app = source({ failure, incomplete });
    const report = await collect(app);
    assert.equal(report.status, 'failed');
    assert.equal(report.diagnostics.failure.reason, expected);
    assert.equal(app.reloads, 2);
    assert.deepEqual(app.snapshots.map(snapshot => snapshot.url), [bookUrl, sectionUrl(11)]);
    assert.deepEqual(report.visited, [bookUrl, sectionUrl(11)]);
    assert.equal(report.items.find(item => item.key === 'section-13').status, 'pending');
    assert.equal(app.calls.some(call => call.type === 'OPEN_MATERIAL_ITEM' && call.key === 'section-13'), false);
    assert.equal(app.checkpoints.at(-1).status, 'failed');
    assert.equal(app.calls.at(-1).type, 'END_COLLECTION');
  });
}

test('missing author data followed by a blank reloaded page does not restart the retry budget', async () => {
  const app = source({ failure: 'missing', reloadFailure: 'blank' });
  const report = await collect(app);
  assert.equal(report.status, 'failed');
  assert.equal(app.reloads, 2);
  assert.equal(report.diagnostics.failure.reason, 'section_render_timeout');
  assert.deepEqual(app.snapshots.map(snapshot => snapshot.url), [bookUrl, sectionUrl(11)]);
});

test('recovery after a completely blank retry verifies the original outline and saves the restored section', async () => {
  const app = source({ failure: 'missing', reloadFailure: 'blank', recoverAfter: 2 });
  const report = await collect(app);
  assert.equal(report.status, 'finished', JSON.stringify(report.failed));
  assert.equal(app.reloads, 2);
  assert.ok(app.snapshots.every(snapshot => snapshot.confirmed && !snapshot.old));
  assert.equal(app.snapshots.filter(snapshot => snapshot.url === sectionUrl(12)).length, 1);
});

test('render timeout survives both diagnostic projections without internal visit tokens', () => {
  const event = { at: '2026-11-15T12:00:00.000Z', stage: 'wait_exercises', status: 'failed',
    reason: 'section_render_timeout', url: sectionUrl(12), sectionVisit: { token: 'private-visit-token' } };
  assert.equal(projectProblemEvent(event).reason, 'section_render_timeout');
  const diagnostic = collectionDiagnosticsForDownload({ version: 1, extensionVersion: '0.3.34', events: [event], failure: event });
  assert.equal(diagnostic.failure.reason, 'section_render_timeout');
  assert.doesNotMatch(JSON.stringify(diagnostic), /private-visit-token|sectionVisit/);
});
