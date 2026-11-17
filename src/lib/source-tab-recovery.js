const PREFIX = 'source-tab-recovery:';
const stale = () => Object.assign(new Error('Восстановление относится к другому сбору или окну.'), { code: 'stale_collection' });

/** A journalled handoff keeps storage and deadline independent of the live source tab. */
export function createSourceTabRecovery({ chrome, navigation, exporterBinding, catalogue, readLease,
  revoke, activate, rollback, now = () => Date.now(), randomUUID = () => crypto.randomUUID() }) {
  const committing = new Map();
  const aborting = new Set(), finishing = new Set();
  const read = async owner => (await chrome.storage.session.get(`${PREFIX}${owner}`))[`${PREFIX}${owner}`];
  const write = record => chrome.storage.session.set({ [`${PREFIX}${record.ownerTabId}`]: record });
  async function live(record) {
    const current = await read(record.ownerTabId);
    if (current?.token !== record.token || current.phase === 'aborted' || now() >= record.intent.deadlineAt) throw stale();
  }
  async function owner(record, sender, tabId) {
    if (!record || sender.tab?.id !== record.ownerTabId || sender.documentId !== record.lease.ownerDocumentId) throw stale();
    await exporterBinding.requireOwner(record.ownerTabId, tabId, record.workspaceId, { sender, documentId: record.lease.ownerDocumentId });
  }
  async function prepare(binding, sender, id) {
    await exporterBinding.requireOwner(binding.ownerTabId, binding.tabId, binding.workspaceId, { sender });
    if (!binding.workspaceId) throw stale();
    const existing = await read(binding.ownerTabId);
    if (existing && existing.phase !== 'aborted') {
      await live(existing);
      if (existing.intent.id !== id || existing.collectionId !== binding.collectionId) throw stale();
      return { ok: true, token: existing.token, sourceTabId: existing.newTabId };
    }
    const intent = await navigation.recoveryIntent(binding, id);
    if (intent.attempt !== 2) throw stale();
    const lease = await readLease(binding.tabId);
    if (lease?.collectionId !== binding.collectionId || lease.ownerDocumentId !== sender.documentId) throw stale();
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    if (!Number.isSafeInteger(tab?.id)) throw Object.assign(new Error('Не удалось открыть вкладку восстановления.'), { code: 'source_unavailable' });
    const record = { ...binding, oldTabId: binding.tabId, newTabId: tab.id, token: randomUUID(), lease,
      captureId: randomUUID(), intent, phase: 'prepared' };
    try {
      await navigation.recoveryIntent(binding, id);
      await write(record);
      await navigation.recoveryIntent(binding, id);
      return { ok: true, token: record.token, sourceTabId: tab.id };
    } catch (error) {
      if ((await read(record.ownerTabId))?.token === record.token) await chrome.storage.session.remove(`${PREFIX}${record.ownerTabId}`);
      await chrome.tabs.remove(tab.id).catch(() => {}); throw error;
    }
  }
  async function commitInner(message, sender) {
    const record = await read(sender.tab?.id);
    await owner(record, sender, record?.newTabId);
    if (message.token !== record.token || message.collectionId !== record.collectionId || message.tabId !== record.newTabId) throw stale();
    await live(record);
    if (record.phase === 'prepared') {
      await navigation.recoveryIntent({ ...record, tabId: record.oldTabId }, record.intent.id);
      const [tab, frame] = await Promise.all([chrome.tabs.get(record.newTabId), chrome.webNavigation.getFrame({ tabId: record.newTabId, frameId: 0 })]);
      if ((frame?.url || tab.url) !== 'about:blank') throw stale();
      record.phase = 'committing'; await write(record);
    }
    await revoke(record.oldTabId);
    await live(record);
    await activate(record);
    await live(record);
    const frame = await chrome.webNavigation.getFrame({ tabId: record.newTabId, frameId: 0 });
    if (!frame?.documentId) throw Object.assign(new Error('Не удалось подтвердить новую вкладку.'), { code: 'source_unavailable' });
    const result = await navigation.installReplacement(record.intent, record.newTabId, frame.documentId);
    await navigation.clear(record.oldTabId);
    await live(record);
    record.phase = 'committed'; await write(record);
    const tab = await chrome.tabs.get(record.newTabId);
    await live(record);
    if ((frame.url || tab.url) === 'about:blank') await chrome.tabs.update(record.newTabId, { url: record.intent.recoveryUrl, active: true });
    return { ...result, sourceTabId: record.newTabId };
  }
  function commit(message, sender) {
    const ownerTabId = sender.tab?.id, current = committing.get(ownerTabId);
    if (current) {
      if (current.token !== message.token || current.documentId !== sender.documentId || current.collectionId !== message.collectionId) return Promise.reject(stale());
      return current.promise;
    }
    const entry = { token: message.token, documentId: sender.documentId, collectionId: message.collectionId };
    entry.promise = commitInner(message, sender).catch(async error => { await abort(message, sender).catch(() => {}); throw error; })
      .finally(() => { if (committing.get(ownerTabId) === entry) committing.delete(ownerTabId); });
    committing.set(ownerTabId, entry);
    return entry.promise;
  }
  async function abort(message, sender) {
    const record = await read(sender.tab?.id);
    if (!record) return { ok: true };
    if (message.token && message.token !== record.token || message.collectionId && message.collectionId !== record.collectionId) throw stale();
    try { await owner(record, sender, record.newTabId); }
    catch { await owner(record, sender, record.oldTabId); }
    for (const tabId of [record.oldTabId, record.newTabId]) {
      const lease = await readLease(tabId);
      if (lease && lease.collectionId !== record.collectionId) return { ok: true };
    }
    const current = await read(record.ownerTabId);
    if (!current || finishing.has(record.token)) return { ok: true, replacementSaved: true };
    if (current.token !== record.token) return { ok: true };
    aborting.add(record.token);
    try {
      record.phase = 'aborted'; await write(record);
      await revoke(record.oldTabId);
      await revoke(record.newTabId);
      await navigation.clear(record.newTabId);
      await rollback(record);
      await catalogue.update(record.workspaceId, { sourceTabId: record.oldTabId });
      await chrome.tabs.remove(record.newTabId).catch(() => {});
      return { ok: true, restoreSourceTabId: record.oldTabId };
    } finally { aborting.delete(record.token); }
  }
  async function finish(tabId, collectionId, sender) {
    const record = await read(sender.tab?.id);
    if (!record || record.phase !== 'committed' || record.newTabId !== tabId || record.collectionId !== collectionId) return;
    await owner(record, sender, tabId);
    const current = await read(record.ownerTabId);
    if (current?.token !== record.token || current.phase !== 'committed' || aborting.has(record.token)) return;
    finishing.add(record.token);
    try {
      await chrome.storage.session.remove(`${PREFIX}${record.ownerTabId}`);
      await chrome.tabs.remove(record.oldTabId).catch(() => {});
    } finally { finishing.delete(record.token); }
  }
  async function alternateOwner(ownerTabId, sourceTabId, workspaceId, documentId) {
    const record = await read(ownerTabId);
    if (!record || !['prepared', 'committing'].includes(record.phase) || now() >= record.intent.deadlineAt ||
      record.oldTabId !== sourceTabId || record.workspaceId !== workspaceId || record.lease.ownerDocumentId !== documentId) return false;
    return exporterBinding.isOwner(ownerTabId, record.newTabId, workspaceId, documentId);
  }
  async function acceptsOwnerUrl(ownerTabId, change) {
    if (!change.url && change.status !== 'loading') return false;
    const record = await read(ownerTabId);
    if (!record) return false;
    return await exporterBinding.isOwner(ownerTabId, record.oldTabId, record.workspaceId, record.lease.ownerDocumentId) ||
      record.phase !== 'aborted' && await exporterBinding.isOwner(ownerTabId, record.newTabId, record.workspaceId, record.lease.ownerDocumentId);
  }
  async function discard(ownerTabId) {
    const record = await read(ownerTabId);
    if (!record) return;
    if (record.phase === 'aborted') {
      if (!await exporterBinding.isOwner(ownerTabId, record.oldTabId, record.workspaceId, record.lease.ownerDocumentId)) await chrome.storage.session.remove(`${PREFIX}${ownerTabId}`);
      return;
    }
    if (await exporterBinding.isOwner(ownerTabId, record.oldTabId, record.workspaceId, record.lease.ownerDocumentId) ||
      await exporterBinding.isOwner(ownerTabId, record.newTabId, record.workspaceId, record.lease.ownerDocumentId)) return;
    const current = await read(ownerTabId);
    if (current?.token !== record.token || current.phase === 'aborted' || finishing.has(record.token) || aborting.has(record.token)) return;
    aborting.add(record.token);
    try {
      record.phase = 'aborted'; await write(record);
      await revoke(record.oldTabId); await revoke(record.newTabId); await navigation.clear(record.newTabId); await rollback(record);
      await catalogue.update(record.workspaceId, { sourceTabId: record.oldTabId });
      await chrome.tabs.remove(record.newTabId).catch(() => {});
    } finally { aborting.delete(record.token); }
  }
  return { prepare, commit, abort, finish, alternateOwner, acceptsOwnerUrl, discard, read, busy: owner => committing.has(owner) };
}
