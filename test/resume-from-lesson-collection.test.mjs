import assert from 'node:assert/strict';
import test from 'node:test';
import { collectBook } from '../src/lib/collection.js';
import { savedResumeState, resumeBook, resumeSection } from './resume-ui-fixture.js';
import { withCollectionTransitions } from './collection-transition-fixture.js';

function source({ entry = '10', sourceBook = '71', origin = 'https://progressme.ru', changed = false, changedOnStart = false, freshFailure, blocked = false, denyLease = false, rootUrl = resumeBook } = {}) {
  const state = savedResumeState();
  state.collection.rootUrl = rootUrl;
  const sections = [
    { key: '71/8/section/id/9', title: 'Section', kind: 'section', sourceId: '9' },
    { key: 'section-10', title: 'Next section', kind: 'section', sourceId: '10' },
    { key: 'homework', title: 'Homework', kind: 'homework', sourceId: 'for-homework' },
  ];
  state.collection.resume.lessons[0].sections = structuredClone(sections);
  let position = entry, generation = 1, sequence = 0, captureVisit = 0;
  const calls = [], saved = [];
  const url = () => position === 'book' ? resumeBook : `${origin}/lesson-editor/book/${sourceBook}/lesson/8${position === 'lesson' ? '' : position === 'bootstrap' ? '/section' : `/section/${position}`}`;
  const token = () => `resume-entry-document-${generation}`;
  const visit = () => `resume-entry-section-visit-${generation}-${position}-${captureVisit}`;
  const navigation = () => ({ url: url(), materialId: sourceBook, documentToken: token(), blocked,
    ready: position === 'book' || position === '9', warnings: [], contentSignature: position,
    ...(position === 'book' ? { kind: 'book', title: 'Saved book', items: state.collection.resume.book }
      : { kind: 'lesson', lessonId: '8', title: 'Lesson',
        sectionVisit: { token: visit(), received: position === '9', revision: 1, idleMs: 10000 },
        items: sections.map(item => ({ ...item, active: item.sourceId === position })) }) });
  const request = withCollectionTransitions(async (type, payload = {}) => {
    calls.push({ type, ...structuredClone(payload) });
    if (type === 'BEGIN_COLLECTION') {
      if (denyLease) throw Object.assign(new Error('Another exporter owns this book'), { code: 'collection_locked' });
      return { collectionId: 'resume-entry-collection-0001' };
    }
    if (type === 'GET_NAVIGATION' || type === 'PREPARE_BOOK') {
      const nav = navigation();
      if (generation > 1 && position !== 'book') { nav.ready = true; nav.sectionVisit.received = true; }
      if (captureVisit > 0 && generation === 1) {
        if (freshFailure === 'blocked') nav.blocked = true;
        if (freshFailure === 'missing-visit') delete nav.sectionVisit;
        if (freshFailure === 'document') nav.documentToken = 'replaced-entry-document';
      }
      return { navigation: nav, opened: 0 };
    }
    if (type === 'START_CAPTURE') {
      captureVisit++;
      if (changedOnStart) position = 'for-homework';
    }
    if (type === 'NAVIGATE_SOURCE') {
      assert.equal(payload.url, resumeBook);
      assert.equal(payload.expectedUrl, url());
      assert.equal(payload.expectedDocumentToken, token());
      if (position !== 'book') assert.equal(payload.expectedVisitToken, visit());
      assert.ok(calls.find(call => call.type === 'BEGIN_COLLECTION'));
      assert.ok(calls.find(call => call.type === 'START_CAPTURE'));
      if (changed) throw Object.assign(new Error('Source changed during the return'), { code: 'source_changed' });
      position = 'book'; generation++;
      return { ok: true };
    }
    if (type === 'OPEN_MATERIAL_ITEM') {
      position = payload.key === state.collection.resume.book[0].key ? '9'
        : sections.find(item => item.key === payload.key).sourceId;
      return { ok: true };
    }
    if (type === 'TAKE_SNAPSHOT') {
      const snapshot = { url: url(), capturedAt: `2026-11-16T12:00:0${++sequence}.000Z` };
      saved.push(snapshot); state.snapshots.push(snapshot);
      return { snapshotUrl: snapshot.url, retained: { dropped: 0, capturedAt: snapshot.capturedAt, authorData: true } };
    }
    if (type === 'SAVE_COLLECTION') state.collection = structuredClone(payload.collection);
    if (type === 'GET_STATE') return { state: { dropped: 0 } };
    return { ok: true };
  });
  return { state, calls, saved, request };
}
const collect = (app, extra = {}) => collectBook({ request: app.request, mode: 'resume', resumeState: structuredClone(app.state),
  wait: async () => {}, now: () => 0, attempts: 8, pollMs: 1, quietMs: 0, transitionTimeoutMs: 24, retryDelaysMs: [0, 0], ...extra });

for (const entry of ['10', 'for-homework', 'lesson', 'bootstrap']) {
  test(`resume from ${entry} returns to saved contents under its lease and preserves the committed section`, async () => {
    const app = source({ entry });
    const before = structuredClone(app.state.snapshots);
    const report = await collect(app);
    assert.equal(report.status, 'finished', JSON.stringify(report.failed));
    const firstNavigation = app.calls.find(call => call.type === 'NAVIGATE_SOURCE');
    assert.equal(firstNavigation.url, resumeBook);
    assert.match(firstNavigation.expectedUrl, /\/lesson-editor\/book\/71\/lesson\/8/);
    assert.equal(firstNavigation.collectionId, 'resume-entry-collection-0001');
    const startIndex = app.calls.findIndex(call => call.type === 'START_CAPTURE');
    const navigationIndex = app.calls.findIndex(call => call.type === 'NAVIGATE_SOURCE');
    const recheck = app.calls.slice(startIndex + 1, navigationIndex).find(call => call.type === 'GET_NAVIGATION');
    assert.equal(recheck.expectedUrl, firstNavigation.expectedUrl);
    assert.equal(recheck.expectedDocumentToken, firstNavigation.expectedDocumentToken);
    assert.equal(recheck.expectedVisitToken, undefined, 'capture rotates the visit; recheck must use the document and URL');
    assert.equal(app.calls.some(call => call.type === 'CLEAR_CAPTURE'), false);
    assert.deepEqual(app.state.snapshots.filter(snapshot => snapshot.url === resumeSection), before.filter(snapshot => snapshot.url === resumeSection));
    assert.equal(app.saved.length, 2);
    assert.equal(report.startedAt, '2026-11-16T10:00:00.000Z');
  });
}

test('another book, origin, blocked page or invalid stored contents cannot acquire a lease or navigate', async () => {
  for (const options of [{ sourceBook: '99' }, { origin: 'https://platform.desharschool.ru' }, { blocked: true },
    { rootUrl: resumeSection }, { rootUrl: `${resumeBook}?redirect=other` }, { rootUrl: `${resumeBook}#other` }]) {
    const app = source(options), before = structuredClone(app.state);
    const report = await collect(app);
    assert.equal(report.status, 'failed', JSON.stringify(options));
    assert.equal(app.calls.some(call => call.type === 'BEGIN_COLLECTION'), false);
    assert.equal(app.calls.some(call => call.type === 'NAVIGATE_SOURCE'), false);
    assert.deepEqual(app.state, before);
  }
});

test('a fresh collection from a lesson still requires opening contents explicitly', async () => {
  const app = source();
  const report = await collect(app, { mode: 'new', reset: true });
  assert.equal(report.status, 'failed');
  assert.equal(app.calls.some(call => call.type === 'BEGIN_COLLECTION'), false);
  assert.equal(app.calls.some(call => call.type === 'CLEAR_CAPTURE'), false);
});

test('a refused lease never starts capture or returns to contents', async () => {
  const app = source({ denyLease: true });
  const report = await collect(app);
  assert.equal(report.status, 'failed');
  assert.ok(app.calls.find(call => call.type === 'BEGIN_COLLECTION'));
  assert.equal(app.calls.some(call => ['START_CAPTURE', 'NAVIGATE_SOURCE', 'SAVE_COLLECTION'].includes(call.type)), false);
});

test('a source change during the guarded return stops before saving and releases its lease', async () => {
  const app = source({ changed: true });
  const before = structuredClone(app.state.snapshots);
  const report = await collect(app);
  assert.equal(report.status, 'failed');
  assert.equal(report.diagnostics.failure.reason, 'source_changed');
  assert.deepEqual(app.state.snapshots, before);
  assert.equal(app.saved.length, 0);
  assert.ok(app.calls.find(call => call.type === 'STOP_CAPTURE'));
  assert.ok(app.calls.find(call => call.type === 'END_COLLECTION'));
});

test('a route change while enabling capture cannot redirect the resume attempt', async () => {
  const app = source({ changedOnStart: true });
  const before = structuredClone(app.state.snapshots);
  const report = await collect(app);
  assert.equal(report.status, 'failed');
  assert.equal(report.diagnostics.failure.reason, 'source_changed');
  assert.equal(app.calls.some(call => call.type === 'NAVIGATE_SOURCE'), false);
  assert.deepEqual(app.state.snapshots, before);
  assert.ok(app.calls.find(call => call.type === 'STOP_CAPTURE'));
  assert.ok(app.calls.find(call => call.type === 'END_COLLECTION'));
});

test('fresh entry checks refuse a blocked page, missing section visit or replaced document', async () => {
  for (const [freshFailure, reason] of [['blocked', 'navigation_blocked'], ['missing-visit', 'source_update_required'], ['document', 'source_changed']]) {
    const app = source({ freshFailure });
    const before = structuredClone(app.state.snapshots);
    const report = await collect(app);
    assert.equal(report.status, 'failed', freshFailure);
    assert.equal(report.diagnostics.failure.reason, reason, freshFailure);
    assert.equal(app.calls.some(call => call.type === 'NAVIGATE_SOURCE'), false, freshFailure);
    assert.deepEqual(app.state.snapshots, before);
    assert.ok(app.calls.find(call => call.type === 'END_COLLECTION'));
  }
});
