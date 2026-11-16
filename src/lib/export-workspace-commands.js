/** Freeze a small projection once, then release the collected raw bodies. */
export function createExportWorkspaceCommands({ readMetadata, saveSummary, readWorkspace, summary, release }) {
  async function readSummary(storageId) {
    if (!readMetadata) return null;
    try { return (await readMetadata(storageId)).summary || null; }
    catch (error) { if (error.code === 'export_metadata_missing') return null; throw error; }
  }
  async function info(storageId) {
    const cached = await readSummary(storageId);
    if (cached) return { revision: cached.exportRevision, snapshotCount: cached.snapshots.length, captureCount: cached.captures.length };
    const state = await readWorkspace(storageId);
    const projection = summary(storageId, state);
    if (saveSummary && (state.snapshots.length || state.captures.length)) {
      await saveSummary(storageId, projection);
      release(storageId);
    }
    return { revision: state.exportRevision || 0, snapshotCount: state.snapshots.length, captureCount: state.captures.length };
  }
  return { readSummary, info };
}
