import test from "node:test";
import assert from "node:assert/strict";
import { createExportPackage, replacePackageAssets, MAX_ASSETS } from "../src/lib/package.js";
import { buildZipBlob } from "../src/lib/archive.js";
import { collectAssets } from "../src/ui/assets.js";
import { assertExportFilesReady } from "../src/lib/export-readiness.js";

test("book archives exclude local collection diagnostics", () => {
  const rootUrl = "https://progressme.ru/cabinet/school/materials/book/71/content";
  const diagnostics = { version: 1, events: [{ stage: "book" }] };
  const collection = { rootUrl, status: "finished", diagnostics };
  const { entries } = createExportPackage({ collection });
  assert.deepEqual(JSON.parse(entries.find(entry => entry.name === "collection.json").data), { rootUrl, status: "finished" });
  assert.equal(collection.diagnostics, diagnostics);
  assert.ok(entries.every(entry => !String(entry.data).includes('diagnostics')));
});

test("book cover is linked through its source URL to one packaged binary and survives asset replacement", () => {
  const url = 'https://progressme.ru/cabinet/school/materials/book/71/content';
  const coverUrl = 'https://cdn.example.org/cover.jpg';
  const snapshots = [{ url, title: 'Book', coverUrl }];
  const assets = collectAssets(snapshots).map(asset => ({ ...asset, status: 'downloaded', data: new Uint8Array([255, 216, 255]) }));
  assert.doesNotThrow(() => assertExportFilesReady(assets, collectAssets(snapshots)));
  const prepared = createExportPackage({ snapshots, assets });
  assert.equal(prepared.manifest.schemaVersion, 1);
  assert.equal(prepared.manifest.inventory.hierarchy.materials[0].coverUrl, coverUrl);
  assert.equal(prepared.manifest.inventory.assets[0].url, coverUrl);
  assert.equal(prepared.entries.filter(entry => entry.name.startsWith('media/')).length, 1);
  const replaced = replacePackageAssets(prepared, assets);
  assert.equal(replaced.manifest.inventory.hierarchy.materials[0].coverUrl, coverUrl);
  assert.ok(replaced.entries.some(entry => entry.name === replaced.manifest.inventory.assets[0].file));
});

test("hierarchy accepts cover only from the matching retained source book contents page", () => {
  const url = 'https://progressme.ru/cabinet/school/materials/book/71/content';
  const lesson = 'https://progressme.ru/lesson-editor/book/71/lesson/12/section/24';
  const coverUrl = 'https://cdn.example.org/right.jpg';
  const first = { url: lesson, title: 'Section' };
  for (const snapshot of [
    { url: lesson, coverUrl },
    { url, coverUrl, route: { materialId: '72' } },
    { url: url.replace('progressme.ru', 'platform.desharschool.ru'), coverUrl },
    { url, coverUrl: 'https://127.0.0.1/private.jpg' },
  ]) {
    const { manifest } = createExportPackage({ snapshots: [first, snapshot] });
    assert.equal(manifest.inventory.hierarchy.materials[0].coverUrl, undefined);
  }
  const { manifest } = createExportPackage({ snapshots: [first,
    { url: url.replace('/71/', '/72/'), coverUrl: 'https://cdn.example.org/other.jpg' },
    { url, coverUrl: coverUrl + '?token=cover-secret' },
  ] });
  assert.equal(manifest.inventory.hierarchy.materials[0].coverUrl, coverUrl);
  assert.equal(manifest.inventory.hierarchy.materials[1].coverUrl, 'https://cdn.example.org/other.jpg');
  assert.doesNotMatch(JSON.stringify(manifest), /cover-secret/);
});

test("old snapshots without cover metadata keep their original hierarchy", () => {
  const { manifest } = createExportPackage({ snapshots: [{ url: 'https://progressme.ru/cabinet/school/materials/book/71/content', title: 'Old book' }] });
  assert.deepEqual(manifest.inventory.hierarchy.materials, [{ externalId: '71', sourceUrl: 'https://progressme.ru/cabinet/school/materials/book/71/content', title: 'Old book' }]);
});

test("media filenames with literal and encoded percent signs remain valid importer paths", async () => {
  const { manifest, entries } = createExportPackage({ assets: [
    { name: "100% listening.mp3", url: "https://cdn.example.org/a.mp3", data: new Uint8Array([1]) },
    { name: "100%25 listening.mp3", url: "https://cdn.example.org/b.mp3", data: new Uint8Array([2]) },
    { name: "%252e%252e%252ftask.pdf", url: "https://cdn.example.org/c.pdf", data: new Uint8Array([3]) },
  ] });
  assert.equal(manifest.inventory.assets[0].file, "media/00001-100_ listening.mp3");
  assert.equal(manifest.inventory.assets[1].file, "media/00002-100_ listening.mp3");
  for (const asset of manifest.inventory.assets) {
    assert.equal(decodeURIComponent(asset.file), asset.file);
    assert.ok(!asset.file.includes("%"));
    assert.ok(entries.some(entry => entry.name === asset.file));
  }
  assert.ok((await buildZipBlob(entries)).size > 0);
});

test("package media capacity matches the importer including reference-only entries and never truncates", () => {
  const assets = Array.from({ length: MAX_ASSETS }, (_, index) => ({ url: `https://cdn.example.org/${index}.png`, status: "skipped" }));
  const { manifest } = createExportPackage({ assets });
  assert.equal(manifest.inventory.assets.length, MAX_ASSETS);
  const overflow = [...assets, { url: "https://cdn.example.org/overflow.png" }];
  assert.throws(() => createExportPackage({ assets: overflow }), new RegExp(`${MAX_ASSETS + 1}.*${MAX_ASSETS}`));
  assert.throws(() => createExportPackage({ assets: overflow.map(asset => ({ ...asset, data: new Uint8Array([1]) })) }), new RegExp(`${MAX_ASSETS + 1}.*${MAX_ASSETS}`));
  assert.equal(overflow.length, MAX_ASSETS + 1, "Refusing the archive preserves all caller records");
});

test("capture package preserves raw author answer keys, hierarchy and binary media without claiming conversion", async () => {
  const original = { type: "test", content: { question: "Hello?" }, answer_key: { correct: "A" } };
  const { manifest, entries } = createExportPackage({
    exportedAt: "2026-10-19T12:00:00.000Z",
    warnings: ["Stopped after 100 pages"],
    dropped: 2,
    source: { platform: "progressme", origin: "https://platform.desharschool.ru" },
    snapshots: [{
      url: "https://platform.desharschool.ru/lesson-editor/book/12/lesson/34/section/56",
      title: "Unit one",
      links: [{ href: "/lesson-editor/book/12/lesson/35/section", text: "Next lesson" }],
      blocks: [{ text: "Hello" }],
    }],
    captures: [{ kind: "fetch", url: "https://platform.desharschool.ru/api/lesson/34", data: { blocks: [original] } }],
    assets: [{ id: "audio-one", url: "https://cdn.example.org/one.mp3", name: "one.mp3", mimeType: "audio/mpeg", data: new Uint8Array([0, 128, 255]) }, { url: "https://cdn.example.org/missing.pdf", status: "failed", error: "Unavailable" }],
  });
  assert.equal(manifest.format, "thedeshar-material-capture");
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.completeness.status, "partial");
  assert.equal(manifest.completeness.representation, "raw-capture");
  assert.equal(manifest.completeness.editableConversion, false);
  assert.equal(manifest.completeness.answerKeysVerified, false);
  assert.equal(manifest.counts.pages, 1);
  assert.equal(manifest.counts.downloadedAssets, 1);
  assert.equal(manifest.completeness.missingAssets, 1);
  assert.deepEqual(manifest.completeness.warnings, ["Stopped after 100 pages"]);
  assert.equal(manifest.completeness.droppedRecords, 2);
  assert.deepEqual(manifest.inventory.hierarchy.lessons.map((lesson) => lesson.externalId), ["34", "35"]);
  assert.equal(manifest.inventory.hierarchy.sections[0].externalId, "56");
  assert.equal(JSON.parse(entries.find((entry) => entry.name === "originals/responses/00001.json").data).data.blocks[0].answer_key.correct, "A");
  assert.deepEqual(entries.find((entry) => entry.name === "media/00001-one.mp3").data, new Uint8Array([0, 128, 255]));
  assert.ok((await buildZipBlob(entries)).size > 0);
});

test("all JSON entries and manifest scrub original signed URLs, personal data and credentials", () => {
  const signed = "https://cdn.example.org/one.mp3?token=download-secret&X-Amz-Signature=signature-secret";
  const { manifest, entries } = createExportPackage({
    source: { origin: "https://school.example.org", token: "source-secret", account: { email: "private@example.org" } },
    snapshots: [{ url: "https://school.example.org/lesson/1?auth=page-secret", html: `<audio src="${signed}"></audio>`, cookies: "cookie-secret" }],
    captures: [{ kind: "fetch", url: "https://school.example.org/lesson/1?token=request-secret", data: { headers: { Authorization: "header-secret" }, blocks: [{ image: signed, answer_key: { correct: true } }], students: [{ firstName: "private-name" }] } }],
    assets: [{ url: signed, downloadUrl: signed, name: "one.mp3", error: `Download failed: ${signed}` }],
  });
  const serialized = JSON.stringify(manifest) + entries.filter((entry) => typeof entry.data === "string").map((entry) => entry.data).join("\n");
  for (const secret of ["download-secret", "signature-secret", "source-secret", "private@example.org", "page-secret", "cookie-secret", "request-secret", "header-secret", "private-name"]) assert.ok(!serialized.includes(secret), secret);
  assert.equal(manifest.inventory.assets[0].url, "https://cdn.example.org/one.mp3");
  assert.equal(manifest.inventory.assets[0].file, null);
  assert.equal(manifest.completeness.answerKeysVerified, false);
});

test("archives include coverage and incomplete navigation without claiming native import readiness", () => {
  const url = 'https://progressme.ru/lesson-editor/book/867169/lesson/13794943/section/for-homework';
  const { manifest, entries } = createExportPackage({
    snapshots: [{ url, title: 'Homework', blocks: [] }],
    captures: [{ kind: 'websocket', url: 'wss://proxy.progressme.ru/ws', pageUrl: url, data: { exercises: [] } }],
    collection: { rootUrl: 'https://progressme.ru/cabinet/school/materials/book/867169/content?token=secret', status: 'cancelled', visited: [url], items: [{ title: 'Unvisited lesson', kind: 'lesson', status: 'pending' }] },
  });
  assert.equal(manifest.reports.coverage, 'coverage.json');
  assert.equal(manifest.reports.collection, 'collection.json');
  const coverage = JSON.parse(entries.find(entry => entry.name === 'coverage.json').data);
  const collection = JSON.parse(entries.find(entry => entry.name === 'collection.json').data);
  assert.equal(coverage.routes.find(route => route.url === url).kind, 'homework');
  assert.equal(coverage.routes.find(route => route.url === url).jsonCount, 1);
  assert.equal(coverage.counts.unvisitedItems, 1);
  assert.ok(!collection.rootUrl.includes('secret'));
  assert.equal(manifest.inventory.responses[0].pageUrl, url);
  assert.equal(manifest.completeness.sourceEnumerationComplete, false);
  assert.equal(manifest.completeness.answerKeysVerified, false);
});

test("collection metadata distinguishes the book, lesson and section names without adding uncaptured pages", () => {
  const rootUrl = "https://progressme.ru/cabinet/school/materials/book/867169/content";
  const url = "https://progressme.ru/lesson-editor/book/867169/lesson/13794943/section/67546487";
  const unvisitedUrl = "https://progressme.ru/lesson-editor/book/867169/lesson/13794944/section/67546488";
  const { manifest } = createExportPackage({
    snapshots: [{ url, title: "Starting point", blocks: [] }],
    collection: { rootUrl, title: "  Starter\nPack  ", status: "failed", items: [
      { kind: "lesson", lessonId: "13794943", url, title: "1. First impressions", status: "failed" },
      { kind: "section", lessonId: "13794943", url, title: "Starting point", status: "visited" },
      { kind: "lesson", lessonId: "13794944", url: unvisitedUrl, title: "2. Unvisited lesson", status: "pending" },
    ] },
  });
  const { materials, lessons, sections } = manifest.inventory.hierarchy;
  assert.equal(materials[0].title, "Starter Pack");
  assert.equal(lessons[0].title, "1. First impressions");
  assert.equal(lessons[0].materialId, "867169");
  assert.equal(sections[0].title, "Starting point");
  assert.equal(sections[0].lessonId, "13794943");
  assert.equal(lessons.length, 1);
  assert.equal(manifest.counts.pages, 1);
  assert.equal(manifest.completeness.status, "partial");
  assert.equal(manifest.completeness.sourceEnumerationComplete, false);
});

test("collection names cannot overwrite an existing hierarchy from another book, origin or inconsistent lesson ID", () => {
  const rootUrl = "https://progressme.ru/cabinet/school/materials/book/867169/content";
  const url = "https://progressme.ru/lesson-editor/book/867169/lesson/13794943/section/67546487";
  const snapshots = [{ url: rootUrl, title: "Original book", blocks: [] }, { url, title: "Starting point", blocks: [] }];
  const wrongReports = [
    { rootUrl: rootUrl.replace("867169", "867170"), title: "Wrong book", items: [{ kind: "lesson", lessonId: "13794943", title: "Wrong lesson" }] },
    { rootUrl: rootUrl.replace("progressme.ru", "platform.desharschool.ru"), title: "Wrong book", items: [{ kind: "lesson", lessonId: "13794943", title: "Wrong lesson" }] },
    { rootUrl, items: [{ kind: "lesson", lessonId: "13794943", url: url.replace("867169", "867170"), title: "Wrong lesson" }] },
    { rootUrl, items: [{ kind: "lesson", lessonId: "13794944", url, title: "Wrong lesson" }] },
    { rootUrl, items: [{ kind: "lesson", key: "867169/13794943", title: "Wrong lesson" }] },
  ];
  for (const report of wrongReports) {
    const { manifest } = createExportPackage({ snapshots, collection: { status: "finished", ...report } });
    assert.equal(manifest.inventory.hierarchy.materials[0].title, "Original book");
    assert.equal(manifest.inventory.hierarchy.lessons[0].title, "Starting point");
    assert.equal(manifest.inventory.hierarchy.sections[0].title, "");
    assert.equal(manifest.counts.pages, 2);
  }
});

test("a numeric reported lesson ID may refine a captured lesson without deriving IDs from navigation keys", () => {
  const url = "https://progressme.ru/lesson-editor/book/867169/lesson/13794943/section/67546487";
  const { manifest } = createExportPackage({
    snapshots: [{ url, title: "Starting point", blocks: [] }],
    collection: { rootUrl: "https://progressme.ru/cabinet/school/materials/book/867169/content", items: [
      { kind: "lesson", lessonId: "13794943", title: "1. First impressions" },
      { kind: "section", lessonId: "13794943", key: "867169/13794943/67546487", title: "No route means no section mapping" },
    ] },
  });
  assert.equal(manifest.inventory.hierarchy.lessons[0].title, "1. First impressions");
  assert.equal(manifest.inventory.hierarchy.sections[0].title, "");
});


test("homework keeps a separate hierarchy entry for each lesson", () => {
  const rootUrl = "https://progressme.ru/cabinet/school/materials/book/867169/content";
  const homework = id => `https://progressme.ru/lesson-editor/book/867169/lesson/${id}/section/for-homework`;
  const { manifest } = createExportPackage({
    snapshots: [
      { url: homework(11), title: "First homework", blocks: [] },
      { url: homework(22), title: "Second homework", blocks: [] },
    ], collection: { rootUrl, items: [
      { kind: "homework", lessonId: "11", url: homework(11), title: "Homework A" },
      { kind: "homework", lessonId: "22", url: homework(22), title: "Homework B" },
    ] },
  });
  assert.deepEqual(manifest.inventory.hierarchy.sections.map(section => [section.externalId, section.lessonId, section.title]), [
    ["for-homework", "11", "Homework A"], ["for-homework", "22", "Homework B"],
  ]);
});

test("downloaded Blob media updates a prepared package without serializing its raw definitions twice", () => {
  const prepared = createExportPackage({
    source: { url: "https://progressme.ru/lesson-editor/book/1/lesson/2/section/3" },
    captures: [{ kind: "fetch", data: { Items: [{ Id: 12, Answers: ["a"] }] } }],
    assets: [{ id: "a", name: "sound.mp3", url: "https://cdn.example.org/sound.mp3" }],
  });
  const originalEntry = prepared.entries.find(entry => entry.name.startsWith("originals/responses/"));
  const updated = replacePackageAssets(prepared, [{ id: "a", name: "sound.mp3", url: "https://cdn.example.org/sound.mp3", data: new Blob([new Uint8Array([1, 2, 3])]), status: "downloaded" }]);
  assert.equal(updated.entries.find(entry => entry.name === originalEntry.name), originalEntry, "Raw serialized data is reused by reference");
  assert.equal(updated.manifest.counts.downloadedAssets, 1);
  assert.equal(updated.manifest.completeness.missingAssets, 0);
  assert.equal(updated.manifest.inventory.assets[0].size, 3);
  assert.ok(updated.entries.find(entry => entry.name.startsWith("media/")).data instanceof Blob);
  assert.equal(prepared.manifest.counts.downloadedAssets, 0, "The initial inventory remains immutable");
});
