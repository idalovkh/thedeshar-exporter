import { createProblemReport, appendProblemEvent, problemReportForDownload } from './problem-report.js';

const keyFor = tabId => `problem-report:${tabId}`;
const token = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const bookKey = book => {
  try {
    const url = new URL(book?.rootUrl);
    const id = url.pathname.match(/^\/cabinet\/(?:school|teacher)\/materials\/book\/(\d+)\/content\/?$/)?.[1];
    return id ? `${url.origin}/book/${id}` : '';
  } catch { return ''; }
};
const stale = () => Object.assign(new Error('Этот отчёт относится к предыдущей попытке. Начните действие заново.'), { code: 'stale_problem_report' });

/** Diagnostic persistence is separate from capture revisions and lasts for this browser session. */
export function createProblemReportStore({ sessionStorage = globalThis.chrome?.storage?.session,
  randomUUID = () => globalThis.crypto.randomUUID(), now = () => new Date().toISOString() } = {}) {
  const pending = new Map(), epochs = new Map(), cleared = new Set();
  const epochOf = tabId => epochs.get(tabId) || 0;
  const check = (tabId, epoch) => { if (epochOf(tabId) !== epoch) throw stale(); };
  function queued(tabId, operation) {
    const task = (pending.get(tabId) || Promise.resolve()).catch(() => {}).then(operation);
    pending.set(tabId, task);
    const finished = () => { if (pending.get(tabId) === task) pending.delete(tabId); };
    task.then(finished, finished);
    return task;
  }
  const storage = () => {
    if (!sessionStorage) throw Object.assign(new Error('Не удалось сохранить отчёт в текущей сессии браузера.'), { code: 'storage_error' });
    return sessionStorage;
  };
  async function read(tabId) {
    if (cleared.has(tabId)) return null;
    const value = (await storage().get(keyFor(tabId)))[keyFor(tabId)];
    const report = problemReportForDownload(value?.report);
    return report && token(value.reportId) && token(value.attemptId) && Number.isInteger(value.ownerTabId)
      ? { ...value, report } : null;
  }
  const response = value => value ? { reportId: value.reportId, attemptId: value.attemptId, report: value.report } : null;

  async function begin(tabId, { ownerTabId, kind, book, extensionVersion, browserVersion, collectionDiagnostics } = {}) {
    if (!(Number.isInteger(tabId) && tabId > 0 || typeof tabId === 'string' && token(tabId)) || !Number.isInteger(ownerTabId) || ownerTabId <= 0 ||
      !['collection', 'download', 'connection'].includes(kind)) throw new Error('Недопустимая попытка диагностики.');
    const epoch = epochOf(tabId) + 1;
    epochs.set(tabId, epoch);
    return queued(tabId, async () => {
      check(tabId, epoch);
      const previous = await read(tabId);
      check(tabId, epoch);
      const requestedBook = createProblemReport({ book }).book;
      const sameBook = previous && (bookKey(previous.report.book) === bookKey(requestedBook) || kind === 'connection' && !requestedBook);
      const retained = sameBook && kind !== 'collection' ? previous.report : null;
      const report = createProblemReport({ ...retained, kind,
        ...(kind !== 'collection' && !retained ? { collectionDiagnostics } : {}),
        book: requestedBook || (kind === 'connection' ? retained?.book : null),
        extensionVersion: extensionVersion || retained?.extensionVersion,
        browserVersion: browserVersion || retained?.browserVersion,
        startedAt: retained?.startedAt || now(), stage: kind === 'collection' ? 'book' : kind === 'download' ? 'export' : 'connection',
        status: 'started', persisted: true, storageError: false, legacy: false });
      const value = { reportId: previous?.reportId || randomUUID(), attemptId: randomUUID(), ownerTabId, kind, report };
      check(tabId, epoch);
      await storage().set({ [keyFor(tabId)]: value });
      check(tabId, epoch);
      cleared.delete(tabId);
      return response(value);
    });
  }

  async function append(tabId, { ownerTabId, reportId, attemptId, events } = {}) {
    const epoch = epochOf(tabId);
    return queued(tabId, async () => {
      check(tabId, epoch);
      const value = await read(tabId);
      check(tabId, epoch);
      if (!value || value.ownerTabId !== ownerTabId || value.reportId !== reportId || value.attemptId !== attemptId) throw stale();
      if (!Array.isArray(events) || events.length > 128) throw new Error('Недопустимые события диагностики.');
      let report = value.report;
      for (const event of events) report = appendProblemEvent(report, event);
      const next = { ...value, report };
      check(tabId, epoch);
      await storage().set({ [keyFor(tabId)]: next });
      check(tabId, epoch);
      return response(next);
    });
  }

  const get = tabId => queued(tabId, async () => response(await read(tabId)));
  function clear(tabId) {
    epochs.set(tabId, epochOf(tabId) + 1);
    cleared.add(tabId);
    // A pending session write completes before removal, so a late callback cannot restore it.
    return queued(tabId, () => storage().remove(keyFor(tabId)));
  }
  function adopt(previousKey, workspaceId) {
    return queued(workspaceId, async () => {
      const marker = `problem-report-adopted:${workspaceId}`;
      if ((await storage().get(marker))[marker]) return;
      const current = await read(workspaceId);
      const previous = current ? null : await read(previousKey);
      await storage().set({ [marker]: true, ...(previous ? { [keyFor(workspaceId)]: previous } : {}) });
    });
  }
  return Object.freeze({ begin, append, get, clear, adopt });
}
