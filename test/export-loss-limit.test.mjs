import assert from 'node:assert/strict';
import test from 'node:test';
import { exportFileProblems } from '../src/lib/export-file-problems.js';
import { createProblemReporter } from '../src/ui/problem-report.js';

const missing = index => ({ url: `https://cdn.example.org/${index}.png`, status: 'failed', error: 'Файл недоступен.' });

test('three terminal missing files cannot be approved even when most files succeeded', () => {
  const files = Array.from({ length: 100 }, (_, index) => index < 3 ? missing(index) : {
    url: `https://cdn.example.org/${index}.png`, status: 'downloaded', data: new Blob(['verified']),
  });
  assert.throws(() => exportFileProblems(files), { code: 'incomplete_export' });
});

test('at most two missing files remain available for the existing explicit consent', () => {
  const files = [missing(1), missing(2)];
  assert.deepEqual(exportFileProblems(files), files);
});

test('a finished export with missing files keeps its diagnostic report available', async () => {
  const reporter = createProblemReporter({ send: async () => { throw Error('Session storage unavailable'); } });
  reporter.select({ tabId: 7, book: { rootUrl: 'https://progressme.ru/cabinet/school/materials/book/71/content', title: 'Book' } });
  const attempt = await reporter.begin('download');
  attempt.record({ stage: 'files', status: 'failed', assetId: 'asset-1', reason: 'http_error' });
  attempt.record({ stage: 'export', status: 'finished' });
  await attempt.flush();
  assert.equal(reporter.available(), true);
  reporter.clear();
});

test('resource and selected-file errors retain useful codes in the support report', async () => {
  for (const reason of ['export_resources', 'storage_unavailable', 'zip_write', 'zip_verification']) {
    const reporter = createProblemReporter({ send: async () => { throw Error('Unavailable'); } });
    reporter.select({ tabId: 7, book: { rootUrl: 'https://progressme.ru/cabinet/school/materials/book/71/content' } });
    reporter.record({ stage: 'zip', status: 'failed', reason });
    assert.equal((await reporter.snapshot()).events.at(-1).reason, reason);
    reporter.clear();
  }
});
