import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { prepareSourceSite } from '../src/lib/source-site-registration.js';
import { hydrateSourceOrigins, isTrustedSourceOrigin, rememberSourceOrigin } from '../src/lib/source-origins.js';
import { isSourceUrl } from '../src/lib/state.js';
import { sourceBookKey } from '../src/lib/book-workspaces.js';
import { createExportPackage } from '../src/lib/package.js';
import { buildMediaRequestUrls } from '../src/lib/media-request-urls.js';

const book = origin => `${origin}/cabinet/school/materials/book/71/content`;
function browser({ compatible = true, granted = true, blocked = false } = {}) {
  const calls = [], saved = {}, permissions = new Set();
  return { calls, saved,
    storage: { local: { async get(key) { return { [key]: saved[key] }; }, async set(value) { Object.assign(saved, value); } } },
    permissions: {
      async contains({ origins }) { return origins.every(value => permissions.has(value)); },
      async request(value) { calls.push({ kind: 'permission', ...value }); if (granted) value.origins.forEach(item => permissions.add(item)); return granted; },
      async remove({ origins }) { calls.push({ kind: 'remove', origins }); origins.forEach(item => permissions.delete(item)); },
    },
    scripting: {
      async executeScript(value) {
        calls.push({ kind: 'execute', ...value });
        const result = value.func ? vm.runInNewContext(`(${value.func.toString()})()`, {
          document: { querySelector: () => compatible ? {} : null },
          __thedesharNavigation: { inspect: () => ({ kind: 'book', blocked }) },
          location: { href: book('https://school-one.example') },
        }) : undefined;
        return [{ frameId: 0, result }];
      },
      async getRegisteredContentScripts() { return []; },
      async registerContentScripts(value) { calls.push({ kind: 'register', value }); },
    },
  };
}

test('a user-selected compatible white label is connected only on its exact origin', async () => {
  const chrome = browser();
  const tab = { id: 7, url: book('https://school-one.example') };
  assert.equal(isSourceUrl(tab.url), false);
  await prepareSourceSite(chrome, tab);
  assert.equal(isSourceUrl(tab.url), true);
  assert.equal(isSourceUrl(book('https://school-two.example')), false);
  assert.deepEqual(chrome.calls.find(call => call.kind === 'permission').origins, ['https://school-one.example/*']);
  const scripts = chrome.calls.find(call => call.kind === 'register').value;
  assert.deepEqual(scripts.map(script => script.world).sort(), ['ISOLATED', 'MAIN']);
  for (const script of scripts) {
    assert.deepEqual(script.matches, ['https://school-one.example/*']);
    assert.equal(script.runAt, 'document_start');
    assert.equal(script.allFrames, false);
  }
  assert.notEqual(sourceBookKey(tab.url), sourceBookKey(book('https://progressme.ru')));
  const coverUrl = 'https://cdn.example/cover.jpg';
  const snapshot = { url: tab.url, title: 'White-label book', coverUrl };
  const prepared = createExportPackage({ snapshots: [snapshot], collection: { rootUrl: tab.url, title: 'White-label book', status: 'finished' } });
  assert.equal(prepared.manifest.inventory.hierarchy.materials[0].coverUrl, coverUrl);
  assert.equal(prepared.manifest.inventory.hierarchy.materials[0].title, 'White-label book');
  const media = `${new URL(tab.url).origin}/files/LessonExerciseImages/12345678-1234-1234-1234-123456789abc`;
  assert.equal(buildMediaRequestUrls([{ url: media }]).get(media).url, media, 'A white label must not infer another provider CDN');
  await hydrateSourceOrigins(chrome);
  assert.equal(isTrustedSourceOrigin('https://school-one.example'), true);
});

test('an unrelated application is rejected and the new site permission is removed', async () => {
  const chrome = browser({ compatible: false });
  await hydrateSourceOrigins(chrome);
  await assert.rejects(prepareSourceSite(chrome, { id: 7, url: book('https://school-one.example') }), /не поддерживается|не удалось распознать/i);
  assert.equal(chrome.calls.some(call => call.kind === 'register'), false);
  assert.ok(chrome.calls.some(call => call.kind === 'remove'));
  assert.equal(isTrustedSourceOrigin('https://school-one.example'), false);
});

test('denied permissions and unsupported routes cannot install observers', async () => {
  const chrome = browser({ granted: false });
  await assert.rejects(prepareSourceSite(chrome, { id: 7, url: book('https://school-one.example') }), /доступ/i);
  assert.equal(chrome.calls.some(call => call.kind === 'execute'), false);
  const unsupported = browser();
  await assert.rejects(prepareSourceSite(unsupported, { id: 7, url: 'https://unrelated.example/students' }), /содержание книги/i);
  assert.equal(unsupported.calls.length, 0);
});

test('a recognizable app with blocked navigation still connects for its specific diagnostic', async () => {
  const chrome = browser({ blocked: true });
  const result = await prepareSourceSite(chrome, { id: 7, url: book('https://school-one.example') });
  assert.equal(result.connected, true);
  assert.ok(chrome.calls.some(call => call.kind === 'register'));
});

test('built-in sources and missing optional browser APIs keep existing behavior', async () => {
  await hydrateSourceOrigins({});
  const result = await prepareSourceSite({}, { id: 7, url: book('https://progressme.ru') });
  assert.equal(result.origin, 'https://progressme.ru');
  assert.equal(isSourceUrl(book('https://progressme.ru')), true);
});

test('a saved source loses trust when its permission is removed', async () => {
  const chrome = browser();
  chrome.saved['source-sites-v1'] = ['https://school-one.example'];
  await hydrateSourceOrigins(chrome);
  assert.equal(isTrustedSourceOrigin('https://school-one.example'), false);
  assert.equal(isTrustedSourceOrigin('https://progressme.ru'), true);
});

test('an older hydration cannot remove a site connected while it was reading permissions', async () => {
  const chrome = browser();
  chrome.saved['source-sites-v1'] = ['https://old-school.example'];
  let release, reached;
  const reading = new Promise(resolve => { reached = resolve; });
  chrome.permissions.contains = () => new Promise(resolve => { release = resolve; reached(); });
  const restoring = hydrateSourceOrigins(chrome);
  await reading;
  await rememberSourceOrigin(chrome, 'https://new-school.example');
  release(true);
  await restoring;
  assert.equal(isTrustedSourceOrigin('https://new-school.example'), true);
});
