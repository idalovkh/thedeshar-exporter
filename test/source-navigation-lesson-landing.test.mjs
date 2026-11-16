import assert from 'node:assert/strict';
import test from 'node:test';
import { createSourceNavigation } from '../src/lib/source-navigation.js';
import { sourceBookKey } from '../src/lib/book-workspaces.js';

const origin = 'https://platform.desharschool.ru';
const contents = `${origin}/cabinet/school/materials/book/1153358/content`;
const lesson = `${origin}/lesson-editor/book/1153358/lesson/18601240`;
const bootstrap = `${lesson}/section`;
const firstSection = `${bootstrap}/91646226`;
const nextSection = `${bootstrap}/91646227`;
const documentId = '11111111-1111-4111-8111-111111111111';
const token = 'lesson-landing-content-document-00001';
const binding = { tabId: 7, ownerTabId: 99, workspaceId: 'workspace-a', collectionId: 'collection-a', bookKey: `${origin}/book/1153358` };
const canonicalUrl = value => {
  try { const url = new URL(value); return sourceBookKey(url.href) ? `${url.origin}${url.pathname}` : ''; }
  catch { return ''; }
};
function fixture({ sourceId = '18601240' } = {}) {
  const sessions = {}, callbacks = {}, actions = [];
  let clock = 1000, active = true;
  let tab = { id: 7, url: contents, status: 'complete' }, frame = { url: contents, documentId, errorOccurred: false };
  let navigation = { url: contents, kind: 'book', materialId: '1153358', documentToken: token,
    items: [{ key: 'lesson-18601240', kind: 'lesson', ...(sourceId ? { sourceId } : {}) }] };
  const event = name => ({ addListener: callback => { callbacks[name] = callback; } });
  const chrome = {
    storage: { session: { get: async () => structuredClone(sessions), set: async values => Object.assign(sessions, structuredClone(values)), remove: async key => { delete sessions[key]; } } },
    tabs: { get: async () => structuredClone(tab), update: async (id, patch) => { actions.push({ type: 'native', id, ...patch }); } },
    webNavigation: { onBeforeNavigate: event('before'), onCommitted: event('committed'), onErrorOccurred: event('error'),
      onHistoryStateUpdated: event('history'), onReferenceFragmentUpdated: event('fragment'), onTabReplaced: event('replaced'), getFrame: async () => structuredClone(frame) },
  };
  const manager = createSourceNavigation({ chrome, canonicalUrl, bookKey: sourceBookKey, now: () => clock,
    randomUUID: () => 'transition-lesson-landing', authorize: async candidate => {
      if (!active || Object.keys(binding).some(key => candidate[key] !== binding[key])) throw Object.assign(new Error('Wrong owner'), { code: 'stale_collection' });
      return () => { if (!active) throw Object.assign(new Error('Lost owner'), { code: 'stale_collection' }); };
    },
    sendSource: async (_tab, command) => {
      if (command.type === 'MATERIAL_NAVIGATION') return { ok: true, navigation: structuredClone(navigation) };
      actions.push(structuredClone(command)); return { ok: true };
    } });
  manager.remember(7, navigation);
  return { manager, sessions, actions,
    async open() { return manager.navigate(binding, { type: 'OPEN_MATERIAL_ITEM', key: 'lesson-18601240', expectedUrl: contents, expectedDocumentToken: token }); },
    history(url, id = documentId) {
      tab = { id: 7, url, status: 'complete' }; frame = { url, documentId: id, errorOccurred: false };
      navigation = { url, kind: 'lesson', materialId: '1153358', lessonId: '18601240', documentToken: token, ready: false, items: [] };
      callbacks.history({ tabId: 7, frameId: 0, timeStamp: clock++, url, documentId: id, documentLifecycle: 'active' });
    },
    emit(name, url, id = documentId) { callbacks[name]({ tabId: 7, frameId: 0, timeStamp: clock++, url, documentId: id, documentLifecycle: 'active' }); },
    setBrowser(url, id) { tab = { id: 7, url, status: 'complete' }; frame = { url, documentId: id, errorOccurred: false }; },
    remember(value) { navigation = { ...navigation, ...value }; manager.remember(7, navigation); },
    cancel() { active = false; },
  };
}

test('a selected lesson can stage through /section before its first concrete section in the same document', async () => {
  const app = fixture(), started = await app.open();
  app.history(contents);
  await app.manager.status(binding, started.transition.id);
  app.history(bootstrap);
  assert.equal((await app.manager.status(binding, started.transition.id)).state, 'same_book');
  app.history(firstSection);
  const status = await app.manager.status(binding, started.transition.id);
  assert.equal(status.state, 'same_book');
  assert.equal(status.url, firstSection);
  assert.equal(status.attempt, 1);
  assert.equal(status.deadlineAt, started.transition.deadlineAt);
  assert.equal(app.sessions['source-navigation:7'].observedUrl, firstSection);
});


for (const stages of [[lesson, firstSection], [lesson, bootstrap, firstSection]]) {
  test(`the selected lesson can advance through ${stages.length} router stages without changing its budget`, async () => {
    const app = fixture(), started = await app.open();
    for (const url of stages) {
      app.history(url);
      const status = await app.manager.status(binding, started.transition.id);
      assert.equal(status.state, 'same_book', url);
      assert.equal(status.attempt, 1);
      assert.equal(status.deadlineAt, started.transition.deadlineAt);
    }
    assert.equal(app.sessions['source-navigation:7'].observedUrl, firstSection);
  });
}

test('a card without a source ID binds its first positive browser-confirmed lesson before landing in a section', async () => {
  const app = fixture({ sourceId: '' }), started = await app.open();
  app.history(bootstrap);
  await app.manager.status(binding, started.transition.id);
  app.history(firstSection);
  const status = await app.manager.status(binding, started.transition.id);
  assert.equal(status.state, 'same_book');
  assert.equal(app.sessions['source-navigation:7'].observedUrl, firstSection);
});

for (const url of [nextSection, bootstrap, lesson]) {
  test(`a pinned first section refuses the subsequent manual route ${url.slice(lesson.length) || '/lesson'}`, async () => {
    const app = fixture(), started = await app.open();
    app.history(bootstrap); await app.manager.status(binding, started.transition.id);
    app.history(firstSection); await app.manager.status(binding, started.transition.id);
    app.history(url);
    const status = await app.manager.status(binding, started.transition.id);
    assert.equal(status.state, 'source_changed');
    assert.equal(status.canRetry, false);
    assert.equal(status.navigation.cause, 'unexpected_target');
    await assert.rejects(app.manager.retry(binding, started.transition.id), { code: 'source_left_page' });
  });
}

for (const sourceId of ['18601240', '']) {
  test(`bootstrap landing cannot switch to another lesson when source ID is ${sourceId ? 'confirmed' : 'absent'}`, async () => {
    const app = fixture({ sourceId }), started = await app.open();
    app.history(bootstrap); await app.manager.status(binding, started.transition.id);
    app.history(firstSection.replace('/lesson/18601240/', '/lesson/18601241/'));
    assert.equal((await app.manager.status(binding, started.transition.id)).state, 'source_changed');
  });
}

test('an explicit source lesson ID cannot be replaced by a different observed bootstrap ID', async () => {
  const app = fixture({ sourceId: '18601241' }), started = await app.open();
  app.history(bootstrap);
  const status = await app.manager.status(binding, started.transition.id);
  assert.equal(status.state, 'source_changed');
  assert.equal(status.navigation.cause, 'unexpected_target');
});

test('bootstrap landing in a different document cannot confirm the first section', async () => {
  const app = fixture(), started = await app.open();
  app.history(bootstrap); await app.manager.status(binding, started.transition.id);
  app.history(firstSection, '22222222-2222-4222-8222-222222222222');
  const status = await app.manager.status(binding, started.transition.id);
  assert.notEqual(status.state, 'same_book');
  assert.equal(status.canRetry, false);
  await assert.rejects(app.manager.retry(binding, started.transition.id));
});

test('a full retry of the unfinished selected lesson still permits its new document to choose the first section', async () => {
  const app = fixture(), started = await app.open();
  app.history(bootstrap); await app.manager.status(binding, started.transition.id);
  const retry = await app.manager.retry(binding, started.transition.id);
  assert.equal(retry.transition.attempt, 2);
  assert.equal(retry.transition.deadlineAt, started.transition.deadlineAt);
  const newDocument = '22222222-2222-4222-8222-222222222222';
  app.emit('before', bootstrap);
  app.emit('committed', bootstrap, newDocument);
  app.setBrowser(bootstrap, newDocument);
  await app.manager.status(binding, started.transition.id);
  app.history(firstSection, newDocument);
  const status = await app.manager.status(binding, started.transition.id);
  assert.equal(status.state, 'same_book');
  assert.equal(status.attempt, 2);
  assert.equal(status.deadlineAt, started.transition.deadlineAt);
  assert.equal(app.sessions['source-navigation:7'].attemptMode, 'document');
  assert.equal(app.sessions['source-navigation:7'].observedUrl, firstSection);
});

test('a backward router bootstrap step is not a new first landing', async () => {
  const app = fixture(), started = await app.open();
  app.history(bootstrap); await app.manager.status(binding, started.transition.id);
  app.history(lesson);
  assert.equal((await app.manager.status(binding, started.transition.id)).state, 'source_changed');
});

test('the selected lesson may initially land in its explicit homework section', async () => {
  const app = fixture(), started = await app.open();
  app.history(bootstrap); await app.manager.status(binding, started.transition.id);
  const homework = `${bootstrap}/for-homework`;
  app.history(homework);
  const status = await app.manager.status(binding, started.transition.id);
  assert.equal(status.state, 'same_book');
  assert.equal(app.sessions['source-navigation:7'].observedUrl, homework);
  app.history(firstSection);
  assert.equal((await app.manager.status(binding, started.transition.id)).state, 'source_changed');
});

for (const url of [firstSection.replace('/book/1153358/', '/book/1153359/'), firstSection.replace(origin, 'https://progressme.ru')]) {
  test(`bootstrap landing cannot cross the selected ${url.includes('1153359') ? 'book' : 'origin'}`, async () => {
    const app = fixture({ sourceId: '' }), started = await app.open();
    app.history(bootstrap); await app.manager.status(binding, started.transition.id);
    app.history(url);
    const status = await app.manager.status(binding, started.transition.id);
    assert.notEqual(status.state, 'same_book');
    assert.equal(status.canRetry, false);
    await assert.rejects(app.manager.retry(binding, started.transition.id));
  });
}
