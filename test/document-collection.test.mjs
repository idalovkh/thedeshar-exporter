import assert from 'node:assert/strict';
import test from 'node:test';
import { collectBook } from '../src/lib/collection.js';
import { collectionDiagnosticsForDownload } from '../src/lib/collection-diagnostics.js';
import { withCollectionTransitions } from './collection-transition-fixture.js';

const bookUrl = 'https://platform.desharschool.ru/cabinet/school/materials/book/1/content';
const sectionUrl = id => `https://platform.desharschool.ru/lesson-editor/book/1/lesson/2/section/${id}`;
const sections = [11, 12].map(id => ({ key: `section-${id}`, sourceId: String(id), kind: 'section', title: id === 12 ? 'Pronunciation' : 'Grammar' }));

// A reload acknowledges its command while the old, fully ready document can
// still answer several polls. SPA clicks retain the document's token.
function source({ stalePolls = 4, authorReload = false, loaderReload = false, neverCommit = false, stallSectionReload = false, missingToken = false, switchBefore = '', changeSections = false } = {}) {
  let generation = 1;
  let position = 'book';
  let pending;
  let authorReceived = !authorReload;
  let loaderVisible = false;
  let observed = false;
  const calls = [], snapshots = [], checkpoints = [], replies = [];
  const token = () => `document-token-${String(generation).padStart(8, '0')}`;
  const navigation = () => ({
    url: position === 'book' ? bookUrl : sectionUrl(position),
    kind: position === 'book' ? 'book' : 'lesson', materialId: '1', lessonId: position === 'book' ? null : '2',
    title: position === 'book' ? 'Book' : 'Review and Check 7-8',
    documentToken: missingToken ? undefined : token(), ready: !loaderVisible,
    sectionVisit: { token: `section-visit-${generation}-${position}`, revision: authorReceived ? 1 : 0, received: authorReceived, idleMs: 10000 },
    contentSignature: String(position), network: { pending: 0, idleMs: 10000 },
    ...(position === 'book' ? {} : { exerciseState: { loaderVisible, listVisible: true, emptyVisible: false } }),
    items: position === 'book'
      ? [{ key: 'lesson-2', sourceId: '2', kind: 'lesson', title: 'Review and Check 7-8' }]
      : sections.map(item => ({ ...item, active: Number(position) === Number(item.sourceId) })),
  });
  async function request(type, message = {}) {
    calls.push({ type, ...structuredClone(message), generation, pending: Boolean(pending) });
    if (type === 'GET_NAVIGATION') {
      if (pending && !neverCommit && !(stallSectionReload && pending.position !== 'book') && pending.remaining-- <= 0) {
        position = pending.position;
        pending = undefined;
        generation++;
        loaderVisible = false;
        if (position !== 'book') authorReceived = true;
        observed = false;
      }
      const nav = navigation();
      if (pending) {
        nav.ready = true;
        if (nav.exerciseState) nav.exerciseState.loaderVisible = false;
      }
      if (message.expectedUrl && message.expectedUrl !== nav.url) throw Object.assign(new Error('Source changed'), { code: 'source_changed' });
      if (message.expectedDocumentToken && message.expectedDocumentToken !== token()) throw Object.assign(new Error('Document changed'), { code: 'source_changed' });
      if (changeSections && message.expectedUrl && position === 11 && snapshots.some(snapshot => snapshot.url === sectionUrl(11))) nav.items.pop();
      observed = true;
      replies.push(structuredClone(nav));
      return { ok: true, navigation: nav };
    }
    if (['PREPARE_BOOK', 'TAKE_SNAPSHOT', 'OPEN_MATERIAL_ITEM', 'NAVIGATE_SOURCE'].includes(type)) {
      if (switchBefore === type && position === 11) generation++;
      if (message.expectedDocumentToken && message.expectedDocumentToken !== token()) throw Object.assign(new Error('Document changed'), { code: 'source_changed' });
      assert.equal(Boolean(pending), false, `${type} must wait for the newly loaded document`);
    }
    if (type === 'BEGIN_COLLECTION') return { ok: true, collectionId: 'document-collection-test' };
    if (type === 'NAVIGATE_SOURCE') {
      assert.equal(message.expectedUrl, navigation().url);
      pending = { position: message.url === bookUrl ? 'book' : position, remaining: stalePolls };
      return { ok: true };
    }
    if (type === 'PREPARE_BOOK') return { ok: true, opened: 0, navigation: navigation() };
    if (type === 'OPEN_MATERIAL_ITEM') {
      assert.equal(observed, true, 'the new document must have its navigation read before clicking');
      if (message.key === 'lesson-2') position = 11;
      else position = Number(sections.find(item => item.key === message.key).sourceId);
      loaderVisible = loaderReload && position === 12;
      return { ok: true };
    }
    if (type === 'TAKE_SNAPSHOT') {
      const { documentToken, sectionVisit, ...snapshot } = navigation();
      snapshots.push(snapshot);
      return { ok: true, snapshotUrl: snapshot.url, retained: { dropped: 0, ...(position === 'book' ? {} : { authorData: authorReceived }) } };
    }
    if (type === 'SAVE_COLLECTION') checkpoints.push(structuredClone(message.collection));
    if (type === 'GET_STATE') return { ok: true, state: { dropped: 0 } };
    return { ok: true };
  }
  return { request: withCollectionTransitions(request), calls, snapshots, checkpoints, replies };
}

const collect = (app, options = {}) => collectBook({ request: app.request, wait: async () => {}, attempts: 12, pollMs: 1, quietMs: 0,
  transitionTimeoutMs: 36, retryDelaysMs: [0, 0], now: () => 0,
  ...options });

test('ready old documents are ignored at startup, section reload and return to contents', async () => {
  for (const options of [{}, { authorReload: true }, { loaderReload: true }]) {
    const app = source(options);
    const report = await collect(app);
    assert.equal(report.status, 'finished', JSON.stringify(report.failed));
    assert.ok(app.calls.some(call => call.type === 'GET_NAVIGATION' && call.pending));
    assert.ok(app.snapshots.some(snapshot => snapshot.url === sectionUrl(12)));
    assert.equal(app.snapshots.filter(snapshot => snapshot.url === sectionUrl(11)).length, 1);
    assert.ok(report.items.every(item => item.status === 'visited'));
    for (const call of app.calls.filter(call => ['PREPARE_BOOK', 'TAKE_SNAPSHOT', 'OPEN_MATERIAL_ITEM', 'NAVIGATE_SOURCE'].includes(call.type))) {
      assert.equal(call.expectedDocumentToken, `document-token-${String(call.generation).padStart(8, '0')}`, call.type);
    }
    assert.doesNotMatch(JSON.stringify(report), /documentToken|document-token-/);
    assert.doesNotMatch(JSON.stringify(app.snapshots), /documentToken|document-token-/);
  }
});

test('an unchanged document reaches the shared transition deadline without a snapshot or click', async () => {
  const app = source({ neverCommit: true });
  const report = await collect(app);
  assert.equal(report.status, 'failed');
  assert.equal(report.diagnostics.failure.reason, 'document_load_timeout');
  assert.equal(app.calls.filter(call => call.type === 'GET_NAVIGATION').length, 37);
  assert.equal(app.snapshots.length, 0);
  assert.equal(app.calls.some(call => ['OPEN_MATERIAL_ITEM', 'PREPARE_BOOK'].includes(call.type)), false);
  assert.equal(app.checkpoints.at(-1).status, 'failed');
});

test('a section reload timeout retains saved pages and does not open later sections', async () => {
  for (const options of [{ authorReload: true }, { loaderReload: true }]) {
    const app = source({ ...options, stallSectionReload: true });
    const report = await collect(app);
    assert.equal(report.status, 'failed');
    assert.equal(report.diagnostics.failure.reason, 'document_load_timeout');
    assert.deepEqual(app.snapshots.map(snapshot => snapshot.url), options.authorReload ? [bookUrl] : [bookUrl, sectionUrl(11)]);
    assert.deepEqual(report.visited, options.authorReload ? [bookUrl] : [bookUrl, sectionUrl(11)]);
    assert.equal(app.calls.filter(call => call.type === 'OPEN_MATERIAL_ITEM' && call.key === 'section-12').length, options.authorReload ? 0 : 1);
    assert.deepEqual(app.checkpoints.at(-1).visited, report.visited);
    assert.equal(app.calls.at(-1).type, 'END_COLLECTION');
  }
});

test('an incompatible content script is rejected before acquiring or clearing a collection', async () => {
  const app = source({ missingToken: true });
  const report = await collect(app, { reset: true });
  assert.equal(report.diagnostics.failure.reason, 'source_update_required');
  assert.deepEqual(app.calls.map(call => call.type), ['GET_NAVIGATION']);
});

test('a same-URL document replacement between inspection and snapshot or click preserves earlier snapshots', async () => {
  for (const type of ['TAKE_SNAPSHOT', 'OPEN_MATERIAL_ITEM']) {
    const app = source({ switchBefore: type });
    const report = await collect(app);
    assert.equal(report.status, 'failed');
    assert.equal(report.diagnostics.failure.reason, 'source_changed');
    assert.ok(app.snapshots.some(snapshot => snapshot.url === bookUrl));
    assert.equal(app.snapshots.some(snapshot => snapshot.url === sectionUrl(12)), false);
    assert.deepEqual(app.checkpoints.at(-1).visited, report.visited);
  }
});

test('the next section requires a fresh unchanged outline after saving', async () => {
  const app = source({ changeSections: true });
  const report = await collect(app);
  assert.equal(report.status, 'failed');
  assert.equal(report.diagnostics.failure.reason, 'section_list_changed');
  assert.equal(app.snapshots.some(snapshot => snapshot.url === sectionUrl(11)), true);
  assert.equal(app.calls.some(call => call.type === 'OPEN_MATERIAL_ITEM' && call.key === 'section-12'), false);
});

test('new document and navigation failure codes survive diagnostic download without transport tokens', () => {
  for (const reason of ['document_load_timeout', 'navigation_stale']) {
    const log = collectionDiagnosticsForDownload({ version: 1, extensionVersion: '0.3.20', omittedEvents: 0,
      events: [{ at: '2026-11-11T00:00:00.000Z', stage: 'open_section', status: 'failed', reason, documentToken: 'transport-only' }],
      failure: { stage: 'open_section', reason, documentToken: 'transport-only' } });
    assert.equal(log.events[0].reason, reason);
    assert.equal(log.failure.reason, reason);
    assert.doesNotMatch(JSON.stringify(log), /documentToken|transport-only/);
  }
});
