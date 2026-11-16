import test from "node:test";
import assert from "node:assert/strict";
import { collectAssets, mediaOrigins, readMediaResponse, downloadMediaAssets, MAX_MEDIA_BYTES, MEDIA_CONCURRENCY } from "../src/ui/assets.js";

test("book cover metadata joins ordinary downloads once and survives a missing duplicate assets entry", () => {
  const url = 'https://progressme.ru/cabinet/school/materials/book/71/content';
  const coverUrl = 'https://cdn.example.org/cover-opaque';
  const snapshots = [{ url, coverUrl, assets: [{ url: coverUrl, kind: 'image' }] }];
  const captures = [{ url: 'https://progressme.ru/api/materials/71', data: { imageUrl: coverUrl } }];
  const assets = collectAssets(snapshots, captures);
  assert.equal(assets.length, 1);
  assert.equal(assets[0].kind, 'image');
  assert.deepEqual(mediaOrigins(assets), ['https://cdn.example.org/*']);
  assert.equal(collectAssets([{ url, coverUrl }])[0].url, coverUrl);
  const signed = collectAssets([{ url, coverUrl: coverUrl + '?token=cover-secret' }]);
  assert.equal(signed[0].url, coverUrl);
  assert.equal(signed[0].downloadUnavailable, true);
  assert.doesNotMatch(JSON.stringify(signed), /cover-secret/);
});

test("cover metadata from lessons, invalid source identities and unsafe URLs cannot create downloads", () => {
  const url = 'https://progressme.ru/cabinet/school/materials/book/71/content';
  const coverUrl = 'https://cdn.example.org/cover.png';
  for (const snapshot of [
    { url: 'https://progressme.ru/lesson-editor/book/71/lesson/12/section/24', coverUrl },
    { url: url.replace('progressme.ru', 'unrelated.example'), coverUrl },
    { url, coverUrl, route: { materialId: '72' } },
    { url, coverUrl, route: { materialId: '71', lessonId: '12' } },
    { url, coverUrl: 'https://127.0.0.1/private.png' },
    { url, coverUrl: 'data:image/png;base64,abcd' },
  ]) assert.deepEqual(collectAssets([snapshot]), []);
});

test("asset inventory resolves explicit references, keeps extensions and deduplicates", () => {
  const assets = collectAssets([{ url: "https://platform.desharschool.ru/lesson-editor/book/1/lesson/2", assets: [
    { url: "/files/cat.png", name: "Кот", kind: "image" },
    { url: "https://cdn.example.org/words.mp3", kind: "audio" },
    { url: "http://127.0.0.1/private.png" },
  ] }], [{ url: "https://platform.desharschool.ru/api/lesson/2", data: {
    imageUrl: "https://platform.desharschool.ru/files/cat.png",
    fileUrl: "https://cdn.example.org/worksheet.pdf",
    lessonUrl: "https://platform.desharschool.ru/api/lesson/3",
    ordinaryLink: "https://example.org/article",
  } }]);
  assert.equal(assets.length, 3);
  assert.equal(assets[0].name, "Кот.png");
  assert.equal(assets[2].name, "worksheet.pdf");
  assert.deepEqual(mediaOrigins(assets), ["https://platform.desharschool.ru/*", "https://cdn.example.org/*"]);
});

test("animated PNG URLs in generic capture fields are collected as media", () => {
  const url = "https://cdn.example.org/animated.apng";
  const assets = collectAssets([], [{ url: "https://progressme.ru/api/materials/42", data: { example: url } }]);
  assert.deepEqual(assets.map(asset => asset.url), [url]);
});

test("asset metadata filenames do not become extra API-relative downloads", () => {
  const assets = collectAssets([], [{ url: "https://progressme.ru/api/materials/42", data: {
    attachment: { url: "https://cdn.example.org/file.jpg", name: "Vocabulary.jpg", mimeType: "image/jpeg" },
    title: "Lesson.pdf", label: "Label.png", filename: "Filename.mp3", file_name: "File_name.mp4",
    description: "Description.webp", text: "Text.svg",
    imageUrl: "https://cdn.example.org/image.png", fileUrl: "/files/worksheet.pdf",
    groups: [{ files: ["https://cdn.example.org/listening.mp3"] }],
  } }]);
  assert.deepEqual(assets.map(asset => asset.url), [
    "https://cdn.example.org/file.jpg",
    "https://cdn.example.org/image.png",
    "https://progressme.ru/files/worksheet.pdf",
    "https://cdn.example.org/listening.mp3",
  ]);
  assert.equal(assets[0].name, "Vocabulary.jpg");
});

test("signed, private and embedded URLs cannot become credentialed download requests", () => {
  const assets = collectAssets([{ url: "https://platform.desharschool.ru/materials", assets: [
    { url: "https://cdn.example.org/file.pdf?token=secret&size=5", kind: "pdf" },
    { url: "https://cdn.example.org/clean.mp3", downloadUnavailable: true, reason: "Temporary link" },
    { url: "https://user:password@cdn.example.org/file.png" },
    { url: "https://192.168.1.10/private.png" },
    { url: "data:image/png;base64,abcd" },
    { url: "https://example.local/secret.pdf" },
  ] }]);
  assert.equal(assets.length, 3);
  assert.equal(assets[0].url, "https://cdn.example.org/file.pdf?size=5");
  assert.equal(assets[0].downloadUnavailable, true);
  assert.equal(assets[2].downloadUnavailable, true);
  assert.deepEqual(mediaOrigins(assets), []);
  assert.doesNotMatch(JSON.stringify(assets), /secret|password@/);
});

test("serialized constructor fields expose media absent from the DOM without turning filenames into URLs", () => {
  const assets = collectAssets([], [{ url: "https://progressme.ru/api/materials/42", data: {
    Items: [{
      JsonData: JSON.stringify({ slides: [
        { attachment: { url: "https://cdn.example.org/lesson-photo.jpg", name: "Vocabulary.jpg", mimeType: "image/jpeg" } },
        { audioUrl: "/files/listening.mp3", fileName: "Audio.mp3", text: "Text.png" },
      ] }),
      ImagesJson: JSON.stringify([{ Url: "https://cdn.example.org/hidden-image.png", FileName: "Picture.png" }]),
      Text: JSON.stringify({ imageUrl: "https://cdn.example.org/prose-is-not-constructor.json.png" }),
    }],
  } }]);
  assert.deepEqual(assets.map(asset => asset.url), [
    "https://cdn.example.org/lesson-photo.jpg",
    "https://progressme.ru/files/listening.mp3",
    "https://cdn.example.org/hidden-image.png",
  ]);
  assert.equal(assets[0].name, "Vocabulary.jpg");
});

test("socket constructor media resolves relative URLs in its validated source page, while HTTP retains its endpoint base", () => {
  const pageUrl = "https://progressme.ru/lesson-editor/book/12/lesson/34/section/56";
  const data = { JsonData: JSON.stringify({
    imageUrl: "/files/exercise-photo.png", audioUrl: "//cdn.example.org/exercise-audio.mp3",
    fileUrl: "worksheet.pdf",
  }) };
  const socket = { kind: "websocket", url: "wss://proxy.progressme.ru/websocket", pageUrl, data };
  assert.deepEqual(collectAssets([], [socket]).map(asset => asset.url), [
    "https://progressme.ru/files/exercise-photo.png", "https://cdn.example.org/exercise-audio.mp3",
    "https://progressme.ru/lesson-editor/book/12/lesson/34/section/worksheet.pdf",
  ]);
  const http = { ...socket, kind: "fetch", url: "https://progressme.ru/api/materials/42" };
  assert.deepEqual(collectAssets([], [http]).map(asset => asset.url), [
    "https://progressme.ru/files/exercise-photo.png", "https://cdn.example.org/exercise-audio.mp3",
    "https://progressme.ru/api/materials/worksheet.pdf",
  ]);
  for (const invalidPage of [undefined, "http://progressme.ru/lesson-editor/1", "https://evil.example/lesson-editor/1",
    "https://user:secret@progressme.ru/lesson-editor/1", "https://progressme.ru/cabinet/school/students"]) {
    assert.deepEqual(collectAssets([], [{ ...socket, pageUrl: invalidPage }]), [], String(invalidPage));
  }
});

test("unexpected media metadata types use safe defaults without interrupting the entire inventory", () => {
  const assets = collectAssets([], [{ url: "https://progressme.ru/api/materials/42", data: {
    attachments: [
      { url: "https://cdn.example.org/picture.png", mimeType: "image/png", name: { en: "Picture" }, kind: 7 },
      { url: "https://cdn.example.org/number.png", mimeType: "image/png", name: 123 },
      { url: "https://cdn.example.org/audio", mimeType: { toString: 1 }, mime: "audio/mpeg", name: "Listening" },
    ],
  } }]);
  assert.deepEqual(assets.map(asset => [asset.name, asset.kind, asset.mimeType]), [
    ["picture.png", "file", "image/png"], ["number.png", "file", "image/png"], ["Listening", "file", "audio/mpeg"],
  ]);
});

test("serialized constructor media keeps signed links unavailable and rejects private or embedded destinations", () => {
  const assets = collectAssets([], [{ url: "https://progressme.ru/api/materials/42", data: {
    JsonData: JSON.stringify({ attachments: [
      { imageUrl: "https://cdn.example.org/photo.jpg?token=download-secret&size=2" },
      { audioUrl: "https://cdn.example.org/listening.mp3" },
      { imageUrl: "http://127.0.0.1/private.jpg" },
      { fileUrl: "https://192.168.1.10/private.pdf" },
      { imageUrl: "https://service.local/private.png" },
      { imageUrl: "data:image/png;base64,abcd" },
    ] }),
  } }]);
  assert.equal(assets.length, 2);
  assert.equal(assets[0].url, "https://cdn.example.org/photo.jpg?size=2");
  assert.equal(assets[0].downloadUnavailable, true);
  assert.equal(assets[1].downloadUnavailable, undefined);
  assert.deepEqual(mediaOrigins(assets), ["https://cdn.example.org/*"]);
  assert.doesNotMatch(JSON.stringify(assets), /download-secret|private|base64/);
});

test("serialized media parsing is bounded, object-only and never applied to arbitrary text fields", () => {
  const oversized = JSON.stringify({ padding: "я".repeat(4300000), imageUrl: "https://cdn.example.org/oversized.png" });
  const tooDeep = Array.from({ length: 19 }).reduce(value => ({ nested: value }), { JsonData: '{"imageUrl":"https://cdn.example.org/deep.png"}' });
  const assets = collectAssets([], [{ url: "https://progressme.ru/api/materials/42", data: {
    JsonData: oversized,
    items: [
      { JsonData: '{"imageUrl":"https://cdn.example.org/broken.png"' },
      { ImagesJson: '"https://cdn.example.org/scalar.png"' },
      { JsonData: 'https://cdn.example.org/plain.png' },
      { text: '{"imageUrl":"https://cdn.example.org/text.png"}' },
      { description: '{"imageUrl":"https://cdn.example.org/description.png"}' },
    ],
    deep: tooDeep,
  } }]);
  assert.deepEqual(assets, []);
});

test("media reader preserves bytes and content type", async () => {
  const response = new Response(new Uint8Array([0, 255, 9, 4]), { headers: { "content-type": "image/png; charset=binary" } });
  const file = await readMediaResponse(response, { maxBytes: 8 });
  assert.deepEqual([...new Uint8Array(await file.data.arrayBuffer())], [0, 255, 9, 4]);
  assert.equal(file.mimeType, "image/png");
});

test("media reader reports cumulative bytes while a known-size file is downloading", async () => {
  const progress = [];
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array([1, 2]));
    controller.enqueue(new Uint8Array([3, 4, 5]));
    controller.close();
  } });
  const response = new Response(stream, { headers: { "content-type": "audio/mpeg", "content-length": "5" } });
  const file = await readMediaResponse(response, { maxBytes: 8, onProgress: value => progress.push(value) });
  assert.deepEqual(progress, [{ loaded: 0, total: 5 }, { loaded: 2, total: 5 }, { loaded: 5, total: 5 }]);
  assert.deepEqual([...new Uint8Array(await file.data.arrayBuffer())], [1, 2, 3, 4, 5]);
});

test("media reader reports chunked downloads without inventing a total", async () => {
  const progress = [];
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(2));
    controller.enqueue(new Uint8Array(4));
    controller.close();
  } });
  await readMediaResponse(new Response(stream, { headers: { "content-type": "video/mp4" } }), {
    maxBytes: 8, onProgress: value => progress.push(value),
  });
  assert.deepEqual(progress, [{ loaded: 0, total: undefined }, { loaded: 2, total: undefined }, { loaded: 6, total: undefined }]);
});

test("media reader does not use invalid or encoded Content-Length as a progress total", async () => {
  for (const headers of [
    { "content-length": "invalid" },
    { "content-length": "-5" },
    { "content-length": "2.5" },
    { "content-length": "3", "content-encoding": "gzip" },
    { "content-length": "3", "transfer-encoding": "chunked" },
  ]) {
    const progress = [];
    await readMediaResponse(new Response(new Uint8Array(3), { headers: { "content-type": "image/png", ...headers } }), {
      maxBytes: 8, onProgress: value => progress.push(value),
    });
    assert.equal(progress.at(-1).loaded, 3);
    assert.ok(progress.every(value => value.total === undefined));
  }
});

test("media reader rejects shorter and longer bodies than a trusted declared length", async () => {
  for (const declaredSize of [2, 7]) {
    const progress = [];
    await assert.rejects(readMediaResponse(new Response(new Uint8Array(4), { headers: { "content-type": "image/png", "content-length": String(declaredSize) } }), {
      maxBytes: 8, onProgress: value => progress.push(value),
    }), /размер файла не совпадает/);
    assert.ok(progress.every(value => value.total === declaredSize && value.loaded <= value.total));
  }
});

test("media reader rejects range responses before reading and cancels their bodies", async () => {
  for (const [status, range] of [[206, undefined], [206, "bytes 0-1/10"], [200, "bytes 0-1/10"], [200, "invalid"]]) {
    let cancelled = false;
    const progress = [];
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1, 2])); },
      cancel() { cancelled = true; },
    });
    const response = new Response(stream, { status, headers: {
      "content-type": "image/png", "content-length": "2", ...(range ? { "content-range": range } : {}),
    } });
    await assert.rejects(readMediaResponse(response, { maxBytes: 8, onProgress: value => progress.push(value) }), /только часть файла/);
    assert.equal(cancelled, true, `The ${status} range body must be discarded`);
    assert.deepEqual(progress, [], "Partial attachment bytes must not count as download progress");
  }
});

test("media reader rejects HTML login responses and HTTP errors", async () => {
  await assert.rejects(readMediaResponse(new Response("<html>login</html>", { headers: { "content-type": "text/html" } }), { maxBytes: 100 }), /тип файла/);
  await assert.rejects(readMediaResponse(new Response("", { status: 403 }), { maxBytes: 100 }), /HTTP 403/);
});

test("media reader enforces stream limit even without content-length", async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8)); }, cancel() { cancelled = true; } });
  await assert.rejects(readMediaResponse(new Response(stream, { headers: { "content-type": "application/pdf" } }), { maxBytes: 4 }), /лимит/);
  assert.equal(cancelled, true);
});

test("media reader checks declared size before reading", async () => {
  await assert.rejects(readMediaResponse(new Response("x", { headers: { "content-type": "audio/mpeg", "content-length": "100" } }), { maxBytes: 4 }), /лимит/);
});

test("media reader respects cancellation and rejects empty bodies", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readMediaResponse(new Response("x", { headers: { "content-type": "audio/mpeg" } }), { signal: controller.signal, maxBytes: 10 }), { name: "AbortError" });
  await assert.rejects(readMediaResponse(new Response(new Uint8Array(), { headers: { "content-type": "audio/mpeg" } }), { maxBytes: 10 }), /пустой файл/);
});

test("ProgressMe media containers accept opaque Url fields without treating ordinary object links as media", () => {
  const assets = collectAssets([], [{ url: "https://progressme.ru/api/materials/42", data: {
    Audios: [{ Url: "/files/audio-opaque", Name: "Listening" }, { Url: "", UrlFull: "/files/full-audio-opaque" }],
    Images: [{ Url: "//cdn.example.org/image-opaque" }],
    Videos: [{ FileUrl: "https://cdn.example.org/video-opaque" }],
    other: { Url: "https://cdn.example.org/ordinary-api" },
    JsonData: JSON.stringify({ Audios: [{ Url: "/files/serialized-audio" }] }),
  } }]);
  assert.deepEqual(assets.map(asset => asset.url), [
    "https://progressme.ru/files/audio-opaque", "https://progressme.ru/files/full-audio-opaque", "https://cdn.example.org/image-opaque",
    "https://cdn.example.org/video-opaque", "https://progressme.ru/files/serialized-audio",
  ]);
});

test("opaque Videos Link files are collected while native provider players and unrelated links stay references", () => {
  const playerLinks = ["https://www.youtube.com/watch?v=abc_123", "https://youtu.be/abc-123", "https://m.youtube.com/shorts/abc", "https://vimeo.com/12345", "https://rutube.ru/video/abc123/", "https://vkvideo.ru/video_ext.php?oid=1&id=2", "https://dzen.ru/embed/example"];
  const assets = collectAssets([], [{ url: "https://progressme.ru/api/materials/42", data: {
    Videos: [{ Link: "https://cdn.example.org/download?id=video" }, ...playerLinks.map(Link => ({ Link }))],
    JsonData: JSON.stringify({ Videos: [{ Link: "/files/opaque-video" }] }),
    other: { Link: "https://cdn.example.org/ordinary-page" },
    Images: [{ Link: "https://cdn.example.org/image-page" }],
  } }]);
  assert.deepEqual(assets.map(asset => asset.url), ["https://cdn.example.org/download?id=video", "https://progressme.ru/files/opaque-video"]);
});

test("embedded activities and normalized players are excluded across every asset discovery route", () => {
  const embeds = [
    "https://wordwall.net/ru/embed/fdc384e60fa5423595f7a5361ea0154f?themeId=1",
    "https://wordwall.net/resource/12345/activity", "https://wordwall.net/embed/abc-123",
    "https://learningapps.org/watch?app=p81piob6323", "https://learningapps.org/display?v=p123",
    "https://drive.google.com/file/d/abc_123/view?usp=drive_link", "https://drive.google.com/file/d/abc_123/preview",
    "https://www.youtube.com/watch?v=abc_123", "https://www.youtube-nocookie.com/embed/abc_123",
    "https://player.vimeo.com/video/12345", "https://rutube.ru/play/embed/abc123",
    "https://view.genially.com/abc-123/interactive-content-lesson", "https://quizlet.com/12345/lesson-flash-cards/",
    "https://quizlet.com/12345",
  ];
  const data = { Videos: embeds.map(Url => ({ Url })), videoUrl: embeds[7],
    media: embeds.map(url => ({ url, mimeType: "video/mp4" })),
    Text: `<video src="${embeds[7]}"></video><img src="https://cdn.example.org/still.jpg">`,
  };
  const original = JSON.stringify(data);
  const assets = collectAssets([{ url: "https://progressme.ru/materials", assets: embeds.map(url => ({ url, kind: "embed" })) }],
    [{ url: "https://progressme.ru/api/materials/42", data }]);
  assert.deepEqual(assets.map(asset => asset.url), ["https://cdn.example.org/still.jpg"]);
  assert.equal(JSON.stringify(data), original, "raw author provider references remain available to import");
});

test("unknown pages, provider lookalikes and actual opaque files stay in the download inventory", () => {
  const urls = ["https://wordwall.net.example.org/ru/embed/abc", "https://learningapps.org/watch", "https://drive.google.com/file/d/abc/download",
    "https://cdn.example.org/fdc384e60fa5423595f7a5361ea0154f", "https://wordwall.net/assets/image.png",
    "https://view.genially.com.example.org/abc/lesson", "https://view.genially.com/abc",
    "https://quizlet.com.example.org/12345/lesson", "https://quizlet.com/not-a-set/lesson"];
  const assets = collectAssets([{ url: "https://progressme.ru/materials", assets: urls }]);
  assert.deepEqual(assets.map(asset => asset.url), urls);
});

test("resolved top-level audio URL supersedes only matching serialized audio IDs", () => {
  const exercise = { Id: 387811294, Type: 4, Audios: [{ Id: "audio-1", Url: "https://media-y.progressme.ru/files/resolved.mp3" }],
    JsonData: JSON.stringify({ Audios: [
      { Id: "audio-1", Url: "\\\\files\\LessonExerciseAudios\\2156\\Audios[0].Urlstale.mp3", UrlFull: "/stale-full.mp3", Script: '<img src="/script-image.png">' },
      { Id: "audio-2", Url: "/other.mp3" },
    ], Images: [{ Url: "/constructor-image.png" }] }),
  };
  const original = JSON.stringify(exercise);
  const assets = collectAssets([], [{ url: "https://progressme.ru/api/materials/42", data: exercise }]);
  assert.deepEqual(assets.map(asset => asset.url), ["https://media-y.progressme.ru/files/resolved.mp3", "https://progressme.ru/script-image.png",
    "https://progressme.ru/other.mp3", "https://progressme.ru/constructor-image.png"]);
  assert.equal(JSON.stringify(exercise), original);
});

test("serialized audio is retained without a usable unambiguous matching DTO audio", () => {
  for (const Audios of [null, [], [{ Id: "audio-1", Url: "" }], [{ Url: "/resolved.mp3" }],
    [{ Id: "audio-1", Url: "/one.mp3" }, { Id: "audio-1", Url: "/two.mp3" }]]) {
    const assets = collectAssets([], [{ url: "https://progressme.ru/api/materials/42", data: {
      Id: 42, Type: 4, Audios, JsonData: JSON.stringify({ Audios: [{ Id: "audio-1", Url: "/serialized.mp3" }] }),
    } }]);
    assert.ok(assets.some(asset => asset.url === "https://progressme.ru/serialized.mp3"));
  }
});

test("media HTML extracts source attributes rather than downloading the entire HTML as a URL", () => {
  const assets = collectAssets([], [{ url: "https://progressme.ru/api/materials/42", data: {
    Text: '<p>Explanation</p><audio src="/files/audio-opaque?lang=en&amp;part=2"></audio><img src="//cdn.example.org/image-opaque"><video poster="/files/poster" src="/files/video"></video><a href="/files/task.pdf">Task</a><a href="/lesson/12">Lesson</a>',
  } }]);
  assert.deepEqual(assets.map(asset => asset.url), [
    "https://progressme.ru/files/audio-opaque?lang=en&part=2", "https://cdn.example.org/image-opaque",
    "https://progressme.ru/files/poster", "https://progressme.ru/files/video", "https://progressme.ru/files/task.pdf",
  ]);
});

test("constructor media between 1 and 8 MiB remains discoverable", () => {
  const assets = collectAssets([], [{ url: "https://progressme.ru/api/materials/42", data: {
    JsonData: JSON.stringify({ text: "a".repeat(1100000), Audios: [{ Url: "/files/opaque-audio" }] }),
  } }]);
  assert.deepEqual(assets.map(asset => asset.url), ["https://progressme.ru/files/opaque-audio"]);
});

test("the media reader returns a typed Blob with the downloaded bytes", async () => {
  const progress = [];
  const file = await readMediaResponse(new Response(new Uint8Array([0, 255, 5]), { headers: { "content-type": "audio/mpeg" } }), {
    maxBytes: 8, onProgress: value => progress.push(value),
  });
  assert.ok(file.data instanceof Blob);
  assert.equal(file.data.size, 3);
  assert.equal(file.data.type, "audio/mpeg");
  assert.deepEqual([...new Uint8Array(await file.data.arrayBuffer())], [0, 255, 5]);
  assert.equal(progress.at(-1).loaded, 3);
});

test("encoded Content-Length is not mistaken for decoded file size", async () => {
  const file = await readMediaResponse(new Response(new Uint8Array(3), { headers: {
    "content-type": "audio/mpeg", "content-length": "999999", "content-encoding": "gzip",
  } }), { maxBytes: 4 });
  assert.equal(file.data.size, 3);
});

test("aborting a pending response read cancels its stream promptly", async () => {
  let cancelled = false;
  const controller = new AbortController();
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const result = readMediaResponse(new Response(stream, { headers: { "content-type": "audio/mpeg" } }), { signal: controller.signal, maxBytes: 10 });
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(cancelled, true);
});

const waitFor = async predicate => {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail("Expected asynchronous download state was not reached");
};
const mediaCandidates = count => Array.from({ length: count }, (_, index) => ({ name: `${index}.mp3`, url: `https://cdn.example.org/${index}.mp3` }));

test("temporary HTTP errors retry at most three times without retaining failed response bytes", async () => {
  const attempts = new Map(), progress = [];
  const results = await downloadMediaAssets(mediaCandidates(2), {
    concurrency: 1, retryDelayMs: 0, maxTotalBytes: 4,
    fetchFile: async url => {
      const attempt = (attempts.get(url) || 0) + 1; attempts.set(url, attempt);
      return attempt < 3 ? new Response("temporary failure", { status: attempt === 1 ? 503 : 429 })
        : new Response(new Uint8Array([1, 2]), { headers: { "content-type": "audio/mpeg" } });
    }, onProgress: value => progress.push(value),
  });
  assert.deepEqual([...attempts.values()], [3, 3]);
  assert.ok(results.every(asset => asset.status === "downloaded"));
  assert.equal(progress.at(-1).loadedBytes, 4);
  assert.equal(progress.at(-1).retainedBytes, 4);
});

test("media downloads recover from network changes before and during a response", async () => {
  let attempts = 0;
  const progress = [];
  const [asset] = await downloadMediaAssets(mediaCandidates(1), {
    retryDelayMs: 0, maxTotalBytes: 3,
    fetchFile: async () => {
      attempts++;
      if (attempts === 1) throw new TypeError("Failed to fetch");
      if (attempts === 2) {
        let sent = false;
        return new Response(new ReadableStream({ pull(controller) {
          if (sent) controller.error(new TypeError("network error"));
          else { sent = true; controller.enqueue(new Uint8Array([9, 9])); }
        } }), { headers: { "content-type": "audio/mpeg" } });
      }
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
    }, onProgress: value => progress.push(value),
  });
  assert.equal(attempts, 3);
  assert.equal(asset.status, "downloaded");
  assert.deepEqual([...new Uint8Array(await asset.data.arrayBuffer())], [1, 2, 3]);
  assert.ok(progress.some(value => value.retainedBytes === 2), "the interrupted response transferred a partial body");
  assert.equal(progress.at(-1).retainedBytes, 3);
});

test("persistent media network errors stop after three attempts", async () => {
  let attempts = 0;
  const [asset] = await downloadMediaAssets(mediaCandidates(1), {
    retryDelayMs: 0,
    fetchFile: async () => { attempts++; throw new TypeError("Failed to fetch"); },
  });
  assert.equal(attempts, 3);
  assert.equal(asset.status, "failed");
  assert.match(asset.error, /Нет связи/);
});

test("persistent temporary HTTP errors stop after three attempts while permanent failures are not retried", async () => {
  const attempts = new Map();
  const results = await downloadMediaAssets(mediaCandidates(4), {
    retryDelayMs: 0, maxFileBytes: 2,
    fetchFile: async url => {
      attempts.set(url, (attempts.get(url) || 0) + 1);
      if (url.endsWith("0.mp3")) return new Response("down", { status: 503 });
      if (url.endsWith("1.mp3")) return new Response("missing", { status: 404 });
      if (url.endsWith("2.mp3")) return new Response("<html>page</html>", { headers: { "content-type": "text/html" } });
      return new Response(new Uint8Array(3), { headers: { "content-type": "audio/mpeg" } });
    },
  });
  assert.deepEqual([...attempts.values()], [3, 1, 1, 1]);
  assert.ok(results.every(asset => asset.status === "failed"));
  assert.match(results[0].error, /временно недоступен/);
});

test("cancellation interrupts HTTP retry backoff and starts no later files", async () => {
  let requested = 0, responseCancelled = 0;
  const controller = new AbortController();
  const task = downloadMediaAssets(mediaCandidates(2), {
    concurrency: 1, retryDelayMs: 10_000, signal: controller.signal,
    fetchFile: async () => { requested++; return new Response(new ReadableStream({ cancel() { responseCancelled++; } }), { status: 503 }); },
  });
  await waitFor(() => responseCancelled === 1);
  controller.abort();
  await assert.rejects(task, { name: "AbortError" });
  assert.equal(requested, 1);
});

test("media pool keeps three downloads active, caches permissions, preserves inventory order and sums progress", async () => {
  const pending = new Map(), progress = [], permissions = [];
  let active = 0, peak = 0;
  const task = downloadMediaAssets(mediaCandidates(5), {
    concurrency: 3, maxFileBytes: 20, maxTotalBytes: 100,
    hasPermission: async origin => { permissions.push(origin); return true; },
    fetchFile: async url => {
      const index = Number(new URL(url).pathname.match(/\d+/)[0]);
      active++; peak = Math.max(peak, active);
      return new Response(new ReadableStream({ start(controller) {
        pending.set(index, () => { controller.enqueue(new Uint8Array([index, 1, 2, 3])); controller.close(); active--; });
      } }), { headers: { "content-type": "audio/mpeg", "content-length": "4" } });
    },
    onProgress: value => progress.push(value),
  });
  await waitFor(() => pending.size === 3);
  assert.equal(peak, 3);
  pending.get(1)();
  await waitFor(() => pending.has(3));
  assert.equal(peak, 3);
  pending.get(0)(); pending.get(2)(); pending.get(3)();
  await waitFor(() => pending.has(4));
  pending.get(4)();
  const results = await task;
  assert.equal(permissions.length, 1);
  assert.deepEqual(results.map(asset => asset.name), ["0.mp3", "1.mp3", "2.mp3", "3.mp3", "4.mp3"]);
  assert.ok(results.every(asset => asset.status === "downloaded" && asset.data instanceof Blob));
  assert.equal(progress.at(-1).completed, 5);
  assert.equal(progress.at(-1).loadedBytes, 20);
  assert.equal(progress.at(-1).retainedBytes, 20);
  assert.ok(progress.every((value, index) => !index || value.loadedBytes >= progress[index - 1].loadedBytes));
});

test("default media pool uses six parallel downloads", async () => {
  const pending = [];
  let active = 0, peak = 0;
  const task = downloadMediaAssets(mediaCandidates(8), {
    maxFileBytes: 20, maxTotalBytes: 100,
    fetchFile: async () => {
      active++; peak = Math.max(peak, active);
      return new Response(new ReadableStream({ start(controller) {
        pending.push(() => { controller.enqueue(new Uint8Array([1])); controller.close(); active--; });
      } }), { headers: { "content-type": "audio/mpeg", "content-length": "1" } });
    },
  });
  await waitFor(() => pending.length === MEDIA_CONCURRENCY);
  assert.equal(MEDIA_CONCURRENCY, 6);
  assert.equal(peak, 6);
  for (let index = 0; index < 8; index++) { await waitFor(() => pending.length > index); pending[index](); }
  assert.ok((await task).every(asset => asset.status === "downloaded"));
});

test("book budget exhaustion rejects export rather than marking every later small file oversized", async () => {
  const task = downloadMediaAssets(mediaCandidates(8), {
    concurrency: 1, maxFileBytes: 10, maxTotalBytes: 15,
    fetchFile: async () => new Response(new Uint8Array(8), { headers: { "content-type": "audio/mpeg", "content-length": "8" } }),
  });
  await assert.rejects(task, error => error.code === "archive_limit" && /Архив/.test(error.message) && !/лимит размера файла/.test(error.message));
});

test("oversized individual media does not consume the book budget or prevent later small downloads", async () => {
  const results = await downloadMediaAssets(mediaCandidates(3), {
    concurrency: 1, maxFileBytes: 4, maxTotalBytes: 6,
    fetchFile: async url => new Response(new Uint8Array(url.endsWith("0.mp3") ? 9 : 3), { headers: { "content-type": "audio/mpeg" } }),
  });
  assert.equal(results[0].status, "failed");
  assert.match(results[0].error, /лимит размера файла/);
  assert.deepEqual(results.slice(1).map(asset => asset.data.size), [3, 3]);
  assert.equal(MAX_MEDIA_BYTES, 100 * 1024 * 1024);
});

test("cancelling the pool aborts every active stream and starts no further files", async () => {
  let requested = 0, cancelled = 0;
  const controller = new AbortController();
  const task = downloadMediaAssets(mediaCandidates(20), {
    signal: controller.signal,
    fetchFile: async () => {
      requested++;
      return new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { "content-type": "audio/mpeg" } });
    },
  });
  await waitFor(() => requested === MEDIA_CONCURRENCY);
  controller.abort();
  await assert.rejects(task, { name: "AbortError" });
  assert.equal(requested, MEDIA_CONCURRENCY);
  assert.equal(cancelled, MEDIA_CONCURRENCY);
});

test("confirmed ProgressMe RPC media uses the lesson page for both HTTP and socket envelopes", () => {
  const pageUrl = "https://progressme.ru/lesson-editor/book/12/lesson/34/section/56";
  for (const Method of ["LoadExercises", "LoadExercisesInMaterial"]) {
    const data = { Class: "GetExerciseWsController", Method, IsSuccess: true, Value: { Items: [
      { Audios: [{ Url: "relative-audio" }, { Url: "/files/absolute-audio" }] },
    ] } };
    const http = collectAssets([], [{ kind: "fetch", url: "https://api.progressme.ru/api/ExSender", pageUrl, data }]);
    const socket = collectAssets([], [{ kind: "websocket", url: "wss://proxy.progressme.ru/websocket", pageUrl, data }]);
    assert.deepEqual(http.map(asset => asset.url), [
      "https://progressme.ru/lesson-editor/book/12/lesson/34/section/relative-audio", "https://progressme.ru/files/absolute-audio",
    ]);
    assert.deepEqual(http, socket);
  }
});

test("the media reader compacts multiple Blob parts without changing their byte order", async () => {
  const chunk = new Uint8Array(1024 * 1024).fill(7);
  const stream = new ReadableStream({ start(controller) {
    for (let index = 0; index < 5; index++) controller.enqueue(chunk);
    controller.enqueue(new Uint8Array([255])); controller.close();
  } });
  const file = await readMediaResponse(new Response(stream, { headers: { "content-type": "audio/mpeg" } }), {});
  assert.equal(file.data.size, 5 * chunk.byteLength + 1);
  assert.deepEqual([...new Uint8Array(await file.data.slice(-2).arrayBuffer())], [7, 255]);
});

test("wrapped HTTP exercise responses resolve author media in the page without changing generic sibling URLs", () => {
  const pageUrl = "https://progressme.ru/lesson-editor/book/12/lesson/34/section/56";
  const rpc = { Class: "GetExerciseWsController", Method: "LoadExercises", IsSuccess: true,
    Value: { Items: [{ Audios: [{ Url: "/media/audio-opaque" }] }] } };
  for (const data of [[rpc], { batch: [rpc] }, { transport: { result: rpc } }]) {
    const [asset] = collectAssets([], [{ kind: "fetch", url: "https://api.progressme.ru/api/send", pageUrl, data }]);
    assert.equal(asset.url, "https://progressme.ru/media/audio-opaque");
  }
  const assets = collectAssets([], [{ kind: "fetch", url: "https://api.progressme.ru/api/send", pageUrl,
    data: { batch: [rpc], imageUrl: "generic.png" } }]);
  assert.deepEqual(assets.map(asset => asset.url), [
    "https://progressme.ru/media/audio-opaque", "https://api.progressme.ru/api/generic.png",
  ]);
});
