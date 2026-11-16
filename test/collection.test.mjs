import test from "node:test";
import assert from "node:assert/strict";
import { collectBook } from "../src/lib/collection.js";
import { buildCoverage } from "../src/lib/coverage.js";
import { withCollectionTransitions } from './collection-transition-fixture.js';

const origin = "https://progressme.ru";
const bookUrl = `${origin}/cabinet/school/materials/book/867169/content`;
const lessonUrl = (lesson, section) => `${origin}/lesson-editor/book/867169/lesson/${lesson}/section/${section}`;
const lessonKey = (id) => `867169/book/lesson/Lesson%20${id}/1`;
const sectionKey = (id, section) => `867169/${id}/${section === "for-homework" ? "homework" : "section"}/${section}/1`;

function navigationFixture({ lessonIds = [34, 35], title = '' } = {}) {
  const book = () => ({
    url: bookUrl, kind: "book", materialId: "867169", lessonId: null, title, ready: true,
    contentSignature: "book-list", warnings: ["Only loaded source items are known."],
    items: lessonIds.map((id) => ({ key: lessonKey(id), title: `Lesson ${id}`, kind: "lesson", active: false })),
  });
  const lesson = (id, active = "first") => ({
    url: lessonUrl(id, active === "first" ? "56" : active), kind: "lesson", materialId: "867169", lessonId: String(id),
    title: active === "for-homework" ? "Для домашней работы" : "Section header", ready: true,
    // Empty homework is loaded content, not an unfinished request.
    contentSignature: active === "for-homework" ? "0:empty" : `content-${id}-${active}`, warnings: [],
    items: ["first", "57", "for-homework"].map((section) => ({
      key: sectionKey(id, section), title: section === "for-homework" ? "Для домашней работы" : `Section ${section}`,
      kind: section === "for-homework" ? "homework" : "section", active: active === section,
    })),
  });
  return { book, lesson };
}

function fakeSource(options = {}) {
  const fixture = navigationFixture({ lessonIds: options.lessonIds });
  let documentGeneration = 1;
  const documentToken = () => `test-document-${String(documentGeneration).padStart(8, '0')}`;
  let current = options.initialBook || fixture.book();
  let queued = [];
  let snapshotCount = 0;
  let waits = 0;
  let reloaded = false;
  let navigations = 0;
  let navigationReads = 0;
  let ownsCollection = false;
  const collectionId = 'test-collection-00000000';
  let sectionReloads = 0;
  let ignoredLessonClicks = options.ignoreLessonClicks || 0;
  let dropped = options.initialDropped || 0;
  let authorConfirmed = false;
  let visitGeneration = 0;
  const calls = [];
  const snapshots = [];
  const checkpoints = [];
  const progress = [];
  function transition(target) {
    authorConfirmed = false; visitGeneration++;
    current = structuredClone(target);
    // Loading, then changing content, then three identical ready observations.
    queued = [
      ...Array.from({ length: options.loadingPolls || 1 }, () => ({ ...structuredClone(target), ready: false, contentSignature: "loading" })),
      { ...structuredClone(target), contentSignature: "intermediate" },
      ...Array.from({ length: options.stablePolls || 3 }, () => structuredClone(target)),
    ];
  }
  function navigation() {
    let sectionVisit;
    if (current.kind === 'lesson') {
      let received = options.authorDataFor?.(current) !== false;
      if (!received && !authorConfirmed && current.ready && options.authorStatus) {
        const status = options.authorStatus(structuredClone(current));
        if (status.url !== current.url) throw Object.assign(new Error('Исходная вкладка изменилась.'), { code: 'source_changed' });
        authorConfirmed = status.received;
      }
      received ||= authorConfirmed;
      sectionVisit = { token: `test-section-visit-${documentGeneration}-${visitGeneration}`, revision: received ? 1 : 0,
        received, idleMs: received ? 10000 : 0 };
    }
    return { ...structuredClone(current), documentToken: documentToken(), ...(sectionVisit ? { sectionVisit } : {}) };
  }
  async function request(type, message = {}) {
    calls.push({ type, ...structuredClone(message) });
    if (['END_COLLECTION', 'SAVE_COLLECTION', 'START_CAPTURE', 'STOP_CAPTURE', 'CLEAR_CAPTURE', 'TAKE_SNAPSHOT', 'PREPARE_BOOK', 'OPEN_MATERIAL_ITEM', 'NAVIGATE_SOURCE'].includes(type)) assert.equal(message.collectionId, collectionId, type);
    if (type === "GET_NAVIGATION") {
      navigationReads++;
      const error = options.navigationError?.(navigationReads);
      if (error) throw error;
      if (queued.length) current = queued.shift();
      else if (options.finalNavigation) current = options.finalNavigation(structuredClone(current));
      if (message.expectedUrl && options.onGuardedNavigation) current = options.onGuardedNavigation(structuredClone(current));
      if (message.expectedUrl && current.url !== message.expectedUrl) {
        throw Object.assign(new Error("Исходная вкладка перешла на другую страницу."), { code: "source_changed" });
      }
      if (message.expectedDocumentToken) assert.equal(message.expectedDocumentToken, documentToken(), 'the request must address the current document');
      return { navigation: navigation() };
    }
    if (type === "PREPARE_BOOK") {
      assert.equal(ownsCollection, true, "expanding source groups requires the collection lease");
      assert.equal(message.expectedUrl, current.url, "preparation must guard the currently open page");
      assert.equal(current.kind, "book", "only the contents page has lazy lesson groups");
      const prepared = options.prepareBook?.(structuredClone(current), navigations);
      if (prepared?.navigation) {
        current = structuredClone(prepared.navigation);
        queued = [];
      }
      assert.equal(message.expectedDocumentToken, documentToken());
      return { ok: true, opened: prepared?.opened || 0, navigation: { ...structuredClone(current), documentToken: documentToken() } };
    }
    if (type === "SAVE_COLLECTION") {
      if (options.failFinalCheckpoint && message.collection.status !== "running") throw new Error("Failed to persist the final checkpoint.");
      checkpoints.push(structuredClone(message.collection));
      return { ok: true };
    }
    if (type === "BEGIN_COLLECTION") {
      assert.equal(ownsCollection, false, "a tour acquires its collection only once");
      if (options.failBegin) throw new Error("Another dashboard owns this collection.");
      ownsCollection = true;
      options.onBegin?.();
      return { ok: true, collectionId };
    }
    if (type === "CLEAR_CAPTURE") {
      assert.equal(ownsCollection, true, "existing data can only be cleared after acquiring the source");
      snapshots.length = 0;
      dropped = 0;
      return { ok: true };
    }
    if (type === "END_COLLECTION") {
      assert.equal(ownsCollection, true, "only an acquired collection can be released");
      ownsCollection = false;
      return { ok: true };
    }
    if (type === "START_CAPTURE" || type === "STOP_CAPTURE") {
      assert.equal(ownsCollection, true);
      if (type === "STOP_CAPTURE" && options.dropOnStop) dropped++;
      return { ok: true };
    }
    if (type === "NAVIGATE_SOURCE") {
      assert.equal(ownsCollection, true);
      assert.equal(message.expectedUrl, current.url, "navigation must guard the currently open page");
      assert.equal(message.expectedDocumentToken, documentToken());
      documentGeneration++;
      if (message.url === current.url && current.kind === 'lesson') {
        transition(options.sectionReload?.(structuredClone(current), ++sectionReloads) || current);
        return { ok: true };
      }
      assert.equal(message.url, bookUrl);
      reloaded = true;
      navigations++;
      if (options.failNavigationAt === navigations) throw new Error("The source tab closed before reloading.");
      transition(options.bookOnNavigation?.(navigations) || options.bookAfterReload || fixture.book());
      return { ok: true };
    }
    if (type === "OPEN_MATERIAL_ITEM") {
      assert.equal(ownsCollection, true);
      assert.equal(message.expectedUrl, current.url, "click must guard the currently open page");
      assert.equal(message.expectedDocumentToken, documentToken());
      const target = current.items.find((item) => item.key === message.key);
      assert.ok(target, "only a visible known navigation item may be opened");
      if (options.failOpenKey === message.key) throw new Error("The source tab changed before the click.");
      if (target.kind === "lesson" && ignoredLessonClicks > 0) {
        ignoredLessonClicks--;
        return { ok: true, key: target.key, kind: target.kind, title: target.title };
      }
      if (options.foreignOpenKey === message.key) {
        transition({ ...fixture.lesson(99), materialId: "other", url: `${origin}/lesson-editor/book/other/lesson/99/section/1` });
      } else if (target.kind === "lesson") {
        const id = Number(message.key.match(/Lesson%20(\d+)/)[1]);
        const next = fixture.lesson(options.redirectLessonIds?.[id] || id);
        transition(next);
        if (options.switchDuringOpenKey === message.key) {
          queued = [queued[0], ...Array.from({ length: 5 }, () => fixture.lesson(99))];
        }
      } else {
        const id = Number(current.lessonId);
        const section = ["first", "57", "for-homework"].find((value) => sectionKey(id, value) === message.key);
        const next = fixture.lesson(id, section);
        transition(options.sectionOnOpen?.(next, message.key) || next);
      }
      return { ok: true, key: target.key, kind: target.kind, title: target.title };
    }
    if (type === "TAKE_SNAPSHOT") {
      assert.equal(ownsCollection, true);
      assert.equal(message.expectedUrl, current.url);
      assert.equal(message.expectedDocumentToken, documentToken());
      assert.equal(current.ready, true);
      assert.equal(queued.length, 0, "snapshot waits until the ready content has stopped changing");
      snapshotCount++;
      if (options.staleSnapshotAt === snapshotCount) return { snapshotUrl: `${origin}/lesson-editor/book/other/lesson/99/section/1` };
      const savedUrl = options.savedQuery && current.kind === 'lesson' ? `${current.url}?view=preview` : current.url;
      snapshots.push({ ...structuredClone(current), url: savedUrl });
      return { snapshotUrl: current.url, savedSnapshotUrl: savedUrl,
        ...(options.authorDataFor ? { retained: { dropped: 0, authorData: navigation().sectionVisit?.received } } : {}) };
    }
    if (type === "GET_STATE") {
      assert.equal(message.summary, true, 'Collection checkpoints must not request the entire raw textbook');
      return { state: { dropped: options.dropAtSnapshot && snapshotCount >= options.dropAtSnapshot ? 1 : dropped, warnings: options.captureWarnings || [] } };
    }
    throw new Error(`Unexpected request: ${type}`);
  }
  return {
    calls, snapshots, checkpoints, progress,
    request: withCollectionTransitions(request, { sourceStatus: options.sourceStatus, getNavigation: navigation,
      onCommand: (type, payload) => calls.push({ type, ...structuredClone(payload) }) }),
    get reloaded() { return reloaded; },
    async wait() { waits++; options.onWait?.(waits); },
    onProgress(report) { progress.push(structuredClone(report)); },
  };
}

async function collect(source, extra = {}) {
  return collectBook({ request: source.request, wait: source.wait, onProgress: source.onProgress, attempts: 9, pollMs: 1, quietMs: 0,
    transitionTimeoutMs: (extra.attempts || 9) * (extra.pollMs || 1) * 3, retryDelaysMs: [0, 0], now: () => 0, ...extra });
}

function stoppedAndPersisted(source, status, started = true, acquired = started) {
  assert.equal(source.calls.filter((call) => call.type === "STOP_CAPTURE").length, started ? 1 : 0);
  assert.equal(source.calls.filter((call) => call.type === "BEGIN_COLLECTION").length, acquired ? 1 : 0);
  assert.equal(source.calls.filter((call) => call.type === "END_COLLECTION").length, acquired ? 1 : 0);
  if (acquired) assert.equal(source.calls.at(-1).type, "END_COLLECTION", "release follows the final persisted checkpoint");
  if (!acquired) { assert.equal(source.checkpoints.length, 0); assert.equal(source.progress.length, 0); return; }
  assert.equal(source.checkpoints.at(-1).status, status);
  assert.equal(source.progress.at(-1).status, status);
  assert.ok(source.checkpoints.at(-1).finishedAt);
}

test("a two-lesson tour waits for ready stable content and retains empty homework pages", async () => {
  const source = fakeSource();
  const report = await collect(source);
  assert.equal(report.status, "finished");
  assert.equal(report.rootUrl, bookUrl);
  assert.deepEqual(source.snapshots.map((page) => page.url), [
    bookUrl,
    lessonUrl(34, "56"), lessonUrl(34, "57"), lessonUrl(34, "for-homework"),
    lessonUrl(35, "56"), lessonUrl(35, "57"), lessonUrl(35, "for-homework"),
  ]);
  assert.deepEqual(report.visited, source.snapshots.map((page) => page.url));
  assert.equal(report.items.filter((item) => item.kind === "lesson").length, 2);
  assert.deepEqual(report.items.filter((item) => item.kind === "lesson").map(item => item.lessonId), ['34', '35']);
  assert.equal(report.items.filter((item) => item.kind === "homework" && item.status === "visited").length, 2);
  assert.ok(report.items.every((item) => item.status === "visited"));
  assert.equal(report.failed.length, 0);
  assert.ok(report.warnings.includes("Only loaded source items are known."));
  assert.ok(source.calls.findIndex((call) => call.type === "START_CAPTURE") < source.calls.findIndex((call) => call.type === "NAVIGATE_SOURCE"));
  assert.ok(source.checkpoints.some((checkpoint) => checkpoint.items.some((item) => item.status === "pending")), "unfinished checkpoints must preserve pending work");
  stoppedAndPersisted(source, "finished");
});

test('a delayed author WebSocket response is awaited before leaving its section without reloading', async () => {
  let polls = 0;
  const target = lessonUrl(34, '56');
  const source = fakeSource({ authorDataFor: page => page.url === target ? false : undefined,
    authorStatus: page => ({ url: page.url, received: ++polls >= 3 }) });
  const report = await collect(source);
  assert.equal(report.status, 'finished');
  assert.equal(polls, 3);
  assert.equal(source.snapshots.length, 7);
  assert.equal(source.calls.some(call => call.type === 'NAVIGATE_SOURCE' && call.url === target), false);
});

test('a section missing author data is reloaded in place and saved only after its response arrives', async () => {
  let received = false;
  const target = lessonUrl(34, '56');
  const source = fakeSource({ authorDataFor: page => page.url === target ? received : undefined,
    authorStatus: page => ({ url: page.url, received }), sectionReload: page => { received = true; return page; } });
  const report = await collect(source);
  assert.equal(report.status, 'finished');
  assert.equal(source.snapshots.filter(page => page.url === target).length, 1);
  assert.equal(source.calls.filter(call => call.type === 'NAVIGATE_SOURCE' && call.url === target && call.expectedUrl === target).length, 1);
  assert.equal(report.visited.filter(url => url === target).length, 1);
});

test('persistent missing author data preserves previous pages and stops before saving unconfirmed or later sections', async () => {
  const target = lessonUrl(34, '56');
  const source = fakeSource({ authorDataFor: page => page.url === target ? false : undefined });
  const report = await collect(source);
  assert.equal(report.status, 'failed');
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].url, target);
  assert.match(report.failed[0].error, /Не получены исходные задания/);
  assert.equal(report.diagnostics.failure.stage, "wait_author_data");
  assert.equal(report.diagnostics.failure.lastSavedUrl, bookUrl);
  assert.equal(report.diagnostics.failure.lessonTitle, "Lesson 34");
  assert.equal(report.diagnostics.failure.sectionTitle, "Section first");
  assert.equal(source.snapshots.filter(page => page.url === target).length, 0);
  assert.equal(source.snapshots.length, 1);
  assert.equal(report.items.find(item => item.key === lessonKey(34)).status, 'failed');
  assert.equal(report.items.find(item => item.key === lessonKey(35)).status, 'pending');
  stoppedAndPersisted(source, 'failed');
});

test('cancelling while awaiting author data preserves earlier snapshots and performs no reload', async () => {
  const controller = new AbortController();
  const target = lessonUrl(34, '56');
  const source = fakeSource({ authorDataFor: page => page.url === target ? false : undefined,
    authorStatus: page => { controller.abort(); return { url: page.url, received: false }; } });
  const report = await collect(source, { signal: controller.signal });
  assert.equal(report.status, 'cancelled');
  assert.deepEqual(report.visited, [bookUrl]);
  assert.equal(source.calls.some(call => call.type === 'NAVIGATE_SOURCE' && call.url === target), false);
  stoppedAndPersisted(source, 'cancelled');
});

test('a changed source URL while waiting for author data stops before collecting any later section', async () => {
  const target = lessonUrl(34, '56');
  const source = fakeSource({ authorDataFor: page => page.url === target ? false : undefined,
    authorStatus: () => ({ url: lessonUrl(99, '56'), received: true }) });
  const report = await collect(source);
  assert.equal(report.status, 'failed');
  assert.match(report.failed[0].error, /вкладка изменилась/);
  assert.equal(source.snapshots.length, 1);
  assert.equal(source.calls.some(call => call.type === 'NAVIGATE_SOURCE' && call.url === target), false);
});

test('an empty native response or empty page does not trigger author-data retries', async () => {
  const source = fakeSource({ authorDataFor: page => page.kind === 'lesson' ? true : undefined });
  const report = await collect(source);
  assert.equal(report.status, 'finished');
  assert.equal(source.calls.some(call => call.type === 'NAVIGATE_SOURCE' && call.url !== bookUrl), false);
  assert.equal(source.snapshots.filter(page => page.url.endsWith('/for-homework')).length, 2);
});

test("reset clears the old dataset only after source validation and lease acquisition", async () => {
  const source = fakeSource({ initialDropped: 5 });
  const report = await collect(source, { reset: true });
  assert.equal(report.status, 'finished');
  assert.deepEqual(source.calls.slice(0, 5).map(call => call.type), ['GET_NAVIGATION', 'BEGIN_COLLECTION', 'CLEAR_CAPTURE', 'SAVE_COLLECTION', 'START_CAPTURE']);
  assert.equal(source.calls.filter(call => call.type === 'CLEAR_CAPTURE').length, 1);
  stoppedAndPersisted(source, 'finished');
});

test("collection keeps existing data by default", async () => {
  const source = fakeSource();
  const report = await collect(source);
  assert.equal(report.status, 'finished');
  assert.equal(source.calls.some(call => call.type === 'CLEAR_CAPTURE'), false);
});

test("a rejected lease never clears existing data even when reset was requested", async () => {
  const source = fakeSource({ failBegin: true });
  const report = await collect(source, { reset: true });
  assert.equal(report.status, 'failed');
  assert.equal(source.calls.some(call => call.type === 'CLEAR_CAPTURE'), false);
  assert.equal(source.calls.some(call => call.type === 'START_CAPTURE'), false);
  assert.equal(source.calls.some(call => call.type === 'END_COLLECTION'), false);
});

test("an unsupported starting page cannot clear the previous dataset", async () => {
  const source = fakeSource({ initialBook: navigationFixture().lesson(34) });
  const report = await collect(source, { reset: true });
  assert.equal(report.status, 'failed');
  assert.equal(source.calls.some(call => call.type === 'BEGIN_COLLECTION'), false);
  assert.equal(source.calls.some(call => call.type === 'CLEAR_CAPTURE'), false);
});

test("collection checkpoints retain the book title without replacing it with section titles", async () => {
  const source = fakeSource({ initialBook: navigationFixture({ title: '  Starter\n Pack  ' }).book() });
  const report = await collect(source);
  assert.equal(report.status, 'finished');
  assert.equal(report.title, 'Starter Pack');
  assert.ok(source.checkpoints.every(checkpoint => checkpoint.title === 'Starter Pack'));
});

test("the reloaded book can supply its title when the initial heading was unavailable", async () => {
  const source = fakeSource({ bookAfterReload: navigationFixture({ title: 'Starter Pack' }).book() });
  const report = await collect(source);
  assert.equal(source.checkpoints[0].title, '');
  assert.equal(report.title, 'Starter Pack');
  assert.equal(source.checkpoints.at(-1).title, 'Starter Pack');
});

test("a rejected source click keeps later lessons pending and stops collection", async () => {
  const source = fakeSource({ failOpenKey: sectionKey(34, "57") });
  const report = await collect(source);
  assert.equal(report.status, "failed");
  assert.equal(report.items.find((item) => item.key === lessonKey(34)).status, "failed");
  assert.equal(report.items.find((item) => item.key === lessonKey(35)).status, "pending");
  assert.ok(report.failed[0].error.includes("changed before the click"));
  assert.equal(report.diagnostics.failure.stage, "open_section");
  assert.equal(report.diagnostics.failure.sectionTitle, "Section 57");
  assert.ok(!source.snapshots.some((page) => page.lessonId === "35"));
  stoppedAndPersisted(source, "failed");
});

test("navigation outside the original book cannot be saved or mark a lesson complete", async () => {
  const source = fakeSource({ foreignOpenKey: lessonKey(34) });
  const report = await collect(source);
  assert.equal(report.status, "failed");
  assert.deepEqual(report.visited, [bookUrl]);
  assert.equal(report.items.find((item) => item.key === lessonKey(35)).status, "pending");
  assert.equal(source.snapshots.length, 1);
  stoppedAndPersisted(source, "failed");
});

test("a stale snapshot response is rejected even after navigation was stable", async () => {
  const source = fakeSource({ staleSnapshotAt: 2 });
  const report = await collect(source);
  assert.equal(report.status, "failed");
  assert.deepEqual(report.visited, [bookUrl]);
  assert.equal(report.items.find((item) => item.key === lessonKey(35)).status, "pending");
  assert.ok(report.failed[0].error.includes("изменилась во время сохранения"));
  assert.equal(report.diagnostics.failure.stage, "save_page");
  assert.equal(report.diagnostics.failure.lastSavedUrl, bookUrl);
  stoppedAndPersisted(source, "failed");
});

test("abort during navigation persists cancellation and does not start later work", async () => {
  const controller = new AbortController();
  const source = fakeSource({ onWait: (count) => { if (count === 2) controller.abort(); } });
  const report = await collect(source, { signal: controller.signal });
  assert.equal(report.status, "cancelled");
  assert.equal(source.snapshots.length, 0);
  assert.ok(report.items.every((item) => item.status === "pending"));
  assert.equal(source.calls.filter((call) => call.type === "OPEN_MATERIAL_ITEM").length, 0);
  stoppedAndPersisted(source, "cancelled");
});

test("a signal aborted before the tour never enables capture or navigates the source", async () => {
  const controller = new AbortController();
  controller.abort();
  const source = fakeSource();
  const report = await collect(source, { signal: controller.signal });
  assert.equal(report.status, "cancelled");
  assert.ok(!source.calls.some((call) => ["START_CAPTURE", "NAVIGATE_SOURCE", "OPEN_MATERIAL_ITEM", "TAKE_SNAPSHOT"].includes(call.type)));
  stoppedAndPersisted(source, "cancelled", false);
});

test("page capacity stops before another snapshot and leaves later lessons pending", async () => {
  const source = fakeSource();
  const report = await collect(source, { maxPages: 2 });
  assert.equal(report.status, "failed");
  assert.equal(source.snapshots.length, 2);
  assert.equal(report.visited.length, 2);
  assert.equal(report.items.find((item) => item.key === lessonKey(35)).status, "pending");
  assert.ok(report.failed[0].error.includes("предел обхода"));
  stoppedAndPersisted(source, "failed");
});

test("storage drops stop collection without claiming later lessons were captured", async () => {
  const source = fakeSource({ dropAtSnapshot: 2 });
  const report = await collect(source);
  assert.equal(report.status, "failed");
  assert.equal(source.snapshots.length, 2);
  assert.equal(report.diagnostics.failure.lastSavedUrl, lessonUrl(34, "56"));
  assert.equal(report.items.find((item) => item.key === lessonKey(35)).status, "pending");
  assert.ok(report.failed[0].error.includes("лимит хранения"));
  stoppedAndPersisted(source, "failed");
});

test("capture issues retain their actual cause instead of being misreported as a storage limit", async () => {
  const warning = 'Ответ с учебным материалом слишком сложный и не сохранён.';
  const source = fakeSource({ dropAtSnapshot: 2, captureWarnings: [warning] });
  const report = await collect(source);
  assert.equal(report.status, 'failed');
  assert.ok(report.failed[0].error.includes(warning));
  assert.ok(!report.failed[0].error.includes('лимит хранения'));
});

test("an issue queued after the final snapshot prevents a finished collection", async () => {
  const source = fakeSource({ dropOnStop: true, captureWarnings: ['Часть ранних ответов не сохранена.'] });
  const report = await collect(source);
  assert.equal(report.status, 'failed');
  assert.ok(report.failed[0].error.includes('Часть ранних ответов не сохранена'));
  assert.ok(source.calls.findIndex(call => call.type === 'STOP_CAPTURE') < source.calls.findLastIndex(call => call.type === 'GET_STATE'));
  stoppedAndPersisted(source, 'failed');
});

test("coverage uses the actual saved query URL while navigation guards remain canonical", async () => {
  const source = fakeSource({ savedQuery: true });
  const report = await collect(source);
  assert.equal(report.status, 'finished');
  assert.equal(report.visited[0], bookUrl);
  assert.ok(report.visited.slice(1).every(url => url.endsWith('?view=preview')));
  assert.ok(report.expected.slice(1).every(url => url.endsWith('?view=preview')));
  const coverage = buildCoverage({ snapshots: source.snapshots, collection: report });
  assert.equal(coverage.counts.missingRoutes, 0);
});

test("a changed lesson inventory after reload cannot silently omit newly listed lessons", async () => {
  const refreshed = navigationFixture({ lessonIds: [34, 35, 36] }).book();
  const source = fakeSource({ bookAfterReload: refreshed });
  const report = await collect(source);
  if (report.status === "finished") {
    assert.equal(report.items.find((item) => item.key === lessonKey(36))?.status, "visited", "finished requires every refreshed lesson to be collected");
  } else {
    assert.equal(report.status, "failed");
    assert.ok(report.failed.length > 0);
  }
  stoppedAndPersisted(source, report.status);
});

test("a lesson list changing during the tour preserves the remaining lesson as pending", async () => {
  const changed = navigationFixture({ lessonIds: [34, 36] }).book();
  const source = fakeSource({ bookOnNavigation: (count) => count > 1 ? changed : undefined });
  const report = await collect(source);
  assert.equal(report.status, "failed");
  assert.equal(report.items.find((item) => item.key === lessonKey(34)).status, "visited");
  assert.equal(report.items.find((item) => item.key === lessonKey(35)).status, "pending");
  assert.ok(report.failed[0].error.includes("Список уроков изменился"));
  assert.ok(!source.snapshots.some((page) => page.lessonId === "35" || page.lessonId === "36"));
  stoppedAndPersisted(source, "failed");
});

test("two different cards opening the same lesson cannot mark both cards as visited", async () => {
  const source = fakeSource({ redirectLessonIds: { 35: 34 } });
  const report = await collect(source);
  assert.equal(report.status, "failed");
  assert.equal(report.items.find((item) => item.key === lessonKey(34)).status, "visited");
  assert.equal(report.items.find((item) => item.key === lessonKey(35)).status, "failed");
  assert.equal(source.snapshots.filter((page) => page.lessonId === "34").length, 3);
  assert.equal(source.snapshots.filter((page) => page.lessonId === "35").length, 0);
  assert.ok(report.failed[0].error.includes("Разные карточки открыли один урок"));
  stoppedAndPersisted(source, "failed");
});

test("a lesson switching during settling cannot replace the first observed lesson", async () => {
  const source = fakeSource({ switchDuringOpenKey: lessonKey(34) });
  const report = await collect(source);
  assert.equal(report.status, "failed");
  assert.deepEqual(report.visited, [bookUrl]);
  assert.equal(report.items.find((item) => item.key === lessonKey(35)).status, "pending");
  assert.equal(source.snapshots.some((page) => page.lessonId === "99"), false);
  stoppedAndPersisted(source, "failed");
});

test("a newly added section after a transition stops the tour and retains known pending sections", async () => {
  const source = fakeSource({ sectionOnOpen: (page, key) => {
    if (key === sectionKey(34, "57")) page.items.push({ key: sectionKey(34, "late"), title: "Late section", kind: "section", active: false });
    return page;
  } });
  const report = await collect(source);
  assert.equal(report.status, "failed");
  assert.ok(report.failed[0].error.includes("Список разделов изменился"));
  assert.equal(report.items.find((item) => item.key === sectionKey(34, "first")).status, "visited");
  assert.equal(report.items.find((item) => item.key === sectionKey(34, "57")).status, "pending");
  assert.equal(report.items.find((item) => item.key === sectionKey(34, "for-homework")).status, "pending");
  assert.equal(report.items.find((item) => item.key === lessonKey(35)).status, "pending");
  assert.deepEqual(report.visited, [bookUrl, lessonUrl(34, "56")]);
  stoppedAndPersisted(source, "failed");
});

test("a late section list change on the fresh final read prevents a completed lesson", async () => {
  const source = fakeSource({ finalNavigation: (page) => {
    if (page.url === lessonUrl(34, "for-homework")) page.items.push({ key: sectionKey(34, "late"), title: "Late section", kind: "section", active: false });
    return page;
  } });
  const report = await collect(source);
  assert.equal(report.status, "failed");
  assert.equal(report.items.find((item) => item.key === lessonKey(34)).status, "failed");
  assert.equal(report.items.find((item) => item.key === lessonKey(35)).status, "pending");
  assert.equal(report.items.filter((item) => item.lessonId === "34" && item.status === "visited").length, 3);
  assert.ok(report.failed[0].error.includes("Список разделов изменился"));
  stoppedAndPersisted(source, "failed");
});

test("the initial lesson inventory stays pending when the first reload fails", async () => {
  const source = fakeSource({ failNavigationAt: 1 });
  const report = await collect(source);
  assert.equal(report.status, "failed");
  assert.deepEqual(report.items.map((item) => [item.key, item.status]), [[lessonKey(34), "pending"], [lessonKey(35), "pending"]]);
  assert.equal(report.visited.length, 0);
  assert.equal(source.snapshots.length, 0);
  assert.deepEqual(source.checkpoints[0].items, report.items);
  assert.ok(report.failed[0].error.includes("before reloading"));
  stoppedAndPersisted(source, "failed");
});

test("cancelling immediately after acquisition releases the collection without enabling capture", async () => {
  const controller = new AbortController();
  const source = fakeSource({ onBegin: () => controller.abort() });
  const report = await collect(source, { signal: controller.signal });
  assert.equal(report.status, "cancelled");
  assert.equal(source.calls.some((call) => call.type === "START_CAPTURE"), false);
  assert.equal(source.calls.some((call) => call.type === "NAVIGATE_SOURCE"), false);
  stoppedAndPersisted(source, "cancelled", false, true);
});

test("a final checkpoint failure still releases the acquired collection", async () => {
  const source = fakeSource({ failFinalCheckpoint: true });
  await assert.rejects(collect(source), /Failed to persist the final checkpoint/);
  assert.equal(source.calls.filter((call) => call.type === "STOP_CAPTURE").length, 1);
  assert.equal(source.calls.filter((call) => call.type === "BEGIN_COLLECTION").length, 1);
  assert.equal(source.calls.filter((call) => call.type === "END_COLLECTION").length, 1);
  assert.equal(source.calls.at(-1).type, "END_COLLECTION");
});

test("slow renders are saved only after ready content becomes stable", async () => {
  const source = fakeSource({ loadingPolls: 7 });
  const report = await collect(source, { attempts: 12 });
  assert.equal(report.status, "finished");
  assert.equal(source.snapshots.length, 7);
  assert.ok(source.snapshots.every(page => page.ready && page.contentSignature !== "loading"));
  stoppedAndPersisted(source, "finished");
});

test("a transient content-script disconnect during reload is retried", async () => {
  const source = fakeSource({ navigationError: read => [2, 3].includes(read) ? Object.assign(new Error("Нет связи с учебником. Переподключите учебник."), { code: "source_disconnected" }) : null });
  const report = await collect(source);
  assert.equal(report.status, "finished");
  assert.equal(report.failed.length, 0);
  assert.equal(source.snapshots.length, 7);
  stoppedAndPersisted(source, "finished");
});

test("a temporary source RPC timeout during a transition is retried before failing the book", async () => {
  const source = fakeSource({ navigationError: read => [2, 3].includes(read)
    ? Object.assign(new Error("Вкладка книги не отвечает."), { code: "source_timeout" }) : null });
  const report = await collect(source);
  assert.equal(report.status, "finished");
  assert.equal(report.failed.length, 0);
  assert.equal(source.snapshots.length, 7);
  stoppedAndPersisted(source, "finished");
});

test('slow browser loading beyond sixty seconds finishes without restarting a progressing page', async () => {
  let clock = 0;
  const events = [];
  const source = fakeSource({ lessonIds: [34], loadingPolls: 70,
    sourceStatus: () => ({ state: 'loading', browserLoading: true, canRetry: false }) });
  const report = await collect(source, { attempts: undefined, pollMs: 1000, transitionTimeoutMs: 180000,
    now: () => clock, wait: async ms => { clock += ms; }, onDiagnostic: event => events.push(event) });
  assert.equal(report.status, 'finished', JSON.stringify(report.failed));
  assert.ok(clock > 60000);
  assert.ok(events.some(event => event.status === 'waiting' && event.elapsedMs >= 60000));
  assert.equal(source.calls.filter(call => call.type === 'RETRY_SOURCE_NAVIGATION').length, 0);
  assert.equal(source.snapshots.length, 4);
});

test('pending author requests beyond sixty seconds are allowed to complete without a reload', async () => {
  let clock = 0, slowPolls = 0;
  const fixture = navigationFixture();
  const source = fakeSource({ lessonIds: [34],
    sectionOnOpen: page => page.url === stalledUrl ? { ...page, ready: false,
      network: { pending: 1, idleMs: 0 }, exerciseState: stalledExerciseState } : page,
    finalNavigation: page => page.url === stalledUrl && ++slowPolls >= 80 ? fixture.lesson(34, '57') : page,
  });
  const report = await collect(source, { attempts: undefined, pollMs: 1000, transitionTimeoutMs: 180000,
    now: () => clock, wait: async ms => { clock += ms; } });
  assert.equal(report.status, 'finished', JSON.stringify(report.failed));
  assert.equal(source.calls.filter(call => call.type === 'RETRY_SOURCE_NAVIGATION').length, 0);
  assert.ok(source.snapshots.some(page => page.url === stalledUrl));
});

test('a source request that stays pending reaches the three-minute deadline without a destructive restart', async () => {
  let clock = 0, targetStarted;
  const source = fakeSource({ lessonIds: [34], sectionOnOpen: page => {
    if (page.url !== stalledUrl) return page;
    targetStarted = clock;
    return { ...page, ready: false, network: { pending: 1, idleMs: 0 }, exerciseState: stalledExerciseState };
  } });
  const report = await collect(source, { attempts: undefined, pollMs: 1000, transitionTimeoutMs: 180000,
    now: () => clock, wait: async ms => { clock += ms; } });
  assert.equal(report.status, 'failed');
  assert.equal(clock - targetStarted, 180000);
  assert.equal(source.calls.filter(call => call.type === 'RETRY_SOURCE_NAVIGATION').length, 0);
  assert.deepEqual(report.visited, [bookUrl, lessonUrl(34, '56')]);
  assert.equal(source.snapshots.some(page => page.url === stalledUrl), false);
});

test('confirmed native network failures recover on the second and third attempt', async () => {
  const source = fakeSource({ navigationError: read => [2, 3].includes(read)
    ? Object.assign(new Error('Страница не загрузилась.'), { code: 'source_network_error' }) : null,
    sourceStatus: () => ({ state: 'network_error', networkError: 'net::ERR_CONNECTION_RESET', canRetry: true }),
  });
  const report = await collect(source);
  assert.equal(report.status, 'finished', JSON.stringify(report.failed));
  assert.equal(source.calls.filter(call => call.type === 'RETRY_SOURCE_NAVIGATION').length, 2);
  assert.deepEqual(report.diagnostics.events.filter(event => event.reason === 'source_network_error' && event.status === 'retrying').map(event => event.attempt), [2, 3]);
});

test('a provisional browser retry that starts during backoff continues waiting instead of failing', async () => {
  let statusReads = 0;
  const source = fakeSource({ navigationError: read => read === 2
    ? Object.assign(new Error('Страница не загрузилась.'), { code: 'source_network_error' }) : null,
    sourceStatus: () => ++statusReads === 3
      ? { state: 'loading', browserLoading: true, canRetry: false }
      : { state: 'network_error', networkError: 'net::ERR_CONNECTION_RESET', canRetry: true },
  });
  const report = await collect(source);
  assert.equal(report.status, 'finished', JSON.stringify(report.failed));
  assert.equal(source.calls.filter(call => call.type === 'RETRY_SOURCE_NAVIGATION').length, 0);
  assert.ok(statusReads >= 3);
});

test('permanent native network failures stop after three attempts and retain their actual Chrome cause', async () => {
  const source = fakeSource({ navigationError: read => read > 1
    ? Object.assign(new Error('Страница не загрузилась.'), { code: 'source_network_error' }) : null,
    sourceStatus: () => ({ state: 'network_error', networkError: 'net::ERR_TUNNEL_CONNECTION_FAILED', canRetry: true }),
  });
  const report = await collect(source);
  assert.equal(report.status, 'failed');
  assert.equal(source.calls.filter(call => call.type === 'RETRY_SOURCE_NAVIGATION').length, 2);
  assert.equal(report.diagnostics.failure.reason, 'source_network_error');
  assert.equal(report.diagnostics.failure.networkError, 'net::ERR_TUNNEL_CONNECTION_FAILED');
  assert.equal(report.diagnostics.failure.attempt, 3);
  assert.equal(report.visited.length, 0);
  assert.ok(report.items.every(item => item.status === 'pending'));
});

test('native recovery and author-data reloads share one three-attempt budget', async () => {
  let failed = false;
  const source = fakeSource({
    navigationError: () => {
      if (!failed && source.calls.some(call => call.type === 'OPEN_MATERIAL_ITEM')) {
        failed = true;
        return Object.assign(new Error('Страница не загрузилась.'), { code: 'source_network_error' });
      }
      return null;
    },
    authorDataFor: page => page.kind !== 'lesson',
    sourceStatus: ({ transition }) => failed && transition.attempt === 1
      ? { state: 'network_error', networkError: 'net::ERR_TIMED_OUT' } : {},
  });
  const report = await collect(source);
  assert.equal(report.status, 'failed');
  assert.equal(source.calls.filter(call => call.type === 'RETRY_SOURCE_NAVIGATION').length, 2);
  assert.equal(report.diagnostics.failure.reason, 'author_data_missing');
  assert.equal(report.diagnostics.failure.attempt, 3);
  assert.deepEqual(report.visited, [bookUrl]);
});

test("an unrecovered disconnect retains the reconnect instruction and book stage", async () => {
  const source = fakeSource({ navigationError: read => read > 1 ? Object.assign(new Error("Нет связи с учебником. Нажмите «Переподключить учебник»."), { code: "source_disconnected" }) : null });
  const report = await collect(source);
  assert.equal(report.status, "failed");
  assert.equal(report.visited.length, 0);
  assert.equal(report.failed[0].url, bookUrl);
  assert.match(report.failed[0].error, /Содержание учебника: Нет связи с учебником/);
  assert.match(report.failed[0].error, /Переподключить учебник/);
  assert.ok(report.failed[0].error.includes(bookUrl));
  assert.equal(source.calls.filter(call => call.type === "GET_NAVIGATION").length, 28,
    'Read-only recovery uses the whole shared deadline without resetting or reloading');
  stoppedAndPersisted(source, "failed");
});

test("a blocked page stops immediately with its specific cause rather than the partial-capture warning", async () => {
  const partial = "Обход охватывает только загруженные элементы страницы; отсутствие других уроков и разделов не подтверждается.";
  const source = fakeSource({ bookAfterReload: { ...navigationFixture().book(), ready: false, blocked: true, warnings: [partial, "В книге включён поиск. Очистите фильтр перед автоматическим обходом."] } });
  const report = await collect(source);
  assert.equal(report.status, "failed");
  assert.match(report.failed[0].error, /В книге включён поиск/);
  assert.ok(!report.failed[0].error.includes(partial));
  assert.equal(source.calls.filter(call => call.type === "GET_NAVIGATION").length, 2);
  assert.equal(report.visited.length, 0);
  stoppedAndPersisted(source, "failed");
});

test("a lesson click ignored by the source is repeated once from the same confirmed contents", async () => {
  const source = fakeSource({ ignoreLessonClicks: 1 });
  const report = await collect(source);
  assert.equal(report.status, "finished");
  assert.equal(source.calls.filter(call => call.type === "OPEN_MATERIAL_ITEM" && call.key === lessonKey(34)).length, 2);
  assert.ok(source.calls.some(call => call.type === "GET_NAVIGATION" && call.expectedUrl === bookUrl));
  assert.ok(report.diagnostics.events.some(event => event.stage === "open_lesson" && event.status === "retrying"));
  assert.equal(report.visited.filter(url => url === lessonUrl(34, "56")).length, 1);
  stoppedAndPersisted(source, "finished");
});

test("a persistently ignored lesson click uses the same three-attempt limit", async () => {
  const source = fakeSource({ ignoreLessonClicks: 3 });
  const report = await collect(source);
  assert.equal(report.status, "failed");
  assert.equal(source.calls.filter(call => call.type === "OPEN_MATERIAL_ITEM").length, 3);
  assert.equal(report.diagnostics.failure.reason, "navigation_timeout");
  assert.deepEqual(report.visited, [bookUrl]);
  stoppedAndPersisted(source, "failed");
});

test("a lesson click is never repeated after the source route or confirmed lesson inventory changes", async () => {
  const changed = [
    () => navigationFixture().lesson(34),
    page => ({ ...page, items: page.items.slice(0, 1) }),
  ];
  for (const onGuardedNavigation of changed) {
    const source = fakeSource({ ignoreLessonClicks: 1, onGuardedNavigation });
    const report = await collect(source);
    assert.equal(report.status, "failed");
    assert.equal(source.calls.filter(call => call.type === "OPEN_MATERIAL_ITEM").length, 1);
    assert.ok(source.calls.some(call => call.type === "GET_NAVIGATION" && call.expectedUrl === bookUrl));
    assert.deepEqual(report.visited, [bookUrl]);
    stoppedAndPersisted(source, "failed");
  }
});

test("a lesson that never becomes ready reports the exact missing content and lesson URL", async () => {
  const fixture = navigationFixture();
  const source = fakeSource({ sectionOnOpen: page => page.url === lessonUrl(34, "57") ? { ...page, ready: false, readinessReason: "Не найден загруженный список упражнений или сообщение о пустом разделе." } : page });
  const report = await collect(source);
  assert.equal(report.status, "failed");
  assert.equal(report.failed[0].url, lessonUrl(34, "57"));
  assert.match(report.failed[0].error, /Раздел «Section 57» урока «Lesson 34»/);
  assert.match(report.failed[0].error, /Не найден загруженный список упражнений/);
  assert.ok(report.failed[0].error.includes(lessonUrl(34, "57")));
  assert.deepEqual(report.visited, [bookUrl, fixture.lesson(34).url]);
  stoppedAndPersisted(source, "failed");
});

const stalledUrl = lessonUrl(34, "57");
const stalledExerciseState = { loaderVisible: true, listVisible: true, emptyVisible: false };
const stallSection = page => page.url === stalledUrl ? {
  ...page, ready: false, readinessReason: "Сайт загружает задания раздела.",
  exerciseState: stalledExerciseState, network: { pending: 0, idleMs: 10000 },
} : page;

test("a confirmed loader timeout reloads the same section once, then saves it and continues", async () => {
  const source = fakeSource({ sectionOnOpen: stallSection, sectionReload: () => navigationFixture().lesson(34, "57") });
  const report = await collect(source, { extensionVersion: "0.3.16" });
  assert.equal(report.status, "finished");
  assert.equal(report.diagnostics.extensionVersion, "0.3.16");
  assert.equal(report.diagnostics.failure, undefined);
  assert.equal(source.calls.filter(call => call.type === "NAVIGATE_SOURCE" && call.url === stalledUrl).length, 1);
  assert.equal(source.snapshots.filter(page => page.url === stalledUrl).length, 1);
  const events = report.diagnostics.events.filter(event => event.url === stalledUrl);
  const timeout = events.find(event => event.reason === "section_loading_timeout");
  assert.equal(timeout.stage, "wait_exercises");
  assert.equal(timeout.attempt, 1);
  assert.equal(timeout.lessonId, "34");
  assert.equal(timeout.sectionId, "57");
  assert.ok(timeout.polls > 0);
  assert.ok(timeout.elapsedMs >= 0);
  assert.deepEqual(timeout.exerciseState, stalledExerciseState);
  assert.equal(timeout.network.pending, 0, 'Only a page without active source requests is restarted at the soft deadline');
  assert.ok(events.some(event => event.stage === "reload_section" && event.status === "retrying"));
  assert.ok(events.some(event => event.stage === "wait_exercises" && event.status === "ready" && event.attempt === 2));
  stoppedAndPersisted(source, "finished");
});

test("a section that becomes ready at the guarded recheck continues without a reload", async () => {
  const source = fakeSource({
    sectionOnOpen: stallSection,
    onGuardedNavigation: page => page.url === stalledUrl ? navigationFixture().lesson(34, "57") : page,
  });
  const report = await collect(source);
  assert.equal(report.status, "finished");
  assert.equal(source.calls.some(call => call.type === "NAVIGATE_SOURCE" && call.url === stalledUrl), false);
  assert.ok(report.visited.includes(stalledUrl));
});

test('a timeout while rechecking a stalled section is read again within the same transition', async () => {
  let timedOut = false;
  const source = fakeSource({ sectionOnOpen: stallSection,
    sectionReload: () => navigationFixture().lesson(34, '57'),
    onGuardedNavigation: page => {
      if (page.url === stalledUrl && !timedOut) {
        timedOut = true;
        throw Object.assign(new Error('Вкладка книги не отвечает.'), { code: 'source_timeout' });
      }
      return page;
    },
  });
  const report = await collect(source);
  assert.equal(report.status, 'finished', JSON.stringify(report.failed));
  assert.equal(timedOut, true);
  assert.equal(source.calls.filter(call => call.type === 'NAVIGATE_SOURCE' && call.url === stalledUrl).length, 1);
  assert.ok(report.visited.includes(stalledUrl));
});

test('a browser load beginning during an author-data retry is observed without resetting the budget', async () => {
  let statusReads = 0, stalledReads = 0;
  const source = fakeSource({ sectionOnOpen: stallSection,
    finalNavigation: page => page.url === stalledUrl && ++stalledReads >= 20 ? navigationFixture().lesson(34, '57') : page,
    sourceStatus: () => ++statusReads === 1 ? {} : { state: 'loading', browserLoading: true, canRetry: false },
  });
  const report = await collect(source);
  assert.equal(report.status, 'finished', JSON.stringify(report.failed));
  assert.equal(source.calls.filter(call => call.type === 'RETRY_SOURCE_NAVIGATION').length, 0);
  assert.ok(report.visited.includes(stalledUrl));
});

test("a persistent loader exhausts the shared retry budget without saving a stale list", async () => {
  const source = fakeSource({ sectionOnOpen: stallSection });
  const report = await collect(source);
  assert.equal(report.status, "failed");
  assert.match(report.failed[0].error, /после повторной загрузки/i);
  assert.equal(source.calls.filter(call => call.type === "NAVIGATE_SOURCE" && call.url === stalledUrl).length, 2);
  assert.deepEqual(report.visited, [bookUrl, lessonUrl(34, "56")]);
  assert.deepEqual(report.diagnostics.events.filter(event => event.reason === "section_loading_timeout" && event.polls).map(event => event.attempt), [1, 2, 3]);
  const failure = report.diagnostics.failure;
  assert.equal(failure.stage, "wait_exercises");
  assert.equal(failure.lessonTitle, "Lesson 34");
  assert.equal(failure.sectionTitle, "Section 57");
  assert.equal(failure.url, stalledUrl);
  assert.equal(failure.lastSavedUrl, lessonUrl(34, "56"));
  assert.deepEqual(source.checkpoints.at(-1).diagnostics, report.diagnostics);
});

test("a source URL change during the reload stops before taking a snapshot", async () => {
  const changed = navigationFixture().lesson(34, "for-homework");
  const source = fakeSource({ sectionOnOpen: stallSection, sectionReload: () => changed });
  const report = await collect(source);
  assert.equal(report.status, "failed");
  assert.equal(report.diagnostics.failure.stage, "reload_section");
  assert.equal(report.diagnostics.failure.reason, "source_changed");
  assert.equal(report.diagnostics.failure.url, changed.url);
  assert.equal(report.diagnostics.failure.lastSavedUrl, lessonUrl(34, "56"));
  assert.deepEqual(report.visited, [bookUrl, lessonUrl(34, "56")]);
  assert.equal(source.calls.filter(call => call.type === "NAVIGATE_SOURCE" && call.url === stalledUrl).length, 1);
});

test("a closed source or another fatal navigation error is not retried as a loading timeout", async () => {
  const source = fakeSource({ navigationError: read => read > 1 ? Object.assign(new Error("Вкладка с учебником закрыта. Выберите открытую вкладку."), { code: "source_closed" }) : null });
  const report = await collect(source);
  assert.equal(report.status, "failed");
  assert.match(report.failed[0].error, /Вкладка с учебником закрыта/);
  assert.equal(source.calls.filter(call => call.type === "GET_NAVIGATION").length, 2);
  stoppedAndPersisted(source, "failed");
});

test("an initially unready contents page starts capture before reloading and discovers its lessons", async () => {
  const source = fakeSource({ initialBook: { ...navigationFixture().book(), items: [], ready: false, readinessReason: "Не найдены карточки уроков в содержании учебника." } });
  const report = await collect(source);
  assert.equal(report.status, "finished");
  assert.deepEqual(source.checkpoints[0].items, []);
  assert.equal(report.items.filter(item => item.kind === "lesson" && item.status === "visited").length, 2);
  assert.ok(source.calls.findIndex(call => call.type === "START_CAPTURE") < source.calls.findIndex(call => call.type === "NAVIGATE_SOURCE"));
  stoppedAndPersisted(source, "finished");
});

test("lazy groups are expanded automatically after every return to the contents", async () => {
  const fixture = navigationFixture();
  const collapsed = { ...fixture.book(), collapsed: true, items: [], ready: false, readinessReason: "Раскрываются группы уроков." };
  const openedOnNavigation = [];
  const source = fakeSource({
    initialBook: collapsed,
    bookOnNavigation: () => collapsed,
    prepareBook: (page, navigation) => {
      if (!page.collapsed) return;
      openedOnNavigation.push(navigation);
      return { opened: 2, navigation: fixture.book() };
    },
  });
  const report = await collect(source);
  assert.equal(report.status, "finished");
  assert.deepEqual(openedOnNavigation, [1, 2, 3], "the initial reload and both lesson returns re-expand their groups");
  assert.equal(report.items.filter(item => item.kind === "lesson" && item.status === "visited").length, 2);
  assert.ok(source.calls.findIndex(call => call.type === "BEGIN_COLLECTION") < source.calls.findIndex(call => call.type === "PREPARE_BOOK"));
  assert.ok(source.calls.findIndex(call => call.type === "START_CAPTURE") < source.calls.findIndex(call => call.type === "PREPARE_BOOK"));
  assert.ok(source.calls.filter(call => call.type === "PREPARE_BOOK").every(call => call.expectedUrl === bookUrl));
  stoppedAndPersisted(source, "finished");
});

test("a complete book exceeding ninety pages has no default collection page limit", async () => {
  const lessonIds = Array.from({ length: 44 }, (_, index) => index + 34);
  const source = fakeSource({ lessonIds });
  const report = await collect(source);
  assert.equal(report.status, "finished");
  assert.equal(report.visited.length, 133);
  assert.equal(source.snapshots.length, 133);
  assert.equal(report.items.filter(item => item.kind === "lesson" && item.status === "visited").length, 44);
  assert.equal(report.failed.length, 0);
  stoppedAndPersisted(source, "finished");
});

test('cancellation after opening a source lesson retains only completed snapshots', async () => {
  const controller = new AbortController();
  const source = fakeSource();
  const request = async (type, payload) => {
    const result = await source.request(type, payload);
    if (type === 'OPEN_MATERIAL_ITEM') controller.abort();
    return result;
  };
  const report = await collect(source, { request, signal: controller.signal });
  assert.equal(report.status, 'cancelled');
  assert.deepEqual(report.visited, [bookUrl]);
  assert.equal(source.calls.filter(call => call.type === 'OPEN_MATERIAL_ITEM').length, 1);
  assert.equal(source.snapshots.filter(page => page.kind === 'lesson').length, 0);
  stoppedAndPersisted(source, 'cancelled');
});

test('a late unready observation restarts stability even when its fingerprint is unchanged', async () => {
  let readyReads = 0;
  let unreadyAt = -1;
  const source = fakeSource({ lessonIds: [34] });
  const request = async (type, payload) => {
    const result = await source.request(type, payload);
    if (type === 'GET_NAVIGATION' && result.navigation.kind === 'lesson' &&
        result.navigation.ready && unreadyAt < 0 && ++readyReads === 4) {
      result.navigation = { ...result.navigation, ready: false };
      unreadyAt = source.calls.length - 1;
    }
    return result;
  };
  const report = await collect(source, { request, attempts: 12 });
  assert.equal(report.status, 'finished');
  const savedAfter = source.calls.findIndex((call, index) => index > unreadyAt && call.type === 'TAKE_SNAPSHOT');
  assert.ok(unreadyAt > 0);
  assert.equal(source.calls.slice(unreadyAt + 1, savedAfter).filter(call => call.type === 'GET_NAVIGATION').length, 3,
    'An unready page needs three fresh ready observations before its snapshot');
  stoppedAndPersisted(source, 'finished');
});

test('same-title lessons retain separate source IDs throughout a complete tour', async () => {
  const book = navigationFixture().book();
  book.items = book.items.map((item, index) => ({ ...item, title: 'Test', sourceId: String(34 + index) }));
  const source = fakeSource({ initialBook: book, bookOnNavigation: () => book });
  const report = await collect(source);
  assert.equal(report.status, 'finished');
  const lessons = report.items.filter(item => item.kind === 'lesson');
  assert.deepEqual(lessons.map(item => [item.title, item.lessonId, item.status]), [['Test', '34', 'visited'], ['Test', '35', 'visited']]);
});

test('a card with a known source ID cannot save a different redirected lesson', async () => {
  const book = navigationFixture({ lessonIds: [34] }).book();
  book.items[0].sourceId = '34';
  const source = fakeSource({ initialBook: book, bookOnNavigation: () => book, lessonIds: [34], redirectLessonIds: { 34: 99 } });
  const report = await collect(source, { attempts: 8 });
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.visited, [bookUrl]);
  assert.equal(source.snapshots.length, 1);
});

// Current content scripts attach observed request activity to navigation replies.
function reportingNetwork(source, networkFor) {
  const replies = [], forward = source.request;
  const request = async (type, message) => {
    if (type === "TAKE_SNAPSHOT") source.snapshotNetwork = replies.at(-1);
    const response = await forward(type, message);
    if ((type === "GET_NAVIGATION" || type === "PREPARE_BOOK") && response.navigation) {
      response.navigation.network = networkFor(response.navigation, type);
      replies.push(response.navigation.network);
    }
    return response;
  };
  return Object.assign(source, { request, replies });
}

test("reported quiet network saves a page after two identical polls instead of three", async () => {
  const source = reportingNetwork(fakeSource({ stablePolls: 2 }), () => ({ pending: 0, idleMs: 1000 }));
  const report = await collect(source);
  assert.equal(report.status, "finished");
  assert.equal(source.snapshots.length, 7);
  const legacy = fakeSource();
  await collect(legacy);
  const polls = calls => calls.filter(call => call.type === "GET_NAVIGATION").length;
  assert.ok(polls(source.calls) < polls(legacy.calls), "the network signal shortens every page wait");
});

test("a page is not saved while an observed request is still in flight", async () => {
  let busyReads = 0;
  const base = fakeSource({ stablePolls: 2 });
  const request = base.request;
  base.request = async (type, message) => {
    if (type === "OPEN_MATERIAL_ITEM" || type === "NAVIGATE_SOURCE") busyReads = 5;
    return request(type, message);
  };
  const source = reportingNetwork(base, (_navigation, type) => {
    const busy = busyReads > 0;
    if (type === "GET_NAVIGATION") busyReads--;
    return busy ? { pending: 1, idleMs: 0 } : { pending: 0, idleMs: 1000 };
  });
  const snapshotNetworks = [];
  const take = source.request;
  source.request = async (type, message) => {
    const response = await take(type, message);
    if (type === "TAKE_SNAPSHOT") snapshotNetworks.push(source.snapshotNetwork);
    return response;
  };
  const report = await collect(source);
  assert.equal(report.status, "finished");
  assert.equal(snapshotNetworks.length, 7);
  assert.ok(snapshotNetworks.every(network => network.pending === 0 && network.idleMs >= 500));
  assert.ok(source.replies.some(network => network.pending === 1));
});

test("a request that never finishes is bounded by the grace period instead of stalling the tour", async () => {
  const busy = () => reportingNetwork(fakeSource({ stablePolls: 2 }), () => ({ pending: 1, idleMs: 0 }));
  const stalled = await collect(busy());
  assert.equal(stalled.status, "failed");
  assert.match(stalled.failed.at(-1).error, /получает данные/);
  const graced = await collect(busy(), { pendingGraceMs: 3 });
  assert.equal(graced.status, "finished");
});

test("fast polling does not click a lesson group again before it can open", async () => {
  const fixture = navigationFixture();
  const collapsed = { ...fixture.book(), collapsed: true, items: [], ready: false, readinessReason: "Раскрываются группы уроков." };
  let preparations = 0;
  const source = reportingNetwork(fakeSource({
    initialBook: collapsed, bookOnNavigation: () => collapsed, stablePolls: 2,
    prepareBook: page => {
      if (!page.collapsed) return;
      // The first click applies its open state only after a later poll.
      return ++preparations % 2 ? { opened: 1 } : { opened: 1, navigation: fixture.book() };
    },
  }), () => ({ pending: 0, idleMs: 1000 }));
  const report = await collect(source, { pollMs: 700, fastPollMs: 250 });
  assert.equal(report.status, "finished");
  const types = source.calls.map(call => call.type);
  const prepared = types.flatMap((type, index) => type === "PREPARE_BOOK" ? [index] : []);
  assert.equal(prepared.length, 6);
  for (let pair = 0; pair < prepared.length; pair += 2) {
    const between = types.slice(prepared[pair] + 1, prepared[pair + 1]).filter(type => type === "GET_NAVIGATION").length;
    assert.equal(between, 3, "two fast polls pass before the same contents are prepared again");
  }
});

function reportingRetained(source, retainedAt) {
  const forward = source.request;
  let snapshots = 0;
  source.request = async (type, message) => {
    const response = await forward(type, message);
    return type === "TAKE_SNAPSHOT" ? { ...response, retained: retainedAt(++snapshots) } : response;
  };
  return source;
}

test("snapshot replies replace per-page state reads and one checkpoint records each opened section", async () => {
  const source = reportingRetained(fakeSource(), () => ({ dropped: 0 }));
  const report = await collect(source);
  assert.equal(report.status, "finished");
  assert.equal(source.calls.filter(call => call.type === "GET_STATE").length, 1, "only the final drain reads the stored state");
  assert.equal(source.calls.filter(call => call.type === "SAVE_COLLECTION").length, 15);
  for (const [index, call] of source.calls.entries()) {
    if (call.type !== "TAKE_SNAPSHOT" || !/section\/(?:57|for-homework)$/.test(call.expectedUrl)) continue;
    const checkpoint = source.calls.slice(index).find(next => next.type === "SAVE_COLLECTION").collection;
    const item = checkpoint.items.find(candidate => candidate.url === call.expectedUrl && candidate.kind !== "lesson");
    assert.equal(item?.status, "visited", call.expectedUrl);
  }
});

test("capture losses reported with a snapshot stop the tour at that page", async () => {
  const source = reportingRetained(fakeSource(), count => count >= 3 ? { dropped: 1, warning: "Capture lost." } : { dropped: 0 });
  const report = await collect(source);
  assert.equal(report.status, "failed");
  assert.equal(source.snapshots.length, 3);
  assert.match(report.failed.at(-1).error, /Capture lost\./);
  stoppedAndPersisted(source, "failed");
});
