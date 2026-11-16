import test from "node:test";
import assert from "node:assert/strict";
import { buildCoverage } from "../src/lib/coverage.js";

const origin = "https://progressme.ru";
const material = `${origin}/cabinet/school/materials/book/867169/content`;
const lesson = `${origin}/lesson-editor/book/867169/lesson/34`;
const section = `${lesson}/section/56`;
const homework = `${lesson}/homework/section/57`;
const capture = (pageUrl, data = { exercises: [] }) => ({ kind: "fetch", url: `${origin}/api/materials`, pageUrl, data });

test("coverage distinguishes listed routes, retained snapshots and page-associated JSON", () => {
  const result = buildCoverage({
    snapshots: [
      { url: material, links: [{ href: lesson }, { url: section }, { url: homework }] },
      { url: section },
    ],
    captures: [capture(section), capture(section, { exercises: [{ answer_key: "yes" }] }), capture(undefined)],
  });
  assert.deepEqual(result.counts, {
    routes: 4, listedRoutes: 3, capturedRoutes: 2, missingRoutes: 1, resolvedRoutes: 1, visitedRoutes: 2, failedRoutes: 0,
    jsonResponses: 3, associatedJsonResponses: 2, unassociatedJsonResponses: 1,
    routesWithJson: 1, routesWithoutJson: 3, navigationItems: 0, unvisitedItems: 0, droppedRecords: 0,
  });
  const route = (url) => result.routes.find((item) => item.url === url);
  assert.equal(route(material).kind, "material");
  assert.equal(route(lesson).kind, "lesson");
  assert.equal(route(lesson).captured, false);
  assert.equal(route(lesson).requiresSnapshot, false);
  assert.deepEqual(route(lesson).resolvedBy, [section]);
  assert.equal(route(section).kind, "section");
  assert.equal(route(section).materialId, "867169");
  assert.equal(route(section).lessonId, "34");
  assert.equal(route(section).sectionId, "56");
  assert.equal(route(section).jsonCount, 2);
  assert.equal(route(homework).kind, "homework");
  assert.equal(route(homework).captured, false);
  assert.equal(route(homework).warnings.length, 2);
  assert.equal(result.status, "partial");
  assert.equal(result.editableConversion, false);
  assert.equal(result.answerKeysVerified, false);
  assert.equal(result.sourceEnumerationComplete, false);
});

test("a finished crawler cannot turn visited pages or JSON into retained snapshots or a complete export", () => {
  const result = buildCoverage({
    snapshots: [{ url: material }, { url: section }],
    captures: [capture(section)],
    dropped: 7,
    collection: { rootUrl: material, status: "complete", expected: [material, section, homework], visited: [material, section, homework], failed: [{ url: homework, error: "private error data" }] },
  });
  const missing = result.routes.find((route) => route.url === homework);
  assert.equal(missing.visited, true);
  assert.equal(missing.captured, false);
  assert.equal(missing.failed, true);
  assert.equal(result.counts.missingRoutes, 1);
  assert.equal(result.counts.droppedRecords, 7);
  assert.equal(result.counts.failedRoutes, 1);
  assert.equal(result.status, "partial");
  assert.equal(result.sourceEnumerationComplete, false);
  assert.ok(result.warnings.some((warning) => warning.includes("отброшено записей: 7")));
  assert.ok(!JSON.stringify(result).includes("private error data"));
});

test("endpoint URLs do not prove page coverage and old captures stay unassociated", () => {
  const result = buildCoverage({
    snapshots: [{ url: section }],
    captures: [
      { kind: "xhr", url: section, data: { sections: [] } },
      capture("https://other.example/lesson-editor/book/867169/lesson/34"),
      { kind: "websocket", url: "wss://progressme.ru/socket", pageUrl: homework, data: { homework: [] } },
      { kind: "fetch", pageUrl: section, data: null },
      { kind: "unsupported", pageUrl: section, data: {} },
    ],
  });
  assert.equal(result.counts.jsonResponses, 3);
  assert.equal(result.counts.associatedJsonResponses, 1);
  assert.equal(result.counts.unassociatedJsonResponses, 2);
  assert.equal(result.routes.find((route) => route.url === section).jsonCount, 0);
  assert.equal(result.routes.find((route) => route.url === homework).captured, false);
  assert.ok(result.warnings.some((warning) => warning.includes("без подтверждённой страницы: 2")));
});

test("coverage canonicalizes credentials and duplicate links without merging homework query views", () => {
  const page = `${section}?tab=homework`;
  const result = buildCoverage({
    snapshots: [{ url: material, links: [
      { url: `${section}/?token=secret#fragment` },
      { href: section },
      { href: page },
      { href: "https://progressme.ru.evil.example/lesson-editor/book/867169/lesson/34" },
      { href: "https://progressme.ru/account/profile" },
      { href: "javascript:alert(1)" },
    ] }, { url: `${section}?auth=hidden` }, { url: page }],
    captures: [capture(`${page}&token=private`)],
    collection: { expected: [section, { url: page }], visited: [page], failed: [{ url: section }] },
  });
  assert.equal(result.counts.routes, 3);
  assert.equal(result.counts.listedRoutes, 2);
  assert.equal(result.counts.capturedRoutes, 3);
  assert.equal(result.routes.find((route) => route.url === page).kind, "homework");
  assert.equal(result.routes.find((route) => route.url === page).jsonCount, 1);
  assert.equal(result.routes.find((route) => route.url === section).failed, true);
  const serialized = JSON.stringify(result);
  for (const secret of ["secret", "hidden", "private", "evil.example", "javascript:"]) assert.ok(!serialized.includes(secret));
});

test("empty and stopped collections warn honestly and leave caller data untouched", () => {
  const empty = buildCoverage();
  assert.equal(empty.status, "empty");
  assert.equal(empty.counts.routes, 0);
  assert.ok(empty.warnings.some((warning) => warning.includes("JSON-ответы учебных материалов не сохранены")));
  const input = {
    snapshots: [{ url: section, route: { kind: "homework" }, materialLinks: [{ href: "/cabinet/school/materials/book/867169/content" }] }],
    collection: { rootUrl: material, status: "cancelled", expected: [section] },
    dropped: -1,
  };
  const before = structuredClone(input);
  const result = buildCoverage(input);
  assert.deepEqual(input, before);
  assert.equal(result.routes.find((route) => route.url === section).kind, "homework");
  assert.equal(result.counts.droppedRecords, 0);
  assert.ok(result.warnings.some((warning) => warning.includes("остановлен до завершения")));
  assert.throws(() => buildCoverage({ captures: {} }), TypeError);
});

test("the source's for-homework route is reported as homework rather than an ordinary section", () => {
  const url = `${lesson}/section/for-homework`;
  const result = buildCoverage({ snapshots: [{ url, route: { kind: "lesson" } }] });
  assert.equal(result.routes[0].kind, "homework");
  assert.equal(result.routes[0].lessonId, "34");
  assert.equal(result.routes[0].sectionId, "for-homework");
});

test("unvisited navigation items without URLs are reported separately from missing route snapshots", () => {
  const result = buildCoverage({
    snapshots: [{ url: material }],
    collection: {
      rootUrl: material,
      status: "running",
      items: [
        { key: "lesson-1", kind: "lesson", status: "visited", url: section },
        { key: "lesson-2", kind: "lesson", status: "pending" },
        { key: "section-2", kind: "section", status: "running" },
        { key: "homework-2", kind: "homework", status: "failed" },
        { key: "section-3", kind: "section", status: "cancelled" },
      ],
    },
  });
  assert.equal(result.counts.navigationItems, 5);
  assert.equal(result.counts.unvisitedItems, 4);
  assert.equal(result.counts.routes, 1, "item statuses must not manufacture route or snapshot evidence");
  assert.equal(result.counts.missingRoutes, 0);
  assert.ok(result.warnings.some((warning) => warning.includes("без завершённого посещения: 4")));
  assert.ok(result.warnings.some((warning) => warning.includes("Обход ещё не завершён")));
  assert.equal(result.sourceEnumerationComplete, false);
});

test("finished navigation does not hide pending items or invent missing routes", () => {
  const result = buildCoverage({ collection: {
    status: "finished",
    items: [{ key: "a", status: "visited" }, { key: "b", status: "pending" }, { key: "c" }],
  } });
  assert.equal(result.counts.navigationItems, 3);
  assert.equal(result.counts.unvisitedItems, 2);
  assert.equal(result.counts.routes, 0);
  assert.ok(result.warnings.some((warning) => warning.includes("без завершённого посещения: 2")));
  assert.equal(result.status, "empty");
  assert.equal(result.sourceEnumerationComplete, false);
});

test("three transitional lesson metadata addresses do not invent three missing content pages", () => {
  const snapshots = [];
  const captures = [];
  const wrappers = [];
  for (let id = 1; id <= 3; id++) {
    const base = `${origin}/lesson-editor/book/867169/lesson/${id}`;
    wrappers.push(`${base}/section`);
    captures.push(capture(`${base}/section`, { Class: "LessonWsController", Method: "GetLessonWithId", IsSuccess: true }));
    for (let sectionId = 1; sectionId <= 9; sectionId++) snapshots.push({ url: `${base}/section/${sectionId}` });
  }
  const result = buildCoverage({ snapshots, captures });
  assert.equal(result.counts.routes, 30);
  assert.equal(result.counts.capturedRoutes, 27);
  assert.equal(result.counts.missingRoutes, 0);
  assert.equal(result.counts.resolvedRoutes, 3);
  for (const url of wrappers) {
    const wrapper = result.routes.find(route => route.url === url);
    assert.equal(wrapper.captured, false);
    assert.equal(wrapper.visited, false);
    assert.equal(wrapper.jsonCount, 1);
    assert.equal(wrapper.resolvedBy.length, 9);
    assert.ok(!wrapper.warnings.some(warning => warning.includes("Снимок этой страницы отсутствует")));
  }
  assert.ok(result.routes.filter(route => route.captured).every(route => route.jsonCount === 0), "Metadata must not become section response evidence");
  assert.ok(!result.warnings.some(warning => warning.includes("Нет снимков")));
});

test("lesson wrappers remain missing without a retained exact section of that origin, book and lesson", () => {
  for (const other of [null, section.replace(origin, 'https://platform.desharschool.ru'),
    section.replace('/book/867169/', '/book/999/'), section.replace('/lesson/34/', '/lesson/999/'),
    `${section}/unknown`, `${section}?view=other`]) {
    const result = buildCoverage({ snapshots: other ? [{ url: other }] : [], captures: [capture(`${lesson}/section`)] });
    const wrapper = result.routes.find(route => route.url === `${lesson}/section`);
    assert.equal(wrapper.requiresSnapshot, true, String(other));
    assert.equal(wrapper.resolvedBy, undefined);
    assert.equal(result.counts.missingRoutes, 1);
  }
});

test("resolved wrappers never hide missing sections, homework, query views or failed transitions", () => {
  const missingSection = `${lesson}/section/99`;
  const missingHomework = `${lesson}/section/for-homework`;
  const queryView = `${lesson}/section?tab=overview`;
  const failedWrapper = `${lesson}/section`;
  const result = buildCoverage({
    snapshots: [{ url: section, links: [lesson, missingSection, missingHomework, queryView] }],
    captures: [capture(failedWrapper)], collection: { failed: [failedWrapper] },
  });
  assert.equal(result.counts.resolvedRoutes, 1);
  assert.equal(result.routes.find(route => route.url === lesson).requiresSnapshot, false);
  for (const url of [missingSection, missingHomework, queryView, failedWrapper]) {
    const item = result.routes.find(route => route.url === url);
    assert.equal(item.requiresSnapshot, true, url);
    assert.equal(item.captured, false, url);
  }
  assert.equal(result.counts.missingRoutes, 4);
  assert.equal(result.counts.failedRoutes, 1);
});


test("retired collection route aliases never supply current coverage inputs", () => {
  const url = "https://progressme.ru/lesson-editor/book/1/lesson/2/section/3";
  const result = buildCoverage({ collection: { expectedRoutes: [url], visitedRoutes: [url], failedRoutes: [url] } });
  assert.equal(result.routes.length, 0);
  assert.equal(result.counts.visitedRoutes, 0);
  assert.equal(result.counts.failedRoutes, 0);
});
