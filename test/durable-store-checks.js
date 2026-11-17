import { createWorkspaceStore } from '../src/lib/store.js';
import { createBookWorkspaces } from '../src/lib/book-workspaces.js';

/** Real IndexedDB contract: adopt supported v3 data and reopen after session loss. */
export async function runDurableStoreChecks(indexedDB, databaseName, IDBKeyRange) {
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  const storage = (values = {}) => ({ values, get: async key => ({ [key]: structuredClone(values[key]) }),
    set: async update => Object.assign(values, structuredClone(update)) });
  const session = storage({ 'workspace-session-scope': 'supported-current-session-000001' });
  const local = storage();
  const book = { title: 'Retained book', rootUrl: 'https://progressme.ru/cabinet/school/materials/book/71/content' };
  const page = { url: 'https://progressme.ru/lesson-editor/book/71/lesson/8/section/9', capturedAt: '2026-11-16T10:00:00.000Z', blocks: [{ text: 'Original' }] };
  const first = createWorkspaceStore({ indexedDB, databaseName, sessionStorage: session, localStorage: null, IDBKeyRange });
  await first.updateWorkspace(7, state => ({ ...state, book, snapshots: [page], captures: [
    { kind: 'websocket', pageUrl: page.url, receivedAt: page.capturedAt, data: { text: 'Original answer', padding: 'x'.repeat(1024 * 1024) } },
  ], exportRevision: 4 }));
  await session.set({ 'book-workspaces-v1': { adopted: true, entries: [{ workspaceId: 'retained-workspace', storageId: 7,
    bookKey: 'https://progressme.ru/book/71', book, status: 'failed', sourceTabId: 7, exporterTabId: 99 }] } });
  const options = { indexedDB, databaseName, sessionStorage: session, localStorage: local, IDBKeyRange };
  const adopted = createWorkspaceStore(options);
  check((await adopted.readExportMetadata(7)).captureCount === 1, 'Supported v3 raw rows remain addressable after durable scope adoption');
  const catalogue = createBookWorkspaces({ storage: local, sessionStorage: session, listLegacy: adopted.listWorkspaceMetadata });
  check((await catalogue.get('retained-workspace')).storageId === 7, 'Catalogue migration retains existing workspace and physical storage IDs');
  const restartedSession = storage();
  const restarted = createWorkspaceStore({ ...options, sessionStorage: restartedSession });
  const metadata = await restarted.readExportMetadata(7);
  check(metadata.snapshotCount === 1 && metadata.captureCount === 1 && metadata.revision === 4, 'A browser restart retains counts and export revision');
  const snapshot = await restarted.readExportRecordPage(7, { kind: 'snapshots', offset: 0, limit: 1, revision: 4 });
  const capture = await restarted.readExportRecordPage(7, { kind: 'captures', offset: 0, limit: 1, revision: 4 });
  check(snapshot.records[0].capturedAt === page.capturedAt && snapshot.records[0].blocks[0].text === 'Original', 'The original saved snapshot and timestamp survive session loss');
  check(capture.records[0].data.text === 'Original answer' && capture.records[0].data.padding.length === 1024 * 1024, 'Durable adoption preserves complete authored capture bytes');
  const restartedCatalogue = createBookWorkspaces({ storage: local, sessionStorage: restartedSession, listLegacy: restarted.listWorkspaceMetadata });
  const retained = await restartedCatalogue.get('retained-workspace');
  check(retained.storageId === 7 && retained.sourceTabId === undefined && retained.exporterTabId === undefined,
    'Restarted catalogues preserve the book without reviving source/exporter tabs');
  check(Object.keys(restartedSession.values).length === 0, 'Reading durable records never recreates capture leases, IDs or browser bindings');
  check((await restartedCatalogue.list()).length === 1, 'Repeated durable adoption never duplicates the supported saved book');
  return checks;
}
