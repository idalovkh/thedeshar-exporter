import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { assertExportFilesReady } from '../src/lib/export-readiness.js';
import { downloadMediaAssets } from '../src/ui/assets.js';

const path = '/files/LessonExerciseImages/883a1997-622d-447f-8910-0a7dd7ba2040.png';
const cdn = `https://media-a.edvibe.com${path}`;
const sourcePage = section => `https://progressme.ru/lesson-editor/book/1/lesson/2/section/${section}`;
const alias = (section, query = '') => `${sourcePage(section)}${path}${query}`;
const asset = (id, url, source = sourcePage(1)) => ({ id: `asset-${id}`, url, name: `${id}.png`, sourcePage: source });
const sharedAssets = () => [asset('first', alias(1)), asset('cdn', cdn), asset('last', alias(2), sourcePage(2))];
const response = (body = 'source') => new Response(body, { headers: { 'content-type': 'image/png' } });

test('exact resolved URL aliases reuse one active preparation and its admitted result', async () => {
  const assets = sharedAssets();
  const requests = [], permissions = [], diagnostics = [];
  let finish, started, conversions = 0;
  const ready = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { finish = resolve; });
  let progress;
  const job = downloadMediaAssets(assets, {
    deduplicate: true, concurrency: 2, maxTotalBytes: 4,
    hasPermission: async origin => { permissions.push(origin); return true; },
    async fetchFile(url) {
      requests.push(url);
      started();
      await blocked;
      return response();
    },
    async optimizeMedia() {
      conversions++;
      return { data: new Blob(['webp'], { type: 'image/webp' }), mimeType: 'image/webp' };
    },
    onProgress: value => { progress = value; },
    onDiagnostic: event => diagnostics.push(event),
  });
  await ready;
  await setImmediate();
  finish();
  const files = await job;
  assert.deepEqual(requests, [cdn]);
  assert.deepEqual(permissions, ['https://media-a.edvibe.com/*']);
  assert.equal(conversions, 1);
  assert.doesNotThrow(() => assertExportFilesReady(files, assets));
  assert.deepEqual(files.map(({ id, url, name, mimeType }) => [id, url, name, mimeType]),
    assets.map(({ id, url, name }) => [id, url, name.replace(/\.png$/, '.webp'), 'image/webp']));
  assert.ok(files.every(file => file.data === files[0].data));
  assert.equal(progress.completed, assets.length);
  assert.equal(progress.loadedBytes, 'source'.length);
  assert.equal(progress.retainedBytes, 'webp'.length);
  const finished = diagnostics.filter(event => event.status === 'downloaded')
    .sort((a, b) => a.assetId.localeCompare(b.assetId));
  assert.deepEqual(finished.map(event => [event.assetId, event.url, event.sourcePage, event.receivedBytes]), [
    ['asset-cdn', cdn, sourcePage(1), 0], ['asset-first', cdn, sourcePage(1), 6], ['asset-last', cdn, sourcePage(2), 0],
  ]);
});

test('distinct request queries still fetch independently and keep their response types', async () => {
  const assets = [asset('one', alias(1, '?v=1')), asset('two', alias(2, '?v=2')),
    asset('cdn-one', `${cdn}?v=1`), asset('cdn-two', `${cdn}?v=2`)];
  const requests = [];
  const files = await downloadMediaAssets(assets, {
    deduplicate: true,
    fetchFile: async url => {
      requests.push(url);
      const first = url.endsWith('?v=1');
      return new Response(first ? 'one' : 'two', {
        headers: { 'content-type': first ? 'image/png' : 'application/octet-stream' },
      });
    },
  });
  assert.deepEqual(requests.sort(), [`${cdn}?v=1`, `${cdn}?v=2`]);
  assert.deepEqual(await Promise.all(files.map(file => file.data.text())), ['one', 'two', 'one', 'two']);
  assert.deepEqual(files.map(file => file.mimeType), ['image/png', 'application/octet-stream',
    'image/png', 'application/octet-stream']);
});

test('reuse is scoped to one export and cannot admit an unavailable reference', async () => {
  const assets = [{ ...asset('private', alias(1)), downloadUnavailable: true }, asset('cdn', cdn)];
  const requests = [];
  const options = {
    deduplicate: true,
    fetchFile: async url => {
      requests.push(url);
      return response(String(requests.length));
    },
  };
  const first = await downloadMediaAssets(assets, options);
  const second = await downloadMediaAssets(assets, options);
  assert.deepEqual(requests, [cdn, cdn]);
  assert.equal(first[0].status, 'unavailable');
  assert.equal(second[0].status, 'unavailable');
  assert.equal(await first[1].data.text(), '1');
  assert.equal(await second[1].data.text(), '2');
});

test('aliases share retries and a terminal failure keeps its reason for each reference', async () => {
  const assets = sharedAssets();
  for (const succeeds of [true, false]) {
    let attempts = 0;
    const events = [];
    const files = await downloadMediaAssets(assets, {
      deduplicate: true, retryDelayMs: 0,
      fetchFile: async () => {
        attempts++;
        if (attempts < 3) return new Response('', { status: 503 });
        return succeeds ? response() : new Response('Forbidden', { status: 403 });
      },
      onDiagnostic: event => events.push(event),
    });
    assert.equal(attempts, 3);
    assert.ok(files.every(file => file.status === (succeeds ? 'downloaded' : 'failed')));
    if (!succeeds) {
      assert.throws(() => assertExportFilesReady(files, assets), { code: 'incomplete_export' });
      const failures = events.filter(event => event.status === 'failed');
      assert.deepEqual(failures.map(event => event.assetId).sort(), assets.map(item => item.id).sort());
      assert.ok(failures.every(event => event.url === cdn && event.reason === 'http_error'));
    }
  }
});

test('a shared download timeout marks every reference with the timeout reason', async () => {
  const assets = sharedAssets();
  const events = [];
  let requests = 0;
  const files = await downloadMediaAssets(assets, {
    deduplicate: true, timeoutMs: 10,
    fetchFile: async (_url, { signal }) => {
      requests++;
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
    onDiagnostic: event => events.push(event),
  });
  assert.equal(requests, 1);
  assert.ok(files.every(file => file.status === 'failed' && /не передавал данные/.test(file.error)));
  const failures = events.filter(event => event.status === 'failed');
  assert.equal(failures.length, assets.length);
  assert.ok(failures.every(event => event.reason === 'timeout'));
});

test('canceling stops the shared request and leaves queued references unfetched', async () => {
  const controller = new AbortController();
  const requests = [], assets = [...sharedAssets(), asset('other', `${cdn}?v=2`)];
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const job = downloadMediaAssets(assets, {
    deduplicate: true, signal: controller.signal, concurrency: 2,
    fetchFile: async (url, { signal }) => {
      requests.push(url);
      started();
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  const canceled = assert.rejects(job, { name: 'AbortError' });
  await ready;
  await setImmediate();
  controller.abort();
  await canceled;
  assert.deepEqual(requests, [cdn]);
});
