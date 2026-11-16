import assert from 'node:assert/strict';
import test from 'node:test';
import { createBookWorkspaces } from '../src/lib/book-workspaces.js';

const url = id => `https://progressme.ru/cabinet/school/materials/book/${id}/content`;
function fixture(legacy = []) {
  const session = {};
  let sequence = 0;
  const options = { storage: { get: async key => ({ [key]: structuredClone(session[key]) }),
    set: async values => Object.assign(session, structuredClone(values)) },
    listLegacy: async () => legacy, randomUUID: () => `workspace-${++sequence}` };
  return { catalogue: createBookWorkspaces(options), restart: () => createBookWorkspaces(options) };
}

test('a second book in the same source tab receives independent retained storage', async () => {
  const { catalogue } = fixture();
  const first = await catalogue.resolve({ sourceTabId: 7, url: url(71) });
  const second = await catalogue.resolve({ sourceTabId: 7, url: url(81) });
  assert.notEqual(first.workspaceId, second.workspaceId);
  assert.notEqual(first.storageId, second.storageId);
  assert.equal((await catalogue.get(first.workspaceId)).book.rootUrl, url(71));
  assert.equal((await catalogue.list()).length, 2);
  assert.equal((await catalogue.resolve({ sourceTabId: 8, url: url(71) })).workspaceId, first.workspaceId);
});

test('legacy books retain their physical record keys and all duplicate results', async () => {
  const legacy = [
    { storageId: 7, state: { collection: { title: 'First', rootUrl: url(71), status: 'finished' }, updatedAt: '2026-01-01' } },
    { storageId: 8, state: { collection: { title: 'Second', rootUrl: url(71), status: 'finished' }, updatedAt: '2026-01-02' } },
    { storageId: 9, state: { warnings: ['Unknown legacy'] } },
  ];
  const app = fixture(legacy);
  const selected = await app.catalogue.resolve({ sourceTabId: 10, url: url(71) });
  assert.equal(selected.storageId, 8);
  assert.equal((await app.catalogue.list()).length, 3);
  assert.equal((await app.restart().get(selected.workspaceId)).storageId, 8);
  assert.equal((await app.catalogue.list()).find(entry => entry.storageId === 9).book, null);
});

test('concurrent opens of a book share one workspace and different origins stay isolated', async () => {
  const { catalogue } = fixture();
  const [first, second] = await Promise.all([
    catalogue.resolve({ sourceTabId: 7, url: url(71) }), catalogue.resolve({ sourceTabId: 8, url: url(71) }),
  ]);
  assert.equal(first.workspaceId, second.workspaceId);
  const other = await catalogue.resolve({ sourceTabId: 9, url: url(71).replace('progressme.ru', 'platform.desharschool.ru') });
  assert.notEqual(other.workspaceId, first.workspaceId);
});
