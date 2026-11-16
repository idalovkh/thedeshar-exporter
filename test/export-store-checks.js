import { createWorkspaceStore } from '../src/lib/store.js';

export async function runExportStoreChecks(indexedDB, databaseName) {
  const values = {};
  const options = { indexedDB, databaseName,
    sessionStorage: { get: async key => ({ [key]: values[key] }), set: async next => Object.assign(values, next) },
    randomUUID: () => 'session-export-00000001' };
  const store = createWorkspaceStore(options);
  const url = 'https://progressme.ru/cabinet/school/materials/book/71/content';
  await store.updateWorkspace(7, state => ({ ...state, exportRevision: 12,
    snapshots: [{ url, blocks: [{ text: 'Raw page' }] }], captures: [{ data: { text: 'Raw response' } }],
    collection: { status: 'finished', rootUrl: url } }));
  const summary = { exportRevision: 12, snapshots: [{ url }], captures: [{ data: true }],
    collection: { status: 'finished', rootUrl: url }, assetInventory: [] };
  await store.saveExportSummary(7, summary);
  await store.releaseWorkspace(7);
  const cold = createWorkspaceStore(options);
  indexedDB.operations?.splice(0);
  const info = await cold.readExportMetadata(7);
  if (info.revision !== 12 || info.captureCount !== 1 || info.summary.captures[0].data !== true) throw Error('Export metadata lost its frozen revision');
  if (indexedDB.operations?.some(operation => operation.store === 'workspace-records')) throw Error('Reading export metadata loaded raw records');
  const page = await cold.readExportRecordPage(7, { kind: 'captures', offset: 0, limit: 1, revision: 12 });
  if (page.records[0].data.text !== 'Raw response' || page.nextOffset !== 1) throw Error('Export page did not read its exact committed record');
  try { await cold.readExportRecordPage(7, { kind: 'captures', offset: 0, limit: 1, revision: 11 }); throw Error('Stale page was accepted'); }
  catch (error) { if (error.code !== 'export_changed') throw error; }
  indexedDB.operations?.splice(0);
  const saved = await cold.recordExportResult(7, { revision: 12, loaded: 1, missing: 1 });
  if (saved.exportRevision !== 13 || saved.downloadResult.missing !== 1) throw Error('Export result was not committed');
  if (indexedDB.operations?.some(operation => operation.store === 'workspace-records')) throw Error('Writing an export result loaded raw records');
  const refreshed = await cold.readExportMetadata(7);
  if (refreshed.summary.exportRevision !== 13 || refreshed.summary.downloadResult.loaded !== 1) throw Error('Summary did not follow the metadata result');
  if ((await store.readWorkspace(7)).captures[0].data.text !== 'Raw response') throw Error('Metadata result changed committed source records');
  return 6;
}
