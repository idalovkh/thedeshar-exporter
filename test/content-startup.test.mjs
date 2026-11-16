import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const scripts = await Promise.all(['section-visit.js', 'content.js'].map(name =>
  readFile(new URL(`../src/capture/${name}`, import.meta.url), 'utf8')));
const tick = () => new Promise(resolve => setImmediate(resolve));
const sectionUrl = 'https://platform.desharschool.ru/lesson-editor/book/1/lesson/2/section/3';
const captureId = 'capture-startup-00000001';

function source() {
  let resolveReady, rejectReady, listener, windowRef;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const location = new URL(sectionUrl);
  const posts = [], commands = [], reads = [], listeners = [], navigationListeners = [];
  const page = { location, URL, TextEncoder, crypto, Date,
    document: { title: 'Lesson', querySelector: () => null, querySelectorAll: () => [], body: { querySelectorAll: () => [] } },
    addEventListener(type, callback) { if (type === 'message') listeners.push(callback); },
    navigation: { addEventListener(type, callback) { if (type === 'currententrychange') navigationListeners.push(callback); } },
    history: {
      pushState(_state, _unused, url) {
        location.href = new URL(url, location).href;
        navigationListeners.forEach(callback => callback({ type: 'currententrychange' }));
      },
      replaceState(_state, _unused, url) {
        location.href = new URL(url, location).href;
        navigationListeners.forEach(callback => callback({ type: 'currententrychange' }));
      },
    },
    postMessage(value) {
      posts.push(value);
      setImmediate(() => listeners.forEach(callback => callback({ data: value, source: windowRef, origin: location.origin })));
    }, setTimeout, clearTimeout,
    chrome: { runtime: { sendMessage: message => message.type === 'CAPTURE_READY' ? ready : Promise.resolve({ ok: true }),
      onMessage: { addListener: callback => { listener = callback; } } } },
    __thedesharNavigation: {
      inspect() { reads.push('inspect'); return { url: location.href, kind: 'lesson', ready: true, items: [], title: 'Lesson' }; },
      prepare() { commands.push('prepare'); return { ok: true }; },
      open() { commands.push('open'); return { ok: true }; },
    },
  };
  location.reload = () => commands.push('reload');
  location.assign = value => commands.push(value);
  page.window = page;
  const context = vm.createContext(page);
  windowRef = vm.runInContext('window', context);
  scripts.forEach(script => vm.runInContext(script, context));
  return { location, posts, commands, reads, resolveReady, rejectReady,
    request(message) {
      let response, resolve, responded = false;
      const pending = new Promise(complete => { resolve = complete; });
      const asynchronous = listener(message, {}, value => { response = value; responded = true; resolve(structuredClone(value)); }) === true;
      if (responded) return structuredClone(response);
      assert.equal(asynchronous, true, `${message.type} must respond or retain its asynchronous channel`);
      return pending;
    },
  };
}

test('source startup withholds provisional visit identity until CAPTURE_READY has been applied', async () => {
  const app = source();
  for (const type of ['MATERIAL_NAVIGATION', 'PREPARE_BOOK', 'PAGE_SNAPSHOT', 'OPEN_MATERIAL_ITEM']) {
    const pending = (await app.request({ type }));
    assert.equal(pending.ok, false);
    assert.equal(pending.code, 'source_loading');
    assert.equal(pending.navigation, undefined, 'a provisional visit token must never escape startup');
  }
  assert.deepEqual(app.reads, []);
  assert.deepEqual(app.commands, []);
  app.resolveReady({ enabled: true, captureId });
  await tick();
  const first = (await app.request({ type: 'MATERIAL_NAVIGATION' }));
  const second = (await app.request({ type: 'MATERIAL_NAVIGATION' }));
  assert.equal(first.ok, true);
  assert.equal(first.navigation.documentToken, second.navigation.documentToken);
  assert.equal(first.navigation.sectionVisit.token, second.navigation.sectionVisit.token);
  assert.equal(first.navigation.sectionVisit.received, false, 'the handshake does not confirm author data');
});

for (const disabled of [{ enabled: false }, { captureEnabled: false }]) {
  test(`a successful disabled startup reply without an ok field establishes ${Object.keys(disabled)[0]}`, async () => {
    const app = source();
    app.resolveReady(disabled);
    await tick();
    const before = (await app.request({ type: 'MATERIAL_NAVIGATION' })).navigation;
    assert.ok(before?.sectionVisit.token);
    assert.equal(app.posts.filter(message => message.type === 'CAPTURE_STATE').at(-1).enabled, false);
    const started = app.request({ type: 'CAPTURE_START', captureId });
    assert.equal(started.ok, true);
    const after = (await app.request({ type: 'MATERIAL_NAVIGATION' })).navigation;
    assert.equal(after.documentToken, before.documentToken);
    assert.notEqual(after.sectionVisit.token, before.sectionVisit.token, 'an actual capture start creates a fresh visit');
    assert.equal((await app.request({ type: 'PAGE_SNAPSHOT', expectedDocumentToken: before.documentToken,
      expectedVisitToken: before.sectionVisit.token })).code, 'source_changed');
  });
}

for (const reply of [undefined, null, {}, { ok: false, enabled: false }, { enabled: true, captureId: 'invalid' }]) {
  test(`an unavailable startup reply does not manufacture a ready identity: ${JSON.stringify(reply)}`, async () => {
    const app = source();
    app.resolveReady(reply);
    await tick();
    const result = (await app.request({ type: 'MATERIAL_NAVIGATION' }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'source_unavailable');
    assert.equal(result.navigation, undefined);
    assert.deepEqual(app.reads, []);
    assert.equal(app.request({ type: 'CAPTURE_START', captureId }).ok, true);
    assert.ok((await app.request({ type: 'MATERIAL_NAVIGATION' })).navigation?.sectionVisit.token,
      'a later authoritative capture command can establish the state');
  });
}

test('a rejected startup transport remains unavailable until an authoritative capture command', async () => {
  const app = source();
  app.rejectReady(new Error('The extension worker did not answer'));
  await tick();
  assert.equal((await app.request({ type: 'MATERIAL_NAVIGATION' })).code, 'source_unavailable');
  assert.equal(app.request({ type: 'CAPTURE_STOP', captureId: null }).ok, true);
  assert.ok((await app.request({ type: 'MATERIAL_NAVIGATION' })).navigation?.sectionVisit.token);
});

for (const command of ['CAPTURE_START', 'CAPTURE_STOP']) {
  test(`a delayed startup reply cannot overwrite authoritative ${command} state or visit identity`, async () => {
    const app = source();
    const commandCapture = command === 'CAPTURE_START' ? captureId : null;
    assert.equal(app.request({ type: command, captureId: commandCapture }).ok, true);
    const before = (await app.request({ type: 'MATERIAL_NAVIGATION' })).navigation;
    app.resolveReady({ enabled: command === 'CAPTURE_STOP', captureId: command === 'CAPTURE_STOP' ? captureId : null });
    await tick();
    const after = (await app.request({ type: 'MATERIAL_NAVIGATION' })).navigation;
    assert.equal(after.documentToken, before.documentToken);
    assert.equal(after.sectionVisit.token, before.sectionVisit.token);
    assert.equal(app.posts.filter(message => message.type === 'CAPTURE_STATE').at(-1).enabled, command === 'CAPTURE_START');
  });
}

test('invalid capture commands cannot bypass startup and document or visit guards remain strict', async () => {
  const app = source();
  assert.equal(app.request({ type: 'CAPTURE_START', captureId: 'invalid' }).ok, false);
  assert.equal(app.request({ type: 'CAPTURE_STOP', captureId }).ignored, true);
  assert.equal((await app.request({ type: 'MATERIAL_NAVIGATION' })).code, 'source_loading');
  assert.equal((await app.request({ type: 'NAVIGATE_SOURCE', expectedDocumentToken: 'another-document', url: sectionUrl,
    expectedUrl: sectionUrl, reload: true })).code, 'source_changed');
  assert.deepEqual(app.commands, []);
  app.resolveReady({ enabled: true, captureId });
  await tick();
  const before = (await app.request({ type: 'MATERIAL_NAVIGATION' })).navigation;
  app.location.pathname = app.location.pathname.replace('/section/3', '/section/4');
  const after = (await app.request({ type: 'MATERIAL_NAVIGATION' })).navigation;
  assert.equal(after.documentToken, before.documentToken);
  assert.notEqual(after.sectionVisit.token, before.sectionVisit.token);
  assert.equal((await app.request({ type: 'PAGE_SNAPSHOT', expectedDocumentToken: after.documentToken,
    expectedVisitToken: before.sectionVisit.token })).code, 'source_changed');
  assert.equal((await app.request({ type: 'MATERIAL_NAVIGATION', expectedDocumentToken: 'another-document' })).code, 'source_changed');
});
