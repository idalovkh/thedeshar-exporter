import { isSourceUrl } from './state.js';

export const MAX_NAVIGATION_DIAGNOSTIC_EVENTS = 32;
const EVENTS = new Set(['onBeforeNavigate', 'onCommitted', 'onHistoryStateUpdated',
  'onReferenceFragmentUpdated', 'onErrorOccurred', 'onTabReplaced']);
const PHASES = new Set(['armed', 'loading', 'committed', 'failed', 'browser_retry']);
const CAUSES = new Set(['expected_navigation', 'expected_commit', 'expected_spa', 'same_url_history_ignored',
  'old_document_ignored', 'stale_event_ignored', 'unexpected_target', 'unexpected_document',
  'navigation_after_commit', 'navigation_interrupted', 'network_error', 'navigation_error', 'legacy_transition']);
const DOCUMENT_ID = /^(?:[a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i;

export function diagnosticPageUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    if (!isSourceUrl(url) || url.pathname.length > 256) return '';
    const book = /^\/cabinet\/(?:school|teacher)\/materials\/book\/\d+\/content\/?$/;
    const lesson = /^\/lesson-editor\/book\/\d+\/lesson\/\d+(?:\/section(?:\/(?:\d+|for-homework))?)?\/?$/;
    return book.test(url.pathname) || lesson.test(url.pathname) ? `${url.origin}${url.pathname}` : '';
  } catch { return ''; }
}

function navigationEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const event = {};
  if (EVENTS.has(value.event)) event.event = value.event;
  if (PHASES.has(value.phase)) event.phase = value.phase;
  if (CAUSES.has(value.cause)) event.cause = value.cause;
  for (const key of ['sourceDocumentId', 'documentId', 'currentDocumentId']) {
    if (typeof value[key] === 'string' && DOCUMENT_ID.test(value[key])) event[key] = value[key];
  }
  for (const key of ['expectedUrl', 'observedUrl']) {
    const url = diagnosticPageUrl(value[key]);
    if (url) event[key] = url;
  }
  if (Number.isFinite(value.timeStamp) && value.timeStamp >= 0 && value.timeStamp <= Number.MAX_SAFE_INTEGER) event.timeStamp = value.timeStamp;
  if (Number.isInteger(value.attempt) && value.attempt >= 1 && value.attempt <= 3) event.attempt = value.attempt;
  return Object.keys(event).length ? event : undefined;
}

/** Browser context is optional in old reports; only finite known fields enter new ones. */
export function navigationDiagnostic(value) {
  const context = navigationEvent(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const events = Array.isArray(value.events) ? value.events.slice(-MAX_NAVIGATION_DIAGNOSTIC_EVENTS)
    .map(navigationEvent).filter(Boolean) : [];
  if (!context && !events.length) return undefined;
  return { ...context, ...(events.length ? { events } : {}) };
}
