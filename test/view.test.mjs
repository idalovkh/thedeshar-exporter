import test from "node:test";
import assert from "node:assert/strict";
import { getView } from "../src/ui/view.js";

const book = "https://progressme.ru/cabinet/school/materials/book/867169/content";
const lesson = "https://progressme.ru/lesson-editor/book/867169/lesson/34/section/56";
const ready = { sourceAvailable: true, source: { url: book } };
const saved = { snapshots: [{ url: book }], captures: [] };
function completedState() {
  return {
    snapshots: [{ url: book }, { url: lesson }], captures: [], dropped: 0,
    collection: { status: "finished", rootUrl: book, expected: [book, lesson], visited: [book, lesson], failed: [], items: [{ kind: "lesson", title: "Урок", url: lesson, status: "visited" }] },
  };
}
function assertNeedsCompletion(result) {
  assert.equal(result.canExport, false);
  assert.doesNotMatch(result.description, /можно скачать|доступн\S* для скачивания|скачайте уже|скачать сейчас/i);
}

test("a book content URL can start collection including query and hash", () => {
  for (const url of [book, `${book}/`, `${book}?view=all#lessons`]) {
    const result = getView({ sourceAvailable: true, source: { url } });
    assert.equal(result.mode, "ready"); assert.equal(result.canCollect, true); assert.equal(result.canExport, false);
    assert.equal(result.hasData, false); assert.equal(result.collectLabel, "Собрать книгу");
  }
});

test("lesson pages and invalid URLs cannot start the automatic book collection", () => {
  for (const url of ["https://progressme.ru/lesson-editor/book/867169/lesson/34", `${book}/extra`, "not a URL"]) {
    const result = getView({ sourceAvailable: true, source: { url } });
    assert.equal(result.mode, "lesson"); assert.equal(result.canCollect, false); assert.equal(result.canExport, false);
  }
  assert.equal(getView().mode, "unavailable");
});

test("collection state takes priority over capture mode and counts only lessons", () => {
  const result = getView({ ...ready, collecting: true, state: { enabled: true, collection: { status: "running", items: [
    { kind: "lesson", title: "Первый урок", status: "visited" }, { kind: "lesson", title: "Второй урок", status: "running" },
    { kind: "section", title: "Раздел", status: "visited" }, { kind: "homework", title: "Домашнее задание", status: "pending" },
  ] } } });
  assert.equal(result.mode, "collecting"); assert.equal(result.canCollect, false); assert.equal(result.canExport, false);
  assert.equal(result.lessonsDone, 1); assert.equal(result.lessonsTotal, 2); assert.equal(result.currentLesson, "Второй урок");
  assert.match(result.description, /Собрано уроков: 1 из 2/); assert.match(result.description, /Сейчас: Второй урок/);
});

test("collection preparation does not invent a total before lessons are discovered", () => {
  const result = getView({ ...ready, collecting: true });
  assert.equal(result.lessonsDone, 0); assert.equal(result.lessonsTotal, 0); assert.equal(result.currentLesson, "");
  assert.match(result.description, /Оставьте обе вкладки открытыми/); assert.doesNotMatch(result.description, /0 из 0|100%/);
});

test("a persisted running collection waits for completion without advertising a partial download", () => {
  const result = getView({ ...ready, state: { ...saved, enabled: true, collection: { status: "running" } } });
  assert.equal(result.mode, "partial"); assert.equal(result.hasData, true); assert.match(result.description, /другой вкладке/);
  assert.match(result.description, /материалы сохранены/); assert.doesNotMatch(result.description, /окно.*закрыт/i); assertNeedsCompletion(result);
});

test("legacy active capture directs teachers to complete a book collection before downloading", () => {
  const result = getView({ ...ready, state: { enabled: true } });
  assert.equal(result.mode, "manual"); assert.equal(result.statusLabel, "Книга");
  assert.match(result.description, /откройте содержание книги/); assert.match(result.description, /дождитесь завершения/);
  assert.doesNotMatch(result.description, /ручн|Обновите|Сохранить страницу/); assertNeedsCompletion(result);
});

test("completed retained collection allows export without promising exhaustive source verification", () => {
  const result = getView({ ...ready, state: completedState() });
  assert.equal(result.mode, "finished"); assert.equal(result.title, "Сбор завершён"); assert.equal(result.canExport, true);
  assert.equal(result.hasData, true); assert.equal(result.collectLabel, "Собрать заново");
  assert.doesNotMatch(result.description, /полност|все упражнения|правильные ответы|100%/);
});

test("a complete retained book remains downloadable after its source tab closes", () => {
  const result = getView({ sourceAvailable: false, state: completedState() });
  assert.equal(result.mode, "finished"); assert.equal(result.canExport, true); assert.equal(result.canCollect, false);
  assert.match(result.description, /Скачайте архив/); assert.match(result.description, /Для нового сбора/);
});

test("stopped, failed and cancelled collections preserve data but require recollection", () => {
  for (const status of ["cancelled", "canceled", "stopped", "failed", "interrupted", "limit"]) {
    const state = { ...saved, collection: { status } }, before = structuredClone(state);
    const result = getView({ ...ready, state });
    assert.equal(result.mode, "partial"); assert.equal(result.hasData, true); assert.equal(result.canCollect, true);
    assert.match(result.description, /материалы сохранены/); assert.match(result.description, /повторите сбор до завершения/);
    assertNeedsCompletion(result); assert.deepEqual(state, before);
  }
  const empty = getView({ ...ready, state: { collection: { status: "failed" } } });
  assert.equal(empty.hasData, false); assert.match(empty.description, /ещё не сохранены/); assertNeedsCompletion(empty);
});

test("captured answers alone cannot be exported when the source is closed", () => {
  const result = getView({ sourceAvailable: false, state: { captures: [{ data: { exercises: [] } }] } });
  assert.equal(result.mode, "partial"); assert.equal(result.hasData, true); assert.equal(result.canCollect, false);
  assert.match(result.description, /данные сохранены/); assert.match(result.description, /повторите сбор до завершения/); assertNeedsCompletion(result);
});

test("finished reports with known missing, unvisited, failed or dropped data use the partial view", () => {
  const missingSnapshot = completedState(); missingSnapshot.snapshots.pop();
  const failed = completedState(); failed.collection.failed.push({ url: lesson, error: "Источник недоступен" });
  const unvisited = completedState(); unvisited.collection.items[0].status = "pending";
  const dropped = completedState(); dropped.dropped = 1;
  const missingExpected = completedState(); missingExpected.collection.expected.push(`${lesson}/other`);
  for (const state of [missingSnapshot, failed, unvisited, dropped, missingExpected]) {
    const before = structuredClone(state), result = getView({ ...ready, state });
    assert.equal(result.mode, "partial"); assert.equal(result.statusLabel, "Сбор не завершён");
    assert.match(result.description, /пропуски/); assert.match(result.description, /повторите сбор до завершения/);
    assertNeedsCompletion(result); assert.deepEqual(state, before);
  }
});

test("download, collection and other busy operations cannot launch a second export", () => {
  const state = completedState();
  const downloading = getView({ ...ready, downloading: true, state });
  assert.equal(downloading.mode, "downloading"); assert.equal(downloading.canCollect, false); assert.equal(downloading.canExport, false);
  assert.equal(getView({ ...ready, collecting: true, state }).canExport, false);
  assert.equal(getView({ ...ready, busy: true, state }).canCollect, false); assert.equal(getView({ ...ready, busy: true, state }).canExport, false);
  assert.equal(getView({ ...ready, state: { ...state, enabled: true } }).canExport, false);
});

test("saved manual pages require a completed book traversal", () => {
  const result = getView({ ...ready, state: saved });
  assert.equal(result.mode, "partial"); assert.equal(result.hasData, true); assert.equal(result.lessonsTotal, 0);
  assert.equal(result.lessonsDone, 0); assert.equal(result.currentLesson, ""); assert.match(result.description, /нужен завершённый сбор/); assertNeedsCompletion(result);
});

test("teacher-facing copy avoids hidden settings or technical source instructions", () => {
  const states = [{}, ready, { ...ready, state: saved }, { ...ready, state: { enabled: true } },
    { ...ready, source: { url: "https://progressme.ru/lesson-editor/book/867169/lesson/34" } },
    { ...ready, collecting: true }, { ...ready, downloading: true }, { ...ready, state: completedState() },
    ...["running", "finished", "cancelled", "failed"].map((status) => ({ ...ready, state: { ...saved, collection: { status } } }))];
  for (const input of states) {
    const result = getView(input), copy = `${result.title} ${result.description} ${result.statusLabel} ${result.collectLabel}`;
    assert.doesNotMatch(copy, /ручн|раскро|настройк|JSON|cookies|захват|Сохранить страницу/i);
  }
});

test("compact summary metadata and generic coverage cautions do not turn a complete crawl into a partial view", () => {
  const state = completedState();
  state.exportRevision = 7;
  state.captures = [{ kind: "websocket", pageUrl: lesson, url: "wss://proxy.progressme.ru/websocket", data: true }];
  state.warnings = ["Проверены только обнаруженные ссылки и сохранённые страницы."];
  state.collection.warnings = ["Полный состав исходной платформы не подтверждён."];
  const result = getView({ ...ready, state });
  assert.equal(result.mode, "finished"); assert.equal(result.canExport, true);
  assert.doesNotMatch(result.description, /все упражнения|100%/);
});

test("a collection locked by another window cannot offer a finished archive", () => {
  const result = getView({ ...ready, state: { ...completedState(), collectionLocked: true } });
  assert.equal(result.mode, "partial"); assertNeedsCompletion(result);
});
