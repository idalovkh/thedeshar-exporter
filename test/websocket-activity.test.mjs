import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../src/capture/hook.js', import.meta.url), 'utf8');
const request = (RequestId = 'author-request') => ({ Class: 'GetExerciseWsController', Method: 'LoadExercises', RequestId,
  Params: { SectionId: 3, token: 'private-parameter' } });
const response = (RequestId = 'author-request', IsSuccess = true) => ({ Class: 'GetExerciseWsController', Method: 'LoadExercises', RequestId,
  IsSuccess, Value: { Items: [], Count: 0, SectionId: 3 } });

function page({ fetch } = {}) {
  const location = new URL('https://platform.desharschool.ru/lesson-editor/book/1/lesson/2/section/3');
  const posts = [], listeners = [];
  const instances = new WeakSet();
  class Socket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.listeners = new Map(); instances.add(this); }
    addEventListener(type, listener) { const set = this.listeners.get(type) || []; set.push(listener); this.listeners.set(type, set); }
    emit(type, data) { for (const listener of this.listeners.get(type) || []) listener({ data }); }
    receive(data) { this.emit('message', data); }
    send(...args) {
      if (!instances.has(this)) throw new TypeError('Illegal invocation');
      if (this.failSend) throw this.failSend;
      this.sent = args;
      return 'original-send-result';
    }
  }
  const originalPrototype = Socket.prototype;
  let reference;
  const context = vm.createContext({ location, URL, TextEncoder, TextDecoder, ArrayBuffer, Uint8Array, DataView, Blob,
    WebSocket: Socket, fetch,
    addEventListener(type, listener) { if (type === 'message') listeners.push(listener); },
    postMessage(value) { posts.push(value); for (const listener of listeners) listener({ data: value, source: reference, origin: location.origin }); },
  });
  vm.runInContext('window = globalThis', context);
  reference = vm.runInContext('window', context);
  vm.runInContext(source, context);
  let revision = 0;
  const command = enabled => context.postMessage({ source: 'thedeshar-exporter-v1', direction: 'command',
    type: 'CAPTURE_STATE', channel: 'activity-test-channel', enabled, revision: revision++ });
  command(true);
  const socket = new context.WebSocket('wss://proxy.progressme.ru/ws');
  return { socket, context, command, posts, originalPrototype,
    pending: () => posts.filter(value => value.direction === 'activity').at(-1)?.pending,
  };
}

test('an authored WebSocket RPC stays pending until its matching response arrives', () => {
  const env = page();
  env.socket.send(JSON.stringify(request()));
  assert.equal(env.pending(), 1);
  env.socket.receive(JSON.stringify(response()));
  assert.equal(env.pending(), 0);
  assert.ok(env.posts.findIndex(value => value.direction === 'event') < env.posts.findLastIndex(value => value.direction === 'activity'),
    'Author data is posted to the bridge before declaring the request complete');
  assert.doesNotMatch(JSON.stringify(env.posts), /private-parameter|author-request/);
});

test('all supported authored read-only methods contribute activity and their errors complete it', () => {
  const env = page();
  for (const [Class, Method] of [
    ['GetExerciseWsController', 'LoadExercises'], ['GetExerciseWsController', 'LoadExercisesInMaterial'],
    ['CourseWsController', 'GetBookCourses'], ['SharingMaterialWsController', 'GetBookCourses'],
    ['LessonWsController', 'GetLessonWithId'], ['LessonWsController', 'GetLessonPreview'],
  ]) {
    env.socket.send(JSON.stringify({ Class, Method }));
    assert.equal(env.pending(), 1, Method);
    env.socket.receive(JSON.stringify({ Class, Method, IsSuccess: false, Value: 'private-server-error' }));
    assert.equal(env.pending(), 0, Method);
  }
  assert.doesNotMatch(JSON.stringify(env.posts), /private-server-error/);
});

test('learner traffic, writes, private endpoints and oversized outbound data never become authored activity', () => {
  const env = page();
  for (const value of [
    { Class: 'UserWsController', Method: 'GetAccount' }, { Class: 'GetExerciseWsController', Method: 'SaveExercise' },
    { Class: 'UserWsController', Method: 'Save', Value: request() },
    { ...request(), ProjectName: 'Students' }, 'ping', JSON.stringify({ ...request(), text: 'a'.repeat(65536) }),
  ]) env.socket.send(typeof value === 'string' ? value : JSON.stringify(value));
  const privateSocket = new env.context.WebSocket('wss://proxy.progressme.ru/students');
  privateSocket.send(JSON.stringify(request()));
  const unrelated = new env.context.WebSocket('wss://tracker.example/track');
  unrelated.send(JSON.stringify(request()));
  assert.equal(env.pending(), 0);
});

test('only matching responses clear a request and duplicate responses cannot clear another request', () => {
  const env = page();
  env.socket.send(JSON.stringify(request('first')));
  env.socket.send(JSON.stringify(request('second')));
  assert.equal(env.pending(), 2);
  for (const wrong of [{ ...response('first'), Class: 'UserWsController' }, response('foreign'), { ...response('first'), Method: 'SaveExercise' }]) {
    env.socket.receive(JSON.stringify(wrong));
    assert.equal(env.pending(), 2);
  }
  env.socket.receive(JSON.stringify(response('first')));
  env.socket.receive(JSON.stringify(response('first')));
  assert.equal(env.pending(), 1);
  env.socket.receive(JSON.stringify(response('second')));
  assert.equal(env.pending(), 0);
});

for (const event of ['close', 'error']) {
  test(`${event} releases every pending authored request exactly once`, () => {
    const env = page();
    env.socket.send(JSON.stringify(request('first')));
    env.socket.send(JSON.stringify(request('second')));
    assert.equal(env.pending(), 2);
    env.socket.emit(event);
    env.socket.emit(event);
    assert.equal(env.pending(), 0);
    assert.ok(env.posts.filter(value => value.direction === 'activity').every(value => value.pending >= 0));
  });
}

for (const id of ['reused', null]) {
  test(`old ${id === null ? 'uncorrelated' : 'correlated'} replies cannot clear a restarted capture request`, () => {
    const env = page();
    env.socket.send(JSON.stringify(request(id)));
    assert.equal(env.pending(), 1);
    env.command(false);
    assert.equal(env.pending(), 1, 'Disabled observers do not publish new activity');
    env.command(true);
    assert.equal(env.pending(), 0);
    env.socket.send(JSON.stringify(request(id)));
    assert.equal(env.pending(), 1);
    env.socket.receive(JSON.stringify(response(id)));
    assert.equal(env.pending(), 1, 'The retired request consumes its own late completion');
    env.socket.receive(JSON.stringify(response(id)));
    assert.equal(env.pending(), 0);
    env.socket.emit('close');
    assert.equal(env.pending(), 0);
  });
}

test('send preserves arguments, return value, prototype and native receiver/exception semantics', () => {
  const env = page();
  assert.equal(Object.getPrototypeOf(env.socket), env.originalPrototype);
  assert.ok(env.socket instanceof env.context.WebSocket);
  assert.equal(env.context.WebSocket.OPEN, 1);
  const raw = JSON.stringify(request());
  assert.equal(env.socket.send(raw, 'extra-argument'), 'original-send-result');
  assert.deepEqual(env.socket.sent, [raw, 'extra-argument']);
  env.socket.receive(JSON.stringify(response()));
  const failure = new Error('Original send failed');
  env.socket.failSend = failure;
  assert.throws(() => env.socket.send(raw), error => error === failure);
  assert.equal(env.pending(), 0);
  assert.throws(() => env.socket.send.call({}, raw), { name: 'TypeError', message: 'Illegal invocation' });
  assert.equal(env.pending(), 0);
});

test('bounded binary and Blob RPC frames use the same pending signal', async () => {
  const env = page();
  const bytes = new TextEncoder().encode(JSON.stringify(request()));
  env.socket.send(bytes);
  assert.equal(env.socket.sent[0], bytes);
  assert.equal(env.pending(), 1);
  env.socket.receive(new TextEncoder().encode(JSON.stringify(response())).buffer);
  assert.equal(env.pending(), 0);
  const blob = new Blob([JSON.stringify(request())]);
  assert.equal(env.socket.send(blob), 'original-send-result');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.pending(), 1);
  env.socket.receive(new Blob([JSON.stringify(response())]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.pending(), 0);
});

test('RPC tracking is bounded and reports overflow without retaining arbitrary request bodies', () => {
  const env = page();
  for (let index = 0; index < 260; index++) env.socket.send(JSON.stringify(request(`request-${index}`)));
  assert.equal(env.pending(), 256);
  assert.ok(env.posts.some(value => value.direction === 'issue' && value.code === 'response_too_complex'));
  env.socket.emit('close');
  assert.equal(env.pending(), 0);
  assert.doesNotMatch(JSON.stringify(env.posts), /private-parameter|request-\d/);
});

test('an old HTTP completion cannot decrement a new capture WebSocket count', async () => {
  let resolve;
  const env = page({ fetch: () => new Promise(done => { resolve = done; }) });
  const pending = env.context.fetch('https://platform.desharschool.ru/api/lessons/2');
  assert.equal(env.pending(), 1);
  env.command(false); env.command(true);
  env.socket.send(JSON.stringify(request()));
  assert.equal(env.pending(), 1);
  resolve({ url: 'https://platform.desharschool.ru/api/lessons/2', headers: { get: () => 'text/plain' } });
  await pending;
  await new Promise(done => setImmediate(done));
  assert.equal(env.pending(), 1);
  env.socket.receive(JSON.stringify(response()));
  assert.equal(env.pending(), 0);
});
