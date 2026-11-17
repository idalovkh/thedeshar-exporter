import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceConnectionView, collectionLoadingDetail, collectionFailureNotice, sourceSetupMessage } from '../src/ui/source-status-view.js';

test('a stopped collection explains a known navigation blocker', () => {
  const diagnostics = { failure: { reason: 'navigation_blocked', blockedReasonCode: 'pagination' } };
  assert.match(collectionFailureNotice({ diagnostics }), /пагинация или подгрузка/i);
});

test('an unknown or failed source is never presented as another book', () => {
  const view = sourceConnectionView({ expectedKey: 'https://school.example/book/1', sourceKey: '',
    sourceStatus: { state: 'network_error', networkError: 'net::ERR_TIMED_OUT' } });
  assert.match(view.title, /загрузить/);
  assert.doesNotMatch(JSON.stringify(view), /другая книга|ERR_TIMED_OUT/);
  assert.equal(sourceConnectionView({ expectedKey: 'school/book/1', sourceKey: '', sourceStatus: { state: 'unavailable' } }).title,
    'Страница книги недоступна');
});

test('another book requires a recognized different book key', () => {
  assert.equal(sourceConnectionView({ expectedKey: 'school/book/1', sourceKey: 'school/book/1' }), null);
  const view = sourceConnectionView({ expectedKey: 'school/book/1', sourceKey: 'school/book/2' });
  assert.match(view.description, /другая книга/);
});

test('loading and retry details explain progress without technical data', () => {
  assert.equal(collectionLoadingDetail({ status: 'waiting', elapsedMs: 60000 }), 'Страница загружается дольше обычного.');
  assert.equal(collectionLoadingDetail({ status: 'retrying', attempt: 2 }), 'Повторная загрузка раздела. Попытка 2 из 3.');
  assert.equal(collectionLoadingDetail({ status: 'waiting', attempt: 3 }), 'Повторная загрузка раздела. Попытка 3 из 3.');
  assert.equal(collectionLoadingDetail({ status: 'ready', attempt: 2 }), '');
});

test('site setup errors expose only known helpful messages', () => {
  assert.match(sourceSetupMessage('permission_denied'), /разрешите.*доступ/);
  assert.match(sourceSetupMessage('source_unsupported'), /не удалось распознать/);
  assert.equal(sourceSetupMessage('https://example.org/?password=secret'), '');
  assert.equal(sourceSetupMessage('constructor'), '');
});

test('failed collection notices retain human context and leave raw errors to the report', () => {
  const report = { status: 'failed', failed: [{ error: 'net::ERR_PROXY_CONNECTION_FAILED https://secret.example/?token=secret' }],
    diagnostics: { failure: { reason: 'source_network_error', lessonTitle: 'Lesson A', sectionTitle: 'Part B' } } };
  const message = collectionFailureNotice(report);
  assert.match(message, /Lesson A/);
  assert.match(message, /Part B/);
  assert.match(message, /соединени/);
  assert.doesNotMatch(message, /secret|ERR_|https:/);
});
