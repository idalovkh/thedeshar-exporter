import assert from 'node:assert/strict';
import test from 'node:test';
import { exportFileProblems } from '../src/lib/export-file-problems.js';
import { assertExportFilesReady } from '../src/lib/export-readiness.js';
import { createExportPackage, replacePackageAssets } from '../src/lib/package.js';

const retained = { id: 'asset-1', url: 'https://cdn.example.org/one.mp3', name: 'one.mp3',
  status: 'downloaded', data: new Blob(['audio']), mimeType: 'audio/mpeg' };
const missing = (index, status = 'failed') => ({ id: `asset-${index}`, url: `https://cdn.example.org/${index}.jpg`,
  name: `${index}.jpg`, status, error: 'Сервер не отдал файл.' });

test('terminal file problems are returned for consent without discarding retained files', () => {
  const problems = [missing(2), missing(3, 'skipped')];
  const files = [retained, ...problems];
  assert.deepEqual(exportFileProblems(files, files), problems);
  assert.equal(files[0].data, retained.data);
  assert.throws(() => assertExportFilesReady(files), { code: 'incomplete_export' }, 'Strict consumers still require every file');
  assert.deepEqual(exportFileProblems([retained]), []);
  assert.deepEqual(exportFileProblems([], []), []);
});

test('consent cannot excuse omitted, duplicate or unknown inventory entries', () => {
  const expected = [retained, missing(2)];
  for (const files of [[retained], [retained, missing(3)], [retained, retained]])
    assert.throws(() => exportFileProblems(files, expected), { code: 'incomplete_export' });
  for (const status of ['referenced', 'reference-only', 'running', undefined])
    assert.throws(() => exportFileProblems([{ ...missing(2), status }]), { code: 'incomplete_export' });
});

test('invalid downloaded bodies and unverified failure bytes never enter a partial ZIP', () => {
  for (const data of [undefined, null, new Blob(), new Uint8Array(), 'not bytes'])
    assert.throws(() => exportFileProblems([{ ...retained, data }]), { code: 'incomplete_export' });
  for (const status of ['failed', 'skipped', 'unavailable'])
    assert.throws(() => exportFileProblems([{ ...retained, status }]), { code: 'incomplete_export' });
});

test('approved file omissions retain source links, reasons, counts and warnings in the manifest', () => {
  const files = [retained, missing(2), missing(3, 'unavailable')];
  const before = files.map(file => ({ ...file }));
  const prepared = createExportPackage({ assets: files.map(({ data, ...asset }) => asset) });
  const result = replacePackageAssets(prepared, files);
  assert.equal(result.manifest.completeness.missingAssets, 2);
  assert.equal(result.manifest.counts.downloadedAssets, 1);
  assert.match(result.manifest.completeness.warnings.join(' '), /2/);
  for (const index of [1, 2]) {
    assert.equal(result.manifest.inventory.assets[index].url, files[index].url);
    assert.equal(result.manifest.inventory.assets[index].status, files[index].status);
    assert.equal(result.manifest.inventory.assets[index].error, files[index].error);
    assert.equal(result.manifest.inventory.assets[index].file, null);
  }
  assert.equal(result.entries.filter(entry => entry.name.startsWith('media/')).length, 1);
  assert.deepEqual(files, before);
});
