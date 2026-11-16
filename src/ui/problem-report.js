import { appendProblemEvent, createProblemReport, legacyProblemReport, problemReportForDownload, problemReportUrl, projectProblemEvent } from '../lib/problem-report.js';

/** Keep a synchronous local copy: diagnostics must remain downloadable if storage fails. */
export function createProblemReporter({ send, extensionVersion, browserVersion, onChange = () => {} }) {
  browserVersion = browserVersion?.match(/(?:Chrome|Chromium|Edg|Firefox)\/[\d.]+/)?.[0] || browserVersion;
  let current = null;
  let sequence = 0;
  const changed = context => { if (current === context) onChange(); };
  const failedStorage = context => {
    context.storageFailed = true;
    context.report = { ...context.report, persisted: false, storageError: true };
    changed(context);
  };
  const active = (context, attempt) => current === context && context.attempt === attempt;

  function select({ tabId, workspaceId, book, collectionDiagnostics } = {}) {
    if (book?.rootUrl) book = { ...book, rootUrl: problemReportUrl(book.rootUrl).replace(/\/$/, '') };
    const key = `${workspaceId || tabId}:${book?.rootUrl || ''}`;
    if (current?.key === key) {
      current.collectionDiagnostics = collectionDiagnostics;
      return;
    }
    if (current?.timer) clearTimeout(current.timer);
    current = tabId == null && !workspaceId ? null : {
      key, tabId, workspaceId, book, collectionDiagnostics, attempt: ++sequence, kind: 'connection', pending: [],
      report: null, reportId: null, attemptId: null, loaded: false, storageFailed: false,
    };
  }

  function fallback(context) {
    return legacyProblemReport({ extensionVersion, browserVersion, book: context.book, collectionDiagnostics: context.collectionDiagnostics }) ||
      createProblemReport({ extensionVersion, browserVersion, book: context.book, kind: 'connection', persisted: false });
  }

  async function load() {
    const context = current;
    if (!context || context.loaded) return;
    context.loaded = true;
    const attempt = context.attempt;
    try {
      const result = await send(context.tabId, 'GET_PROBLEM_REPORT', { workspaceId: context.workspaceId, book: context.book });
      if (!active(context, attempt)) return;
      if (result.report && (!context.book?.rootUrl || result.report.book?.rootUrl === context.book.rootUrl)) {
        context.report = problemReportForDownload(result.report);
        context.reportId = result.reportId;
        context.attemptId = result.attemptId;
      }
    } catch { /* The fallback can still describe a collection from an older version. */ }
    changed(context);
  }

  async function startStored(context, attempt) {
    const result = await send(context.tabId, 'BEGIN_PROBLEM_REPORT', {
      workspaceId: context.workspaceId, kind: context.kind, book: context.book, extensionVersion, browserVersion,
    });
    if (!active(context, attempt)) return false;
    if (!result.reportId || !result.attemptId) throw new Error('Diagnostic storage unavailable');
    context.reportId = result.reportId;
    context.attemptId = result.attemptId;
    if (result.report && !context.pending.length) context.report = problemReportForDownload(result.report);
    context.report = { ...context.report, persisted: true, storageError: false };
    return true;
  }

  function flush(context, attempt) {
    if (!active(context, attempt)) return Promise.resolve();
    if (context.timer) { clearTimeout(context.timer); context.timer = null; }
    if (context.saving) return context.saving.then(() => flush(context, attempt));
    if (!context.pending.length || context.storageFailed) return Promise.resolve();
    context.saving = (async () => {
      try {
        if (!context.reportId && !await startStored(context, attempt)) return;
        while (active(context, attempt) && context.pending.length) {
          const events = context.pending.splice(0, 64);
          await send(context.tabId, 'APPEND_PROBLEM_EVENTS', { workspaceId: context.workspaceId, reportId: context.reportId, attemptId: context.attemptId, events });
          if (active(context, attempt)) context.report = { ...context.report, persisted: true, storageError: false };
        }
      } catch {
        if (active(context, attempt)) failedStorage(context);
      }
    })().finally(() => { context.saving = null; });
    return context.saving;
  }

  function recordFor(context, attempt, event) {
    if (!active(context, attempt)) return;
    const projected = projectProblemEvent(event, new Date().toISOString());
    if (!projected) return;
    const previous = context.report || fallback(context);
    context.report = appendProblemEvent(previous, projected);
    // Queue only the projected event, never raw caller fields or response data.
    if (!context.storageFailed) context.pending.push(projected);
    if (!context.timer && !context.storageFailed) context.timer = setTimeout(() => { void flush(context, attempt); }, 250);
    changed(context);
  }

  async function begin(kind) {
    const context = current;
    if (!context) return { record() {}, flush: async () => {} };
    if (context.timer) clearTimeout(context.timer);
    const previous = context.report || fallback(context);
    const attempt = ++sequence;
    Object.assign(context, { attempt, kind, pending: [], reportId: null, attemptId: null, storageFailed: false, loaded: true });
    context.report = createProblemReport({ ...(kind === 'collection' ? {} : previous), extensionVersion, browserVersion,
      book: context.book, kind, stage: kind === 'collection' ? 'book' : kind === 'download' ? 'export' : 'connection', status: 'started',
      collectionDiagnostics: kind === 'collection' ? undefined : context.collectionDiagnostics || previous?.collection });
    changed(context);
    try { await startStored(context, attempt); }
    catch { if (active(context, attempt)) failedStorage(context); }
    return { record: event => recordFor(context, attempt, event), flush: () => flush(context, attempt) };
  }

  return Object.freeze({
    select, load, begin,
    record(event) { if (current) recordFor(current, current.attempt, event); },
    connectionRecovered() {
      if (current?.report?.stage === 'connection' && current.report.status === 'failed') {
        recordFor(current, current.attempt, { stage: 'connection', status: 'ready' });
      }
    },
    available() {
      const report = current && (current.report || fallback(current));
      const missing = report?.downloadSummary;
      return (report?.status === 'failed' || report?.status === 'finished' &&
        ['failed', 'skipped', 'unavailable'].some(status => missing?.[status] > 0)) &&
        !(report.legacy && report.collection?.failure?.reason === 'cancelled');
    },
    clear() {
      if (current?.timer) clearTimeout(current.timer);
      current = null;
      sequence++;
      onChange();
    },
    async snapshot() {
      const context = current;
      if (!context) return null;
      await flush(context, context.attempt);
      if (current !== context) return null;
      const report = context.report || fallback(context);
      return problemReportForDownload({ ...report, collection: context.collectionDiagnostics || report.collection });
    },
  });
}

export function downloadProblemReport(report) {
  if (!report) return;
  const file = new Blob([JSON.stringify(report)], { type: 'application/json' });
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = `exporter-problem-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.append(link);
  try { link.click(); }
  finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
