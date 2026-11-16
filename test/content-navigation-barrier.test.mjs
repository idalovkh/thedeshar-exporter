import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const scripts = await Promise.all(['hook.js', 'section-visit.js', 'content.js'].map(name =>
  readFile(new URL(`../src/capture/${name}`, import.meta.url), 'utf8')));
const origin = 'https://platform.desharschool.ru';
const contents = `${origin}/cabinet/school/materials/book/1153358/content`;
const bootstrap = `${origin}/lesson-editor/book/1153358/lesson/18601240/section`;
const concrete = `${bootstrap}/91646226`;
const next = `${bootstrap}/91646227`;
const captureId = 'navigation-barrier-capture-00001';
const tick = () => new Promise(resolve => setImmediate(resolve));

async function source() {
  const listeners = [], queued = [], actions = [], nativeListeners = [];
  let listener, windowRef;
  const location = new URL(contents);
  location.reload = () => actions.push('reload');
  location.assign = value => actions.push(value);
  const page = { location, URL, crypto, TextEncoder, TextDecoder, ArrayBuffer, Blob, Date, setTimeout, clearTimeout,
    document: { title: 'Fixture', querySelector: () => null, querySelectorAll: () => [], body: { querySelectorAll: () => [] } },
    history: { pushState(_state, _unused, url) { location.href = new URL(url, location).href; nativeListeners.forEach(fn => fn()); },
      replaceState(_state, _unused, url) { location.href = new URL(url, location).href; nativeListeners.forEach(fn => fn()); } },
    navigation: { addEventListener(type, fn) { if (type === 'currententrychange') nativeListeners.push(fn); } },
    addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
    postMessage(data) { queued.push(data); },
    chrome: { runtime: { sendMessage: async message => message.type === 'CAPTURE_READY' ? { enabled: true, captureId } : { ok: true },
      onMessage: { addListener: fn => { listener = fn; } } } },
    __thedesharNavigation: { inspect: () => ({ kind: location.pathname.includes('lesson-editor') ? 'lesson' : 'book',
      url: location.href, lessonId: '18601240', ready: false, items: [] }),
      open() { actions.push('open'); return { ok: true }; }, prepare() { actions.push('prepare'); return { ok: true }; } },
  };
  page.window = page;
  const context = vm.createContext(page);
  windowRef = vm.runInContext('window', context);
  scripts.forEach(script => vm.runInContext(script, context));
  const pump = async () => {
    for (let pass = 0; pass < 10; pass++) {
      while (queued.length) {
        const data = queued.shift();
        listeners.forEach(fn => fn({ source: windowRef, origin, data }));
        await tick();
      }
      await tick();
      if (!queued.length) return;
    }
    throw new Error('Fixture message queue did not drain');
  };
  await tick(); await pump();
  const request = message => new Promise(resolve => listener(message, {}, resolve));
  const read = async () => { const result = request({ type: 'MATERIAL_NAVIGATION' }); await pump(); return (await result).navigation; };
  return { request, read, pump, queued, actions, location, page,
    command(message) { let response; listener(message, {}, value => { response = value; }); return response; },
  };
}

test('navigation replies wait for the queued contents-to-bootstrap-to-section notifications before exposing a visit', async () => {
  const app = await source();
  await app.read();
  app.page.history.pushState({}, '', bootstrap);
  app.page.history.replaceState({}, '', concrete);
  assert.equal(app.queued.filter(message => message.direction === 'navigation').length, 2);
  let answered = false;
  const pending = app.request({ type: 'MATERIAL_NAVIGATION' }).then(value => { answered = true; return value; });
  await tick();
  assert.equal(answered, false, 'a read cannot outrun the page navigation-message queue');
  await app.pump();
  const first = (await pending).navigation;
  const after = await app.read();
  assert.equal(first.url, concrete);
  assert.equal(after.url, concrete);
  assert.equal(first.documentToken, after.documentToken);
  assert.equal(first.sectionVisit.token, after.sectionVisit.token);
});

test('a hidden round trip still invalidates the old visit before a queued snapshot is checked', async () => {
  const app = await source();
  app.page.history.pushState({}, '', concrete);
  const first = await app.read();
  app.page.history.pushState({}, '', next);
  app.page.history.replaceState({}, '', concrete);
  const pending = app.request({ type: 'PAGE_SNAPSHOT', expectedDocumentToken: first.documentToken, expectedVisitToken: first.sectionVisit.token });
  await app.pump();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'source_changed');
  assert.notEqual((await app.read()).sectionVisit.token, first.sectionVisit.token);
});

test('an authoritative stop remains synchronous and cancels a navigation waiting for its message barrier', async () => {
  const app = await source();
  app.page.history.pushState({}, '', concrete);
  const before = await app.read();
  const pending = app.request({ type: 'NAVIGATE_SOURCE', expectedDocumentToken: before.documentToken,
    expectedUrl: concrete, url: concrete, reload: true });
  const stop = app.command({ type: 'CAPTURE_STOP', captureId });
  assert.equal(stop.ok, true);
  assert.equal(stop.enabled, false);
  await app.pump();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'source_changed');
  assert.deepEqual(app.actions, []);
});

for (const type of ['PREPARE_BOOK', 'OPEN_MATERIAL_ITEM', 'PAGE_SNAPSHOT']) {
  test(`queued ${type} cannot act after an authoritative stop`, async () => {
    const app = await source();
    app.page.history.pushState({}, '', concrete);
    const before = await app.read();
    const pending = app.request({ type, expectedDocumentToken: before.documentToken, expectedVisitToken: before.sectionVisit.token,
      expectedUrl: concrete, key: 'section-key' });
    assert.equal(app.command({ type: 'CAPTURE_STOP', captureId }).ok, true);
    await app.pump();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'source_changed');
    assert.deepEqual(app.actions, []);
  });
}

function barrier({ nativeSupported = true } = {}) {
  const queued = [], timers = new Map();
  let listener, nextTimer = 0;
  const target = { ...(nativeSupported ? { navigation: { addEventListener() {} } } : {}), addEventListener(type, fn) { if (type === 'message') listener = fn; }, postMessage(data) { queued.push(data); } };
  const context = vm.createContext({ URL, crypto, window: target,
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); } });
  vm.runInContext(scripts[1], context);
  const visit = context.__thedesharCreateSectionVisit({ getUrl: () => concrete, getCaptureId: () => captureId });
  return { visit, queued, timers, deliver(data, overrides = {}) { listener({ source: target, origin, data, ...overrides }); } };
}

test('a navigation barrier accepts only its unpredictable same-window same-origin marker', async () => {
  const app = barrier();
  let finished = false;
  const pending = app.visit.flush().then(() => { finished = true; });
  const marker = app.queued[0];
  assert.match(marker.id, /^[a-f\d-]{36}$/i);
  app.deliver({ ...marker, id: 'guessed-marker' });
  app.deliver(marker, { source: {} });
  app.deliver(marker, { origin: 'https://other.example' });
  await tick();
  assert.equal(finished, false);
  assert.equal(app.timers.size, 1);
  app.deliver(marker);
  await pending;
  assert.equal(app.timers.size, 0);
});

test('a lost navigation marker is bounded by the existing source response deadline', async () => {
  const app = barrier();
  const pending = app.visit.flush();
  const timer = [...app.timers.values()][0];
  assert.equal(timer.ms, 10000);
  timer.fn();
  await assert.rejects(pending, error => error.code === 'source_loading');
  assert.equal(app.timers.size, 0);
  app.deliver(app.queued[0]);
  assert.equal(app.timers.size, 0, 'a late marker cannot resurrect a timed-out action');
});


test('a round trip posted after the snapshot barrier was queued cannot execute a stale snapshot', async () => {
  const app = await source();
  app.page.history.pushState({}, '', concrete);
  const first = await app.read();
  const pending = app.request({ type: 'PAGE_SNAPSHOT', expectedDocumentToken: first.documentToken, expectedVisitToken: first.sectionVisit.token });
  app.page.history.pushState({}, '', next);
  app.page.history.replaceState({}, '', concrete);
  await app.pump();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'source_loading', 'a navigation during the drain must retry the read instead of validating stale proof');
  assert.equal(result.snapshot, undefined);
  const fresh = await app.read();
  assert.notEqual(fresh.sectionVisit.token, first.sectionVisit.token);
  const stale = app.request({ type: 'PAGE_SNAPSHOT', expectedDocumentToken: first.documentToken, expectedVisitToken: first.sectionVisit.token });
  await app.pump();
  assert.equal((await stale).code, 'source_changed');
});


test('a same-URL state-only replacement does not reject an otherwise stable navigation read', async () => {
  const app = await source();
  app.page.history.pushState({}, '', concrete);
  const first = await app.read();
  const pending = app.request({ type: 'MATERIAL_NAVIGATION' });
  app.page.history.replaceState({ applicationState: 'changed' }, '', concrete);
  await app.pump();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.navigation.sectionVisit.token, first.sectionVisit.token);
});

test('the final navigation guard also runs after later listeners of the marker task', async () => {
  const app = await source();
  app.page.history.pushState({}, '', concrete);
  const first = await app.read();
  let moved = false;
  app.page.addEventListener('message', event => {
    if (moved || event.data.source !== 'thedeshar-section-visit-barrier-v1') return;
    moved = true;
    app.page.history.pushState({}, '', next);
    app.page.history.replaceState({}, '', concrete);
  });
  const pending = app.request({ type: 'OPEN_MATERIAL_ITEM', key: 'section-key', expectedUrl: concrete,
    expectedDocumentToken: first.documentToken, expectedVisitToken: first.sectionVisit.token });
  await app.pump();
  const result = await pending;
  assert.equal(result.code, 'source_loading');
  assert.deepEqual(app.actions, []);
});

test('a browser without the native navigation guard cannot expose unchecked source state', async () => {
  const app = barrier({ nativeSupported: false });
  await assert.rejects(app.visit.flush(), error => error.code === 'source_update_required');
  assert.equal(app.queued.length, 0);
  assert.equal(app.timers.size, 0);
});
