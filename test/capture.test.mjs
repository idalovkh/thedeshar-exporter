import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { appendCapture, appendSnapshot, createWorkspace } from '../src/lib/state.js';
import { collectAssets } from '../src/ui/assets.js';
import { assertExportFilesReady } from '../src/lib/export-readiness.js';

const hookSource = await readFile(new URL('../src/capture/hook.js', import.meta.url), 'utf8');
const visitSource = await readFile(new URL('../src/capture/section-visit.js', import.meta.url), 'utf8');
const contentSource = await readFile(new URL('../src/capture/content.js', import.meta.url), 'utf8');
const baseUrl = 'https://platform.desharschool.ru/lesson-editor/book/1254486/lesson/20349346/section/100346962';
const captureBytes = 8 * 1024 * 1024;
let pendingWindowMessages = 0;
const postTask = callback => {
  pendingWindowMessages++;
  setImmediate(() => { try { callback(); } finally { pendingWindowMessages--; } });
};
const tick = async () => {
  do { await new Promise(resolve => setImmediate(resolve)); } while (pendingWindowMessages);
};

function makePage({ readyEnabled = false, pathname, document } = {}) {
  const location = new URL(baseUrl);
  if (pathname) location.pathname = pathname;
  const listeners = [];
  const navigationListeners = [];
  const posts = [];
  const runtimeMessages = [];
  const runtimeListeners = [];
  const requests = [];
  const initialCaptureId = 'test-capture-initial-0000';
  let runtimeCaptureId = readyEnabled ? initialCaptureId : null;
  let captureStarts = 0;
  let explicitCaptureCommands = 0;
  let windowRef;
  class FakeSocket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.listeners = []; }
    addEventListener(type, callback) { if (type === 'message') this.listeners.push(callback); }
    receive(data) { this.listeners.forEach(callback => callback({ data })); }
    send(value) { this.lastSent = value; }
  }
  class FakeXHR {
    constructor() { this.listeners = []; this.responseType = ''; }
    open(...args) { this.openArgs = args; }
    send(...args) { this.sendArgs = args; }
    addEventListener(type, callback) { if (type === 'loadend') this.listeners.push(callback); }
    complete(url, data) { this.responseURL = url; this.responseText = data; this.listeners.splice(0).forEach(callback => callback()); }
  }
  const page = {
    location, URL, TextEncoder, TextDecoder, ArrayBuffer, Blob, crypto,
    document: document || { title: 'Test lesson', querySelector: () => null, querySelectorAll: () => [], body: { querySelectorAll: () => [] } },
    NodeFilter: { SHOW_COMMENT: 128 },
    getComputedStyle: node => ({ display: 'block', visibility: 'visible', ...node.computedStyle }),
    XMLHttpRequest: FakeXHR, WebSocket: FakeSocket,
    fetch(...args) { requests.push(args); return Promise.resolve(page.nextResponse); },
    addEventListener(type, callback) { if (type === 'message') listeners.push(callback); },
    navigation: { addEventListener(type, callback) { if (type === 'currententrychange') navigationListeners.push(callback); } },
    history: {
      pushState(_state, _unused, url) {
        location.href = new URL(url, location).href;
        navigationListeners.forEach(callback => callback({ type: 'currententrychange' }));
      },
      replaceState(_state, _unused, url) {
        location.href = new URL(url, location).href;
        navigationListeners.forEach(callback => callback({ type: 'currententrychange' }));
      },
    },
    postMessage(data) {
      posts.push(data);
      postTask(() => listeners.forEach(callback => callback({ source: windowRef, origin: location.origin, data })));
    },
    setTimeout, clearTimeout,
    chrome: { runtime: {
      sendMessage(message) { runtimeMessages.push(message); return Promise.resolve(message.type === 'CAPTURE_READY' ? { enabled: readyEnabled, captureId: readyEnabled ? initialCaptureId : null } : { ok: true }); },
      onMessage: { addListener(callback) { runtimeListeners.push(callback); } },
    } },
  };
  page.window = page;
  const context = vm.createContext(page);
  vm.runInContext(visitSource, context);
  windowRef = vm.runInContext('window', context);
  let commandRevision = 0;
  const command = async enabled => {
    page.postMessage({ revision: commandRevision++, source: 'thedeshar-exporter-v1', direction: 'command', type: 'CAPTURE_STATE', channel: 'test-channel', enabled });
    await tick();
  };
  const exports = () => posts.filter(message => message.direction === 'event').map(message => message.event);
  const runtimeRequest = message => {
    if (message.type === 'CAPTURE_START' && !Object.hasOwn(message, 'captureId')) {
      message = { ...message, captureId: `test-capture-${String(++captureStarts).padStart(8, '0')}` };
    }
    if (message.type === 'CAPTURE_STOP' && !Object.hasOwn(message, 'captureId')) message = { ...message, captureId: runtimeCaptureId };
    if (['CAPTURE_START', 'CAPTURE_STOP'].includes(message.type)) explicitCaptureCommands++;
    let response, resolve, asynchronous = false, responded = false;
    const pending = new Promise(complete => { resolve = complete; });
    const respond = result => {
      response = result; responded = true;
      if (message.type === 'CAPTURE_START' && response?.enabled) runtimeCaptureId = response.captureId;
      if (message.type === 'CAPTURE_STOP' && response?.enabled === false) runtimeCaptureId = null;
      resolve(result);
    };
    runtimeListeners.forEach(callback => { if (callback(message, {}, respond) === true) asynchronous = true; });
    return responded ? response : asynchronous ? pending : undefined;
  };
  const restoreCaptureId = enabled => { if (!explicitCaptureCommands) runtimeCaptureId = enabled ? initialCaptureId : null; };
  return { page, context, posts, requests, exports, command, runtimeMessages, runtimeRequest, restoreCaptureId };
}

// Small DOM fixture: the capture still executes its actual selection, cloning and
// sanitizing code. No production DOM implementation or extension APIs are replaced.
function element(tag, { classes = '', text = '', attributes = {}, children = [], hidden = false, computedStyle = {} } = {}) {
  const attrs = { ...(classes ? { class: classes } : {}), ...attributes };
  const node = {
    tagName: tag.toUpperCase(), parentElement: null, children, hidden, computedStyle,
    get attributes() { return Object.entries(attrs).map(([name, value]) => ({ name, value })); },
    get textContent() { return text + this.children.map(child => child.textContent).join(''); },
    get innerText() { return hidden ? '' : text + this.children.map(child => child.innerText).join(''); },
    get outerHTML() { return `<${tag}${Object.entries(attrs).map(([name, value]) => ` ${name}="${value}"`).join('')}>${this.innerHTML}</${tag}>`; },
    get innerHTML() { return text + this.children.map(child => child.outerHTML).join(''); },
    getAttribute(name) { return attrs[name] ?? null; },
    setAttribute(name, value) { attrs[name] = value; },
    removeAttribute(name) { delete attrs[name]; },
    getClientRects() {
      // A rendered child also has no box when an ancestor uses display:none.
      for (let current = this; current; current = current.parentElement) {
        if (current.hidden || /(?:^|;)\s*display\s*:\s*none\s*(?:;|$)/i.test(current.getAttribute('style') || '')) return [];
      }
      return [{}];
    },
    matches(selector) {
      return selector.split(',').some(part => {
        const attributes = [...part.matchAll(/\[([^\]=*]+)(\*?=)?(?:"([^"]*)")?\]/g)];
        const bare = part.replace(/\[[^\]]*\]/g, '').trim();
        const tagName = bare.match(/^[a-z][a-z0-9-]*/i)?.[0];
        if (tagName && tagName.toUpperCase() !== this.tagName) return false;
        if ([...bare.matchAll(/\.([\w-]+)/g)].some(([, name]) => !String(attrs.class || '').split(/\s+/).includes(name))) return false;
        return attributes.every(([, name, operator, value]) => operator === '*=' ? attrs[name]?.includes(value) : operator === '=' ? attrs[name] === value : attrs[name] !== undefined);
      });
    },
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; },
    contains(other) { return other === this || this.children.some(child => child.contains(other)); },
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    cloneNode() { return element(tag, { attributes: { ...attrs }, text, hidden, children: this.children.map(child => child.cloneNode(true)) }); },
    remove() { if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; },
  };
  for (const property of ['src', 'href', 'poster', 'data']) Object.defineProperty(node, property, { get: () => attrs[property] ? new URL(attrs[property], baseUrl).href : '' });
  for (const property of ['alt', 'title', 'type']) Object.defineProperty(node, property, { get: () => attrs[property] || '', set: value => { attrs[property] = value; } });
  children.forEach(child => { child.parentElement = node; });
  return node;
}

function documentWith(...nodes) {
  const body = element('body', { children: nodes });
  const document = element('document', { children: [body] });
  document.body = body;
  document.title = 'Test lesson';
  document.createTreeWalker = () => ({ nextNode: () => false });
  return document;
}

async function snapshotWith(document, options = {}) {
  const env = makePage({ document, ...options });
  vm.runInContext(contentSource, env.context);
  await tick();
  return { ...env, response: (await env.runtimeRequest({ type: 'PAGE_SNAPSHOT' })) };
}

function responseFor(data, { url = 'https://platform.desharschool.ru/api/lessons/20349346?token=secret&section=1', type = 'application/json' } = {}) {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  let read = false;
  return {
    url, headers: { get: key => key === 'content-type' ? type : String(bytes.byteLength) },
    clone() { return { body: { getReader() { return {
      async read() { if (read) return { done: true }; read = true; return { value: bytes, done: false }; },
      async cancel() {},
    }; } } }; },
  };
}

test('capture starts inert, redacts credentials and preserves answer keys', async () => {
  const env = makePage();
  vm.runInContext(hookSource, env.context);
  const socket = new env.page.WebSocket('wss://proxy.progressme.ru/websocket?token=socket-secret');
  const payload = { lesson: { id: 1, exercises: [{ answer_key: { correct: 'town' }, content: '<img src="https://cdn.docstorio.com/image.jpg?token=embedded-secret&size=2">' }] }, accessToken: 'secret', sessionId: 'secret', profile: { email: 'private@example.com' } };
  socket.receive(JSON.stringify(payload)); await tick();
  assert.equal(env.exports().length, 0);
  await env.command(true);
  assert.equal(env.exports().length, 1, 'sanitized bootstrap response is released only after capture is enabled');
  socket.receive(JSON.stringify(payload)); await tick();
  const [record] = env.exports();
  assert.equal(record.url, 'wss://proxy.progressme.ru/websocket');
  assert.equal(record.data.lesson.exercises[0].answer_key.correct, 'town');
  assert.equal(record.data.accessToken, undefined);
  assert.equal(record.data.sessionId, undefined);
  assert.equal(record.data.profile.email, undefined);
  assert.ok(!JSON.stringify(record).includes('embedded-secret'));
  assert.ok(record.data.lesson.exercises[0].content.includes('size=2'));
  assert.ok(socket instanceof env.page.WebSocket);
  assert.equal(env.page.WebSocket.OPEN, 1);
  socket.send('original application request');
  assert.equal(socket.lastSent, 'original application request');
  await env.command(false);
  socket.receive(JSON.stringify(payload)); await tick();
  assert.equal(env.exports().length, 2);
  await tick();
});

test('account payloads, unrelated hosts, large frames and SPA non-material pages are excluded', async () => {
  const env = makePage();
  vm.runInContext(hookSource, env.context);
  await env.command(true);
  const privateSocket = new env.page.WebSocket('wss://proxy.progressme.ru/students');
  privateSocket.receive(JSON.stringify({ lessons: [{ id: 1 }] })); await tick();
  const foreignSocket = new env.page.WebSocket('wss://tracker.example/events');
  foreignSocket.receive(JSON.stringify({ lesson: { id: 1 } })); await tick();
  const socket = new env.page.WebSocket('wss://proxy.progressme.ru/websocket');
  socket.receive(JSON.stringify({ profile: { name: 'Private' } })); await tick();
  socket.receive(JSON.stringify({ users: [{ lesson: { id: 1 } }] })); await tick();
  socket.receive(JSON.stringify({ lesson: { text: 'я'.repeat(captureBytes / 2 + 1) } })); await tick();
  assert.equal(env.exports().length, 0);
  env.page.location.pathname = '/cabinet/school/students';
  socket.receive(JSON.stringify({ lesson: { id: 1 } })); await tick();
  assert.equal(env.exports().length, 0);
});

test('confirmed exercise response envelopes pass MAIN, ISOLATED and storage with only author definitions', async () => {
  const env = makePage({ readyEnabled: true });
  vm.runInContext(hookSource, env.context);
  vm.runInContext(contentSource, env.context);
  await tick();
  const socket = new env.page.WebSocket('wss://proxy.progressme.ru/websocket');
  // Shape confirmed in lesson_shell's GetExerciseWsController and exercises_shell
  // ExerciseModel; sample text/IDs are synthetic, not an account export.
  for (const Method of ['LoadExercisesInMaterial', 'LoadExercises']) {
    const response = { Class: 'GetExerciseWsController', Method, IsSuccess: true, ProjectName: 'Exercises', ConnectionId: 'unrelated-session', Value: {
      SectionId: 23, Count: 2, Pupils: [{ Name: 'unrelated-learner' }], Items: [
        { Id: 41, Type: 10, SectionId: 23, Name: 'Choose the word', Number: 1,
          QuestionWithCodingTexts: [{ Text: 'A [cat] sleeps.' }], JsonData: '{"instruction":"Read first"}',
          Answers: { Answers: [{ PupilId: 2, Answer: 'learner-response' }] }, AnswerVersion1: [{ PupilId: 2 }],
          AnswersTeacher: [{ PupilId: 2 }], TopicsPupils: ['private-translation'], EssaysPupils: ['private-essay'],
          SaveAnswerHistoriesRequest: { Answer: 'private-history' }, CurrentPupilId: 2, Statistics: { Score: 4 }, Grades: [4],
        },
        { Id: 42, Type: 5, Test: { Questions: [{ Id: 1, Question: 'Choose A', Answers: ['A', 'B'], QuestionAnswers: ['true', 'false'] }] } },
      ],
    } };
    socket.receive(JSON.stringify(response)); await tick();
    assert.equal(response.Value.Items[0].Answers.Answers[0].Answer, 'learner-response');
  }
  assert.equal(env.exports().length, 2);
  const bridged = env.runtimeMessages.filter(message => message.type === 'CAPTURE_EVENT').map(message => message.event);
  assert.equal(bridged.length, 2, 'the isolated-world bridge must forward both confirmed response methods');
  for (const event of bridged) {
    const saved = appendCapture(createWorkspace(7), { ...event, pageUrl: baseUrl }).captures[0];
    assert.ok(saved, 'the background validator must accept the same envelope as the observer');
    assert.equal(saved.data.Value.Items[0].QuestionWithCodingTexts[0].Text, 'A [cat] sleeps.');
    assert.equal(saved.data.Value.Items[1].Test.Questions[0].QuestionAnswers[0], 'true');
    assert.equal(saved.data.Value.Items[0].JsonData, '{"instruction":"Read first"}');
    assert.equal(saved.data.Value.Count, 2);
    assert.doesNotMatch(JSON.stringify(saved), /unrelated-|learner-response|private-|Pupil|AnswerVersion1|AnswersTeacher|Statistics|Grades|SaveAnswerHistoriesRequest/);
  }
  for (const Method of ['GetLessonWithId', 'GetLessonPreview']) {
    socket.receive(JSON.stringify({ Class: 'LessonWsController', Method, IsSuccess: true, ProjectName: 'Books', Value: { Sections: [{ Id: 23 }], HomeworkSection: { Id: 24 }, Book: { Id: 1 } } })); await tick();
  }
  const metadata = env.runtimeMessages.filter(message => message.type === 'CAPTURE_EVENT').slice(-2);
  assert.equal(metadata.length, 2);
  for (const message of metadata) assert.equal(appendCapture(createWorkspace(7), { ...message.event, pageUrl: baseUrl }).captures.length, 1);
});

test('ISOLATED bridge independently projects page-supplied RPC definitions and rejects commands', async () => {
  const env = makePage({ readyEnabled: true });
  vm.runInContext(contentSource, env.context);
  await tick();
  const channel = env.posts.find(message => message.type === 'CAPTURE_STATE').channel;
  const post = async data => { env.page.postMessage({ source: 'thedeshar-exporter-v1', direction: 'event', revision: 0, channel,
    event: { kind: 'websocket', url: 'wss://proxy.progressme.ru/websocket', data } }); await tick(); };
  const response = { Class: 'GetExerciseWsController', Method: 'LoadExercises', IsSuccess: true, Value: {
    Items: [{ Id: 1, Type: 28, Text: '<p>Read this.</p>', Answers: ['private-attempt'], CurrentPupilId: 5,
      JsonData: JSON.stringify({ imageUrl: '/files/a.png?token=private-url', credentials: { password: 'private-password' }, correctAnswers: ['cat'] }),
      ImagesJson: JSON.stringify([{ url: '/files/b.png?token=private-image-url', accessToken: 'private-access-token' }]),
    }],
    Pupils: [{ Name: 'private-person' }],
  } };
  await post(response);
  await post({ ...response, Class: 'SaveExerciseWsController', Method: 'SaveExercise', Value: { Exercises: [] } });
  await post({ ...response, Class: 'UserWsController', Method: 'GetAccount', Value: { Lessons: [] } });
  const captures = env.runtimeMessages.filter(message => message.type === 'CAPTURE_EVENT');
  assert.equal(captures.length, 1);
  assert.equal(captures[0].event.data.Value.Items[0].Text, '<p>Read this.</p>');
  assert.equal(JSON.parse(captures[0].event.data.Value.Items[0].JsonData).correctAnswers[0], 'cat');
  assert.equal(new URL(JSON.parse(captures[0].event.data.Value.Items[0].ImagesJson)[0].url).pathname, '/files/b.png');
  assert.doesNotMatch(JSON.stringify(captures), /private-|Pupil/);
  await post([response, { Class: 'UserWsController', Method: 'GetAccount', IsSuccess: true, Value: { Lessons: [], Name: 'private-person' } }]);
  const mixed = env.runtimeMessages.filter(message => message.type === 'CAPTURE_EVENT').at(-1);
  assert.equal(mixed.event.data[0].Value.Items[0].Id, 1);
  assert.doesNotMatch(JSON.stringify(mixed), /private-|UserWsController|GetAccount/);
});

test('serialized definition JSON keeps its string type and author answers across MAIN, ISOLATED and persistence', async () => {
  const env = makePage({ readyEnabled: true });
  vm.runInContext(hookSource, env.context);
  vm.runInContext(contentSource, env.context);
  await tick();
  const socket = new env.page.WebSocket('wss://proxy.progressme.ru/websocket');
  const JsonData = JSON.stringify({ imageUrl: '/files/a.png?token=nested-url-secret&width=200',
    config: { credentials: { password: 'nested-password-secret' }, accessToken: 'nested-token-secret' },
    Questions: [{ Answers: ['cat', 'dog'], QuestionAnswers: ['true', 'false'] }],
  });
  const ImagesJson = JSON.stringify([{ url: '/files/b.png?signature=nested-image-secret', title: 'A cat' }]);
  socket.receive(JSON.stringify({ Class: 'GetExerciseWsController', Method: 'LoadExercisesInMaterial', IsSuccess: true, Value: { Items: [
    { Id: 1, Type: 5, JsonData, ImagesJson },
    { Id: 2, Type: 28, JsonData: '[draft text]', ImagesJson: '42' },
    { Id: 3, Type: 28, JsonData: '"author text"', ImagesJson: 'null' },
  ] } })); await tick();
  const main = env.exports()[0];
  const bridged = env.runtimeMessages.find(message => message.type === 'CAPTURE_EVENT')?.event;
  assert.ok(main && bridged);
  const persisted = appendCapture(createWorkspace(7), { ...bridged, pageUrl: baseUrl }).captures[0];
  for (const event of [main, bridged, persisted]) {
    const items = event.data.Value.Items;
    assert.equal(typeof items[0].JsonData, 'string');
    assert.equal(typeof items[0].ImagesJson, 'string');
    const json = JSON.parse(items[0].JsonData);
    assert.equal(new URL(json.imageUrl).pathname, '/files/a.png');
    assert.equal(new URL(json.imageUrl).search, '?width=200');
    assert.equal(json.Questions[0].QuestionAnswers[0], 'true');
    assert.equal(json.Questions[0].Answers[1], 'dog');
    assert.equal(JSON.parse(items[0].ImagesJson)[0].title, 'A cat');
    assert.equal(items[1].JsonData, '[draft text]');
    assert.equal(items[1].ImagesJson, '42');
    assert.equal(items[2].JsonData, '"author text"');
    assert.equal(items[2].ImagesJson, 'null');
    assert.doesNotMatch(JSON.stringify(event), /nested-[\w-]*secret/);
  }
  assert.ok(JsonData.includes('nested-password-secret'), 'sanitization does not alter the source string');
});

test('RPC account responses, write commands, errors and malformed exercise items cannot use the material-key fallback', async () => {
  const env = makePage();
  vm.runInContext(hookSource, env.context);
  await env.command(true);
  const socket = new env.page.WebSocket('wss://proxy.progressme.ru/websocket');
  const definition = { Id: 41, Type: 10, QuestionWithCodingTexts: [{ Text: '[cat]' }] };
  const valid = { Class: 'GetExerciseWsController', Method: 'LoadExercisesInMaterial', IsSuccess: true, Value: { Items: [definition] } };
  for (const response of [
    { ...valid, IsSuccess: false, Value: { ...valid.Value, Exercises: [] } },
    { ...valid, Class: 'SaveExerciseWsController', Method: 'SaveExercise', Value: { Exercises: [definition] } },
    { ...valid, Class: 'UserWsController', Method: 'GetAccount', Value: { Lessons: [] } },
    { ...valid, Method: 'SaveExercise', Value: { Exercises: [definition] } },
    { Controller: valid.Class, Method: valid.Method, Value: { Exercises: [definition] } },
    { ...valid, Value: { Items: [{ Id: 2, Type: 'profile', Exercises: [] }] } },
  ]) socket.receive(JSON.stringify(response)); await tick();
  assert.equal(env.exports().length, 0);
  socket.receive(JSON.stringify({ ...valid, Value: { Items: [], SectionId: 23 } })); await tick();
  assert.equal(env.exports().length, 1, 'an explicitly empty section is useful coverage evidence');
  socket.receive(JSON.stringify([valid, { Class: 'UserWsController', Method: 'GetAccount', IsSuccess: true, Value: { Lessons: [], Name: 'private-person' } }])); await tick();
  assert.equal(env.exports().length, 2);
  assert.doesNotMatch(JSON.stringify(env.exports().at(-1)), /private-person|UserWsController|GetAccount/);
});

test('fetch observes a response clone without replaying or consuming the application response', async () => {
  const env = makePage();
  const originalResponse = responseFor({ lesson: { id: 20349346, sections: [] } });
  env.page.nextResponse = originalResponse;
  vm.runInContext(hookSource, env.context);
  await env.command(true);
  const request = { method: 'POST', headers: { Authorization: 'Bearer request-secret' }, body: 'request-body-secret' };
  const result = await env.page.fetch('/api/lessons/20349346', request);
  await tick();
  assert.equal(result, originalResponse);
  assert.equal(env.requests.length, 1);
  assert.equal(env.requests[0][1], request);
  assert.equal(env.exports().length, 1);
  assert.equal(env.exports()[0].url, 'https://platform.desharschool.ru/api/lessons/20349346?section=1');
  assert.ok(!JSON.stringify(env.exports()).includes('request-secret'));
  assert.ok(!JSON.stringify(env.exports()).includes('request-body-secret'));
});

test('XHR observer leaves request arguments intact and excludes private paths', async () => {
  const env = makePage();
  vm.runInContext(hookSource, env.context);
  await env.command(true);
  const xhr = new env.page.XMLHttpRequest();
  xhr.open('POST', '/api/lessons/1');
  xhr.send('request-body-secret');
  xhr.complete('https://platform.desharschool.ru/api/lessons/1', JSON.stringify({ lesson: { id: 1 } }));
  assert.equal(xhr.sendArgs[0], 'request-body-secret');
  assert.equal(env.exports().length, 1);
  assert.ok(!JSON.stringify(env.exports()).includes('request-body-secret'));
  const privateXhr = new env.page.XMLHttpRequest();
  privateXhr.open('GET', '/api/students/1');
  privateXhr.send();
  privateXhr.complete('https://platform.desharschool.ru/api/students/1', JSON.stringify({ lessons: [] }));
  assert.equal(env.exports().length, 1);
});

test('content restores tab capture, revalidates bridged events and stops on SPA navigation', async () => {
  const env = makePage({ readyEnabled: true });
  vm.runInContext(contentSource, env.context);
  await tick();
  const command = env.posts.find(message => message.direction === 'command');
  assert.equal(command.enabled, true);
  const post = async (data, url = 'wss://proxy.progressme.ru/websocket?token=secret') => { env.page.postMessage({ source: 'thedeshar-exporter-v1', direction: 'event', revision: command.revision, channel: command.channel, event: { kind: 'websocket', url, data } }); await tick(); };
  await post({ lesson: { id: 1, answer_key: { correct: 2 } }, accessToken: 'secret' });
  await tick();
  const captures = () => env.runtimeMessages.filter(message => message.type === 'CAPTURE_EVENT');
  assert.equal(captures().length, 1);
  assert.equal(captures()[0].event.data.accessToken, undefined);
  assert.equal(captures()[0].event.data.lesson.answer_key.correct, 2);
  assert.ok(!captures()[0].event.url.includes('token'));
  await post({ students: [{ lessons: [] }] });
  await post({ lesson: { id: 1 } }, 'https://platform.desharschool.ru/api/users');
  await post({ lesson: { id: 1 } }, 'https://evil.example/lessons');
  assert.equal(captures().length, 1);
  env.page.location.pathname = '/cabinet/school/payments';
  await post({ lesson: { id: 1 } });
  assert.equal(captures().length, 1);
});

test('snapshot returns observed route IDs, reports limits and rejects non-material pages', async () => {
  const env = makePage({ document: documentWith(element('div', { classes: 'lesson-viewer-layout_main', children: [element('p', { text: 'A lesson paragraph' })] })) });
  vm.runInContext(contentSource, env.context);
  await tick();
  const response = (await env.runtimeRequest({ type: 'PAGE_SNAPSHOT' }));
  assert.equal(response.ok, true);
  assert.equal(response.snapshot.route.materialId, '1254486');
  assert.equal(response.snapshot.route.lessonId, '20349346');
  assert.equal(response.snapshot.route.sectionId, '100346962');
  assert.ok(response.snapshot.warnings.length);
  env.page.location.pathname = '/cabinet/school/students';
  assert.equal((await env.runtimeRequest({ type: 'PAGE_SNAPSHOT' })).ok, false);
  assert.equal(env.runtimeRequest({ type: 'CAPTURE_START' }).enabled, false);
  await tick();
});

test('snapshot never falls back to the page body or generic main when lesson content is absent', async () => {
  const document = documentWith(element('main', { children: [
    element('h1', { text: 'Добро пожаловать' }),
    element('p', { text: 'Account help text' }),
    element('img', { attributes: { src: '/assets/chat-button.4d3e389a.svg' } }),
    element('div', { classes: 'content-wrapper', children: [element('p', { text: 'Page wrapper is not an exercise marker' })] }),
  ] }));
  const { response } = await snapshotWith(document);
  assert.equal(response.ok, false);
  assert.match(response.error, /Не найдено учебное содержимое/);
  assert.equal(response.snapshot, undefined);
});

test('book snapshot keeps navigation metadata and excludes chat, school logo and book-card media', async () => {
  const document = documentWith(
    element('main', { children: [element('h1', { text: 'Добро пожаловать' }), element('img', { attributes: { src: '/school-logo.png' } })] }),
    element('li', { classes: 'unit_li', children: [element('img', { attributes: { src: '/book-cover.png' } })] }),
    element('img', { attributes: { src: '/assets/chat-button.4d3e389a.svg' } }),
  );
  const env = makePage({ document, pathname: '/cabinet/school/materials/book/867169/content' });
  env.page.__thedesharNavigation = { inspect: () => ({ title: 'Starter Pack', items: [{ title: 'Lesson 1', kind: 'lesson' }] }) };
  vm.runInContext(contentSource, env.context);
  await tick();
  const { snapshot, ok } = (await env.runtimeRequest({ type: 'PAGE_SNAPSHOT' }));
  assert.equal(ok, true);
  assert.equal(snapshot.title, 'Starter Pack');
  assert.equal(snapshot.navigation.items.length, 1);
  assert.equal(snapshot.blocks.length + snapshot.assets.length, 0);
  assert.ok(!JSON.stringify(snapshot).includes('chat-button'));
});

async function bookSnapshot(...nodes) {
  const env = makePage({ document: documentWith(...nodes), pathname: '/cabinet/school/materials/book/867169/content' });
  env.page.__thedesharNavigation = { inspect: () => ({ title: 'Starter Pack', materialId: '867169', items: [] }) };
  vm.runInContext(contentSource, env.context);
  await tick();
  return (await env.runtimeRequest({ type: 'PAGE_SNAPSHOT' })).snapshot;
}

test('book header image uses currentSrc and excludes the school logo and lesson thumbnails', async () => {
  const cover = element('img', { attributes: { src: '/cover-small.jpg' } });
  cover.currentSrc = 'https://cdn.example.org/cover-large.jpg';
  const snapshot = await bookSnapshot(
    element('header', { children: [element('img', { attributes: { src: '/school-logo.png' } })] }),
    element('div', { children: [cover, element('div', { children: [element('h1', { text: 'Starter Pack' })] })] }),
    element('li', { classes: 'unit_li', children: [element('img', { attributes: { src: '/lesson-thumbnail.jpg' } })] }),
  );
  assert.equal(snapshot.coverUrl, cover.currentSrc);
  assert.equal(snapshot.assets.length, 1);
  assert.equal(snapshot.assets[0].kind, 'image');
  assert.equal(snapshot.assets[0].url, snapshot.coverUrl);
  assert.equal(snapshot.blocks.length, 0);
});

test('book cover supports a single CSS background in the title header and relative URLs', async () => {
  for (const backgroundImage of ['url("/files/cover.webp")', "url('/files/cover.webp')", 'url(/files/cover.webp)']) {
    const snapshot = await bookSnapshot(element('header', { children: [
      element('div', { computedStyle: { backgroundImage } }),
      element('div', { children: [element('h1', { text: 'Starter Pack' })] }),
    ] }));
    assert.equal(snapshot.coverUrl, 'https://platform.desharschool.ru/files/cover.webp');
    assert.equal(snapshot.assets[0].url, snapshot.coverUrl);
  }
});

test('book cover selection rejects ambiguous headers and never expands into main or lesson lists', async () => {
  const title = () => element('h1', { text: 'Starter Pack' });
  const image = () => element('img', { attributes: { src: '/unrelated.png' } });
  const ambiguous = await bookSnapshot(element('div', { children: [
    title(), image(), element('img', { attributes: { src: '/other.png' } }),
  ] }));
  assert.equal(ambiguous.coverUrl, undefined);
  assert.equal(ambiguous.assets.length, 0);
  assert.match(ambiguous.warnings.join(' '), /несколько изображений/);
  for (const root of [
    element('main', { children: [element('div', { children: [title()] }), image()] }),
    element('div', { children: [title(), element('li', { classes: 'unit_li', children: [image()] })] }),
    element('div', { children: [title(), element('nav', { children: [image()] })] }),
  ]) {
    const snapshot = await bookSnapshot(root);
    assert.equal(snapshot.coverUrl, undefined);
    assert.equal(snapshot.assets.length, 0);
  }
});

test('hidden covers and a stale title from another book cannot become the current cover', async () => {
  for (const children of [
    [element('h1', { text: 'Another book' }), element('img', { attributes: { src: '/wrong-cover.png' } })],
    [element('h1', { text: 'Starter Pack' }), element('img', { hidden: true, attributes: { src: '/hidden.png' } })],
  ]) {
    const snapshot = await bookSnapshot(element('div', { children }));
    assert.equal(snapshot.coverUrl, undefined);
    assert.equal(snapshot.assets.length, 0);
  }
});

test('signed book cover is redacted before storage and remains a required unavailable download', async () => {
  const snapshot = await bookSnapshot(element('div', { children: [
    element('h1', { text: 'Starter Pack' }),
    element('div', { computedStyle: { backgroundImage: 'url("https://cdn.example.org/cover.png?signature=cover-secret&size=2")' } }),
  ] }));
  const stored = appendSnapshot(createWorkspace(1), snapshot);
  assert.equal(stored.snapshots[0].coverUrl, 'https://cdn.example.org/cover.png?size=2');
  assert.doesNotMatch(JSON.stringify(stored), /cover-secret/);
  const assets = collectAssets(stored.snapshots);
  assert.equal(assets.length, 1);
  assert.equal(assets[0].downloadUnavailable, true);
  assert.throws(() => assertExportFilesReady([], assets), { code: 'incomplete_export' });
  assert.throws(() => assertExportFilesReady(assets, assets), { code: 'incomplete_export' });
});

test('lesson header media never declares a book cover', async () => {
  const { response } = await snapshotWith(documentWith(element('div', { classes: 'lesson-viewer-layout_main', children: [
    element('h1', { text: 'Starter Pack' }), element('img', { attributes: { src: '/lesson-picture.jpg' } }),
  ] })));
  assert.equal(response.ok, true);
  assert.equal(response.snapshot.coverUrl, undefined);
  assert.equal(response.snapshot.assets.length, 1);
});

test('known lesson container wins over an earlier semantic main and retains exercise media', async () => {
  const document = documentWith(
    element('main', { children: [element('p', { text: 'Site help text' }), element('img', { attributes: { src: '/assets/chat-button.svg' } })] }),
    element('div', { classes: 'lesson-viewer-layout_main', children: [
      element('div', { classes: 'content-wrapper', children: [element('p', { text: 'Choose the picture' }), element('img', { attributes: { src: '/lesson-picture.jpg', alt: 'Town' } })] }),
      element('nav', { children: [element('img', { attributes: { src: '/navigation-icon.png' } })] }),
    ] }),
  );
  const { response } = await snapshotWith(document);
  assert.equal(response.ok, true);
  assert.equal(response.snapshot.blocks.length, 1);
  assert.match(response.snapshot.blocks[0].html, /lesson-picture.jpg/);
  assert.equal(response.snapshot.assets.length, 1);
  assert.match(response.snapshot.assets[0].url, /lesson-picture.jpg$/);
  assert.ok(!JSON.stringify(response.snapshot).includes('chat-button'));
  assert.ok(!JSON.stringify(response.snapshot).includes('Site help text'));
});

test('snapshot rejects the 301st distinct media file instead of silently exporting a prefix', async () => {
  const document = count => documentWith(element('div', { classes: 'lesson-viewer-layout_main', children: [
    element('div', { classes: 'content-wrapper', children: Array.from({ length: count }, (_, index) => element('img', { attributes: { src: `/picture-${index}.png` } })) }),
  ] }));
  const boundary = await snapshotWith(document(300), { readyEnabled: true });
  assert.equal(boundary.response.ok, true);
  assert.equal(boundary.response.snapshot.assets.length, 300);
  const overflow = await snapshotWith(document(301), { readyEnabled: true });
  assert.equal(overflow.response.ok, false);
  assert.equal(overflow.response.snapshot, undefined);
  assert.ok(overflow.runtimeMessages.some(message => message.type === 'CAPTURE_ISSUE' && message.code === 'response_too_complex'));
});

test('fallback captures only explicit exercise roots, including their content and hidden audio sources', async () => {
  const document = documentWith(element('main', { children: [
    element('p', { text: 'Global page description' }),
    element('div', { attributes: { 'data-exercise-id': 'exercise-1' }, children: [
      element('p', { text: 'Listen to the recording' }),
      element('button', { children: [element('img', { attributes: { src: '/answer-picture.jpg' } })] }),
      element('audio', { hidden: true, children: [element('source', { attributes: { src: '/lesson-audio.mp3' } })] }),
    ] }),
    element('img', { attributes: { src: '/assets/chat-button.svg' } }),
  ] }));
  const { response } = await snapshotWith(document);
  assert.equal(response.ok, true);
  assert.equal(response.snapshot.blocks.length, 1);
  assert.equal(response.snapshot.blocks[0].sourceId, 'exercise-1');
  assert.match(response.snapshot.blocks[0].html, /Listen to the recording/);
  assert.deepEqual(Array.from(response.snapshot.assets, asset => asset.kind), ['image', 'audio']);
  assert.ok(!JSON.stringify(response.snapshot).includes('chat-button'));
  assert.ok(!JSON.stringify(response.snapshot).includes('Global page description'));
  assert.match(response.snapshot.warnings.join(' '), /только явно обозначенные учебные блоки/);
});

test('snapshot excludes an image whose ancestor has no rendered box while retaining hidden exercise audio', async () => {
  const document = documentWith(element('div', { classes: 'lesson-viewer-layout_main', children: [
    element('div', { classes: 'content-wrapper', children: [
      element('p', { text: 'Listen to the lesson' }),
      element('div', { attributes: { style: 'display:none;' }, children: [element('img', { attributes: { src: '/hidden-helper.svg' } })] }),
      element('audio', { hidden: true, children: [element('source', { attributes: { src: '/lesson-audio.mp3' } })] }),
    ] }),
  ] }));
  const { response } = await snapshotWith(document);
  assert.equal(response.ok, true);
  assert.deepEqual(Array.from(response.snapshot.assets, asset => asset.url), ['https://platform.desharschool.ru/lesson-audio.mp3']);
});

test('lesson media stays within exercises and excludes visible constructor or AI helper media', async () => {
  const document = documentWith(element('div', { classes: 'lesson-viewer-layout_main', children: [
    element('div', { classes: 'lesson-viewer-main', children: [
      element('div', { classes: 'vue_exercises_wrapper', children: [
        element('div', { classes: 'exercises-list', children: [
          element('div', { classes: 'content-wrapper', children: [element('p', { text: 'Describe this picture' }), element('img', { attributes: { src: '/lesson-picture.jpg' } })] }),
          element('audio', { hidden: true, children: [element('source', { attributes: { src: '/exercise-audio.mp3' } })] }),
        ] }),
      ] }),
    ] }),
    element('img', { attributes: { src: '/visible-editor-ui.svg' } }),
    element('div', { classes: 'exercise-constructor', children: [
      element('div', { classes: 'content-wrapper', children: [element('p', { text: 'Generate an exercise' })] }),
      element('div', { classes: 'recognition-text-helper-wrapper', children: [
        element('img', { attributes: { src: '/robotEmoji.svg' } }),
        element('audio', { children: [element('source', { attributes: { src: '/helper-audio.mp3' } })] }),
      ] }),
    ] }),
  ] }));
  const { response } = await snapshotWith(document);
  assert.equal(response.ok, true);
  assert.deepEqual(Array.from(response.snapshot.assets, asset => asset.kind), ['image', 'audio']);
  assert.match(response.snapshot.assets[0].url, /lesson-picture.jpg$/);
  assert.match(response.snapshot.assets[1].url, /exercise-audio.mp3$/);
  assert.doesNotMatch(JSON.stringify(response.snapshot), /visible-editor-ui|robotEmoji|helper-audio|Generate an exercise/);
});

test('authored scoring traverses MAIN, independent ISOLATED validation and storage without learner results', async () => {
  const env = makePage({ readyEnabled: true });
  vm.runInContext(hookSource, env.context);
  vm.runInContext(contentSource, env.context);
  await tick();
  const socket = new env.page.WebSocket('wss://proxy.progressme.ru/websocket');
  const config = {
    TotalPoints: 3, TotalCountAnswers: 2,
    TestAnswers: [{ AnswerId: 11, Points: 3, PupilId: 7, IsTrueAnswer: true, Answer: 'private-attempt' }],
    Points: [{ CountAnswersFalse: 0, Point: 6, Pupil: 'private-person' }], MaxPoints: 6,
    RuntimeScore: 'private-runtime-score', PupilAnswers: ['private-history'],
  };
  const Statistics = { ScoringType: 3, ConfigurationJson: JSON.stringify(config), Score: 'private-score',
    ActualPoints: 7, Grades: ['private-grade'], Pupil: { Name: 'private-person' } };
  const response = { Class: 'GetExerciseWsController', Method: 'LoadExercisesInMaterial', IsSuccess: true, Value: { Items: [
    { Id: 1, Type: 5, Statistics, JsonData: JSON.stringify({ Statistics }) },
  ] } };
  socket.receive(JSON.stringify(response)); await tick();
  const main = env.exports()[0];
  const bridged = env.runtimeMessages.find(message => message.type === 'CAPTURE_EVENT')?.event;
  assert.ok(main && bridged);
  const persisted = appendCapture(createWorkspace(7), { ...bridged, pageUrl: baseUrl }).captures[0];
  const expected = { TotalPoints: 3, TotalCountAnswers: 2, MaxPoints: 6,
    TestAnswers: [{ AnswerId: 11, Points: 3 }], Points: [{ CountAnswersFalse: 0, Point: 6 }] };
  for (const event of [main, bridged, persisted]) {
    const item = event.data.Value.Items[0];
    for (const stats of [item.Statistics, JSON.parse(item.JsonData).Statistics]) {
      assert.deepEqual(Object.keys(stats).sort(), ['ConfigurationJson', 'ScoringType']);
      assert.equal(stats.ScoringType, 3);
      assert.equal(typeof stats.ConfigurationJson, 'string');
      assert.deepEqual(JSON.parse(stats.ConfigurationJson), expected);
    }
    assert.doesNotMatch(JSON.stringify(event), /private-|Pupil|ActualPoints|IsTrueAnswer|RuntimeScore|Grades/);
  }
  // A forged page message must receive the same projection even without MAIN.
  const isolated = makePage({ readyEnabled: true });
  vm.runInContext(contentSource, isolated.context);
  await tick();
  const channel = isolated.posts.find(message => message.type === 'CAPTURE_STATE').channel;
  isolated.page.postMessage({ source: 'thedeshar-exporter-v1', direction: 'event', revision: 0, channel,
    event: { kind: 'websocket', url: 'wss://proxy.progressme.ru/websocket', data: response } }); await tick();
  const independent = isolated.runtimeMessages.find(message => message.type === 'CAPTURE_EVENT')?.event;
  assert.ok(independent);
  assert.deepEqual(JSON.parse(independent.data.Value.Items[0].Statistics.ConfigurationJson), expected);
  assert.doesNotMatch(JSON.stringify(independent), /private-|Pupil|ActualPoints|IsTrueAnswer|Grades/);
  assert.ok(Statistics.ConfigurationJson.includes('private-attempt'), 'live source config must remain untouched');
});

test('null and blank scoring defaults remain inactive across every capture layer', async () => {
  const env = makePage({ readyEnabled: true });
  vm.runInContext(hookSource, env.context);
  vm.runInContext(contentSource, env.context);
  await tick();
  const socket = new env.page.WebSocket('wss://proxy.progressme.ru/websocket');
  const defaults = [null, '', ' \n\t '];
  socket.receive(JSON.stringify({ Class: 'GetExerciseWsController', Method: 'LoadExercises', IsSuccess: true, Value: { Items:
    defaults.map((ConfigurationJson, index) => {
      const Statistics = { ScoringType: 0, ConfigurationJson, Score: 'private-score', PupilAnswers: ['private-history'] };
      return { Id: index + 1, Type: 5, Statistics, JsonData: JSON.stringify({ Statistics }) };
    }),
  } })); await tick();
  const main = env.exports()[0];
  const bridged = env.runtimeMessages.find(message => message.type === 'CAPTURE_EVENT')?.event;
  assert.ok(main && bridged);
  const persisted = appendCapture(createWorkspace(7), { ...bridged, pageUrl: baseUrl }).captures[0];
  for (const event of [main, bridged, persisted]) {
    event.data.Value.Items.forEach((item, index) => {
      for (const stats of [item.Statistics, JSON.parse(item.JsonData).Statistics]) {
        assert.equal(stats.ScoringType, 0);
        assert.equal(stats.ConfigurationJson, defaults[index]);
        assert.deepEqual(Object.keys(stats).sort(), ['ConfigurationJson', 'ScoringType']);
      }
    });
    assert.doesNotMatch(JSON.stringify(event), /private-|Pupil|unsupported scoring/);
  }
});

test('passive book group counts pass every capture boundary without private metadata', async () => {
  const pathname = '/cabinet/school/materials/book/1254486/content';
  const env = makePage({ readyEnabled: true, pathname });
  const inventories = [];
  env.page.__thedesharNavigation = { setBookInventory: value => inventories.push(value) };
  vm.runInContext(hookSource, env.context);
  vm.runInContext(contentSource, env.context);
  await tick();
  const socket = new env.page.WebSocket('wss://proxy.progressme.ru/websocket');
  for (const Class of ['CourseWsController', 'SharingMaterialWsController']) {
    const source = { Class, Method: 'GetBookCourses', IsSuccess: true, ProjectName: 'Books', UserId: 9,
      ConnectionId: 'private-session', Value: [
        { Id: 12, Name: 'First group', CountLesson: 3, BookId: 1254486, Students: ['private-pupil'], Owner: { Name: 'private-owner' } },
        { Id: 13, Name: 'Empty group', CountLesson: 0, Account: 'private-account' },
      ] };
    socket.receive(JSON.stringify(source)); await tick();
    assert.equal(source.Value[0].Students[0], 'private-pupil', 'source payload stays untouched');
  }
  const captures = env.runtimeMessages.filter(message => message.type === 'CAPTURE_EVENT');
  assert.equal(env.exports().length, 2);
  assert.equal(captures.length, 2);
  assert.equal(inventories.length, 2);
  for (const [index, capture] of captures.entries()) {
    const saved = appendCapture(createWorkspace(7), { ...capture.event, pageUrl: env.page.location.href }).captures[0];
    assert.ok(saved);
    assert.deepEqual(JSON.parse(JSON.stringify(saved.data.Value)), [
      { Id: 12, Name: 'First group', CountLesson: 3, BookId: 1254486 }, { Id: 13, Name: 'Empty group', CountLesson: 0 },
    ]);
    assert.equal(inventories[index].url, `${env.page.location.origin}${pathname}`);
    assert.doesNotMatch(JSON.stringify([env.exports()[index], capture, saved, inventories[index]]), /private-|UserId|Students|Owner|Account|ConnectionId/);
  }
});

test('the isolated bridge independently validates book counts and binds inventory to the current book', async () => {
  const env = makePage({ readyEnabled: true, pathname: '/cabinet/teacher/materials/book/1254486/content' });
  const inventories = [];
  env.page.__thedesharNavigation = { setBookInventory: value => inventories.push(value) };
  vm.runInContext(contentSource, env.context);
  await tick();
  const channel = env.posts.find(message => message.type === 'CAPTURE_STATE').channel;
  const response = { Class: 'CourseWsController', Method: 'GetBookCourses', IsSuccess: true,
    Value: [{ Id: 12, Name: 'Group', CountLesson: 1, Profile: { Name: 'private-person' } }], pageUrl: 'https://evil.example/book/99' };
  const post = async data => { env.page.postMessage({ source: 'thedeshar-exporter-v1', direction: 'event', revision: 0, channel,
    event: { kind: 'websocket', url: 'wss://proxy.progressme.ru/websocket', data } }); await tick(); };
  await post({ batch: [response] });
  assert.equal(inventories.length, 1);
  assert.equal(inventories[0].url, env.page.location.href);
  assert.doesNotMatch(JSON.stringify(inventories), /evil|private-|Profile/);
  for (const invalid of [
    { ...response, Class: 'UserWsController' }, { ...response, Method: 'SaveBookCourses' },
    { ...response, ProjectName: 'Accounts' }, { ...response, IsSuccess: false },
    ...[-1, 1.5, '2', null, 10001].map(CountLesson => ({ ...response, Value: [{ Id: 12, Name: 'Group', CountLesson }] })),
    { ...response, Value: [{ Id: 12, Name: 'Group', CountLesson: 1 }, { Id: 12, Name: 'Duplicate', CountLesson: 0 }] },
    { ...response, Value: [{ Id: 12, Name: 'Group', CountLesson: 1, BookId: '1254486' }] },
  ]) await post(invalid);
  assert.equal(inventories.length, 1);
  assert.equal(env.runtimeMessages.filter(message => message.type === 'CAPTURE_EVENT').length, 1);
  env.page.location.pathname = '/lesson-editor/book/1254486/lesson/2/section/3';
  await post(response);
  assert.equal(inventories.length, 1, 'a late book response in a lesson must not set the book inventory');
});

test('prepare command waits for capture-ready before delegating URL validation', async () => {
  const env = makePage({ pathname: '/cabinet/school/materials/book/1254486/content' });
  let request;
  env.page.__thedesharNavigation = { prepare: value => {
    request = value;
    return { ok: true, opened: 2, navigation: { ready: false } };
  } };
  vm.runInContext(contentSource, env.context);
  const expectedUrl = env.page.location.href;
  const pending = (await env.runtimeRequest({ type: 'PREPARE_BOOK', expectedUrl }));
  assert.equal(pending.code, 'source_loading');
  assert.equal(request, undefined, 'startup must not touch source controls before state restoration');
  await tick();
  const response = (await env.runtimeRequest({ type: 'PREPARE_BOOK', expectedUrl }));
  assert.equal(response.ok, true);
  assert.equal(response.opened, 2);
  assert.equal(request.expectedUrl, expectedUrl);
});

test('navigation replies identify one document across SPA routes without persisting its token', async () => {
  const env = makePage({ readyEnabled: true, document: documentWith(element('div', {
    classes: 'lesson-viewer-layout_main', children: [element('p', { text: 'A lesson paragraph' })],
  })) });
  const navigation = { url: baseUrl, kind: 'lesson', ready: true, items: [] };
  env.page.__thedesharNavigation = {
    inspect: () => navigation,
    prepare: () => ({ ok: true, opened: 0, navigation }),
  };
  vm.runInContext(contentSource, env.context);
  await tick();
  const first = (await env.runtimeRequest({ type: 'MATERIAL_NAVIGATION' })).navigation;
  assert.match(first.documentToken, /^[a-f0-9-]{36}$/);
  assert.equal(navigation.documentToken, undefined, 'transport metadata must not mutate the navigation adapter result');
  const prepared = (await env.runtimeRequest({ type: 'PREPARE_BOOK', expectedDocumentToken: first.documentToken }));
  assert.equal(prepared.navigation.documentToken, first.documentToken);
  env.page.location.pathname = '/lesson-editor/book/1254486/lesson/20349346/section/100346963';
  assert.equal((await env.runtimeRequest({ type: 'MATERIAL_NAVIGATION' })).navigation.documentToken, first.documentToken);
  vm.runInContext(contentSource, env.context);
  assert.equal((await env.runtimeRequest({ type: 'MATERIAL_NAVIGATION' })).navigation.documentToken, first.documentToken,
    'reinjection into the same document must preserve its installed bridge');
  const snapshot = (await env.runtimeRequest({ type: 'PAGE_SNAPSHOT', expectedDocumentToken: first.documentToken }));
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.snapshot.navigation.documentToken, undefined);
  assert.ok(!JSON.stringify(env.posts).includes(first.documentToken), 'the document identity must stay inside the extension transport');

  const replacement = makePage();
  replacement.page.__thedesharNavigation = { inspect: () => ({ url: baseUrl, kind: 'lesson', ready: true }) };
  vm.runInContext(contentSource, replacement.context);
  assert.equal((await replacement.runtimeRequest({ type: 'MATERIAL_NAVIGATION' })).code, 'source_loading');
  await tick();
  const next = (await replacement.runtimeRequest({ type: 'MATERIAL_NAVIGATION' })).navigation;
  assert.notEqual(next.documentToken, first.documentToken, 'a new document at the same URL has a new identity');
});

test('stale document commands fail before navigation reads, preparation, snapshots or clicks', async () => {
  const env = makePage({ readyEnabled: true });
  const actions = [];
  env.page.__thedesharNavigation = {
    inspect: () => { actions.push('inspect'); return { url: baseUrl, kind: 'lesson', ready: true }; },
    prepare: () => { actions.push('prepare'); return { ok: true }; },
    open: () => { actions.push('open'); return { ok: true }; },
  };
  vm.runInContext(contentSource, env.context);
  await tick();
  const currentToken = (await env.runtimeRequest({ type: 'MATERIAL_NAVIGATION' })).navigation.documentToken;
  actions.length = 0;
  for (const type of ['MATERIAL_NAVIGATION', 'PREPARE_BOOK', 'PAGE_SNAPSHOT', 'OPEN_MATERIAL_ITEM']) {
    for (const expectedDocumentToken of ['stale-document-0000', null, 17]) {
      const response = (await env.runtimeRequest({ type, expectedDocumentToken, expectedUrl: baseUrl, key: 'section-key' }));
      assert.equal(response.ok, false, type);
      assert.equal(response.code, 'source_changed', type);
    }
  }
  assert.deepEqual(actions, [], 'the stale command must be rejected before consulting the current page');
  assert.equal((await env.runtimeRequest({ type: 'OPEN_MATERIAL_ITEM', expectedDocumentToken: currentToken })).ok, true);
  assert.deepEqual(actions, ['open']);
});

test('automatic reload and book navigation run only in the guarded document', async () => {
  const env = makePage({ readyEnabled: true });
  const actions = [];
  env.page.location.reload = () => actions.push('reload');
  env.page.location.assign = url => actions.push(url);
  env.page.__thedesharNavigation = { inspect: () => ({ url: baseUrl }) };
  vm.runInContext(contentSource, env.context);
  assert.equal((await env.runtimeRequest({ type: 'MATERIAL_NAVIGATION' })).code, 'source_loading');
  assert.deepEqual(actions, []);
  await tick();
  const token = (await env.runtimeRequest({ type: 'MATERIAL_NAVIGATION' })).navigation.documentToken;
  const command = { type: 'NAVIGATE_SOURCE', expectedUrl: baseUrl, expectedDocumentToken: token, url: baseUrl, reload: true };
  assert.equal((await env.runtimeRequest(command))?.ok, true, 'navigation uses the identity established by the capture-ready handshake');
  assert.deepEqual(actions, ['reload']);
  actions.length = 0;
  for (const expectedDocumentToken of [undefined, null, 'old-document-00000000']) {
    assert.equal((await env.runtimeRequest({ ...command, expectedDocumentToken }))?.code, 'source_changed');
  }
  assert.deepEqual(actions, []);
  env.page.location.search = '?view=preview';
  env.page.location.hash = '#exercise';
  assert.equal((await env.runtimeRequest(command))?.ok, true, 'canonical guards allow the current view and fragment');
  assert.deepEqual(actions, ['reload']);
  const bookUrl = `${env.page.location.origin}/cabinet/school/materials/book/1254486/content`;
  assert.equal((await env.runtimeRequest({ ...command, url: bookUrl, reload: false }))?.ok, true);
  assert.deepEqual(actions, ['reload', bookUrl]);
  const replacement = makePage({ readyEnabled: true });
  replacement.page.location.reload = () => actions.push('replacement-reload');
  replacement.page.location.assign = () => actions.push('replacement-assign');
  vm.runInContext(contentSource, replacement.context);
  await tick();
  assert.equal((await replacement.runtimeRequest(command))?.code, 'source_changed');
  assert.deepEqual(actions, ['reload', bookUrl], 'a same-URL replacement must reject the old command before navigating');
});

test('automatic navigation rejects changed routes and destinations outside the current book', async () => {
  const env = makePage({ readyEnabled: true });
  const actions = [];
  env.page.location.reload = () => actions.push('reload');
  env.page.location.assign = url => actions.push(url);
  env.page.__thedesharNavigation = { inspect: () => ({ url: baseUrl }) };
  vm.runInContext(contentSource, env.context);
  await tick();
  const documentToken = (await env.runtimeRequest({ type: 'MATERIAL_NAVIGATION' })).navigation.documentToken;
  const bookUrl = `${env.page.location.origin}/cabinet/school/materials/book/1254486/content`;
  const command = { type: 'NAVIGATE_SOURCE', expectedUrl: baseUrl, expectedDocumentToken: documentToken, url: bookUrl, reload: false };
  const invalid = [
    { expectedUrl: baseUrl.replace('100346962', '100346963') },
    { expectedUrl: baseUrl.replace('https://', 'https://name:password@') },
    { url: bookUrl.replace('1254486', '1254487') },
    { url: bookUrl.replace('platform.desharschool.ru', 'progressme.ru') },
    { url: bookUrl.replace('https:', 'http:') },
    { url: bookUrl.replace('https://', 'https://name:password@') },
    { url: `${bookUrl}?view=preview` }, { url: `${bookUrl}#contents` },
    { url: `${env.page.location.origin}/cabinet/school/students` },
    { url: 'javascript:alert(1)' }, { url: baseUrl },
    { url: baseUrl.replace('100346962', '100346963'), reload: true },
    { url: bookUrl, reload: true }, { reload: 'false' },
  ];
  for (const change of invalid) {
    const response = (await env.runtimeRequest({ ...command, ...change }));
    assert.equal(response?.ok, false, JSON.stringify(change));
    assert.equal(response?.code, 'source_changed', JSON.stringify(change));
  }
  assert.deepEqual(actions, []);
  env.page.location.pathname = '/cabinet/school/materials/book/1254486/content';
  assert.equal((await env.runtimeRequest({ ...command, expectedUrl: bookUrl, reload: true }))?.ok, true);
  assert.deepEqual(actions, ['reload']);
  env.page.location.pathname = '/cabinet/school/students';
  assert.equal((await env.runtimeRequest({ ...command, expectedUrl: env.page.location.href }))?.ok, false);
  assert.deepEqual(actions, ['reload']);
});

test('section opening requires active capture and forwards only the guarded key and URL', async () => {
  const env = makePage({ readyEnabled: true });
  const requests = [];
  env.page.__thedesharNavigation = { open: request => {
    requests.push(request);
    return { ok: true };
  } };
  vm.runInContext(contentSource, env.context);
  const request = { type: 'OPEN_MATERIAL_ITEM', key: 'section-key', expectedUrl: baseUrl, selector: 'button.start-test', start: true };
  assert.equal((await env.runtimeRequest(request)).ok, false, 'an unresolved capture state must not click source controls');
  assert.equal(requests.length, 0);
  await tick();
  const response = (await env.runtimeRequest(request));
  assert.equal(response.ok, true);
  assert.deepEqual(Object.keys(requests[0]), ['key', 'expectedUrl']);
  assert.equal(requests[0].key, 'section-key');
  assert.equal(requests[0].expectedUrl, baseUrl);
  env.runtimeRequest({ type: 'CAPTURE_STOP' });
  assert.equal((await env.runtimeRequest(request)).ok, false);
  assert.equal(requests.length, 1, 'a stopped run cannot reopen a section');
});

test('book preparation failures remain readable and do not expose source exception text', async () => {
  const env = makePage({ pathname: '/cabinet/school/materials/book/1254486/content', readyEnabled: true });
  env.page.__thedesharNavigation = { prepare: () => { throw new Error('private-source-runtime'); } };
  vm.runInContext(contentSource, env.context);
  await tick();
  const response = (await env.runtimeRequest({ type: 'PREPARE_BOOK', expectedUrl: env.page.location.href }));
  assert.equal(response.ok, false);
  assert.match(response.error, /раскрыть разделы учебника/);
  assert.doesNotMatch(response.error, /private-source-runtime/);
});

test('MAIN observer rejects malformed group inventories and unrelated RPC metadata', async () => {
  const env = makePage({ pathname: '/cabinet/school/materials/book/1254486/content' });
  vm.runInContext(hookSource, env.context);
  await env.command(true);
  const socket = new env.page.WebSocket('wss://proxy.progressme.ru/websocket');
  const response = { Class: 'CourseWsController', Method: 'GetBookCourses', IsSuccess: true, Value: [{ Id: 12, Name: 'Group', CountLesson: 1 }] };
  for (const invalid of [
    { ...response, Value: [{ Id: 12, Name: 'Group', CountLesson: '1' }] },
    { ...response, Value: [{ Id: 12, Name: 'Group', CountLesson: -1 }] },
    { ...response, Value: [{ Id: 12, Name: 'Group', CountLesson: 1 }, { Id: 12, Name: 'Duplicate', CountLesson: 0 }] },
    { ...response, Value: Array.from({ length: 1001 }, (_, index) => ({ Id: index + 1, Name: 'Group', CountLesson: 0 })) },
    { ...response, ProjectName: 'Accounts' }, { ...response, IsSuccess: false },
    { ...response, Class: 'UserWsController', Value: { Lessons: [], Name: 'private-person' } },
    { ...response, Method: 'SetBookCourses' },
  ]) socket.receive(JSON.stringify(invalid)); await tick();
  assert.equal(env.exports().length, 0);
  socket.receive(JSON.stringify({ ...response, Value: [] })); await tick();
  assert.equal(env.exports().length, 1, 'an explicitly empty inventory remains an observed response');
});

function textResponse(text, extras = {}) {
  return { Class: 'GetExerciseWsController', Method: 'LoadExercises', IsSuccess: true,
    Value: { Items: [{ Id: 1, Type: 28, Text: { Text: text, ...extras } }] } };
}

function deferredRestore() {
  const env = makePage();
  let restore;
  const originalSend = env.page.chrome.runtime.sendMessage;
  env.page.chrome.runtime.sendMessage = message => message.type === 'CAPTURE_READY'
    ? (env.runtimeMessages.push(message), new Promise(resolve => { restore = resolve; }))
    : originalSend(message);
  vm.runInContext(hookSource, env.context);
  vm.runInContext(contentSource, env.context);
  const socket = new env.page.WebSocket('wss://proxy.progressme.ru/websocket');
  return { ...env, socket, restore: enabled => { env.restoreCaptureId(enabled); restore({ enabled, captureId: enabled ? 'test-capture-initial-0000' : null }); } };
}

const capturesOf = env => env.runtimeMessages.filter(message => message.type === 'CAPTURE_EVENT');
const issuesOf = env => env.runtimeMessages.filter(message => message.type === 'CAPTURE_ISSUE').map(message => message.code);

test('absolute HTML URL entities cannot hide signed query secrets across any capture boundary', async () => {
  const env = makePage({ readyEnabled: true });
  vm.runInContext(hookSource, env.context);
  vm.runInContext(contentSource, env.context);
  await tick();
  const html = '<p>Choose a policy = fair; sig = x.</p><img src="https://cdn.example.org/a.png?width=200&amp;sig=private-signature&amp;policy=private-policy&#38;Key-Pair-Id=private-key&#x26;version=2">';
  const expected = '<p>Choose a policy = fair; sig = x.</p><img src="https://cdn.example.org/a.png?width=200&amp;version=2">';
  const response = textResponse(html);
  const socket = new env.page.WebSocket('wss://proxy.progressme.ru/websocket');
  socket.receive(JSON.stringify(response)); await tick();
  const bridged = capturesOf(env)[0].event;
  const saved = appendCapture(createWorkspace(7), { ...bridged, pageUrl: baseUrl }).captures[0];
  for (const event of [env.exports()[0], bridged, saved]) assert.equal(event.data.Value.Items[0].Text.Text, expected);
  // A page may bypass MAIN; the isolated boundary must sanitize independently.
  const isolated = makePage({ readyEnabled: true });
  vm.runInContext(contentSource, isolated.context);
  await tick();
  const channel = isolated.posts.find(message => message.type === 'CAPTURE_STATE').channel;
  isolated.page.postMessage({ source: 'thedeshar-exporter-v1', direction: 'event', revision: 0, channel,
    event: { kind: 'websocket', url: 'wss://proxy.progressme.ru/websocket', data: response } }); await tick();
  assert.equal(capturesOf(isolated)[0].event.data.Value.Items[0].Text.Text, expected);
  assert.equal(response.Value.Items[0].Text.Text, html, 'source author data remains untouched');
});

test('valid long author text below the event limit survives MAIN, ISOLATED and persistence exactly', async () => {
  const env = makePage({ readyEnabled: true });
  vm.runInContext(hookSource, env.context);
  vm.runInContext(contentSource, env.context);
  await tick();
  const text = '<p>' + 'A'.repeat(4 * 1024 * 1024) + 'TAIL_MARKER</p>';
  const response = textResponse(text);
  assert.ok(new TextEncoder().encode(JSON.stringify(response)).byteLength < captureBytes);
  const socket = new env.page.WebSocket('wss://proxy.progressme.ru/websocket');
  socket.receive(JSON.stringify(response)); await tick();
  const bridged = capturesOf(env)[0].event;
  const state = appendCapture(createWorkspace(7), { ...bridged, pageUrl: baseUrl });
  for (const event of [env.exports()[0], bridged, state.captures[0]]) assert.equal(event.data.Value.Items[0].Text.Text, text);
  assert.equal(state.dropped, 0);
  assert.deepEqual(issuesOf(env), []);
});

test('a long DOM block is retained exactly and an oversized snapshot fails instead of truncating', async () => {
  const text = 'A'.repeat(220000) + 'TAIL_MARKER';
  const document = documentWith(element('div', { classes: 'lesson-viewer-layout_main', children: [element('p', { text })] }));
  const { response } = await snapshotWith(document);
  assert.equal(response.ok, true);
  assert.equal(response.snapshot.blocks[0].text, text);
  assert.equal(response.snapshot.blocks[0].html, text);
  const oversized = await snapshotWith(documentWith(element('div', { classes: 'lesson-viewer-layout_main', children: [element('p', { text: 'A'.repeat(4500000) })] })));
  assert.equal(oversized.response.ok, false);
  assert.equal(oversized.response.snapshot, undefined);
  assert.deepEqual(issuesOf(oversized), ['response_too_large']);
});

test('early authored replies wait for the restored opt-in state and then drain once', async () => {
  const env = deferredRestore();
  env.socket.receive(JSON.stringify(textResponse('Initial author text', { accessToken: 'private-bootstrap-token' }))); await tick();
  assert.equal(env.exports().length, 0);
  assert.equal(capturesOf(env).length, 0);
  env.restore(true);
  await tick();
  assert.equal(capturesOf(env).length, 1);
  assert.equal(capturesOf(env)[0].event.data.Value.Items[0].Text.Text, 'Initial author text');
  assert.doesNotMatch(JSON.stringify(capturesOf(env)), /private-bootstrap-token/);
  env.runtimeRequest({ type: 'CAPTURE_STOP' });
  env.socket.receive(JSON.stringify(textResponse('Off-period author text'))); await tick();
  env.runtimeRequest({ type: 'CAPTURE_START' }); await tick();
  assert.equal(capturesOf(env).length, 1, 'disabled periods are never replayed');
  assert.deepEqual(issuesOf(env), []);
});

test('disabled bootstrap clears early data and issues without persisting or later replaying them', async () => {
  const env = deferredRestore();
  for (let index = 0; index < 33; index++) env.socket.receive(JSON.stringify(textResponse(`Early ${index}`))); await tick();
  env.restore(false);
  await tick();
  assert.equal(capturesOf(env).length, 0);
  assert.deepEqual(issuesOf(env), []);
  env.runtimeRequest({ type: 'CAPTURE_START' }); await tick();
  assert.equal(capturesOf(env).length, 0);
  assert.deepEqual(issuesOf(env), []);
  env.socket.receive(JSON.stringify(textResponse('After explicit start'))); await tick();
  assert.equal(capturesOf(env).length, 1);
});

test('bootstrap queue overflow by count or bytes drops the queue and reports a fixed diagnostic', async () => {
  for (const responses of [Array.from({ length: 33 }, (_, index) => textResponse(`Early ${index}`)),
    Array.from({ length: 3 }, () => textResponse('A'.repeat(6 * 1024 * 1024)))]) {
    const env = deferredRestore();
    for (const response of responses) env.socket.receive(JSON.stringify(response)); await tick();
    assert.equal(capturesOf(env).length, 0);
    assert.deepEqual(issuesOf(env), []);
    env.restore(true);
    await tick();
    assert.equal(capturesOf(env).length, 0, 'a partial bootstrap queue must not look complete');
    assert.deepEqual(issuesOf(env), ['bootstrap_overflow']);
  }
});

test('bootstrap data from a previous route is discarded rather than attached to the new route', async () => {
  const env = deferredRestore();
  env.socket.receive(JSON.stringify(textResponse('Old section text'))); await tick();
  env.page.location.pathname = '/lesson-editor/book/1254486/lesson/20349346/section/100346963';
  env.restore(true);
  await tick();
  assert.equal(capturesOf(env).length, 0);
  assert.deepEqual(issuesOf(env), ['bootstrap_navigation_changed']);
});

test('a late capture-ready reply cannot overwrite an explicit start or stop', async () => {
  for (const enabled of [true, false]) {
    const env = deferredRestore();
    env.runtimeRequest({ type: enabled ? 'CAPTURE_START' : 'CAPTURE_STOP' });
    await tick();
    env.restore(!enabled);
    await tick();
    env.socket.receive(JSON.stringify(textResponse('After restore'))); await tick();
    assert.equal(capturesOf(env).length, enabled ? 1 : 0);
  }
});

test('complex or oversized responses stop at each boundary with a diagnostic and no truncated exercise', async () => {
  let nested = { authored: 'Tail marker' };
  for (let index = 0; index < 30; index++) nested = { nested };
  const cases = [
    { response: textResponse('Author text', { nested }), code: 'response_too_complex' },
    { response: textResponse('Author text', { rows: Array.from({ length: 4001 }, () => 'Tail marker') }), code: 'response_too_complex' },
    { response: textResponse('A'.repeat(captureBytes)), code: 'response_too_large' },
  ];
  for (const { response, code } of cases) {
    const env = makePage({ readyEnabled: true });
    vm.runInContext(hookSource, env.context);
    vm.runInContext(contentSource, env.context);
    await tick();
    const socket = new env.page.WebSocket('wss://proxy.progressme.ru/websocket');
    socket.receive(JSON.stringify(response)); await tick();
    assert.equal(capturesOf(env).length, 0);
    assert.deepEqual(issuesOf(env), [code]);
    const isolated = makePage({ readyEnabled: true });
    vm.runInContext(contentSource, isolated.context);
    await tick();
    const channel = isolated.posts.find(message => message.type === 'CAPTURE_STATE').channel;
    isolated.page.postMessage({ source: 'thedeshar-exporter-v1', direction: 'event', revision: 0, channel,
      event: { kind: 'websocket', url: 'wss://proxy.progressme.ru/websocket', data: response } }); await tick();
    assert.equal(capturesOf(isolated).length, 0);
    assert.deepEqual(issuesOf(isolated), [code]);
  }
});

test('capture diagnostics accept only known codes from the active isolated channel', async () => {
  const env = makePage({ readyEnabled: true });
  vm.runInContext(contentSource, env.context);
  await tick();
  const channel = env.posts.find(message => message.type === 'CAPTURE_STATE').channel;
  for (const message of [
    { channel, code: 'arbitrary-page-text' },
    { channel: 'wrong-channel', code: 'response_too_large' },
    { channel, code: 'response_too_complex' },
  ]) env.page.postMessage({ source: 'thedeshar-exporter-v1', direction: 'issue', revision: 0, ...message }); await tick();
  assert.deepEqual(issuesOf(env), ['response_too_complex']);
  env.runtimeRequest({ type: 'CAPTURE_STOP' });
  env.page.postMessage({ source: 'thedeshar-exporter-v1', direction: 'issue', revision: 0, channel, code: 'response_too_large' }); await tick();
  assert.deepEqual(issuesOf(env), ['response_too_complex']);
});

test('asynchronous blob and fetch reads cannot replay responses across a disabled interval', async () => {
  for (const transport of ['blob', 'fetch']) {
    const env = makePage({ readyEnabled: true });
    vm.runInContext(hookSource, env.context);
    vm.runInContext(contentSource, env.context);
    await tick();
    let finishRead;
    const text = JSON.stringify(textResponse('Before the disabled interval'));
    if (transport === 'blob') {
      class DelayedBlob extends Blob { text() { return new Promise(resolve => { finishRead = () => resolve(text); }); } }
      env.page.Blob = DelayedBlob;
      const socket = new env.page.WebSocket('wss://proxy.progressme.ru/websocket');
      socket.receive(new DelayedBlob([text])); await tick();
    } else {
      let reads = 0;
      env.page.nextResponse = {
        url: 'https://platform.desharschool.ru/api/lessons/1', headers: { get: () => 'application/json' },
        clone: () => ({ body: { getReader: () => ({
          read() { return ++reads === 1 ? new Promise(resolve => { finishRead = () => resolve({ value: new TextEncoder().encode(text), done: false }); }) : Promise.resolve({ done: true }); },
          cancel: async () => {},
        }) } }),
      };
      await env.page.fetch('/api/lessons/1');
    }
    assert.equal(typeof finishRead, 'function');
    env.runtimeRequest({ type: 'CAPTURE_STOP' });
    env.runtimeRequest({ type: 'CAPTURE_START' }); await tick();
    finishRead();
    await tick();
    assert.equal(capturesOf(env).length, 0, transport);
    assert.deepEqual(issuesOf(env), []);
  }
});

test('a pending fetch overflow reports only for its own active capture and route', async () => {
  for (const transition of ['live', 'restart', 'navigate']) {
    const env = makePage({ readyEnabled: true });
    vm.runInContext(hookSource, env.context);
    vm.runInContext(contentSource, env.context);
    await tick();
    let finishRead;
    let cancelled = 0;
    env.page.nextResponse = {
      url: 'https://platform.desharschool.ru/api/lessons/1',
      headers: { get: key => key === 'content-type' ? 'application/json' : '0' },
      clone: () => ({ body: { getReader: () => ({
        read: () => new Promise(resolve => { finishRead = resolve; }),
        cancel: async () => { cancelled++; },
      }) } }),
    };
    await env.page.fetch('/api/lessons/1');
    assert.equal(typeof finishRead, 'function');
    if (transition === 'restart') {
      env.runtimeRequest({ type: 'CAPTURE_STOP' });
      env.runtimeRequest({ type: 'CAPTURE_START' }); await tick();
    } else if (transition === 'navigate') {
      env.page.location.pathname = '/lesson-editor/book/1254486/lesson/20349346/section/100346963';
    }
    finishRead({ done: false, value: new Uint8Array(captureBytes + 1) });
    await tick();
    assert.equal(capturesOf(env).length, 0);
    assert.deepEqual(issuesOf(env), transition === 'live' ? ['response_too_large']
      : transition === 'navigate' ? ['bootstrap_navigation_changed'] : []);
    assert.equal(cancelled, 1, 'the obsolete or oversized clone is released');
  }
});

test('late fetch headers and XHR errors from a prior capture cannot poison a restarted capture', async () => {
  for (const transport of ['fetch', 'xhr']) {
    const env = makePage({ readyEnabled: true });
    let finishResponse;
    if (transport === 'fetch') env.page.fetch = () => new Promise(resolve => { finishResponse = resolve; });
    vm.runInContext(hookSource, env.context);
    vm.runInContext(contentSource, env.context);
    await tick();
    let applicationResponse;
    if (transport === 'fetch') {
      applicationResponse = env.page.fetch('/api/lessons/1');
    } else {
      const xhr = new env.page.XMLHttpRequest();
      xhr.open('GET', '/api/lessons/1');
      xhr.send();
      finishResponse = () => xhr.complete('https://platform.desharschool.ru/api/lessons/1', JSON.stringify(textResponse('A'.repeat(captureBytes))));
    }
    env.runtimeRequest({ type: 'CAPTURE_STOP' });
    env.runtimeRequest({ type: 'CAPTURE_START' }); await tick();
    if (transport === 'fetch') {
      const response = { url: 'https://platform.desharschool.ru/api/lessons/1',
        headers: { get: key => key === 'content-type' ? 'application/json' : String(captureBytes + 1) } };
      finishResponse(response);
      assert.equal(await applicationResponse, response, 'the application still gets its original response');
    } else finishResponse();
    await tick();
    assert.equal(capturesOf(env).length, 0, transport);
    assert.deepEqual(issuesOf(env), [], transport);
    const socket = new env.page.WebSocket('wss://proxy.progressme.ru/websocket');
    socket.receive(JSON.stringify(textResponse('New capture is healthy'))); await tick();
    assert.equal(capturesOf(env).length, 1);
  }
});

test('already posted MAIN events and issues cannot cross a stop/start while awaiting browser delivery', async () => {
  const env = makePage({ readyEnabled: true });
  const postImmediately = env.page.postMessage;
  const queued = [];
  let delayMainDelivery = false;
  env.page.postMessage = message => {
    if (delayMainDelivery && ['event', 'issue'].includes(message.direction)) queued.push(message);
    else postImmediately(message);
  };
  vm.runInContext(hookSource, env.context);
  vm.runInContext(contentSource, env.context);
  await tick();
  const socket = new env.page.WebSocket('wss://proxy.progressme.ru/websocket');
  delayMainDelivery = true;
  socket.receive(JSON.stringify(textResponse('Posted by the previous capture'))); await tick();
  socket.receive(JSON.stringify(textResponse('A'.repeat(captureBytes)))); await tick();
  assert.deepEqual(queued.map(message => message.direction), ['event', 'issue']);
  assert.deepEqual(queued.map(message => message.revision), [0, 0]);
  env.runtimeRequest({ type: 'CAPTURE_STOP' });
  env.runtimeRequest({ type: 'CAPTURE_START' }); await tick();
  const currentRevision = env.posts.filter(message => message.type === 'CAPTURE_STATE').at(-1).revision;
  assert.equal(currentRevision, 2);
  delayMainDelivery = false;
  for (const message of queued) postImmediately(message);
  assert.equal(capturesOf(env).length, 0);
  assert.deepEqual(issuesOf(env), []);
  socket.receive(JSON.stringify(textResponse('Posted by the current capture'))); await tick();
  socket.receive(JSON.stringify(textResponse('A'.repeat(captureBytes)))); await tick();
  assert.equal(capturesOf(env).length, 1);
  assert.equal(capturesOf(env)[0].event.data.Value.Items[0].Text.Text, 'Posted by the current capture');
  assert.deepEqual(issuesOf(env), ['response_too_large']);
  assert.ok(env.posts.filter(message => ['event', 'issue'].includes(message.direction)).slice(-2)
    .every(message => message.revision === currentRevision));
});

test('bootstrap flush uses the confirmed revision and the isolated bridge rejects missing or stale revisions', async () => {
  const env = deferredRestore();
  env.socket.receive(JSON.stringify(textResponse('Early authored text'))); await tick();
  env.runtimeRequest({ type: 'CAPTURE_START' }); await tick();
  const state = env.posts.filter(message => message.type === 'CAPTURE_STATE').at(-1);
  assert.equal(state.revision, 1);
  assert.equal(capturesOf(env).length, 1);
  assert.equal(env.posts.find(message => message.direction === 'event').revision, state.revision);
  env.restore(false);
  await tick();
  for (const revision of [undefined, 0, 2]) {
    env.page.postMessage({ source: 'thedeshar-exporter-v1', direction: 'event', channel: state.channel,
      ...(revision !== undefined ? { revision } : {}),
      event: { kind: 'websocket', url: 'wss://proxy.progressme.ru/websocket', data: textResponse('Wrong generation') } }); await tick();
    env.page.postMessage({ source: 'thedeshar-exporter-v1', direction: 'issue', channel: state.channel,
      ...(revision !== undefined ? { revision } : {}), code: 'response_too_large' }); await tick();
  }
  assert.equal(capturesOf(env).length, 1);
  assert.deepEqual(issuesOf(env), []);
  env.socket.receive(JSON.stringify(textResponse('Current generation'))); await tick();
  assert.equal(capturesOf(env).length, 2);
});

test('twenty authored timed-test questions and scoring survive every capture boundary without learner state', async () => {
  // The public TestRequest/constructor uses Type=5 and Test.IsEnabledTimer;
  // the constructor's TestTimer=99 menu choice is not a separate payload field.
  const questions = Array.from({ length: 20 }, (_, index) => ({
    Id: 700 + index, Question: `<p>Question ${index + 1}</p>`, Points: index % 3 + 1,
    Answers: [`Correct ${index + 1}`, `Alternative ${index + 1}`, 'Another choice'],
    QuestionAnswers: ['true', '', ''],
  }));
  const authored = { Id: 41, Type: 5, Name: 'Grammar timed test', UsedNewConstructor: true,
    Test: { IsEnabledTimer: true, TimerDuration: 20, IsEnabledPoints: true, Questions: questions },
    Statistics: { ScoringType: 3, ConfigurationJson: JSON.stringify({ TotalCountAnswers: 20,
      TestAnswers: questions.map(question => ({ AnswerId: question.Id, Points: question.Points })) }) },
  };
  const response = { Class: 'GetExerciseWsController', Method: 'LoadExercises', IsSuccess: true,
    ConnectionId: 'private-connection', Value: { SectionId: 23, Count: 1,
      Pupils: [{ Name: 'private-pupil' }], Items: [{ ...authored,
        CurrentPupilId: 9, Answers: [{ Answer: 'private-attempt' }], Grades: [4],
        Timers: [{ PupilId: 9, DateStart: 'private-runtime-date' }],
        AnswerVersion1: [{ Answer: 'private-history' }],
      }] } };
  const env = makePage({ readyEnabled: true });
  vm.runInContext(hookSource, env.context);
  vm.runInContext(contentSource, env.context);
  await tick();
  const socket = new env.page.WebSocket('wss://proxy.progressme.ru/websocket');
  socket.receive(JSON.stringify(response)); await tick();
  const observed = env.exports()[0];
  const bridged = capturesOf(env)[0]?.event;
  assert.ok(observed);
  assert.ok(bridged);
  const stored = appendCapture(createWorkspace(7), { ...bridged, pageUrl: baseUrl }).captures[0];
  assert.ok(stored);
  for (const event of [observed, bridged, stored]) {
    assert.deepEqual(JSON.parse(JSON.stringify(event.data.Value.Items[0])), authored);
    assert.equal(event.data.Value.Items[0].Test.Questions.length, 20);
    assert.doesNotMatch(JSON.stringify(event), /private-|CurrentPupilId|Pupils|Grades|Timers|AnswerVersion1/);
  }

  // Exercise the ISOLATED validator independently of MAIN's prior projection.
  const isolated = makePage({ readyEnabled: true });
  vm.runInContext(contentSource, isolated.context);
  await tick();
  const state = isolated.posts.find(message => message.type === 'CAPTURE_STATE');
  isolated.page.postMessage({ source: 'thedeshar-exporter-v1', direction: 'event',
    channel: state.channel, revision: state.revision,
    event: { kind: 'websocket', url: 'wss://proxy.progressme.ru/websocket', data: response } }); await tick();
  const independentlyBridged = capturesOf(isolated)[0]?.event;
  assert.ok(independentlyBridged);
  assert.deepEqual(JSON.parse(JSON.stringify(independentlyBridged.data.Value.Items[0])), authored);
  assert.doesNotMatch(JSON.stringify(independentlyBridged), /private-|CurrentPupilId|Pupils|Grades|Timers|AnswerVersion1/);
  assert.equal(response.Value.Items[0].Answers[0].Answer, 'private-attempt');
});

test('navigation replies report in-flight observed requests only for the active capture revision', async () => {
  const env = makePage({ readyEnabled: true });
  const fetches = [];
  env.page.fetch = () => new Promise(resolve => fetches.push(resolve));
  env.page.__thedesharNavigation = { inspect: () => ({ url: baseUrl, kind: 'lesson', ready: true }) };
  vm.runInContext(hookSource, env.context);
  vm.runInContext(contentSource, env.context);
  await tick();
  const network = async () => (await env.runtimeRequest({ type: 'MATERIAL_NAVIGATION' })).navigation.network;
  assert.equal((await network()).pending, 0);
  assert.ok(Number.isSafeInteger((await network()).idleMs) && (await network()).idleMs >= 0);
  const pendingFetch = env.page.fetch('/api/lessons/1');
  assert.equal((await network()).pending, 1);
  const xhr = new env.page.XMLHttpRequest();
  xhr.open('GET', '/api/lessons/2');
  xhr.send();
  assert.equal((await network()).pending, 2);
  const state = env.posts.filter(message => message.type === 'CAPTURE_STATE').at(-1);
  for (const forged of [{ channel: 'other-channel', revision: state.revision }, { channel: state.channel, revision: state.revision + 1 }, { channel: state.channel, revision: state.revision, pending: -1 }]) {
    env.page.postMessage({ source: 'thedeshar-exporter-v1', direction: 'activity', pending: 0, ...forged }); await tick();
  }
  assert.equal((await network()).pending, 2);
  xhr.complete('https://platform.desharschool.ru/api/lessons/2', JSON.stringify({ lesson: { id: 2 } }));
  assert.equal((await network()).pending, 1);
  fetches[0](responseFor({ lesson: { id: 1 } }));
  await pendingFetch;
  for (let index = 0; index < 5; index++) await tick();
  assert.equal((await network()).pending, 0);
  assert.equal(capturesOf(env).length, 2);
  env.runtimeRequest({ type: 'CAPTURE_STOP' });
  assert.equal((await network()), undefined);
  assert.equal((await env.runtimeRequest({ type: 'PAGE_SNAPSHOT' })).snapshot?.navigation?.network, undefined);
});

test('source events carry their capture ID and a delayed old stop cannot stop a new capture', async () => {
  const env = makePage({ readyEnabled: true });
  vm.runInContext(hookSource, env.context);
  vm.runInContext(contentSource, env.context);
  await tick();
  const oldId = 'test-capture-initial-0000';
  const newId = 'test-capture-next-00000000';
  const socket = new env.page.WebSocket('wss://proxy.progressme.ru/websocket');
  socket.receive(JSON.stringify(textResponse('Old run'))); await tick();
  assert.equal(capturesOf(env)[0].captureId, oldId);
  const started = env.runtimeRequest({ type: 'CAPTURE_START', captureId: newId }); await tick();
  assert.equal(started.captureId, newId);
  const delayedStop = env.runtimeRequest({ type: 'CAPTURE_STOP', captureId: oldId });
  assert.equal(delayedStop.ignored, true);
  assert.equal(delayedStop.enabled, true);
  socket.receive(JSON.stringify(textResponse('New run'))); await tick();
  socket.receive(JSON.stringify(textResponse('A'.repeat(captureBytes)))); await tick();
  assert.equal(capturesOf(env)[1].captureId, newId);
  assert.equal(env.runtimeMessages.filter(message => message.type === 'CAPTURE_ISSUE').at(-1).captureId, newId);
  env.runtimeRequest({ type: 'CAPTURE_STOP', captureId: newId });
  socket.receive(JSON.stringify(textResponse('Stopped'))); await tick();
  assert.equal(capturesOf(env).length, 2);
});
