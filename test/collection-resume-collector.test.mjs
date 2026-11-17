import assert from 'node:assert/strict';
import test from 'node:test';
import { collectBook } from '../src/lib/collection.js';
import { collectionResumeInfo } from '../src/lib/collection-resume.js';
import { withCollectionTransitions } from './collection-transition-fixture.js';

const rootUrl = 'https://progressme.ru/cabinet/school/materials/book/1/content';
const sectionUrl = id => `https://progressme.ru/lesson-editor/book/1/lesson/2/section/${id}`;
function source({ state = { snapshots: [] }, failSection, changedBook = false, changedSections = false, durableAuthorData = true } = {}) {
  let position = 'book', generation = 1, sequence = 0;
  const calls = [], snapshots = new Map(state.snapshots.map(snapshot => [snapshot.url, snapshot]));
  const saved = [];
  const navigation = () => ({ documentToken: `resume-document-${String(generation).padStart(8, '0')}`,
    materialId: '1', ready: true, warnings: [], contentSignature: position,
    ...(position === 'book' ? { url: rootUrl, kind: 'book', title: 'Book',
      items: [{ key: 'lesson-2', title: changedBook ? 'Changed lesson' : 'Lesson', kind: 'lesson', sourceId: '2' }] }
      : { url: sectionUrl(position), kind: 'lesson', lessonId: '2', title: 'Lesson',
        sectionVisit: { token: `resume-visit-${generation}-${position}`, revision: 1, received: true, idleMs: 10000 },
        items: ['3', '4', ...(changedSections ? ['6'] : ['5'])].map(id => ({ key: `section-${id}`, sourceId: id,
          kind: 'section', title: `Section ${id}`, active: id === position })) }) });
  const request = withCollectionTransitions(async (type, payload = {}) => {
    calls.push({ type, ...structuredClone(payload) });
    if (type === 'BEGIN_COLLECTION') return { collectionId: 'resume-collection-000001' };
    if (type === 'GET_NAVIGATION' || type === 'PREPARE_BOOK') return { ok: true, navigation: navigation(), opened: 0 };
    if (type === 'NAVIGATE_SOURCE') { position = 'book'; generation++; return { ok: true }; }
    if (type === 'OPEN_MATERIAL_ITEM') { position = payload.key === 'lesson-2' ? '3' : payload.key.slice(8); return { ok: true }; }
    if (type === 'TAKE_SNAPSHOT') {
      assert.equal(payload.expectedUrl, navigation().url);
      if (position === failSection) throw Error('Disk unavailable before snapshot commit');
      const snapshot = { url: navigation().url, capturedAt: `2026-11-16T10:${String(generation).padStart(2, '0')}:${String(++sequence).padStart(2, '0')}.000Z` };
      snapshots.set(snapshot.url, snapshot); saved.push(snapshot);
      return { ok: true, snapshotUrl: snapshot.url, retained: { dropped: 0, capturedAt: snapshot.capturedAt,
        ...(position !== 'book' ? { authorData: durableAuthorData } : {}) } };
    }
    if (type === 'SAVE_COLLECTION') state.collection = structuredClone(payload.collection);
    if (type === 'GET_STATE') { assert.equal(payload.summary, true); return { state: { dropped: 0 } }; }
    return { ok: true };
  });
  return { request, calls, saved, snapshotState: () => ({ ...structuredClone(state), snapshots: [...snapshots.values()].map(snapshot => ({ ...snapshot })) }) };
}
const collect = (app, extra = {}) => collectBook({ request: app.request, wait: async () => {}, now: () => 0,
  attempts: 8, pollMs: 1, quietMs: 0, transitionTimeoutMs: 24, retryDelaysMs: [0, 0], ...extra });

async function interrupted() {
  const app = source({ failSection: '4' });
  const report = await collect(app);
  assert.equal(report.status, 'failed');
  const state = app.snapshotState();
  assert.equal(collectionResumeInfo(state).confirmedSections, 1);
  return state;
}

test('resume preserves the confirmed section and timestamp, repeats an uncommitted step and never clears the dataset', async () => {
  const state = await interrupted(), before = structuredClone(state);
  const app = source({ state });
  const report = await collect(app, { mode: 'resume', reset: true, resumeState: state });
  assert.equal(report.status, 'finished', JSON.stringify(report.failed));
  assert.equal(app.calls.some(call => call.type === 'CLEAR_CAPTURE'), false);
  assert.deepEqual(app.saved.map(page => page.url), [sectionUrl('4'), sectionUrl('5')]);
  assert.equal(app.snapshotState().snapshots.find(snapshot => snapshot.url === sectionUrl('3')).capturedAt,
    before.snapshots.find(snapshot => snapshot.url === sectionUrl('3')).capturedAt);
  assert.equal(collectionResumeInfo(app.snapshotState()).confirmedSections, 3);
  assert.equal(report.items.filter(item => item.kind === 'section').every(item => item.status === 'visited'), true);
  assert.equal(app.calls.find(call => call.type === 'BEGIN_COLLECTION').mode, 'resume');
});

test('changed book or lesson structure stops resume before replacing any saved section', async () => {
  for (const change of [{ changedBook: true }, { changedSections: true }]) {
    const state = await interrupted(), before = structuredClone(state.snapshots);
    const app = source({ ...change, state });
    const report = await collect(app, { mode: 'resume', resumeState: state });
    assert.equal(report.status, 'failed');
    assert.match(report.failed[0].error, /Структура сохранённого учебника изменилась/);
    assert.equal(app.saved.length, 0);
    assert.deepEqual(app.snapshotState().snapshots, before);
    assert.equal(app.calls.some(call => call.type === 'CLEAR_CAPTURE'), false);
  }
});

test('a snapshot without persisted authored-data confirmation never creates a resumable checkpoint', async () => {
  const app = source({ durableAuthorData: false });
  const report = await collect(app);
  assert.equal(report.status, 'finished');
  assert.equal(collectionResumeInfo(app.snapshotState()).available, false);
});

test('an orphaned checkpoint or another source book cannot acquire a resume lease', async () => {
  const state = await interrupted();
  state.snapshots = [];
  const app = source({ state });
  const report = await collect(app, { mode: 'resume', resumeState: state });
  assert.equal(report.status, 'failed');
  assert.equal(app.calls.some(call => call.type === 'BEGIN_COLLECTION'), false);
  assert.equal(app.calls.some(call => call.type === 'CLEAR_CAPTURE'), false);
});
