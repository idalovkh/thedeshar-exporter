import assert from 'node:assert/strict';
import test from 'node:test';
import { createProblemReporter } from '../src/ui/problem-report.js';
import { createProblemReport } from '../src/lib/problem-report.js';

const book = { rootUrl: 'https://progressme.ru/cabinet/school/materials/book/71/content', title: 'Book' };
const version = { extensionVersion: '0.3.22', browserVersion: 'Chrome/130' };

test('only a failed current attempt offers a report, including after reopening', async () => {
  for (const status of ['started', 'ready', 'waiting', 'failed', 'cancelled', 'finished']) {
    const reporter = createProblemReporter({ ...version, send: async () => ({
      report: createProblemReport({ ...version, book, stage: 'export', status }),
    }) });
    reporter.select({ tabId: 7, book });
    await reporter.load();
    assert.equal(reporter.available(), status === 'failed', status);
  }
});

test('a new attempt supersedes legacy failure and success or cancellation hides the report', async () => {
  const reporter = createProblemReporter({ ...version, send: async () => { throw new Error('Unavailable'); } });
  reporter.select({ tabId: 7, book, collectionDiagnostics: {
    version: 1, events: [], failure: { stage: 'save_page', reason: 'snapshot_error' },
  } });
  assert.equal(reporter.available(), true);
  const attempt = await reporter.begin('collection');
  assert.equal(reporter.available(), false);
  attempt.record({ stage: 'save_page', status: 'failed', reason: 'snapshot_error' });
  assert.equal(reporter.available(), true);
  attempt.record({ stage: 'finish', status: 'finished' });
  assert.equal(reporter.available(), false);
  attempt.record({ stage: 'finish', status: 'cancelled', reason: 'cancelled' });
  assert.equal(reporter.available(), false);
  await attempt.flush();
});

test('legacy cancellation diagnostics do not offer an error report', () => {
  const reporter = createProblemReporter({ ...version, send: async () => ({}) });
  reporter.select({ tabId: 7, book, collectionDiagnostics: {
    version: 1, events: [], failure: { stage: 'save_page', reason: 'cancelled' },
  } });
  assert.equal(reporter.available(), false);
});

test('reconnecting resolves a connection failure without hiding collection or archive failures', async () => {
  const reporter = createProblemReporter({ ...version, send: async () => { throw new Error('Unavailable'); } });
  reporter.select({ tabId: 7, book });
  for (const stage of ['save_page', 'zip']) {
    reporter.record({ stage, status: 'failed', reason: 'operation_failed' });
    reporter.connectionRecovered();
    assert.equal(reporter.available(), true, stage);
  }
  reporter.record({ stage: 'connection', status: 'failed', reason: 'source_disconnected' });
  reporter.connectionRecovered();
  assert.equal(reporter.available(), false);
  const report = await reporter.snapshot();
  assert.equal(report.status, 'ready');
  assert.equal(report.events.filter(event => event.status === 'failed').length, 3, 'Recovery preserves the diagnostic history');
});

test('failed file diagnostics remain downloadable when session storage is unavailable', async () => {
  const reporter = createProblemReporter({ ...version, send: async () => { throw new Error('Storage unavailable'); } });
  reporter.select({ tabId: 7, book });
  const attempt = await reporter.begin('download');
  attempt.record({ stage: 'files', status: 'failed', assetId: 'asset-1', url: 'https://cdn.example.org/image.png?token=secret',
    httpStatus: 200, mimeType: 'text/plain', detectedFormat: 'png', reason: 'unsupported_content_type' });
  await attempt.flush();
  const report = await reporter.snapshot();
  assert.equal(report.persisted, false);
  assert.equal(report.events.at(-1).detectedFormat, 'png');
  assert.equal(report.events.at(-1).url, 'https://cdn.example.org/image.png');
  assert.doesNotMatch(JSON.stringify(report), /secret|Storage unavailable/);
});

test('a late callback cannot restore diagnostics after source selection changes or reset', async () => {
  const messages = [];
  const reporter = createProblemReporter({ ...version, send: async (_id, type, payload) => { messages.push({ type, ...payload }); return {}; } });
  reporter.select({ tabId: 7, book });
  const old = await reporter.begin('download');
  reporter.select({ tabId: 8, book: { ...book, rootUrl: book.rootUrl.replace('/71/', '/81/') } });
  old.record({ stage: 'files', status: 'failed', reason: 'network_error' });
  await old.flush();
  assert.equal(messages.filter(message => message.type === 'APPEND_PROBLEM_EVENTS').length, 0);
  reporter.clear();
  assert.equal(await reporter.snapshot(), null);
});

test('retrying the archive keeps collection diagnostics and replaces download events', async () => {
  const reporter = createProblemReporter({ ...version, send: async () => { throw new Error('Unavailable'); } });
  reporter.select({ tabId: 7, book });
  const collection = await reporter.begin('collection');
  collection.record({ stage: 'save_page', status: 'saved', url: book.rootUrl });
  const first = await reporter.begin('download');
  first.record({ stage: 'files', status: 'failed', reason: 'network_error' });
  const second = await reporter.begin('download');
  second.record({ stage: 'files', status: 'downloaded', assetId: 'asset-1', receivedBytes: 4 });
  const report = await reporter.snapshot();
  assert.equal(report.events.filter(event => event.stage === 'save_page').length, 1);
  assert.equal(report.events.filter(event => event.reason === 'network_error').length, 0);
  assert.equal(report.downloadSummary.downloaded, 1);
});

test('successful background writes mark the local first connection report as persisted', async () => {
  const reporter = createProblemReporter({ ...version, send: async (_tabId, type) => type === 'BEGIN_PROBLEM_REPORT'
    ? { reportId: 'report-1', attemptId: 'attempt-1', report: createProblemReport({ ...version, book, persisted: true }) }
    : {} });
  reporter.select({ tabId: 7, book });
  reporter.record({ stage: 'connection', status: 'ready' });
  const report = await reporter.snapshot();
  assert.equal(report.persisted, true);
  assert.equal(report.storageError, false);
  assert.equal(report.events.at(-1).status, 'ready');
});

test('compaction never substitutes a retained failure for the newly queued event', async () => {
  const events = Array.from({ length: 1400 }, (_, index) => ({ at: '2026-11-11T20:00:00.000Z', stage: 'files', status: 'failed',
    reason: 'network_error', assetId: `asset-${index}`, url: `https://cdn.example.org/${'a'.repeat(960)}${index}` }));
  const report = createProblemReport({ ...version, book, events, persisted: true });
  const queued = [];
  const reporter = createProblemReporter({ ...version, send: async (_tabId, type, payload) => {
    if (type === 'BEGIN_PROBLEM_REPORT') return { reportId: 'report-1', attemptId: 'attempt-1', report };
    if (type === 'APPEND_PROBLEM_EVENTS') queued.push(...payload.events);
    return {};
  } });
  reporter.select({ tabId: 7, book });
  const attempt = await reporter.begin('connection');
  attempt.record({ stage: 'connection', status: 'ready', url: `https://cdn.example.org/${'b'.repeat(960)}`,
    body: 'private-body', headers: { cookie: 'private-cookie' } });
  await attempt.flush();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].stage, 'connection');
  assert.equal(queued[0].status, 'ready');
  assert.doesNotMatch(JSON.stringify(queued), /private-body|private-cookie/);
});
