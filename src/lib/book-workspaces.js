import { isSourceUrl } from './state.js';

const CATALOGUE = 'book-workspaces-v1';
const BINDINGS = 'book-workspace-bindings-v1';
export function sourceBookKey(value) {
  if (!isSourceUrl(value)) return '';
  const url = new URL(value);
  const id = url.pathname.match(/^(?:\/cabinet\/(?:school|teacher)\/materials|\/lesson-editor)\/book\/(\d+)(?:\/|$)/)?.[1];
  return id ? `${url.origin}/book/${id}` : '';
}
export function retainedBook(state = {}) {
  const pairs = [state.collection && { title: state.collection.title, rootUrl: state.collection.rootUrl }, state.book,
    ...(state.snapshots || []).map(snapshot => ({ title: snapshot.title, rootUrl: snapshot.url }))];
  const book = pairs.find(book => sourceBookKey(book?.rootUrl) && /\/materials\/book\/\d+\/content\/?$/.test(new URL(book.rootUrl).pathname));
  if (!book) return null;
  return { title: typeof book.title === 'string' && book.title.trim() ? book.title.trim().slice(0, 500) : `Учебник ${book.rootUrl.match(/\/book\/(\d+)/)[1]}`,
    rootUrl: book.rootUrl };
}

/** Durable book identities point at records; live tab bindings remain session-only. */
export function createBookWorkspaces({ storage, sessionStorage = storage, listLegacy = async () => [], randomUUID = () => crypto.randomUUID() } = {}) {
  let pending = Promise.resolve();
  function queued(operation) {
    const task = pending.catch(() => {}).then(operation);
    pending = task;
    return task;
  }
  async function load() {
    const stored = (await storage.get(CATALOGUE))[CATALOGUE];
    const entries = Array.isArray(stored?.entries) ? stored.entries : [];
    const bindings = (await sessionStorage.get(BINDINGS))[BINDINGS] || {};
    if (stored?.durable) return entries.map(entry => ({ ...entry, ...bindings[entry.workspaceId] }));
    // The supported predecessor kept this small catalogue in the current
    // browser session. Retain its workspace/storage IDs instead of rebuilding
    // duplicate books or loading their raw records during adoption.
    const legacy = (await sessionStorage.get(CATALOGUE))[CATALOGUE];
    for (const entry of Array.isArray(legacy?.entries) ? legacy.entries : []) {
      if (!entries.some(previous => previous.workspaceId === entry.workspaceId || previous.storageId === entry.storageId)) entries.push(entry);
    }
    for (const { storageId, state } of await listLegacy()) {
      if (entries.some(entry => entry.storageId === storageId)) continue;
      const book = retainedBook(state);
      entries.push({ workspaceId: randomUUID(), storageId, sourceTabId: Number.isInteger(storageId) ? storageId : null,
        bookKey: sourceBookKey(book?.rootUrl), book, status: state.collection?.status || 'retained',
        updatedAt: state.updatedAt || '', legacy: true });
    }
    await save(entries);
    return entries;
  }
  const save = async entries => {
    const bindings = {};
    const retained = entries.map(({ sourceTabId, exporterTabId, ...entry }) => {
      if (sourceTabId !== undefined || exporterTabId !== undefined) bindings[entry.workspaceId] = {
        ...(sourceTabId !== undefined ? { sourceTabId } : {}), ...(exporterTabId !== undefined ? { exporterTabId } : {}),
      };
      return entry;
    });
    await sessionStorage.set({ [BINDINGS]: bindings });
    await storage.set({ [CATALOGUE]: { adopted: true, durable: true, entries: retained } });
  };
  const clone = value => value ? structuredClone(value) : null;
  function get(workspaceId) { return queued(async () => clone((await load()).find(entry => entry.workspaceId === workspaceId))); }
  function list() { return queued(async () => structuredClone(await load())); }
  function adopt(storageId, state) {
    return queued(async () => {
      const entries = await load();
      const previous = entries.find(entry => entry.storageId === storageId);
      if (previous) return clone(previous);
      if (!state?.collection && !state?.book && !state?.snapshots?.length && !state?.captures?.length && !state?.warnings?.length) return null;
      const book = retainedBook(state);
      const entry = { workspaceId: randomUUID(), storageId, sourceTabId: Number.isInteger(storageId) ? storageId : null,
        bookKey: sourceBookKey(book?.rootUrl), book, status: state.collection?.status || 'retained',
        updatedAt: state.updatedAt || '', legacy: true };
      entries.push(entry); await save(entries); return clone(entry);
    });
  }
  function resolve({ sourceTabId, url, preferredWorkspaceId } = {}) {
    return queued(async () => {
      const bookKey = sourceBookKey(url);
      if (!bookKey) throw new Error('Откройте содержание книги на учебной платформе.');
      const entries = await load();
      const candidates = entries.filter(entry => entry.bookKey === bookKey).sort((a, b) =>
        String(b.updatedAt).localeCompare(String(a.updatedAt)) || String(a.storageId).localeCompare(String(b.storageId)));
      let entry = candidates.find(entry => entry.workspaceId === preferredWorkspaceId) || candidates[0];
      if (!entry) {
        const workspaceId = randomUUID();
        const contents = /\/materials\/book\/\d+\/content\/?$/.test(new URL(url).pathname);
        entry = { workspaceId, storageId: workspaceId, bookKey,
          book: contents ? { title: `Учебник ${url.match(/\/book\/(\d+)/)[1]}`, rootUrl: url } : null,
          status: 'ready', updatedAt: new Date().toISOString() };
        entries.push(entry);
      }
      entry.sourceTabId = sourceTabId;
      await save(entries);
      return clone(entry);
    });
  }
  function update(workspaceId, { state, sourceTabId, exporterTabId, book } = {}) {
    return queued(async () => {
      const entries = await load(), entry = entries.find(entry => entry.workspaceId === workspaceId);
      if (!entry) throw new Error('Сохранённая книга недоступна в локальном хранилище.');
      const selected = book || (state && retainedBook(state));
      if (selected && sourceBookKey(selected.rootUrl) && (!entry.bookKey || sourceBookKey(selected.rootUrl) === entry.bookKey)) {
        entry.book = selected; entry.bookKey = sourceBookKey(selected.rootUrl);
      }
      if (state) { entry.status = state.collection?.status || 'ready'; entry.updatedAt = state.updatedAt || new Date().toISOString(); }
      if (sourceTabId !== undefined) entry.sourceTabId = sourceTabId;
      if (exporterTabId !== undefined) entry.exporterTabId = exporterTabId;
      await save(entries); return clone(entry);
    });
  }
  return Object.freeze({ get, list, adopt, resolve, update });
}
