import assert from 'node:assert/strict';
import test from 'node:test';
import { bindingBackground, dashboardUrl } from './exporter-binding-background-fixture.js';
import { resumeBook, resumeSection, savedResumeState } from './resume-ui-fixture.js';

async function retainedApp(state = savedResumeState()) {
  const app = bindingBackground();
  app.records.set(7, structuredClone(state));
  const workspaceId = await app.resolve();
  return { ...app, workspaceId };
}
async function start(app, mode = 'resume') {
  const run = await app.send({ type: 'BEGIN_COLLECTION', workspaceId: app.workspaceId, mode });
  assert.equal(run.ok, true, run.error);
  assert.equal(app.sessions['collection:7'].mode, mode);
  assert.equal((await app.send({ type: 'START_CAPTURE', workspaceId: app.workspaceId, collectionId: run.collectionId })).ok, true);
  // Model an application SPA route update inside the same source document.
  app.tabs.get(7).url = resumeSection;
  return run;
}
function response(app, { count = 1, sectionId = 9 } = {}) {
  const event = structuredClone(savedResumeState().captures[0]);
  event.receivedAt = '2026-11-16T12:00:00.000Z';
  event.pageUrl = 'https://foreign.example/forged-page';
  event.data.Value.Items[0].Name = 'Fresh source edit';
  event.data.Value.SectionId = sectionId;
  event.data.Value.Count = count;
  return app.send({ type: 'CAPTURE_EVENT', observedUrl: resumeSection,
    captureId: app.sessions['capture-id:7'], event }, 7);
}

test('resume background acknowledges fresh source data while preserving committed answers and all timestamps', async () => {
  const app = await retainedApp();
  await start(app);
  const before = structuredClone(app.records.get(7));
  const observed = await response(app);
  assert.equal(observed.ok, true, observed.error);
  assert.deepEqual(observed.exerciseCapture, { received: true });
  assert.deepEqual(app.records.get(7), before);
  assert.equal(app.records.get(7).captures[0].pageUrl, resumeSection, 'Only the browser-owned route associates captures');
  assert.equal(app.records.get(7).captures[0].data.Value.Items[0].Name, 'Saved answer');
});

test('incomplete and wrong-section replies cannot acquire freshness from the saved author definitions', async () => {
  const app = await retainedApp();
  await start(app);
  const before = structuredClone(app.records.get(7));
  const incomplete = await response(app, { count: 2 });
  assert.equal(incomplete.ok, true, incomplete.error);
  assert.deepEqual(incomplete.exerciseCapture, { received: false, reason: 'incomplete' });
  const wrong = await response(app, { sectionId: 999 });
  assert.equal(wrong.ok, true, wrong.error);
  assert.equal(wrong.exerciseCapture, undefined);
  assert.deepEqual(app.records.get(7), before);
});

test('new mode does not suppress an edited source response using a prior resume checkpoint', async () => {
  const app = await retainedApp();
  await start(app, 'new');
  const observed = await response(app);
  assert.equal(observed.ok, true, observed.error);
  const records = app.records.get(7).captures;
  assert.equal(records.length, 2);
  assert.equal(records[0].data.Value.Items[0].Name, 'Saved answer');
  assert.equal(records[1].data.Value.Items[0].Name, 'Fresh source edit');
  assert.equal(records[1].pageUrl, resumeSection);
});

test('source pages, foreign extension senders and replaced owner documents cannot begin resume', async () => {
  const app = await retainedApp();
  const before = structuredClone(app.records.get(7));
  for (const [senderId, override] of [[7, {}], [99, { id: 'another-extension' }],
    [99, { documentId: 'replaced-owner-document' }], [99, { tab: undefined }]]) {
    const result = await app.send({ type: 'BEGIN_COLLECTION', workspaceId: app.workspaceId, mode: 'resume' }, senderId, override);
    assert.equal(result.ok, false);
    assert.equal(app.sessions['collection:7'], undefined);
    assert.deepEqual(app.records.get(7), before);
  }
});

test('another live exporter cannot resume or replace the active owner collection', async () => {
  const app = await retainedApp();
  const run = await start(app);
  app.tabs.get(7).url = resumeBook;
  app.tabs.get(100).url = dashboardUrl(app.workspaceId);
  const before = structuredClone(app.records.get(7));
  const refused = await app.send({ type: 'BEGIN_COLLECTION', workspaceId: app.workspaceId, mode: 'resume' }, 100);
  assert.equal(refused.ok, false);
  assert.equal(app.sessions['collection:7'].collectionId, run.collectionId);
  assert.equal(app.sessions['collection:7'].ownerTabId, 99);
  assert.deepEqual(app.records.get(7), before);
});

test('orphaned checkpoints, dropped records and another book are refused without acquiring a lease or clearing data', async () => {
  for (const scenario of ['orphan', 'dropped', 'book', 'origin', 'mode']) {
    const state = savedResumeState();
    if (scenario === 'orphan') state.snapshots = [];
    if (scenario === 'dropped') state.dropped = 1;
    const app = await retainedApp(state);
    if (scenario === 'book') app.tabs.get(7).url = resumeBook.replace('/71/', '/81/');
    if (scenario === 'origin') app.tabs.get(7).url = resumeBook.replace('progressme.ru', 'platform.desharschool.ru');
    const result = await app.send({ type: 'BEGIN_COLLECTION', workspaceId: app.workspaceId, mode: scenario === 'mode' ? 'unsupported-mode' : 'resume' });
    assert.equal(result.ok, false, scenario);
    assert.equal(app.sessions['collection:7'], undefined, scenario);
    assert.deepEqual(app.records.get(7), state, scenario);
  }
});

test('a finished capture cannot be resumed through a direct background command', async () => {
  const state = savedResumeState(); state.collection.status = 'finished';
  const app = await retainedApp(state);
  const result = await app.send({ type: 'BEGIN_COLLECTION', workspaceId: app.workspaceId, mode: 'resume' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'resume_unavailable');
  assert.equal(app.sessions['collection:7'], undefined);
  assert.deepEqual(app.records.get(7), state);
});
