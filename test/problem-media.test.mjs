import assert from 'node:assert/strict';
import test from 'node:test';
import { collectAssets, downloadMediaAssets, readMediaResponse } from '../src/ui/assets.js';
import { inspectRejectedMediaResponse } from '../src/lib/media-response-diagnostics.js';

const sourcePage = 'https://progressme.ru/lesson-editor/book/71/lesson/5/section/6';
const candidate = { id: 'asset-0001', name: 'picture.png', url: 'https://cdn.example.org/picture.png', sourcePage };
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);

test('a truncated text/plain PNG reports its MIME and signature without becoming downloadable', async () => {
  const events = [];
  const [file] = await downloadMediaAssets([candidate], {
    fetchFile: async () => new Response(png, { headers: { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(png.length) } }),
    onDiagnostic: event => events.push(event),
  });
  assert.equal(file.status, 'failed');
  assert.match(file.error, /повреждённый PNG/);
  const failure = events.find(event => event.status === 'failed');
  assert.ok(failure, 'The downloader must emit a terminal diagnostic for the refused file');
  assert.equal(failure.assetId, candidate.id);
  assert.equal(failure.sourcePage, sourcePage);
  assert.equal(failure.httpStatus, 200);
  assert.equal(failure.mimeType, 'text/plain');
  assert.equal(failure.declaredBytes, png.length);
  assert.equal(failure.receivedBytes, png.length);
  assert.equal(failure.detectedFormat, 'png');
  assert.equal(failure.reason, 'invalid_png');
  assert.equal(failure.effectiveMimeType, undefined);
  assert.equal(failure.attempt, 1);
  assert.equal(file.data, undefined);
  assert.doesNotMatch(JSON.stringify(events), /137,80|charset|headers|body/);
});

test('rejected response inspection recognizes only a format and never exports body content', async () => {
  for (const [format, data] of [
    ['html', '<!doctype html><html>private login token</html>'],
    ['html', '\uFEFF \n <HTML><body>private lesson</body></HTML>'],
    ['json', '{"private":"secret"}'], ['jpeg', new Uint8Array([255, 216, 255, 0, 128])],
    ['gif', 'GIF89a\0\0'], ['webp', 'RIFF1234WEBP1234'], ['pdf', '%PDF-1.7 private text'],
    ['unknown', 'private plain response'],
  ]) {
    const output = await inspectRejectedMediaResponse(new Response(data));
    assert.equal(output.detectedFormat, format);
    assert.deepEqual(Object.keys(output).sort(), ['detectedFormat', 'receivedBytes']);
    assert.doesNotMatch(JSON.stringify(output), /private|secret|token|login/);
  }
});

test('rejected response inspection stops at the prefix boundary and does not await cancellation', async () => {
  let pulls = 0, cancelled = false;
  const body = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(2048)); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  }, { highWaterMark: 0 });
  const output = await inspectRejectedMediaResponse(new Response(body));
  assert.equal(output.detectedFormat, 'unknown');
  assert.equal(output.receivedBytes, 2048, 'Received bytes count the delivered chunk, even though only its prefix is inspected');
  assert.equal(pulls, 1);
  assert.equal(cancelled, true);
});

test('failed inspection preserves the unsupported Content-Type error and does not trigger network retries', async () => {
  let requests = 0;
  const events = [];
  const [file] = await downloadMediaAssets([candidate], {
    retryDelayMs: 0,
    fetchFile: async () => {
      requests++;
      return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('private body failure')); } }), {
        headers: { 'content-type': 'text/html' },
      });
    }, onDiagnostic: event => events.push(event),
  });
  assert.equal(requests, 1);
  assert.match(file.error, /неподдерживаемый тип файла/);
  assert.equal(events.at(-1).reason, 'unsupported_content_type');
  assert.equal(events.at(-1).detectedFormat, 'unknown');
  assert.doesNotMatch(JSON.stringify(events), /private body failure/);
});

test('inspection of a stalled unsupported response stops within one second', async () => {
  let cancelled = false;
  const started = performance.now();
  const events = [];
  const [file] = await downloadMediaAssets([candidate], {
    fetchFile: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/html' } }),
    onDiagnostic: event => events.push(event),
  });
  assert.ok(performance.now() - started < 1500);
  assert.equal(cancelled, true);
  assert.match(file.error, /неподдерживаемый тип файла/);
  assert.equal(events.at(-1).detectedFormat, 'unknown');
});

test('media events distinguish retries from terminal failures and keep per-attempt measurements', async () => {
  let attempt = 0;
  const events = [];
  const [file] = await downloadMediaAssets([candidate], {
    retryDelayMs: 0,
    fetchFile: async () => {
      attempt++;
      if (attempt === 1) throw new TypeError('private network error');
      if (attempt === 2) return new Response('temporary', { status: 503, headers: { 'content-type': 'text/html', 'content-length': '9' } });
      return new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } });
    }, onDiagnostic: event => events.push(event),
  });
  assert.equal(file.status, 'downloaded');
  assert.deepEqual(events.map(event => [event.status, event.attempt]), [
    ['started', 1], ['retrying', 1], ['started', 2], ['retrying', 2], ['started', 3], ['downloaded', 3],
  ]);
  assert.equal(events[1].reason, 'network_error');
  assert.equal(events[3].reason, 'http_error');
  assert.equal(events[3].httpStatus, 503);
  assert.equal(events.at(-1).httpStatus, 200);
  assert.equal(events.at(-1).mimeType, 'image/png');
  assert.equal(events.at(-1).receivedBytes, png.length);
  assert.doesNotMatch(JSON.stringify(events), /private network error/);
});

test('permission, temporary URLs, timeout and cancellation have distinct terminal diagnostics', async () => {
  const events = [];
  await downloadMediaAssets([{ ...candidate, downloadUnavailable: true }], { onDiagnostic: event => events.push(event) });
  assert.equal(events.at(-1).status, 'unavailable');
  assert.equal(events.at(-1).reason, 'temporary_url');
  await downloadMediaAssets([candidate], { hasPermission: async () => false, onDiagnostic: event => events.push(event) });
  assert.equal(events.at(-1).status, 'skipped');
  assert.equal(events.at(-1).reason, 'permission_denied');
  await downloadMediaAssets([candidate], {
    timeoutMs: 10,
    fetchFile: async () => new Response(new ReadableStream(), { headers: { 'content-type': 'image/png' } }),
    onDiagnostic: event => events.push(event),
  });
  assert.equal(events.at(-1).status, 'failed');
  assert.equal(events.at(-1).reason, 'timeout');
  const controller = new AbortController();
  const task = downloadMediaAssets([candidate], {
    signal: controller.signal,
    fetchFile: async () => new Response(new ReadableStream(), { headers: { 'content-type': 'image/png' } }),
    onDiagnostic: event => { events.push(event); if (event.status === 'started') setImmediate(() => controller.abort()); },
  });
  await assert.rejects(task, { name: 'AbortError' });
  assert.equal(events.at(-1).status, 'cancelled');
  assert.equal(events.at(-1).reason, 'cancelled');
});

test('diagnostic delivery errors cannot change accepted media or retry policy', async () => {
  for (const onDiagnostic of [() => { throw new Error('observer failed'); }, async () => { throw new Error('async observer failed'); }]) {
    const [file] = await downloadMediaAssets([candidate], {
      fetchFile: async () => new Response(png, { headers: { 'content-type': 'image/png' } }), onDiagnostic,
    });
    assert.equal(file.status, 'downloaded');
    assert.deepEqual(new Uint8Array(await file.data.arrayBuffer()), png);
  }
});

test('first source page follows snapshot and captured HTML, structured and serialized media references', () => {
  const otherPage = sourcePage.replace('/6', '/7');
  const snapshots = [{ url: sourcePage, assets: [candidate.url] }, { url: otherPage, assets: [candidate.url] }];
  const capture = { pageUrl: sourcePage, url: 'https://progressme.ru/api/materials/71', data: {
    imageUrl: 'https://cdn.example.org/capture.png',
    Text: '<img src="/html.png">',
    Images: [{ Url: '/structured.png' }],
    JsonData: JSON.stringify({ imageUrl: '/serialized.png' }),
  } };
  const assets = collectAssets(snapshots, [capture]);
  assert.equal(assets.length, 5);
  assert.ok(assets.every(asset => asset.sourcePage === sourcePage));
});

test('direct media reader validation still rejects a truncated PNG without an observer', async () => {
  await assert.rejects(readMediaResponse(new Response(png, { headers: { 'content-type': 'text/plain' } }), {}),
    error => error.reason === 'invalid_png' && /повреждённый PNG/.test(error.message));
});
