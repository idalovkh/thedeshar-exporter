import assert from 'node:assert/strict';
import test from 'node:test';
import { createBookWorkspaces } from '../src/lib/book-workspaces.js';

const url = 'https://progressme.ru/cabinet/school/materials/book/71/content';
const storage = (values = {}) => ({ values, get: async key => ({ [key]: structuredClone(values[key]) }),
  set: async update => Object.assign(values, structuredClone(update)) });

test('the supported session catalogue migrates idempotently without persisting live tab bindings', async () => {
  const entry = { workspaceId: 'saved-book', storageId: 7, bookKey: 'https://progressme.ru/book/71',
    book: { title: 'Saved', rootUrl: url }, status: 'failed', sourceTabId: 7, exporterTabId: 99 };
  const local = storage(), session = storage({ 'book-workspaces-v1': { adopted: true, entries: [entry] } });
  const options = { storage: local, sessionStorage: session, listLegacy: async () => [{ storageId: 7, state: { book: entry.book } }],
    randomUUID: () => 'must-not-replace-existing-identity' };
  const first = createBookWorkspaces(options);
  assert.deepEqual(await first.get('saved-book'), entry);
  assert.equal((await first.list()).length, 1);
  const persisted = local.values['book-workspaces-v1'].entries[0];
  assert.equal(persisted.sourceTabId, undefined);
  assert.equal(persisted.exporterTabId, undefined);
  assert.equal(persisted.storageId, 7);
  const restarted = createBookWorkspaces({ ...options, sessionStorage: storage() });
  const retained = await restarted.get('saved-book');
  assert.deepEqual(retained.book, entry.book);
  assert.equal(retained.sourceTabId, undefined);
  assert.equal(retained.exporterTabId, undefined);
  assert.equal((await restarted.list()).length, 1);
});

test('new book bindings survive worker restarts only inside the same browser session', async () => {
  const local = storage(), session = storage();
  const options = { storage: local, sessionStorage: session, randomUUID: () => 'workspace-created' };
  const first = await createBookWorkspaces(options).resolve({ sourceTabId: 7, url });
  assert.equal(first.sourceTabId, 7);
  await createBookWorkspaces(options).update(first.workspaceId, { exporterTabId: 99 });
  assert.equal((await createBookWorkspaces(options).get(first.workspaceId)).exporterTabId, 99);
  const restarted = await createBookWorkspaces({ ...options, sessionStorage: storage() }).get(first.workspaceId);
  assert.equal(restarted.sourceTabId, undefined);
  assert.equal(restarted.exporterTabId, undefined);
});
