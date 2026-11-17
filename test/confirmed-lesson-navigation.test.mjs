import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { confirmedLessonInventory, confirmedLessonRoute } from '../src/lib/confirmed-lesson-route.js';
import { createSourceNavigation } from '../src/lib/source-navigation.js';

const origin = 'https://progressme.ru';
const book = `${origin}/cabinet/school/materials/book/71/content`;
const first = `${origin}/lesson-editor/book/71/lesson/8/section/9`;
const next = `${origin}/lesson-editor/book/71/lesson/10`;
const token = 'source-document-00000001';
const binding = { tabId: 7, ownerTabId: 99, workspaceId: 'workspace-a', collectionId: 'collection-a', bookKey: `${origin}/book/71` };
const inventory = () => ({ url: book, kind: 'book', materialId: '71', ready: true, documentToken: token,
  items: [{ key: 'lesson-8', kind: 'lesson', sourceId: '8' }, { key: 'lesson-10', kind: 'lesson', sourceId: '10' }] });
const canonicalUrl = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.port && !url.username && !url.password &&
      /^\/(?:cabinet\/(?:school|teacher)\/materials\/book\/\d+\/content|lesson-editor\/book\/\d+\/lesson\/\d+(?:\/section(?:\/(?:\d+|for-homework))?)?)\/?$/.test(url.pathname)
      ? `${url.origin}${url.pathname}` : '';
  } catch { return ''; }
};
const bookKey = value => canonicalUrl(value) ? `${new URL(value).origin}/book/${new URL(value).pathname.match(/\/book\/(\d+)/)[1]}` : '';

function fixture() {
  const sessions = {}, callbacks = {}, actions = [];
  let allowed = true;
  let current = { url: book, documentId: 'browser-document-1', errorOccurred: false };
  const event = name => ({ addListener: callback => { callbacks[name] = callback; } });
  const chrome = {
    storage: { session: { get: async key => key === null ? structuredClone(sessions) : { [key]: structuredClone(sessions[key]) },
      set: async values => Object.assign(sessions, structuredClone(values)), remove: async key => { delete sessions[key]; } } },
    tabs: { get: async () => ({ id: 7, url: current.url, status: 'complete' }), update: async (_id, patch) => { actions.push(patch); } },
    webNavigation: { getFrame: async () => structuredClone(current), onBeforeNavigate: event('before'), onCommitted: event('commit'),
      onHistoryStateUpdated: event('history'), onReferenceFragmentUpdated: event('fragment'), onErrorOccurred: event('error'), onTabReplaced: event('replace') },
  };
  const manager = createSourceNavigation({ chrome, canonicalUrl, bookKey,
    authorize: async candidate => {
      if (!allowed || Object.keys(binding).some(key => binding[key] !== candidate[key])) throw Object.assign(new Error('stale'), { code: 'stale_collection' });
      return () => { if (!allowed) throw Object.assign(new Error('stale'), { code: 'stale_collection' }); };
    },
    sendSource: async (_id, command) => {
      if (command.type === 'MATERIAL_NAVIGATION') return { ok: true, navigation: { ...inventory(), url: current.url } };
      actions.push(structuredClone(command)); return { ok: true };
    } });
  manager.remember(7, inventory());
  return { manager, sessions, actions, cancel: () => { allowed = false; },
    frame(value) { current = value; },
    emit(name, value) { callbacks[name]({ tabId: 7, frameId: 0, timeStamp: Date.now(), ...value }); } };
}

test('confirmed lesson routes derive only from unique numeric source identities in a ready same-book inventory', () => {
  const known = inventory();
  assert.equal(confirmedLessonRoute(known, known.items[1]), next);
  for (const invalid of [
    { ...known, ready: false }, { ...known, materialId: '72' }, { ...known, url: `${book}?token=secret` },
    { ...known, url: `https://user:secret@progressme.ru/cabinet/school/materials/book/71/content` },
    { ...known, items: [{ key: 'lesson-10', kind: 'lesson' }] },
    { ...known, items: [{ key: 'lesson-10', kind: 'lesson', sourceId: '0' }] },
    { ...known, items: [...known.items, { key: 'duplicate', kind: 'lesson', sourceId: '10' }] },
  ]) assert.equal(confirmedLessonRoute(invalid, { key: 'lesson-10' }), '');
  assert.equal(confirmedLessonRoute(known, { key: 'lesson-10', sourceId: '99' }), '');
  assert.equal(confirmedLessonRoute(known, { key: 'unknown' }), '');
  assert.deepEqual(Object.keys(confirmedLessonInventory(known)).sort(), ['items', 'kind', 'materialId', 'ready', 'url']);
});

test('a confirmed next lesson opens from a section without reopening book contents', async () => {
  const app = fixture();
  await app.manager.navigate(binding, { type: 'OPEN_MATERIAL_ITEM', key: 'lesson-8', expectedUrl: book, expectedDocumentToken: token });
  await app.manager.complete(7, first);
  app.frame({ url: first, documentId: 'browser-document-2', errorOccurred: false });
  app.manager.remember(7, { url: first, kind: 'lesson', lessonId: '8', documentToken: token, items: [] });
  const started = await app.manager.navigate(binding, { type: 'OPEN_CONFIRMED_LESSON', key: 'lesson-10', expectedUrl: first,
    expectedDocumentToken: token, expectedVisitToken: 'section-visit-00000001' });
  assert.equal(started.ok, true);
  assert.equal(app.actions.at(-1).type, 'OPEN_CONFIRMED_LESSON');
  assert.equal(app.actions.at(-1).url, next);
  assert.equal(app.sessions['source-navigation:7'].attemptMode, 'document');
  assert.equal(app.sessions['source-navigation:7'].target.sourceId, '10');
  assert.equal(app.actions.some(action => action.type === 'NAVIGATE_SOURCE'), false);
});

test('unconfirmed keys, another collection, stale documents and revoked ownership cannot open a confirmed lesson', async () => {
  for (const mode of ['key', 'collection', 'document', 'cancel']) {
    const app = fixture();
    if (mode === 'cancel') app.cancel();
    if (mode === 'document') app.frame({ url: first, documentId: 'replacement', errorOccurred: false });
    await assert.rejects(app.manager.navigate(mode === 'collection' ? { ...binding, collectionId: 'other' } : binding,
      { type: 'OPEN_CONFIRMED_LESSON', key: mode === 'key' ? 'missing' : 'lesson-10', expectedUrl: book, expectedDocumentToken: token }));
    assert.equal(app.actions.length, 0, mode);
  }
});

test('a remembered inventory cannot authorize a different book or origin', async () => {
  for (const value of [book.replace('/71/', '/72/'), book.replace(origin, 'https://other.example')]) {
    const app = fixture();
    app.manager.remember(7, { ...inventory(), url: value });
    await assert.rejects(app.manager.navigate(binding, { type: 'OPEN_CONFIRMED_LESSON', key: 'lesson-10', expectedUrl: book, expectedDocumentToken: token }),
      { code: 'source_lesson_unconfirmed' });
    assert.equal(app.actions.length, 0);
  }
});

test('a confirmed document navigation accepts only the selected lesson bootstrap and pins its first section', async () => {
  const app = fixture();
  const started = await app.manager.navigate(binding, { type: 'OPEN_CONFIRMED_LESSON', key: 'lesson-10', expectedUrl: book, expectedDocumentToken: token });
  const documentId = 'browser-document-2';
  app.emit('before', { url: next });
  app.frame({ url: next, documentId, errorOccurred: false });
  app.emit('commit', { url: next, documentId });
  await app.manager.status(binding, started.transition.id);
  for (const url of [`${next}/section`, `${next}/section/11`]) {
    app.frame({ url, documentId, errorOccurred: false });
    app.emit('history', { url, documentId });
    assert.equal((await app.manager.status(binding, started.transition.id)).state, 'same_book');
  }
  app.frame({ url: `${next}/section/12`, documentId, errorOccurred: false });
  app.emit('history', { url: `${next}/section/12`, documentId });
  assert.equal((await app.manager.status(binding, started.transition.id)).state, 'source_changed');
});

test('a repeated or retried confirmed navigation preserves its target and bounded transition', async () => {
  const app = fixture();
  const command = { type: 'OPEN_CONFIRMED_LESSON', key: 'lesson-10', expectedUrl: book, expectedDocumentToken: token };
  const started = await app.manager.navigate(binding, command);
  assert.equal((await app.manager.navigate(binding, command)).transition.id, started.transition.id);
  assert.equal(app.actions.length, 1);
  const retry = await app.manager.retry(binding, started.transition.id);
  assert.equal(retry.transition.attempt, 2);
  assert.equal(retry.transition.deadlineAt, started.transition.deadlineAt);
  assert.equal(app.actions.at(-1).type, 'OPEN_CONFIRMED_LESSON');
  assert.equal(app.actions.at(-1).url, next);
  assert.equal(app.sessions['source-navigation:7'].attemptMode, 'document');
});

test('clearing source ownership revokes the retained book inventory', async () => {
  const app = fixture();
  await app.manager.navigate(binding, { type: 'OPEN_CONFIRMED_LESSON', key: 'lesson-10', expectedUrl: book, expectedDocumentToken: token });
  await app.manager.clear(7);
  app.frame({ url: first, documentId: 'browser-document-2', errorOccurred: false });
  app.manager.remember(7, { url: first, kind: 'lesson', lessonId: '8', documentToken: token, items: [] });
  await assert.rejects(app.manager.navigate(binding, { type: 'OPEN_CONFIRMED_LESSON', key: 'lesson-10', expectedUrl: first, expectedDocumentToken: token }),
    { code: 'source_lesson_unconfirmed' });
  assert.equal(app.actions.length, 1);
});

test('the source command accepts only a canonical next-lesson route in the current book', async () => {
  const script = await readFile(new URL('../src/capture/confirmed-lesson.js', import.meta.url), 'utf8');
  for (const target of [next, `${next}/section/11`, `${next}?token=secret`, next.replace('/71/', '/72/'), next.replace(origin, 'https://other.example')]) {
    const actions = [];
    const location = new URL(first);
    location.assign = value => actions.push(value);
    const page = { URL, location, __thedesharExporterSourceOrigin: origin };
    const context = vm.createContext(page);
    vm.runInContext(script, context);
    let visits = 0;
    const result = page.__thedesharOpenConfirmedLesson({ expectedUrl: first, url: target }, () => { visits++; });
    assert.equal(result.ok, target === next);
    assert.equal(visits, target === next ? 1 : 0);
    assert.deepEqual(actions, target === next ? [next] : []);
  }
});
