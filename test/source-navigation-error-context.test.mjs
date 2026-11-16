import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceStatusError } from '../src/lib/source-navigation-errors.js';
import { sourceConnectionView, collectionFailureNotice } from '../src/ui/source-status-view.js';

const sourceDocumentId = '11111111-1111-4111-8111-111111111111';
const navigation = cause => ({ event: 'onBeforeNavigate', phase: 'committed', cause, sourceDocumentId,
  expectedUrl: 'https://progressme.ru/cabinet/school/materials/book/71/content?token=secret',
  observedUrl: 'https://progressme.ru/cabinet/school/materials/book/71/content?password=secret',
  body: 'private exercise' });

test('navigation stop errors retain projected context and explain a repeated reload', () => {
  const error = sourceStatusError({ state: 'source_changed', navigation: navigation('navigation_after_commit') });
  assert.equal(error.code, 'source_left_page');
  assert.match(error.message, /повторно перезагружена/);
  assert.equal(error.navigation.cause, 'navigation_after_commit');
  assert.equal(error.navigation.sourceDocumentId, sourceDocumentId);
  assert.equal(error.expectedUrl, 'https://progressme.ru/cabinet/school/materials/book/71/content');
  assert.equal(error.observedUrl, 'https://progressme.ru/cabinet/school/materials/book/71/content');
  assert.doesNotMatch(JSON.stringify(error.navigation), /secret|password|token|private/);
});

test('an unconfirmed document and a legacy transition receive precise stop messages', () => {
  const unconfirmed = sourceStatusError({ state: 'source_changed', navigation: navigation('unexpected_document') });
  assert.match(unconfirmed.message, /подтвердить документ/);
  const legacy = sourceStatusError({ state: 'unavailable', navigation: navigation('legacy_transition') });
  assert.equal(legacy.code, 'source_update_required');
  assert.match(legacy.message, /Начните сбор/);
});

test('connection and collection notices show the same safe navigation reason', () => {
  for (const [cause, message] of [['navigation_after_commit', /повторно перезагружена/], ['unexpected_document', /подтвердить документ/]]) {
    const context = navigation(cause);
    const view = sourceConnectionView({ sourceStatus: { state: 'source_changed', navigation: context } });
    assert.match(view.description, message);
    const notice = collectionFailureNotice({ diagnostics: { failure: { reason: 'source_left_page', navigation: context } } });
    assert.match(notice, message);
    assert.doesNotMatch(JSON.stringify([view, notice]), /11111111|secret|private|onBeforeNavigate/);
  }
});
