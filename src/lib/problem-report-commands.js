import { createProblemReport, problemReportUrl } from './problem-report.js';
import { sourceBookKey } from './book-workspaces.js';

const COMMANDS = new Set(['BEGIN_PROBLEM_REPORT', 'APPEND_PROBLEM_EVENTS', 'GET_PROBLEM_REPORT']);
export const isProblemReportCommand = type => COMMANDS.has(type);
const bookKey = value => {
  const clean = problemReportUrl(value);
  return sourceBookKey(clean);
};
const savedBook = state => state.collection?.rootUrl || state.book?.rootUrl ||
  state.snapshots?.find(snapshot => /\/cabinet\/(?:school|teacher)\/materials\/book\/\d+\/content\/?$/.test(snapshot.url || ''))?.url;
const stale = () => Object.assign(new Error('Сохранённые материалы изменились. Обновите выбранный учебник и повторите действие.'), { code: 'stale_problem_report' });

/** Keep session-report authorization independent of the capture lease/revision protocol. */
export function createProblemReportCommands({ chrome, store, readWorkspace, requireOwner, assertEpoch }) {
  return async function problemReportCommand(message, sender, expectedEpoch) {
    const tabId = message.tabId;
    await requireOwner(sender, tabId, message.workspaceId, message.type);
    assertEpoch(tabId, expectedEpoch);
    const state = await readWorkspace(message.storageId ?? tabId);
    assertEpoch(tabId, expectedEpoch);
    const storedKey = bookKey(savedBook(state));
    const currentKey = async () => bookKey((await chrome.tabs.get(tabId).catch(() => null))?.url);
    const reportKey = message.workspaceId || tabId;
    if (message.workspaceId && Number.isInteger(message.storageId)) await store.adopt(message.storageId, reportKey);
    if (message.type === 'GET_PROBLEM_REPORT') {
      const result = await store.get(reportKey);
      assertEpoch(tabId, expectedEpoch);
      if (!result) return { ok: true, reportId: null, attemptId: null, report: null };
      const sameBook = bookKey(result.report.book?.rootUrl) === storedKey;
      const report = sameBook && state.collection?.diagnostics
        ? createProblemReport({ ...result.report, collectionDiagnostics: state.collection.diagnostics }) : result.report;
      return { ok: true, ...result, report };
    }
    if (message.type === 'BEGIN_PROBLEM_REPORT') {
      if (!['collection', 'download', 'connection'].includes(message.kind)) throw new Error('Недопустимая попытка диагностики.');
      const book = createProblemReport({ book: message.book }).book;
      const requestedKey = bookKey(book?.rootUrl), actualKey = await currentKey();
      assertEpoch(tabId, expectedEpoch);
      if (message.book && !book || message.kind === 'collection' && (!requestedKey || requestedKey !== actualKey) ||
        message.kind === 'download' && (!requestedKey || requestedKey !== (storedKey || actualKey)) ||
        message.kind === 'connection' && requestedKey && requestedKey !== storedKey && requestedKey !== actualKey) throw stale();
      const result = await store.begin(reportKey, { ownerTabId: sender.tab.id, kind: message.kind, book,
        extensionVersion: message.extensionVersion, browserVersion: message.browserVersion,
        ...(requestedKey && requestedKey === storedKey ? { collectionDiagnostics: state.collection?.diagnostics } : {}) });
      assertEpoch(tabId, expectedEpoch);
      return { ok: true, ...result };
    }
    const retained = await store.get(reportKey);
    assertEpoch(tabId, expectedEpoch);
    if (!retained) throw stale();
    const reportBook = bookKey(retained.report.book?.rootUrl);
    if (reportBook && reportBook !== storedKey && reportBook !== await currentKey()) throw stale();
    assertEpoch(tabId, expectedEpoch);
    const result = await store.append(reportKey, { ownerTabId: sender.tab.id, reportId: message.reportId,
      attemptId: message.attemptId, events: message.events });
    assertEpoch(tabId, expectedEpoch);
    return { ok: true, ...result };
  };
}
