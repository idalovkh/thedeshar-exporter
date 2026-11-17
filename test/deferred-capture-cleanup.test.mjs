import assert from 'node:assert/strict';
import test from 'node:test';
import { appendCapture, appendSnapshot, createWorkspace } from '../src/lib/state.js';
import { prepareDiskExport } from '../src/ui/export-record-stream.js';

test('capture bodies stay unchanged locally and are cleaned once when preparing archive records', async () => {
  const root = 'https://progressme.ru/cabinet/school/materials/book/71/content';
  const page = 'https://progressme.ru/lesson-editor/book/71/lesson/2/section/3';
  const json = JSON.stringify({ correctAnswers: ['cat'], imageUrl: '/files/cat.png?token=private-image',
    accessToken: 'private-token', Statistics: { ScoringType: 3, ConfigurationJson: JSON.stringify({
      TotalPoints: 2, TestAnswers: [{ AnswerId: 1, Points: 2, PupilId: 9 }], RuntimeScore: 'private-score',
    }), Score: 'private-score' } });
  const incoming = { kind: 'websocket', url: 'wss://api.other-school.example/stream', pageUrl: page,
    data: { Class: 'GetExerciseWsController', Method: 'LoadExercises', IsSuccess: true,
      Value: { SectionId: 3, Count: 1, Items: [{ Id: 4, Type: 5, SectionId: 3, JsonData: json,
        Test: { Questions: [{ Answers: ['cat', 'dog'], QuestionAnswers: ['true', 'false'] }] } }] } } };
  const state = createWorkspace(7);
  appendCapture(state, incoming);
  appendSnapshot(state, { url: root, title: 'Book', blocks: [{ text: '<img src="/a.png?token=private-snapshot">' }] });
  assert.equal(state.captures[0].data.Value.Items[0].JsonData, json);
  assert.match(state.snapshots[0].blocks[0].text, /private-snapshot/);
  const before = JSON.stringify(state);
  const files = new Map();
  const result = await prepareDiskExport({ exportRevision: 1, warnings: [], dropped: 0 }, {
    async send(type, request) {
      if (type === 'GET_EXPORT_INFO') return { revision: 1, snapshotCount: 1, captureCount: 1 };
      return { revision: 1, total: 1, nextOffset: request.offset + 1, records: [state[request.kind][request.offset]] };
    },
    spool: {
      async open(name) { const chunks = []; return { async write(chunk) { chunks.push(chunk); },
        async close() { files.set(name, new Blob(chunks)); }, async abort() {} }; },
      async file(name) { return files.get(name); },
    },
  });
  const records = await Promise.all(result.prepared.entries.filter(entry => entry.name.startsWith('originals/'))
    .map(async entry => JSON.parse(await entry.data.text())));
  assert.doesNotMatch(JSON.stringify(records), /private-|PupilId|RuntimeScore/);
  const captured = records.find(record => record.kind === 'websocket');
  assert.deepEqual(JSON.parse(captured.data.Value.Items[0].JsonData).correctAnswers, ['cat']);
  assert.deepEqual(captured.data.Value.Items[0].Test.Questions[0].QuestionAnswers, ['true', 'false']);
  assert.equal(JSON.stringify(state), before, 'archive preparation must preserve the local source records');
  assert.equal(result.assets.find(asset => asset.url.endsWith('/files/cat.png'))?.downloadUnavailable, true,
    'moving cleanup must not turn a signed-only URL into a usable unsigned download');
});
