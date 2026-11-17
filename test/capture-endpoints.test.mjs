import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const sources = await Promise.all(['section-visit.js', 'hook.js', 'content.js'].map(name =>
  readFile(new URL(`../src/capture/${name}`, import.meta.url), 'utf8')));
const lessonUrl = 'https://edvibe.com/lesson-editor/book/1/lesson/2/section/3';
const definitions = { Class: 'GetExerciseWsController', Method: 'LoadExercises', IsSuccess: true,
  ProjectName: 'Exercises', Value: { SectionId: 3, Count: 1, Items: [{ Id: 4, Type: 10,
    SectionId: 3, Name: 'Choose a word', QuestionWithCodingTexts: [{ Text: 'A [cat] sleeps.' }],
    Answers: [{ PupilId: 5, Answer: 'private-answer' }] }] } };

async function capturePage({ enabled = true } = {}) {
  const listeners = [], messages = [];
  let pending = 0, windowRef;
  class Socket {
    constructor() { this.listeners = []; }
    addEventListener(type, callback) { if (type === 'message') this.listeners.push(callback); }
    send() {}
    receive(data) { this.listeners.forEach(callback => callback({ data })); }
  }
  class XHR {
    constructor() { this.responseType = 'json'; this.listeners = []; }
    open() {}
    send() {}
    addEventListener(type, callback) { if (type === 'loadend') this.listeners.push(callback); }
    complete(url, data) { this.responseURL = url; this.response = data; this.listeners.forEach(callback => callback()); }
  }
  const page = { location: new URL(lessonUrl), URL, crypto, TextEncoder, TextDecoder, ArrayBuffer, Blob,
    WebSocket: Socket, XMLHttpRequest: XHR,
    fetch: async () => new Response(JSON.stringify(definitions), { headers: { 'content-type': 'application/json' } }),
    addEventListener(type, callback) { if (type === 'message') listeners.push(callback); },
    postMessage(data) {
      pending++;
      setImmediate(() => {
        try { listeners.forEach(callback => callback({ source: windowRef, origin: page.location.origin, data })); }
        finally { pending--; }
      });
    },
    chrome: { runtime: {
      onMessage: { addListener() {} },
      async sendMessage(message) {
        messages.push(message);
        return message.type === 'CAPTURE_READY' ? { enabled, captureId: 'endpoint-test-capture-0001' } : { ok: true };
      },
    } },
  };
  page.window = page;
  const context = vm.createContext(page);
  windowRef = vm.runInContext('window', context);
  for (const source of sources) vm.runInContext(source, context);
  const settle = async () => {
    do { await new Promise(resolve => setImmediate(resolve)); } while (pending);
  };
  await settle();
  return { page, settle, events: () => messages.filter(message => message.type === 'CAPTURE_EVENT') };
}

for (const endpoint of ['wss://proxy.edvibe.com/websocket', 'wss://edvibe.com/websocket',
  'wss://materials.other-school.example:8443/stream']) {
  test(`authored WebSocket responses reach the bridge from ${endpoint}`, async () => {
    const env = await capturePage();
    new env.page.WebSocket(`${endpoint}?token=private-token`).receive(JSON.stringify(definitions));
    await env.settle();
    assert.equal(env.events().length, 1);
    const event = env.events()[0].event;
    assert.equal(event.url, endpoint);
    assert.equal(event.data.Value.Items[0].QuestionWithCodingTexts[0].Text, 'A [cat] sleeps.');
    assert.equal(event.data.Value.Items[0].Answers, undefined);
    assert.ok(!JSON.stringify(event).includes('private-'));
  });
}

test('authored fetch and XHR responses reach the bridge from arbitrary domains', async () => {
  const env = await capturePage();
  await env.page.fetch('https://api.other-school.example/materials');
  const xhr = new env.page.XMLHttpRequest();
  xhr.open('GET', 'https://content.third-provider.example/exercises');
  xhr.send();
  xhr.complete('https://content.third-provider.example/exercises', definitions);
  await env.settle();
  assert.deepEqual(env.events().map(message => message.event.kind).sort(), ['fetch', 'xhr']);
});

test('arbitrary endpoints still require active material capture and authored content', async () => {
  const env = await capturePage();
  const socket = new env.page.WebSocket('wss://api.other-school.example/stream');
  socket.receive(JSON.stringify({ profile: { email: 'private@example.com' } }));
  new env.page.WebSocket('wss://api.other-school.example/students').receive(JSON.stringify(definitions));
  await env.settle();
  assert.equal(env.events().length, 0);
  env.page.location.pathname = '/cabinet/school/students';
  socket.receive(JSON.stringify(definitions));
  await env.settle();
  assert.equal(env.events().length, 0);
  const disabled = await capturePage({ enabled: false });
  new disabled.page.WebSocket('wss://api.other-school.example/stream').receive(JSON.stringify(definitions));
  await disabled.settle();
  assert.equal(disabled.events().length, 0);
});
