import test from 'node:test';
import assert from 'node:assert/strict';
import { exportReadiness, assertExportReady, assertExportFilesReady } from '../src/lib/export-readiness.js';

const root = 'https://progressme.ru/cabinet/school/materials/book/71/content';
const lesson = 'https://progressme.ru/lesson-editor/book/71/lesson/12/section';
const section = lesson + '/24';
function finished() {
  return {
    snapshots: [{ url: root }, { url: section }], captures: [{ kind: 'fetch', pageUrl: section, data: true }], dropped: 0,
    collection: { rootUrl: root, status: 'finished', failed: [], expected: [root, lesson, section], visited: [root, lesson, section],
      items: [{ kind: 'lesson', status: 'visited', url: lesson }, { kind: 'section', status: 'visited', url: section }] },
  };
}

test('complete retained book accepts summary bodies and resolved lesson wrappers', () => {
  const state = finished();
  state.warnings = ['Raw capture cannot verify author answer correctness.'];
  assert.deepEqual(exportReadiness(state), { allowed: true, reason: '' });
  assert.doesNotThrow(() => assertExportReady(state));
  state.snapshots[0].links = [{ href: 'https://progressme.ru/cabinet/school/materials' }, { href: root.replace('/71/', '/99/') }];
  assert.equal(exportReadiness(state).allowed, true, 'Other books and the library are not missing pages of this book');
});

test('Wordwall markup stored as a relative lesson link does not block a complete retained book', () => {
  const state = finished();
  const markup = '<iframe src="https://wordwall.net/embed/123?themeId=1"></iframe>';
  state.snapshots[1].links = [{ href: new URL(markup, section).href }];
  assert.equal(exportReadiness(state).allowed, true);

  state.snapshots[1].links.push({ href: lesson + '/25' });
  assert.equal(exportReadiness(state).allowed, false, 'A real section still requires a snapshot');
});

test('every unfinished collection state blocks archive creation without deleting data', () => {
  for (const status of [undefined, 'running', 'failed', 'cancelled', 'canceled', 'interrupted', 'stopped', 'limit']) {
    const state = finished();
    state.collection.status = status;
    const before = structuredClone(state);
    assert.equal(exportReadiness(state).allowed, false, String(status));
    assert.throws(() => assertExportReady(state), { code: 'incomplete_export' });
    assert.deepEqual(state, before);
  }
});

test('finished flag cannot hide missing homework, dropped records, failures or an active collector', () => {
  const mutations = [
    state => { state.dropped = 1; },
    state => { state.enabled = true; },
    state => { state.collectionLocked = true; },
    state => { state.collection.failed.push({ error: 'source failure' }); },
    state => { state.collection.items[1].status = 'pending'; },
    state => { state.snapshots.pop(); },
    state => { state.collection.expected = []; state.collection.visited = []; state.snapshots.pop(); },
    state => { state.collection.expected.push(lesson + '/for-homework'); },
    state => { state.collection.items = []; },
  ];
  for (const mutate of mutations) {
    const state = finished(); mutate(state);
    assert.equal(exportReadiness(state).allowed, false);
  }
});

test('all discovered file bytes are required; empty, skipped and omitted results cannot create a ZIP', () => {
  const file = { url: 'https://cdn.example.test/a.png', status: 'downloaded', data: new Uint8Array([1, 2]) };
  assert.doesNotThrow(() => assertExportFilesReady([file], [file]));
  assert.doesNotThrow(() => assertExportFilesReady([{ ...file, data: new Blob(['ok']) }]));
  assert.doesNotThrow(() => assertExportFilesReady([], []));
  for (const status of ['failed', 'skipped', 'unavailable', 'reference-only'])
    assert.throws(() => assertExportFilesReady([{ ...file, status }]), { code: 'incomplete_export' });
  for (const data of [undefined, new Blob([]), new Uint8Array()])
    assert.throws(() => assertExportFilesReady([{ ...file, data }]), { code: 'incomplete_export' });
  assert.throws(() => assertExportFilesReady([], [file]), { code: 'incomplete_export' });
  assert.throws(() => assertExportFilesReady([{ ...file, url: 'https://cdn.example.test/other.png' }], [file]), { code: 'incomplete_export' });
  assert.throws(() => assertExportFilesReady([file, file], [file, { ...file, url: 'https://cdn.example.test/other.png' }]), { code: 'incomplete_export' });
});
