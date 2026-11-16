import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { installBackground } from '../src/background.js';
import { createExporterContextFixture } from './exporter-context-fixture.js';
import { createWorkspace, LIMITS } from '../src/lib/state.js';

const scripts = await Promise.all(['hook.js', 'section-visit.js', 'content.js'].map(file =>
  readFile(new URL(`../src/capture/${file}`, import.meta.url), 'utf8')));
const tick = () => new Promise(resolve => setImmediate(resolve));
const sectionUrl = 'https://platform.desharschool.ru/lesson-editor/book/1/lesson/2/section/3';
const rpc = (SectionId = 3, Count = 0) => ({ Class: 'GetExerciseWsController', Method: 'LoadExercises', IsSuccess: true,
  Value: { Items: [], Count, ...(SectionId === undefined ? {} : { SectionId }) } });

async function source({ full = false } = {}) {
  const sessions = {}, snapshots = [];
  let state = createWorkspace(7), listener, runtimeListener, page, socket, hold, writeStarted, writeError;
  let rendered = true, browserDocumentId;
  const location = new URL(sectionUrl);
  if (full) state.captures = Array.from({ length: LIMITS.captures }, (_, id) => ({ kind: 'websocket',
    url: 'wss://proxy.progressme.ru/ws', pageUrl: sectionUrl, data: { materials: [{ Id: id + 1 }] } }));
  const dashboardUrl = 'chrome-extension://extension/exporter.html?tab=7';
  const dashboard = { id: 'extension', url: dashboardUrl, tab: { id: 99, url: dashboardUrl } };
  const sender = () => ({ id: 'extension', url: sectionUrl, frameId: 0, tab: { id: 7, url: location.href } });
  const send = (message, from = dashboard) => new Promise(resolve => listener({ tabId: 7, ...message }, withExporterDocument(from), resolve));
  const chrome = {
    runtime: { id: 'extension', getURL: path => `chrome-extension://extension/${path}`,
      sendMessage: async () => {}, onMessage: { addListener: fn => { listener = fn; } } },
    action: { onClicked: { addListener() {} } },
    storage: { session: { get: async key => ({ [key]: sessions[key] }), set: async value => Object.assign(sessions, value),
      remove: async key => { delete sessions[key]; } } },
    tabs: { onRemoved: { addListener() {} }, get: async id => ({ id, url: id === 7 ? location.href : dashboardUrl }),
      sendMessage: async (_id, message) => new Promise(resolve => runtimeListener(message, {}, resolve)) },
    webNavigation: { getFrame: async () => ({ url: location.href, documentId: browserDocumentId,
      errorOccurred: false, documentLifecycle: 'active' }) },
  };
  const withExporterDocument = createExporterContextFixture(chrome);
  installBackground(chrome, { readWorkspace: async () => state, updateWorkspace: async (_id, update) => {
    if (hold) { writeStarted?.(); await hold; hold = undefined; }
    if (writeError) { const error = writeError; writeError = undefined; throw error; }
    state = update(state); return state;
  } });
  function install() {
    browserDocumentId = crypto.randomUUID();
    const listeners = [], nativeListeners = [];
    class Socket {
      constructor() { this.listeners = []; }
      addEventListener(type, fn) { if (type === 'message') this.listeners.push(fn); }
      receive(data) { this.listeners.forEach(fn => fn({ data: JSON.stringify(data) })); }
    }
    const main = { closest: () => null, getClientRects: () => [{}], matches: () => false, querySelectorAll: () => [] };
    page = { location, URL, TextEncoder, TextDecoder, ArrayBuffer, Blob, crypto, setTimeout, clearTimeout, WebSocket: Socket,
      document: { title: 'Lesson', querySelector: selector => selector === '.lesson-viewer-layout_main' ? main : null, querySelectorAll: () => [], body: { querySelectorAll: () => [] } },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
      addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
      history: { pushState(_state, _unused, url) { location.href = new URL(url, location).href; nativeListeners.forEach(fn => fn()); },
        replaceState(_state, _unused, url) { location.href = new URL(url, location).href; nativeListeners.forEach(fn => fn()); } },
      navigation: { addEventListener(type, fn) { if (type === 'currententrychange') nativeListeners.push(fn); } },
      chrome: { runtime: { sendMessage: message => send(message, sender()), onMessage: { addListener: fn => { runtimeListener = fn; } } } },
      __thedesharNavigation: { inspect: () => ({ url: location.href, kind: 'lesson', ready: rendered, items: [], title: 'Lesson' }),
        open: () => ({ ok: true }) },
    };
    page.window = page;
    const context = vm.createContext(page);
    const window = vm.runInContext('window', context);
    page.postMessage = data => listeners.forEach(fn => fn({ source: window, origin: location.origin, data }));
    scripts.forEach(script => vm.runInContext(script, context));
    socket = new page.WebSocket('wss://proxy.progressme.ru/ws');
  }
  install();
  await tick();
  const lease = await send({ type: 'BEGIN_COLLECTION' });
  const start = await send({ type: 'START_CAPTURE', collectionId: lease.collectionId });
  assert.equal(start.ok, true);
  const nav = async () => (await send({ type: 'GET_NAVIGATION' })).navigation;
  const take = async navigation => {
    const response = await send({ type: 'TAKE_SNAPSHOT', collectionId: lease.collectionId, expectedUrl: location.href,
      expectedDocumentToken: navigation.documentToken, expectedVisitToken: navigation.sectionVisit.token, requireExerciseCapture: true });
    if (response.ok) snapshots.push(response);
    return response;
  };
  return { nav, take, send, snapshots, get state() { return state; },
    capture: message => send({ type: 'CAPTURE_EVENT', captureId: sessions['capture-id:7'], ...message }, sender()),
    receive: async data => { socket.receive(data); await tick(); },
    navigate: id => { page.history.pushState({}, '', location.pathname.replace(/section\/[^/]+$/, `section/${id}`)); },
    replace: async () => { install(); await tick(); },
    failNextWrite: () => { writeError = new Error('Disk write rejected'); },
    rendered: value => { rendered = value; },
    async pauseWrite() {
      let resume;
      hold = new Promise(resolve => { resume = resolve; });
      const started = new Promise(resolve => { writeStarted = resolve; });
      return { started, resume };
    },
  };
}

test('a WebSocket reply confirms readiness only after its background transaction succeeds', async () => {
  const app = await source();
  const before = await app.nav();
  assert.equal(before.sectionVisit.received, false);
  assert.equal((await app.take(before)).ok, false);
  const paused = await app.pauseWrite();
  void app.receive(rpc());
  await paused.started;
  assert.equal(app.state.captures.length, 0);
  paused.resume();
  await tick();
  const after = await app.nav();
  assert.equal(after.sectionVisit.received, true);
  assert.equal(app.state.captures.length, 1);
  app.rendered(false);
  assert.equal((await app.take(after)).ok, false, 'a late loader must still prevent the snapshot');
  app.rendered(true);
  assert.equal((await app.take(after)).ok, true);
  assert.doesNotMatch(JSON.stringify(app.state), /sectionVisit|documentToken|visitToken/);
});

test('a delayed acknowledgement cannot confirm the next SPA route', async () => {
  const app = await source();
  const paused = await app.pauseWrite();
  void app.receive(rpc());
  await paused.started;
  app.navigate('for-homework');
  paused.resume();
  await tick();
  const navigation = await app.nav();
  assert.equal(navigation.sectionVisit.received, false);
  assert.equal((await app.take(navigation)).ok, false);
});

test('a rapid SPA round trip between polls invalidates the old opening at the same URL', async () => {
  const app = await source();
  await app.receive(rpc());
  const before = await app.nav();
  app.navigate('4');
  app.navigate('3');
  const after = await app.nav();
  assert.notEqual(after.sectionVisit.token, before.sectionVisit.token);
  assert.equal(after.sectionVisit.received, false);
  assert.equal((await app.take(before)).code, 'source_changed');
});

test('a rejected background write cannot confirm author data', async () => {
  const app = await source();
  app.failNextWrite();
  await app.receive(rpc());
  assert.equal((await app.nav()).sectionVisit.received, false);
  assert.equal(app.state.captures.length, 0);
  await app.receive(rpc());
  assert.equal((await app.nav()).sectionVisit.received, true);
});

test('a capture rejected by storage limits cannot acknowledge author data', async () => {
  const app = await source({ full: true });
  await app.receive(rpc());
  assert.equal((await app.nav()).sectionVisit.received, false);
  assert.equal(app.state.captures.length, LIMITS.captures);
  assert.equal(app.state.dropped, 1);
});

test('an excluded response endpoint cannot acknowledge definitions that were never persisted', async () => {
  const app = await source();
  const result = await app.capture({ observedUrl: sectionUrl,
    event: { kind: 'websocket', url: 'https://platform.desharschool.ru/auth/login', data: rpc() } });
  assert.equal(result.exerciseCapture, undefined);
  assert.equal(app.state.captures.length, 0);
});

test('a capture from a different observed route is rejected before persistence', async () => {
  const app = await source();
  const result = await app.capture({ observedUrl: sectionUrl.replace('/section/3', '/section/4'),
    event: { kind: 'websocket', url: 'wss://proxy.progressme.ru/ws', data: rpc() } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'source_changed');
  assert.equal(result.exerciseCapture, undefined);
  assert.equal(app.state.captures.length, 0);
});

test('late lesson metadata cannot let a confirmed but mismatched homework snapshot reach storage', async () => {
  const app = await source();
  app.navigate('for-homework');
  await app.receive(rpc(3));
  const beforeMetadata = await app.nav();
  assert.equal(beforeMetadata.sectionVisit.received, true);
  await app.receive({ Class: 'LessonWsController', Method: 'GetLessonWithId', IsSuccess: true,
    Value: { Id: 2, Book: { Id: 1 }, Sections: [{ Id: 3 }], HomeworkSection: { Id: 4 } } });
  const result = await app.take(beforeMetadata);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'author_data_missing');
  assert.equal(app.state.snapshots.length, 0);
});

test('reopening the same URL and replacing its document require new replies, including deduplicated data', async () => {
  const app = await source();
  await app.receive(rpc());
  const first = await app.nav();
  assert.equal(first.sectionVisit.received, true);
  assert.equal((await app.take(first)).ok, true);
  const lease = await app.send({ type: 'BEGIN_COLLECTION' });
  const opened = await app.send({ type: 'OPEN_MATERIAL_ITEM', collectionId: lease.collectionId,
    expectedUrl: sectionUrl, expectedDocumentToken: first.documentToken, expectedVisitToken: first.sectionVisit.token, key: 'same-section' });
  assert.equal(opened.ok, true);
  const reopened = await app.nav();
  assert.notEqual(reopened.sectionVisit.token, first.sectionVisit.token);
  assert.equal(reopened.sectionVisit.received, false);
  assert.equal((await app.take(first)).code, 'source_changed');
  assert.equal(app.state.snapshots.length, 1, 'rejected new snapshots preserve the earlier saved page');
  await app.receive(rpc());
  assert.equal((await app.nav()).sectionVisit.received, true);
  assert.equal(app.state.captures.length, 1, 'identical definitions stay deduplicated');
  await app.replace();
  const replaced = await app.nav();
  assert.notEqual(replaced.documentToken, first.documentToken);
  assert.equal(replaced.sectionVisit.received, false, 'stored captures cannot prove a new document is loaded');
});

test('incomplete replies revoke readiness and a later complete reply restores it', async () => {
  const app = await source();
  await app.receive(rpc());
  const complete = await app.nav();
  await app.receive(rpc(3, 1));
  const incomplete = await app.nav();
  assert.equal(incomplete.sectionVisit.received, false);
  assert.equal(incomplete.sectionVisit.reason, 'incomplete');
  assert.ok(incomplete.sectionVisit.revision > complete.sectionVisit.revision);
  assert.equal((await app.take(incomplete)).ok, false);
  await app.receive(rpc());
  assert.equal((await app.nav()).sectionVisit.received, true);
});

test('homework rejects a delayed numeric-section reply when lesson metadata resolves its alias', async () => {
  const app = await source();
  await app.receive({ Class: 'LessonWsController', Method: 'GetLessonWithId', IsSuccess: true,
    Value: { Id: 2, Book: { Id: 1 }, Sections: [{ Id: 3 }], HomeworkSection: { Id: 4 } } });
  app.navigate('for-homework');
  await app.receive(rpc(3));
  assert.equal((await app.nav()).sectionVisit.received, false);
  await app.receive(rpc(4));
  assert.equal((await app.nav()).sectionVisit.received, true);
});

test('an explicit empty response without a section ID confirms the current homework opening', async () => {
  const app = await source();
  app.navigate('for-homework');
  const reply = rpc(); delete reply.Value.SectionId;
  await app.receive(reply);
  assert.equal((await app.nav()).sectionVisit.received, true);
});

test('out-of-order acknowledgements cannot restore an older complete result', () => {
  const context = vm.createContext({ URL, crypto, Date });
  vm.runInContext(scripts[1], context);
  const visit = context.__thedesharCreateSectionVisit({ getUrl: () => sectionUrl, getCaptureId: () => 'current-capture' });
  const old = visit.observe(), latest = visit.observe();
  visit.confirm(latest, { received: false, reason: 'incomplete' });
  visit.confirm(old, { received: true });
  assert.equal(visit.inspect().received, false);
  assert.equal(visit.inspect().reason, 'incomplete');
});
