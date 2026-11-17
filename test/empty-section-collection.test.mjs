import assert from 'node:assert/strict';
import test from 'node:test';
import { installBackground } from '../src/background.js';
import { createExporterContextFixture } from './exporter-context-fixture.js';
import { collectBook } from '../src/lib/collection.js';
import { exportReadiness } from '../src/lib/export-readiness.js';
import { createWorkspace } from '../src/lib/state.js';

const bookUrl = 'https://progressme.ru/cabinet/school/materials/book/1/content';
const dashboardUrl = 'chrome-extension://extension/exporter.html?tab=7';

function emptySectionSource(sectionId, replyAt) {
  const sectionUrl = `https://progressme.ru/lesson-editor/book/1/lesson/2/section/${sectionId}`;
  const sectionKind = sectionId === 'for-homework' ? 'homework' : 'section';
  const sessions = {};
  const calls = [];
  let state = createWorkspace(7);
  let listener;
  let url = bookUrl;
  let generation = 1;
  let received = false;
  let lastTransition;
  const events = new Map();
  let eventSequence = 0;
  const event = name => ({ addListener(callback) { const list = events.get(name) || []; list.push(callback); events.set(name, list); } });
  const emit = name => { for (const callback of events.get(name) || []) callback({ tabId: 7, frameId: 0, url, documentId: `11111111-1111-4111-8111-${String(generation).padStart(12, "0")}`, timeStamp: Date.now() + ++eventSequence / 1000 }); };
  const navigate = target => { url = target; emit("onBeforeNavigate"); generation++; received = false; emit("onCommitted"); };
  const dashboard = { id: 'extension', url: dashboardUrl, tab: { id: 99, url: dashboardUrl } };
  const source = () => ({ id: 'extension', url, frameId: 0, tab: { id: 7, url } });
  const navigation = () => ({ url, documentToken: `source-document-${String(generation).padStart(8, '0')}`,
    materialId: '1', lessonId: url === bookUrl ? null : '2', kind: url === bookUrl ? 'book' : 'lesson',
    sectionVisit: { token: `empty-section-visit-${generation}-${url === bookUrl ? 'book' : 'lesson'}`, revision: received ? 1 : 0, received, idleMs: 10000 },
    title: 'Empty section', ready: true, contentSignature: url === bookUrl ? 'book' : '0:empty', warnings: [],
    ...(url === bookUrl ? {} : { exerciseState: { loaderVisible: false, listVisible: false, emptyVisible: true } }),
    items: url === bookUrl ? [{ key: 'lesson-2', title: 'Lesson', kind: 'lesson', sourceId: '2' }]
      : [{ key: 'empty-section', title: 'Empty section', kind: sectionKind, active: true }],
  });
  const chrome = {
    runtime: { id: 'extension', getURL: path => `chrome-extension://extension/${path}`,
      sendMessage: async () => {}, onMessage: { addListener: fn => { listener = fn; } } },
    action: { onClicked: { addListener() {} } },
    storage: { session: { get: async key => ({ [key]: sessions[key] }), set: async value => Object.assign(sessions, value),
      remove: async key => { delete sessions[key]; } } },
    webNavigation: { onBeforeNavigate: event("onBeforeNavigate"), onCommitted: event("onCommitted"), onHistoryStateUpdated: event("onHistoryStateUpdated"), getFrame: async () => ({ url,
      documentId: `11111111-1111-4111-8111-${String(generation).padStart(12, '0')}`,
      errorOccurred: false, documentLifecycle: 'active' }) },
    tabs: { onRemoved: { addListener() {} }, update: async (_id, patch) => { calls.push({ type: 'NATIVE_RECOVERY', url: patch.url }); navigate(patch.url); }, get: async id => ({ id, url: id === 7 ? url : dashboardUrl }),
      sendMessage: async (_id, message) => {
        calls.push(message);
        if (message.type === 'CAPTURE_START') return { ok: true, captureId: message.captureId };
        if (message.type === 'OPEN_MATERIAL_ITEM') { url = sectionUrl; received = false; emit('onHistoryStateUpdated'); return { ok: true }; }
        if (message.type === 'NAVIGATE_SOURCE') { navigate(message.url); return { ok: true }; }
        if (message.type === 'PAGE_SNAPSHOT') return { ok: true, snapshot: { url,
          route: { kind: url === bookUrl ? 'book' : 'lesson' }, title: 'Empty section', blocks: [], links: [], assets: [] } };
        return { ok: true, navigation: navigation() };
      } },
  };
  const withExporterDocument = createExporterContextFixture(chrome);
  installBackground(chrome, { readWorkspace: async () => state,
    updateWorkspace: async (_id, update) => { state = update(state); return state; } });
  const send = (message, sender = dashboard) => new Promise(resolve => {
    listener({ tabId: 7, ...message }, withExporterDocument(sender), resolve);
  });
  const captureEmpty = async () => {
    const result = await send({ type: 'CAPTURE_EVENT', captureId: sessions['capture-id:7'],
      event: { kind: 'websocket', url: 'wss://proxy.progressme.ru/ws', receivedAt: new Date().toISOString(),
        data: { Class: 'GetExerciseWsController', Method: 'LoadExercises', IsSuccess: true,
          Value: { Items: [], Count: 0, ...(sectionId === 'for-homework' ? {} : { SectionId: Number(sectionId) }) } } } }, source());
    assert.equal(result.ok, true);
    received = result.exerciseCapture.received;
  };
  return {
    sectionUrl, calls, get state() { return state; },
    async request(type, payload) {
      if (type === 'REPLACE_SOURCE_TAB') {
        // Keep this fixture focused on the author-data gate. Real tab/lease transfer
        // is exercised by stall-recovery-background and the Chrome acceptance case.
        calls.push({ type });
        return { ok: true, transition: { ...lastTransition, attempt: 3 }, reloaded: false };
      }
      const result = await send({ type, ...payload });
      if (result.transition) lastTransition = result.transition;
      if (!result?.ok) throw Object.assign(new Error(result?.error || `Failed ${type}`), { code: result?.code });
      if (replyAt === 'open' && type === 'OPEN_MATERIAL_ITEM' ||
          replyAt === 'reload' && ['NAVIGATE_SOURCE', 'RETRY_SOURCE_NAVIGATION'].includes(type) && url === sectionUrl) await captureEmpty();
      return result;
    },
  };
}

async function collect(source, t) {
  return collectBook({ request: source.request, wait: async ms => { t.mock.timers.tick(ms); }, pollMs: 1000, quietMs: 0,
    transitionTimeoutMs: 180000, retryDelaysMs: [0, 0], now: () => Date.now(),
    });
}

for (const sectionId of ['3', 'for-homework']) {
  test(`empty ${sectionId} cannot finish from a DOM empty state without an author response`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1000 });
    const source = emptySectionSource(sectionId);
    const report = await collect(source, t);
    assert.equal(report.status, 'failed');
    assert.equal(report.failed.length, 1);
    assert.equal(report.failed[0].url, source.sectionUrl);
    assert.equal(report.diagnostics.failure.reason, 'author_data_missing');
    assert.equal(source.calls.filter(call => call.type === 'NATIVE_RECOVERY' && call.url === source.sectionUrl).length, 1);
    assert.equal(source.calls.filter(call => call.type === 'REPLACE_SOURCE_TAB').length, 1);
    assert.equal(source.state.snapshots.some(snapshot => snapshot.url === source.sectionUrl), false);
    assert.ok(source.state.snapshots.some(snapshot => snapshot.url === bookUrl));
    assert.equal(exportReadiness(source.state).allowed, false);
  });

  test(`explicitly empty ${sectionId} finishes after its captured author reply`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1000 });
    const source = emptySectionSource(sectionId, 'open');
    const report = await collect(source, t);
    assert.equal(report.status, 'finished');
    assert.equal(report.failed.length, 0);
    assert.equal(source.state.captures.length, 1);
    assert.deepEqual(source.state.captures[0].data.Value.Items, []);
    assert.equal(source.calls.some(call => call.type === 'NAVIGATE_SOURCE' && call.url === source.sectionUrl), false);
    assert.equal(exportReadiness(source.state).allowed, true);
  });

  test(`empty ${sectionId} reloads until an explicit author reply arrives`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1000 });
    const source = emptySectionSource(sectionId, 'reload');
    const report = await collect(source, t);
    assert.equal(report.status, 'finished');
    assert.equal(report.failed.length, 0);
    assert.equal(source.calls.filter(call => call.type === 'NATIVE_RECOVERY' && call.url === source.sectionUrl).length, 1);
    assert.equal(source.state.captures.length, 1);
    assert.equal(exportReadiness(source.state).allowed, true);
  });
}
