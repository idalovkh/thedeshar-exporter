import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { appendCapture, createWorkspace } from '../src/lib/state.js';
import { collectAssets } from '../src/ui/assets.js';
import { createExportPackage } from '../src/lib/package.js';

const [hook, visit, content] = await Promise.all(['hook', 'section-visit', 'content']
  .map(name => readFile(new URL(`../src/capture/${name}.js`, import.meta.url), 'utf8')));
const bookUrl = 'https://platform.desharschool.ru/cabinet/school/materials/book/71/content';

function page({ main = true } = {}) {
  const listeners = [], posts = [], events = [];
  let windowRef, pending = 0;
  class Socket {
    constructor(url) { this.url = url; this.listeners = []; }
    addEventListener(type, callback) { if (type === 'message') this.listeners.push(callback); }
    send() {}
    receive(value) { this.listeners.forEach(callback => callback({ data: JSON.stringify(value) })); }
  }
  class XHR { open() {} send() {} addEventListener() {} }
  const window = { location: new URL(bookUrl), URL, TextEncoder, TextDecoder, ArrayBuffer, Blob, crypto,
    WebSocket: Socket, XMLHttpRequest: XHR, fetch: async () => {}, setTimeout, clearTimeout,
    document: { title: 'Book', querySelector: () => null, querySelectorAll: () => [], body: { querySelectorAll: () => [] } },
    history: { pushState() {}, replaceState() {} }, navigation: { addEventListener() {} },
    addEventListener(type, callback) { if (type === 'message') listeners.push(callback); },
    postMessage(data) {
      posts.push(data); pending++;
      setImmediate(() => { try { listeners.forEach(callback => callback({ data, source: windowRef, origin: window.location.origin })); } finally { pending--; } });
    },
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async message => {
      if (message.type === 'CAPTURE_EVENT') events.push(message.event);
      return message.type === 'CAPTURE_READY' ? { enabled: true, captureId: 'capture-group-covers-0001' } : { ok: true };
    } } },
  };
  window.window = window;
  const context = vm.createContext(window);
  windowRef = vm.runInContext('window', context);
  vm.runInContext(visit, context);
  if (main) vm.runInContext(hook, context);
  vm.runInContext(content, context);
  const drain = async () => { do { await new Promise(resolve => setImmediate(resolve)); } while (pending); };
  return { window, posts, events, drain,
    receive(value) { const socket = new window.WebSocket('wss://proxy.progressme.ru/websocket'); socket.receive(value); },
    direct(value) {
      const state = posts.find(post => post.type === 'CAPTURE_STATE');
      window.postMessage({ source: 'thedeshar-exporter-v1', direction: 'event', channel: state.channel, revision: state.revision,
        event: { kind: 'websocket', url: 'wss://proxy.progressme.ru/websocket', data: value } });
    },
  };
}

function inventory(Class = 'CourseWsController') {
  return { Class, Method: 'GetBookCourses', ProjectName: 'Books', IsSuccess: true, UserId: 'private-owner', Value: [
    { Id: 9, Name: 'Empty group', CountLesson: 0, BookId: 71, ImageUrl: 'https://cdn.example.org/group.jpg?signature=private-secret&size=2', Students: ['private-pupil'] },
    { Id: 10, Name: 'Foreign book group', CountLesson: 1, BookId: 99 },
    { Id: 11, Name: 'Cleared image', CountLesson: 0, ImageUrl: null },
    { Id: 12, Name: 'Empty image', CountLesson: 0, ImageUrl: '' },
    { Id: 13, Name: 'Malformed image', CountLesson: 0, ImageUrl: { user: 'private-person' } },
  ] };
}

for (const main of [true, false]) {
  test(`group covers pass ${main ? 'MAIN and ISOLATED' : 'independent ISOLATED'} capture and storage without account data`, async () => {
    const app = page({ main });
    await app.drain();
    for (const Class of ['CourseWsController', 'SharingMaterialWsController']) {
      if (main) app.receive(inventory(Class)); else app.direct(inventory(Class));
      await app.drain();
    }
    assert.equal(app.events.length, 2);
    for (const event of app.events) {
      const saved = appendCapture(createWorkspace(7), { ...event, pageUrl: bookUrl }).captures[0];
      assert.ok(saved);
      for (const value of [event.data.Value, saved.data.Value]) {
        assert.equal(value[0].ImageUrl, 'https://cdn.example.org/group.jpg?size=2');
        assert.equal(value[0].BookId, 71);
        assert.equal(value[1].BookId, 99, 'retain conflicting book identity so the importer can reject the foreign inventory');
        assert.equal(Object.hasOwn(value[2], 'BookId'), false);
        assert.equal(Object.hasOwn(value[1], 'ImageUrl'), false);
        assert.equal(value[2].ImageUrl, null);
        assert.equal(value[3].ImageUrl, '');
        assert.equal(Object.hasOwn(value[4], 'ImageUrl'), false);
      }
      const assets = collectAssets([], [saved]);
      assert.deepEqual(assets.map(asset => asset.url), ['https://cdn.example.org/group.jpg?size=2']);
      const packaged = createExportPackage({ captures: [saved] });
      const response = JSON.parse(packaged.entries.find(entry => entry.name.startsWith('originals/responses/')).data);
      assert.equal(response.data.Value[0].BookId, 71);
      assert.equal(response.data.Value[1].BookId, 99);
      assert.doesNotMatch(JSON.stringify(saved), /private-|Students|UserId|user/);
    }
  });
}

test('persisted group inventories independently retain authored cover references', () => {
  const saved = appendCapture(createWorkspace(7), { kind: 'websocket', url: 'wss://proxy.progressme.ru/websocket',
    pageUrl: bookUrl, data: inventory() }).captures[0];
  assert.equal(saved.data.Value[0].ImageUrl, 'https://cdn.example.org/group.jpg?size=2');
  assert.equal(saved.data.Value[0].BookId, 71);
  assert.equal(saved.data.Value[1].BookId, 99);
  assert.equal(saved.data.Value[2].ImageUrl, null);
  assert.equal(Object.hasOwn(saved.data.Value[4], 'ImageUrl'), false);
  assert.doesNotMatch(JSON.stringify(saved), /private-|Students|UserId/);
});
