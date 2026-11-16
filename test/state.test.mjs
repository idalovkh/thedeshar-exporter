import assert from 'node:assert/strict';
import test from 'node:test';
import { appendCapture, appendSnapshot, createWorkspace, exceedsWorkspaceCapacity, isSourceUrl, LIMITS } from '../src/lib/state.js';

const url = 'https://platform.desharschool.ru/lesson-editor/book/1254486/lesson/20349346/section/100346962';
const snapshot = { url, title: 'Урок', capturedAt: '2026-10-19T00:00:00Z', blocks: [{ text: 'Hello' }] };

test('material routes on both exact HTTPS source origins are accepted without credentials', () => {
  for (const origin of ['https://platform.desharschool.ru', 'https://progressme.ru']) {
    for (const pathname of ['/cabinet/school/materials/personal', '/cabinet/school/materials/book/867169/content',
      '/cabinet/teacher/materials/book/867169/content', '/lesson-editor/book/867169/lesson/13794943/section/67546487']) {
      assert.equal(isSourceUrl(`${origin}${pathname}`), true);
    }
    for (const pathname of ['/cabinet/school/students', '/login', '/cabinet/school/materials-unrelated', '/lesson-editor-other/book/1']) {
      assert.equal(isSourceUrl(`${origin}${pathname}`), false);
    }
    for (const invalidOrigin of [origin.replace('https:', 'http:'), `${origin}:8443`, origin.replace('https://', 'https://user:secret@'),
      origin.replace('https://', 'https://user@'), `${origin}.evil.example`]) {
      assert.equal(isSourceUrl(`${invalidOrigin}/lesson-editor/book/1`), false);
    }
  }
  for (const value of ['https://other.example/lesson-editor/book/1', 'https://www.progressme.ru/lesson-editor/book/1',
    'https://proxy.progressme.ru/lesson-editor/book/1', 'https://progressme.ru./lesson-editor/book/1', 'not a URL']) {
    assert.equal(isSourceUrl(value), false);
  }
});

test('new section snapshots coexist, while revisiting a section replaces its old snapshot', () => {
  const state = createWorkspace(7);
  appendSnapshot(state, snapshot);
  appendSnapshot(state, { ...snapshot, url: `${url}2`, title: 'Другой раздел' });
  appendSnapshot(state, { ...snapshot, title: 'Новая версия' });
  assert.equal(state.snapshots.length, 2);
  assert.equal(state.snapshots[0].title, 'Новая версия');
  assert.throws(() => appendSnapshot(state, { ...snapshot, url: 'https://other.example/' }));
});

test('credential fields are scrubbed before local persistence; material answers survive', () => {
  const state = createWorkspace(7);
  appendCapture(state, { kind: 'fetch', url: 'https://example.org/lessons/1?token=secret', data: { exercises: [{ correctAnswers: ['a'] }], accessToken: 'private', user: { email: 'private@example.org' } } });
  const persisted = JSON.stringify(state);
  assert.equal(persisted.includes('private@example.org'), false);
  assert.equal(persisted.includes('secret'), false);
  assert.deepEqual(state.captures[0].data.exercises[0].correctAnswers, ['a']);
});

test('duplicate captures do not grow storage and account responses are not retained', () => {
  const state = createWorkspace(7);
  const event = { kind: 'websocket', url: 'https://example.org/websocket', receivedAt: 'now', data: { lesson: { id: 3 } } };
  appendCapture(state, event);
  appendCapture(state, { ...event, receivedAt: 'later' });
  appendCapture(state, { kind: 'fetch', url: 'https://example.org/students', data: { lessons: ['private'] } });
  assert.equal(state.captures.length, 1);
});

test('capture association retains sanitized source pages and distinguishes equal data from different sections', () => {
  const state = createWorkspace(7);
  const firstPage = 'https://progressme.ru/lesson-editor/book/867169/lesson/13794943/section/67546487';
  const secondPage = 'https://progressme.ru/lesson-editor/book/867169/lesson/13794943/section/67546488';
  const event = { kind: 'websocket', url: 'wss://proxy.progressme.ru/websocket', data: { exercises: [{ type: 'text', text: 'Hello' }] } };
  appendCapture(state, { ...event, pageUrl: `${firstPage}?token=first-secret&view=preview` });
  appendCapture(state, { ...event, pageUrl: `${firstPage}?token=second-secret&view=preview` });
  appendCapture(state, { ...event, pageUrl: secondPage });
  assert.equal(state.captures.length, 2);
  assert.equal(state.captures[0].pageUrl, `${firstPage}?view=preview`);
  assert.equal(state.captures[1].pageUrl, secondPage);
  assert.equal(JSON.stringify(state).includes('secret'), false);
});

test('captures with an invalid supplied source page are rejected before persistence', () => {
  const state = createWorkspace(7);
  const event = { kind: 'fetch', url: 'https://progressme.ru/lessons/1', data: { lesson: { id: 1 } } };
  for (const pageUrl of ['https://other.example/lesson-editor/book/1', 'https://progressme.ru/login',
    'https://name:secret@progressme.ru/lesson-editor/book/1', 'http://progressme.ru/lesson-editor/book/1', '', null]) {
    appendCapture(state, { ...event, pageUrl });
  }
  assert.equal(state.captures.length, 0);
  appendCapture(state, { ...event, pageUrl: url });
  assert.equal(state.captures.length, 1);
  assert.equal(state.captures[0].pageUrl, url);
});

test('event and capture-count limits reject incoming responses and preserve all earlier captures', () => {
  const state = createWorkspace(7);
  appendCapture(state, { kind: 'fetch', url: 'https://example.org/lessons', data: { lesson: 'x'.repeat(LIMITS.eventBytes) } });
  assert.equal(state.captures.length, 0);
  assert.equal(state.dropped, 1);
  state.captures = Array.from({ length: LIMITS.captures }, (_, id) => ({ kind: 'fetch', url: 'https://example.org/lessons', data: { lesson: { id } } }));
  for (let id = LIMITS.captures; id < LIMITS.captures + 3; id++) appendCapture(state, { kind: 'fetch', url: 'https://example.org/lessons', data: { lesson: { id } } });
  assert.equal(state.captures.length, LIMITS.captures);
  assert.deepEqual(state.captures.map(event => event.data.lesson.id), Array.from({ length: LIMITS.captures }, (_, id) => id));
  assert.equal(state.dropped, 4);
  assert.ok(state.warnings.length);
});

test('snapshot count capacity preserves earlier pages and permits an in-place revisit', () => {
  const state = createWorkspace(7);
  state.snapshots = Array.from({ length: LIMITS.snapshots }, (_, id) => ({ ...snapshot, url: `${url}-${id}`, title: `Page ${id}` }));
  const original = JSON.stringify(state.snapshots);
  appendSnapshot(state, { ...snapshot, url: `${url}-overflow` });
  assert.equal(JSON.stringify(state.snapshots), original);
  assert.equal(state.dropped, 1);
  appendSnapshot(state, { ...snapshot, url: `${url}-0`, title: 'Updated page' });
  assert.equal(state.snapshots.length, LIMITS.snapshots);
  assert.equal(state.snapshots[0].title, 'Updated page');
  assert.equal(state.dropped, 1);
});

test('workspaces keep collecting beyond the retired 100-page and 250-response caps', () => {
  const state = createWorkspace(7);
  state.snapshots = Array.from({ length: 100 }, (_, id) => ({ ...snapshot, url: `${url}-${id}` }));
  state.captures = Array.from({ length: 250 }, (_, id) => ({ kind: 'fetch', url: 'https://progressme.ru/lessons/1', data: { lesson: { id } } }));
  appendSnapshot(state, { ...snapshot, url: `${url}-next` });
  appendCapture(state, { kind: 'fetch', url: 'https://progressme.ru/lessons/1', data: { lesson: { id: 250 } } });
  assert.equal(state.snapshots.length, 101);
  assert.equal(state.captures.length, 251);
  assert.equal(state.dropped, 0);
  assert.deepEqual(state.warnings, []);
});

test('capacity matches import page and entry bounds and permits the exact byte budget', () => {
  assert.equal(LIMITS.snapshots, 1000);
  assert.ok(LIMITS.snapshots + LIMITS.captures + 10000 + 3 <= 20000);
  assert.equal(LIMITS.bytes, 256 * 1024 * 1024);
  assert.equal(LIMITS.eventBytes, 8 * 1024 * 1024);
  const exact = { snapshotCount: LIMITS.snapshots, captureCount: LIMITS.captures, bytes: LIMITS.bytes };
  assert.equal(exceedsWorkspaceCapacity(exact), false);
  assert.equal(exceedsWorkspaceCapacity({ ...exact, bytes: exact.bytes + 1 }), true);
  assert.equal(exceedsWorkspaceCapacity({ ...exact, snapshotCount: exact.snapshotCount + 1 }), true);
  assert.equal(exceedsWorkspaceCapacity({ ...exact, captureCount: exact.captureCount + 1 }), true);
});

test('an oversized snapshot revisit preserves the retained version and records its rejection', () => {
  const state = createWorkspace(7);
  appendSnapshot(state, snapshot);
  const original = JSON.stringify(state.snapshots);
  state.updatedAt = 'before rejection';
  appendSnapshot(state, { ...snapshot, blocks: [{ text: 'x'.repeat(LIMITS.eventBytes) }] });
  assert.equal(JSON.stringify(state.snapshots), original);
  assert.equal(state.dropped, 1);
  assert.notEqual(state.updatedAt, 'before rejection');
  assert.equal(state.bytes, new TextEncoder().encode(JSON.stringify({ snapshots: state.snapshots, captures: [] })).length);
});

test('legacy workspaces already over count limits remain intact when new data is rejected', () => {
  const states = [createWorkspace(7)];
  states[0].snapshots = Array.from({ length: LIMITS.snapshots + 1 }, (_, id) => ({ ...snapshot, url: `${url}-${id}` }));
  states[0].captures = [{ kind: 'fetch', url: 'https://progressme.ru/lessons/1', data: { lesson: { id: 1 } } }];
  for (const state of states) {
    const original = JSON.stringify({ snapshots: state.snapshots, captures: state.captures });
    appendCapture(state, { kind: 'fetch', url: 'https://progressme.ru/lessons/2', data: { lesson: { id: 2 } } });
    appendSnapshot(state, { ...snapshot, url: `${url}-new` });
    assert.equal(JSON.stringify({ snapshots: state.snapshots, captures: state.captures }), original);
    assert.equal(state.dropped, 2);
    assert.equal(state.bytes, new TextEncoder().encode(original).length);
  }
});

test('a four MiB native exercise response is retained intact beyond the former event bound', () => {
  const state = createWorkspace(7), text = 'x'.repeat(4 * 1024 * 1024);
  appendCapture(state, { kind: 'fetch', url: 'https://progressme.ru/lessons/1', data: { exercises: [{ type: 'text', text }] } });
  assert.equal(state.captures[0].data.exercises[0].text, text);
  assert.equal(state.dropped, 0);
  assert.equal(state.bytes, new TextEncoder().encode(JSON.stringify({ snapshots: [], captures: state.captures })).length);
});

test('duplicate native responses are a real no-op and do not advance content metadata', () => {
  const first = appendCapture(createWorkspace(7), { kind: 'fetch', url: 'https://progressme.ru/lessons/1', data: { lesson: { id: 1 } } });
  const original = JSON.stringify(first);
  const next = appendCapture(first, { ...first.captures[0], receivedAt: 'later' });
  assert.equal(next, first);
  assert.equal(JSON.stringify(next), original);
});
