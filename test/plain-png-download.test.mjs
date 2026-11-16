import assert from 'node:assert/strict';
import test from 'node:test';
import { collectAssets, downloadMediaAssets, readMediaResponse } from '../src/ui/assets.js';
import { createExportPackage } from '../src/lib/package.js';
import { assertExportFilesReady } from '../src/lib/export-readiness.js';
import { buildZipBlob } from '../src/lib/archive.js';
import { appendProblemEvent, createProblemReport } from '../src/lib/problem-report.js';

// A complete 1x1 RGBA PNG, generated independently with Python's zlib/CRC32.
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNoWHDiPwAGdALoLm59EwAAAABJRU5ErkJggg==', 'base64'));
const url = 'https://media.docstorio.com/files/Rules/4cd13f5d-6524-491f-9385-e9c5b984acf3';
const sourcePage = 'https://platform.desharschool.ru/lesson-editor/book/857133/lesson/13598190/section/92138616';
const candidate = { id: 'asset-1991', url, name: '4cd13f5d-6524-491f-9385-e9c5b984acf3', sourcePage };
const response = (body = png, headers = {}) => new Response(body, { headers: { 'content-type': 'text/plain; charset=UTF-8', ...headers } });

test('a complete text/plain PNG is archived byte-for-byte with its original URL and corrected MIME', async () => {
  const snapshots = [{ url: sourcePage, assets: [{ url, kind: 'image' }] }];
  const original = structuredClone(snapshots), events = [], progress = [];
  const assets = collectAssets(snapshots);
  let requests = 0, readers = 0;
  const files = await downloadMediaAssets(assets, { onDiagnostic: event => events.push(event),
    onProgress: value => progress.push(value), fetchFile: async address => {
      requests++; assert.equal(address, url);
      const value = response(png, { 'content-length': String(png.length) });
      value.clone = () => assert.fail('Acceptance must not clone the response');
      const getReader = value.body.getReader.bind(value.body);
      value.body.getReader = (...args) => { readers++; return getReader(...args); };
      return value;
    } });
  assert.equal(files[0].status, 'downloaded');
  assert.equal(files[0].mimeType, 'image/png');
  assert.equal(files[0].data.type, 'image/png');
  assert.equal(files[0].url, url);
  assert.equal(requests, 1); assert.equal(readers, 1);
  assert.deepEqual(new Uint8Array(await files[0].data.arrayBuffer()), png);
  assert.equal(progress.at(-1).loadedBytes, png.length);
  assert.doesNotThrow(() => assertExportFilesReady(files, assets));
  const prepared = createExportPackage({ snapshots, assets: files });
  assert.equal(prepared.manifest.inventory.assets[0].url, url);
  assert.equal(prepared.manifest.inventory.assets[0].mimeType, 'image/png');
  const zip = await buildZipBlob(prepared.entries);
  assert.ok(Buffer.from(await zip.arrayBuffer()).includes(Buffer.from(png)));
  assert.deepEqual(snapshots, original);
  const terminal = events.find(event => event.status === 'downloaded');
  assert.equal(terminal.mimeType, 'text/plain');
  assert.equal(terminal.effectiveMimeType, 'image/png');
  assert.equal(terminal.detectedFormat, 'png');
  const report = appendProblemEvent(createProblemReport(), terminal);
  assert.equal(report.events.at(-1).mimeType, 'text/plain');
  assert.equal(report.events.at(-1).effectiveMimeType, 'image/png');
  assert.doesNotMatch(JSON.stringify(report), /137,80|headers|body|charset/);
});

test('PNG correction works without a diagnostic observer across fragmented reads', async () => {
  for (const contentType of ['text/plain', 'Text/Plain; charset=UTF-8']) {
    const body = new ReadableStream({ start(controller) {
      for (const byte of png) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } });
    const progress = [];
    const file = await readMediaResponse(response(body, { 'content-type': contentType }), { onProgress: value => progress.push(value) });
    assert.equal(file.mimeType, 'image/png');
    assert.deepEqual(new Uint8Array(await file.data.arrayBuffer()), png);
    assert.equal(progress.at(-1).loaded, png.length);
    assert.equal(progress.at(-1).total, undefined);
  }
});

test('HTML, JSON, URL text and other unsupported MIME types do not gain a PNG exception', async () => {
  for (const body of ['<!doctype html><html>Login</html>', '{"url":"https://example.org"}', 'https://example.org/image.png', '%PDF-1.7', new Uint8Array([255,216,255])]) {
    await assert.rejects(readMediaResponse(response(body), {}), error => error.reason === 'unsupported_content_type');
  }
  for (const type of ['text/html', 'application/json', 'text/xml']) {
    await assert.rejects(readMediaResponse(response(png, { 'content-type': type }), {}), error => error.reason === 'unsupported_content_type');
  }
});

test('invalid, truncated and extended PNGs remain missing files and preserve the server MIME in reports', async () => {
  const corrupt = png.slice(); corrupt[29] ^= 1;
  for (const body of [corrupt, png.slice(0, -12), new Uint8Array([...png, 0]), png.slice(0, 10)]) {
    const events = [];
    const files = await downloadMediaAssets([candidate], { fetchFile: async () => response(body), onDiagnostic: event => events.push(event) });
    assert.equal(files[0].status, 'failed');
    assert.equal(files[0].data, undefined);
    assert.throws(() => assertExportFilesReady(files), /Архив не создан/);
    const failure = events.find(event => event.status === 'failed');
    assert.equal(failure.reason, 'invalid_png');
    assert.equal(failure.mimeType, 'text/plain');
    assert.equal(failure.effectiveMimeType, undefined);
    assert.equal(appendProblemEvent(createProblemReport(), failure).events.at(-1).reason, 'invalid_png');
  }
});

test('the PNG exception retains range, length and file-budget checks', async () => {
  for (const size of [png.length - 1, png.length + 1]) {
    await assert.rejects(readMediaResponse(response(png, { 'content-length': String(size) }), {}), error => error.reason === 'size_mismatch');
  }
  for (const value of [new Response(png, { status: 206, headers: { 'content-type': 'text/plain' } }), response(png, { 'content-range': 'bytes 0-69/140' })]) {
    await assert.rejects(readMediaResponse(value, {}), error => error.reason === 'partial_response');
  }
  await assert.rejects(readMediaResponse(response(png), { maxBytes: png.length - 1 }), error => error.reason === 'file_limit');
  await assert.rejects(downloadMediaAssets([candidate], { maxTotalBytes: png.length - 1, fetchFile: async () => response() }), error => error.code === 'archive_limit');
});

test('timeouts and cancellation interrupt provisional PNG reads', async () => {
  const events = [];
  await downloadMediaAssets([candidate], { timeoutMs: 10, onDiagnostic: event => events.push(event),
    fetchFile: async () => response(new ReadableStream({ start(controller) { controller.enqueue(png.slice(0, 4)); } })) });
  assert.equal(events.at(-1).reason, 'timeout');
  const abort = new AbortController();
  const task = downloadMediaAssets([candidate], { signal: abort.signal,
    onDiagnostic: event => { if (event.status === 'started') setImmediate(() => abort.abort()); },
    fetchFile: async () => response(new ReadableStream()) });
  await assert.rejects(task, { name: 'AbortError' });
});

test('a network retry starts a new PNG validator and never retains bytes from the failed attempt', async () => {
  let requests = 0;
  const files = await downloadMediaAssets([candidate], { retryDelayMs: 0, fetchFile: async () => {
    requests++;
    if (requests === 1) {
      let sent = false;
      return response(new ReadableStream({ pull(controller) {
        if (!sent) { sent = true; controller.enqueue(png.slice(0, 33)); }
        else controller.error(new TypeError('Network interrupted'));
      } }));
    }
    return response();
  } });
  assert.equal(requests, 2);
  assert.equal(files[0].status, 'downloaded');
  assert.deepEqual(new Uint8Array(await files[0].data.arrayBuffer()), png);
});

test('a malformed text/plain response cannot hold the download open through a stalled cancellation', async () => {
  let cancelled = false;
  const task = downloadMediaAssets([candidate], { fetchFile: async () => response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('<html>Login</html>')); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  })) });
  const files = await Promise.race([task, new Promise((_, reject) => setTimeout(() => reject(new Error('Cancellation stalled')), 100))]);
  assert.equal(cancelled, true);
  assert.equal(files[0].status, 'failed');
  assert.match(files[0].error, /неподдерживаемый тип файла/);
});

test('range and declared-size rejection keep their reason even when response cancellation stalls or rejects', async () => {
  for (const reason of ['partial_response', 'file_limit']) {
    for (const stalled of [false, true]) {
      let cancelled = false;
      const body = new ReadableStream({ cancel() {
        cancelled = true;
        return stalled ? new Promise(() => {}) : Promise.reject(new Error('Cleanup failed'));
      } });
      const headers = { 'content-type': 'text/plain', ...(reason === 'partial_response' ? { 'content-range': 'bytes 0-69/140' } : { 'content-length': '200' }) };
      const task = readMediaResponse(new Response(body, { headers }), { maxBytes: 100 });
      await assert.rejects(Promise.race([task, new Promise((_, reject) => setTimeout(() => reject(new Error('Cancellation stalled')), 100))]), error => error.reason === reason);
      assert.equal(cancelled, true);
    }
  }
});
