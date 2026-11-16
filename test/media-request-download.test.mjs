import assert from 'node:assert/strict';
import test from 'node:test';
import { collectAssets, downloadMediaAssets, mediaOrigins } from '../src/ui/assets.js';
import { createExportPackage } from '../src/lib/package.js';
import { assertExportFilesReady } from '../src/lib/export-readiness.js';
import { buildZipBlob } from '../src/lib/archive.js';
import { appendProblemEvent, createProblemReport } from '../src/lib/problem-report.js';

const filename = '883a1997-622d-447f-8910-0a7dd7ba2040.jpg';
const storagePath = `/files/LessonExerciseImages/${filename}`;
const sourcePage = 'https://platform.desharschool.ru/lesson-editor/book/857133/lesson/13598158/section/66570000';
const alias = `https://platform.desharschool.ru/lesson-editor/book/857133/lesson/13598158/section${storagePath}`;
const fallback = `https://media-y.progressme.ru${storagePath}`;
const jpeg = new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 255, 217]);
const candidate = (id, url) => ({ id: `asset-${id}`, url, name: filename, sourcePage });
const imageResponse = () => new Response(jpeg, { headers: { 'content-type': 'image/jpeg', 'content-length': String(jpeg.length) } });

function zipEntries(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer), entries = new Map();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    assert.equal(view.getUint16(offset + 8, true), 0);
    const size = view.getUint32(offset + 18, true), nameLength = view.getUint16(offset + 26, true);
    const start = offset + 30 + nameLength + view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    entries.set(name, bytes.subarray(start, start + size));
    offset = start + size;
  }
  return entries;
}

test('the reported nested image URL downloads from the media host while its archive alias and author data stay intact', async () => {
  const snapshots = [{ url: sourcePage, title: 'Section', assets: [] }];
  const captures = [{ kind: 'websocket', url: 'wss://proxy.progressme.ru/websocket', pageUrl: sourcePage,
    data: { Class: 'GetExerciseWsController', Method: 'LoadExercises', IsSuccess: true, ProjectName: 'Exercises',
      Value: { Items: [{ Id: 42, Type: 27, Images: [{ Url: `files/LessonExerciseImages/${filename}` }] }] } } }];
  const before = structuredClone({ snapshots, captures });
  const assets = collectAssets(snapshots, captures);
  assert.equal(assets[0].url, alias);
  assert.deepEqual(mediaOrigins(assets), ['https://media-y.progressme.ru/*']);
  const permissions = [], requested = [], events = [];
  const files = await downloadMediaAssets(assets, {
    hasPermission: async origin => { permissions.push(origin); return true; },
    fetchFile: async (url, options) => {
      requested.push(url);
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      return imageResponse();
    }, onDiagnostic: event => events.push(event),
  });
  assert.deepEqual(requested, [fallback]);
  assert.deepEqual(permissions, ['https://media-y.progressme.ru/*']);
  assert.equal(files[0].url, alias);
  assert.doesNotThrow(() => assertExportFilesReady(files, assets));
  assert.equal(events.find(event => event.status === 'downloaded').url, fallback);
  assert.equal(events.find(event => event.status === 'downloaded').sourcePage, sourcePage);
  const prepared = createExportPackage({ snapshots, captures, assets: files });
  const archive = zipEntries(await (await buildZipBlob(prepared.entries)).arrayBuffer());
  const manifest = JSON.parse(new TextDecoder().decode(archive.get('manifest.json')));
  const media = manifest.inventory.assets[0];
  assert.equal(media.url, alias);
  assert.deepEqual(archive.get(media.file), jpeg);
  const original = JSON.parse(new TextDecoder().decode(archive.get(manifest.inventory.responses[0].file)));
  assert.deepEqual(original, before.captures[0]);
  assert.equal(new URL(original.data.Value.Items[0].Images[0].Url, original.pageUrl).href, media.url);
  assert.deepEqual({ snapshots, captures }, before);
});

test('an explicit Edvibe URL is used for image and audio aliases independently of inventory order', async () => {
  for (const family of ['LessonExerciseImages', 'LessonExerciseAudios', 'WordExerciseAudios']) {
    const path = `/files/${family}/${filename}`;
    const source = `https://progressme.ru/lesson-editor/book/1/lesson/2/section${path}`;
    const observed = `https://media-a.edvibe.com${path}`;
    for (const reversed of [false, true]) {
      const assets = [candidate('alias', source), candidate('observed', observed)];
      if (reversed) assets.reverse();
      assert.deepEqual(mediaOrigins(assets), ['https://media-a.edvibe.com/*']);
      const requested = [];
      const files = await downloadMediaAssets(assets, { fetchFile: async url => { requested.push(url); return imageResponse(); } });
      assert.deepEqual(requested, [observed, observed]);
      assert.deepEqual(files.map(file => file.url), assets.map(asset => asset.url));
      assert.doesNotThrow(() => assertExportFilesReady(files, assets));
    }
  }
});

test('a media-host permission refusal cannot fall back to an already allowed editor origin', async () => {
  const permissions = [];
  const [file] = await downloadMediaAssets([candidate('alias', alias)], {
    hasPermission: async origin => { permissions.push(origin); return origin === 'https://platform.desharschool.ru/*'; },
    fetchFile: async () => { assert.fail('No file request is authorized'); },
  });
  assert.deepEqual(permissions, ['https://media-y.progressme.ru/*']);
  assert.equal(file.status, 'skipped');
  assert.equal(file.url, alias);
});

test('different observed targets reject only the ambiguous alias and keep that reason in the report', async () => {
  const observed = [`https://media-a.edvibe.com${storagePath}`, `https://media-b.edvibe.com${storagePath}`];
  const assets = [candidate('alias', alias), ...observed.map((url, index) => candidate(String(index), url))];
  const requested = [], events = [];
  const files = await downloadMediaAssets(assets, { fetchFile: async url => { requested.push(url); return imageResponse(); }, onDiagnostic: event => events.push(event) });
  assert.deepEqual(requested.sort(), observed.sort());
  assert.equal(files[0].status, 'failed');
  assert.equal(files[0].url, alias);
  assert.match(files[0].error, /однозначно/);
  assert.throws(() => assertExportFilesReady(files, assets), /Архив не создан/);
  const event = events.find(event => event.assetId === 'asset-alias' && event.status === 'failed');
  assert.equal(event.reason, 'ambiguous_media_url');
  const report = appendProblemEvent(createProblemReport(), event);
  assert.equal(report.events.at(-1).reason, 'ambiguous_media_url');
});

test('HTML from the resolved request still blocks export and reports the actual host', async () => {
  const assets = [candidate('alias', alias)], events = [];
  const files = await downloadMediaAssets(assets, { onDiagnostic: event => events.push(event),
    fetchFile: async () => new Response('<!doctype html><html>Unavailable</html>', { headers: { 'content-type': 'text/html' } }) });
  assert.equal(files[0].status, 'failed');
  assert.throws(() => assertExportFilesReady(files, assets), /Архив не создан/);
  const failure = events.find(event => event.status === 'failed');
  assert.equal(failure.url, fallback);
  assert.equal(failure.reason, 'unsupported_content_type');
  assert.equal(failure.detectedFormat, 'html');
});

test('a temporary source alias cannot become a public fallback request', async () => {
  const assets = collectAssets([{ url: sourcePage, assets: [`${alias}?token=private-link`] }]);
  assert.equal(assets[0].downloadUnavailable, true);
  assert.deepEqual(mediaOrigins(assets), []);
  const [file] = await downloadMediaAssets(assets, { fetchFile: async () => { assert.fail('The temporary alias must not be requested'); } });
  assert.equal(file.status, 'unavailable');
  assert.equal(file.url, alias);
  assert.doesNotMatch(JSON.stringify(file), /private-link/);
});
