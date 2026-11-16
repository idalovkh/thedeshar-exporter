import { collectionDiagnosticsForDownload, diagnosticPageUrl } from './collection-diagnostics.js';
import { isSafeMediaUrl, redactSensitive } from './security.js';
import { isSourceUrl } from './state.js';
import { navigationErrorCode } from './source-navigation-errors.js';
import { navigationDiagnostic } from './navigation-diagnostics.js';
import { boundProblemCollection } from './problem-report-collection-limit.js';
import { pageReadinessDiagnostic } from './page-readiness-diagnostics.js';
import { exporterBindingDiagnostic } from './exporter-binding-diagnostics.js';

export const MAX_PROBLEM_REPORT_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
const COLLECTION_STAGES = new Set(['book', 'open_lesson', 'open_section', 'wait_exercises', 'save_page',
  'wait_author_data', 'reload_section', 'finish']);
const DOWNLOAD_STAGES = new Set(['permissions', 'files', 'hydrate', 'package', 'zip', 'export']);
const STAGES = new Set(['connection', ...COLLECTION_STAGES, ...DOWNLOAD_STAGES]);
const STATUSES = new Set(['started', 'waiting', 'ready', 'saved', 'retrying', 'finished', 'failed', 'cancelled',
  'downloaded', 'skipped', 'unavailable']);
const REASONS = new Set(['section_loading_timeout', 'section_render_timeout', 'navigation_timeout', 'source_disconnected', 'source_timeout', 'source_closed',
  'source_changed', 'source_update_required', 'navigation_blocked', 'snapshot_error', 'author_data_missing',
  'author_data_incomplete', 'interrupted', 'operation_failed', 'section_list_changed', 'document_load_timeout',
  'navigation_stale', 'cancelled', 'connection_error', 'permission_denied', 'export_error', 'archive_limit',
  'incomplete_export', 'export_changed', 'asset_limit', 'storage_error', 'storage_unavailable', 'export_resources',
  'zip_write', 'zip_verification', 'file_save_unavailable', 'unsupported_content_type', 'http_error', 'network_error',
  'temporary_url', 'timeout', 'partial_response', 'unsupported_stream', 'file_limit', 'size_mismatch', 'empty_file',
  'download_failed', 'ambiguous_media_url', 'invalid_png', 'webp_timeout', 'webp_unavailable',
  'image_dimensions_unverified', 'image_dimensions_limit', 'image_resize_failed', 'image_resize_timeout',
  'image_webp_failed', 'image_webp_timeout',
  'media_hash_failed', 'source_loading', 'source_network_error', 'source_security_error', 'source_interrupted',
  'source_unavailable', 'source_left_page', 'transition_timeout', 'retry_exhausted', 'exporter_binding_mismatch']);
const FORMATS = new Set(['html', 'json', 'jpeg', 'png', 'gif', 'webp', 'pdf', 'unknown']);
const TERMINAL_FILES = new Set(['downloaded', 'failed', 'skipped', 'unavailable']);
const AUTHOR_STATES = new Set(['received', 'incomplete', 'unobserved', 'unknown']);
const downloadStates = new WeakMap();
const reportSizes = new WeakMap();
const eventSizes = new WeakMap();
const eventKeys = new WeakMap();
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const numericId = value => typeof value === 'string' && /^\d{1,32}$/.test(value);
const count = value => nonnegative(value) ? value : 0;
const plus = (left, right) => Math.min(Number.MAX_SAFE_INTEGER, left + right);
const encodedBytes = value => encoder.encode(JSON.stringify(value)).byteLength;
const eventBytes = value => {
  if (!eventSizes.has(value)) eventSizes.set(value, encodedBytes(value));
  return eventSizes.get(value);
};
const eventKey = value => {
  if (!eventKeys.has(value)) eventKeys.set(value, JSON.stringify([value.stage, value.status, value.reason, value.url, value.assetId]));
  return eventKeys.get(value);
};
function reportSize(report) {
  if (!reportSizes.has(report)) {
    const metadata = encodedBytes({ ...report, events: [] });
    reportSizes.set(report, { metadata,
      total: metadata + report.events.reduce((sum, event) => sum + eventBytes(event), 0) + Math.max(0, report.events.length - 1) });
  }
  return reportSizes.get(report);
}

export const isDownloadStage = value => DOWNLOAD_STAGES.has(value);

/** Diagnostic references deliberately discard every query/hash, including innocuous ones. */
export function problemReportUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return '';
  try {
    const url = new URL(value);
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.pathname.length <= 1024 && isSafeMediaUrl(url.href) ? `${url.origin}${url.pathname}` : '';
  } catch { return ''; }
}

function title(value) {
  if (typeof value !== 'string') return '';
  const text = value.slice(0, 1000).replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ')
    .replace(/(?:\b(?:https?|wss):)?\/\/[^\s<>"']+/gi, '[REDACTED]')
    .replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g, '[REDACTED]');
  return redactSensitive(text).trim().slice(0, 500);
}

function bookForReport(value) {
  const rootUrl = problemReportUrl(value?.rootUrl);
  if (!isSourceUrl(rootUrl) || !/^\/cabinet\/(?:school|teacher)\/materials\/book\/\d+\/content\/?$/.test(new URL(rootUrl).pathname)) return null;
  return { rootUrl, title: title(value?.title) };
}

export function projectProblemEvent(value, defaultAt = new Date().toISOString()) {
  if (!value || !STAGES.has(value.stage) || !STATUSES.has(value.status)) return null;
  const at = value.at ?? defaultAt;
  if (!timestamp(at)) return null;
  const event = { at, stage: value.stage, status: value.status, ...pageReadinessDiagnostic(value) };
  if (REASONS.has(value.reason)) event.reason = value.reason;
  const networkError = navigationErrorCode(value.networkError);
  if (networkError) event.networkError = networkError;
  const navigation = navigationDiagnostic(value.navigation);
  if (navigation) event.navigation = navigation;
  const binding = exporterBindingDiagnostic(value.binding);
  if (binding) event.binding = binding;
  for (const key of ['expectedUrl', 'observedUrl']) {
    const url = diagnosticPageUrl(value[key]);
    if (url) event[key] = url;
  }
  if (typeof value.browserLoading === 'boolean') event.browserLoading = value.browserLoading;
  for (const key of ['url', 'sourcePage', 'lastSavedUrl']) {
    const url = problemReportUrl(value[key]);
    if (url) event[key] = url;
  }
  if (typeof value.assetId === 'string' && /^asset-[a-zA-Z0-9_-]{1,64}$/.test(value.assetId)) event.assetId = value.assetId;
  for (const key of ['attempt', 'declaredBytes', 'receivedBytes', 'elapsedMs', 'polls', 'totalFiles', 'remainingMs', 'retryDelayMs']) if (nonnegative(value[key])) event[key] = value[key];
  if (Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599) event.httpStatus = value.httpStatus;
  for (const key of ['mimeType', 'effectiveMimeType']) {
    const mimeType = typeof value[key] === 'string' ? value[key].split(';')[0].trim().toLowerCase() : '';
    if (/^[a-z0-9!#$&^_.+-]{1,64}\/[a-z0-9!#$&^_.+-]{1,64}$/.test(mimeType)) event[key] = mimeType;
  }
  if (FORMATS.has(value.detectedFormat)) event.detectedFormat = value.detectedFormat;
  if (numericId(value.lessonId)) event.lessonId = value.lessonId;
  if (numericId(value.sectionId) || value.sectionId === 'for-homework') event.sectionId = value.sectionId;
  if (AUTHOR_STATES.has(value.authorData)) event.authorData = value.authorData;
  const state = value.exerciseState;
  if (state && [state.loaderVisible, state.listVisible, state.emptyVisible].every(flag => typeof flag === 'boolean')) {
    event.exerciseState = { loaderVisible: state.loaderVisible, listVisible: state.listVisible, emptyVisible: state.emptyVisible };
  }
  const network = value.network;
  if (network && nonnegative(network.pending) && nonnegative(network.idleMs)) event.network = { pending: network.pending, idleMs: network.idleMs };
  return event;
}
const eventForReport = (value, defaultAt) => projectProblemEvent(value, defaultAt ?? value?.at);

const emptySummary = () => ({ total: 0, downloaded: 0, failed: 0, skipped: 0, unavailable: 0, receivedBytes: 0, attempts: 0, omittedEvents: 0 });
function statesFrom(events) {
  const states = new Map();
  for (const event of events) if (event.stage === 'files' && event.assetId && TERMINAL_FILES.has(event.status)) states.set(event.assetId, event);
  return states;
}
function summaryFrom(events, value) {
  const result = emptySummary();
  for (const event of statesFrom(events).values()) {
    result[event.status]++;
    result.total++;
    result.receivedBytes = plus(result.receivedBytes, count(event.receivedBytes));
  }
  result.attempts = events.filter(event => event.stage === 'files' && event.assetId && event.status === 'started').length;
  if (value && typeof value === 'object') for (const key of Object.keys(result)) if (nonnegative(value[key])) result[key] = value[key];
  return result;
}

function collectionForReport(value) {
  const clean = collectionDiagnosticsForDownload(value);
  if (!clean) return null;
  // Keep the legacy fallback's failure context, but apply the same stricter URL/title policy.
  clean.events = clean.events.map(event => eventForReport(event)).filter(Boolean);
  if (clean.failure) {
    for (const key of ['url', 'lastSavedUrl']) {
      if (clean.failure[key]) clean.failure[key] = problemReportUrl(clean.failure[key]);
    }
    for (const key of ['lessonTitle', 'sectionTitle']) if (clean.failure[key]) clean.failure[key] = title(clean.failure[key]);
  }
  return boundProblemCollection(clean, MAX_PROBLEM_REPORT_BYTES / 2);
}

/** Keep terminal failures while removing the oldest successful/repeated observations first. */
function bounded(report, knownSize) {
  const size = knownSize || reportSize(report);
  if (size.total <= MAX_PROBLEM_REPORT_BYTES) { reportSizes.set(report, size); return report; }
  const events = [...report.events];
  let removed = 0, downloadRemoved = 0;
  let bytes = size.total;
  const remove = index => {
    bytes -= eventBytes(events[index]) + (events.length > 1 ? 1 : 0);
    const [event] = events.splice(index, 1);
    removed++; if (isDownloadStage(event.stage)) downloadRemoved++;
  };
  const terminalFailure = [...events].reverse().find(event => event.status === 'failed' || event.status === 'cancelled');
  const repeated = new Set();
  const priority = new Map();
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    const key = eventKey(event);
    priority.set(event, event === terminalFailure ? 3 : repeated.has(key) || !['failed', 'cancelled', 'retrying', 'unavailable', 'skipped'].includes(event.status) ? 0 : 1);
    repeated.add(key);
  }
  for (const level of [0, 1]) {
    for (let index = 0; index < events.length && bytes > MAX_PROBLEM_REPORT_BYTES - 128;) {
      if (priority.get(events[index]) !== level) { index++; continue; }
      remove(index);
    }
  }
  const result = { ...report, events, omittedEvents: plus(report.omittedEvents, removed),
    downloadSummary: { ...report.downloadSummary, omittedEvents: plus(report.downloadSummary.omittedEvents, downloadRemoved) } };
  const metadata = () => size.metadata + encodedBytes(result.omittedEvents) - encodedBytes(report.omittedEvents)
    + encodedBytes(result.downloadSummary.omittedEvents) - encodedBytes(report.downloadSummary.omittedEvents);
  // The fixed-size projected envelope and the last failure fit without discarding that failure.
  while (bytes + metadata() - size.metadata > MAX_PROBLEM_REPORT_BYTES && result.events.length > 1) {
    const index = result.events.findIndex(event => event !== terminalFailure);
    if (index < 0) break;
    bytes -= eventBytes(result.events[index]) + (result.events.length > 1 ? 1 : 0);
    const [event] = result.events.splice(index, 1);
    result.omittedEvents = plus(result.omittedEvents, 1);
    if (isDownloadStage(event.stage)) result.downloadSummary.omittedEvents = plus(result.downloadSummary.omittedEvents, 1);
  }
  const finalMetadata = metadata();
  reportSizes.set(result, { metadata: finalMetadata, total: bytes + finalMetadata - size.metadata });
  return result;
}

export function createProblemReport(options = {}) {
  const collection = collectionForReport(options.collectionDiagnostics ?? options.collection);
  const sourceEvents = Array.isArray(options.events) ? options.events : collection?.events || [];
  const events = sourceEvents.map(event => eventForReport(event)).filter(Boolean)
    .filter(event => options.kind !== 'download' || !isDownloadStage(event.stage));
  const startedAt = timestamp(options.startedAt) ? options.startedAt : new Date().toISOString();
  const report = {
    version: 2,
    extensionVersion: typeof options.extensionVersion === 'string' && /^\d{1,5}(?:\.\d{1,5}){0,3}$/.test(options.extensionVersion) ? options.extensionVersion : collection?.extensionVersion || 'unknown',
    browserVersion: typeof options.browserVersion === 'string' && /^(?:(?:Chrome|Chromium|Edg|Firefox|Safari)[ /])?\d{1,5}(?:\.\d{1,8}){0,3}$/.test(options.browserVersion) ? options.browserVersion : 'unknown',
    book: bookForReport(options.book), startedAt,
    stage: STAGES.has(options.stage) ? options.stage : options.kind === 'collection' ? 'book' : options.kind === 'download' ? 'export' : 'connection',
    status: STATUSES.has(options.status) ? options.status : 'started', events,
    omittedEvents: Math.max(0, count(options.omittedEvents ?? collection?.omittedEvents) - (options.kind === 'download' ? count(options.downloadSummary?.omittedEvents) : 0)),
    collection, downloadSummary: summaryFrom(events, options.kind === 'download' ? undefined : options.downloadSummary),
  };
  for (const key of ['persisted', 'storageError', 'legacy']) if (typeof options[key] === 'boolean') report[key] = options[key];
  const result = bounded(report);
  downloadStates.set(result, statesFrom(events));
  return result;
}

export function appendProblemEvent(report, value) {
  if (report?.version !== 2 || !Array.isArray(report.events)) return report;
  const event = eventForReport(value, new Date().toISOString());
  if (!event) return report;
  const summary = { ...report.downloadSummary };
  const states = new Map(downloadStates.get(report) || statesFrom(report.events));
  if (event.stage === 'files' && nonnegative(event.totalFiles)) summary.total = event.totalFiles;
  if (event.stage === 'files' && event.assetId) {
    if (event.status === 'started') summary.attempts = plus(count(summary.attempts), 1);
    if (TERMINAL_FILES.has(event.status)) {
      const previous = states.get(event.assetId);
      if (previous) {
        summary[previous.status] = Math.max(0, count(summary[previous.status]) - 1);
        summary.receivedBytes = Math.max(0, count(summary.receivedBytes) - count(previous.receivedBytes));
      } else summary.total = Math.max(count(summary.total), states.size + 1);
      summary[event.status] = plus(count(summary[event.status]), 1);
      summary.receivedBytes = plus(count(summary.receivedBytes), count(event.receivedBytes));
      states.set(event.assetId, event);
      summary.total = Math.max(count(summary.total), [...TERMINAL_FILES].reduce((sum, key) => plus(sum, count(summary[key])), 0));
    }
  }
  const candidate = { ...report, events: [...report.events, event], stage: event.stage, status: event.status, downloadSummary: summary };
  const previousSize = reportSize(report);
  const metadata = previousSize.metadata + encodedBytes(event.stage) - encodedBytes(report.stage)
    + encodedBytes(event.status) - encodedBytes(report.status) + encodedBytes(summary) - encodedBytes(report.downloadSummary);
  const result = bounded(candidate, { metadata,
    total: previousSize.total + metadata - previousSize.metadata + eventBytes(event) + (report.events.length ? 1 : 0) });
  downloadStates.set(result, states);
  return result;
}

export function problemReportForDownload(report) {
  if (report?.version !== 2 || !Array.isArray(report.events)) return null;
  return createProblemReport(report);
}

export function legacyProblemReport({ collectionDiagnostics, extensionVersion, browserVersion, book } = {}) {
  const collection = collectionForReport(collectionDiagnostics);
  if (!collection) return null;
  const last = collection.events.at(-1);
  return createProblemReport({ extensionVersion: extensionVersion || collection.extensionVersion, browserVersion, book,
    collectionDiagnostics: collection, startedAt: collection.events[0]?.at,
    stage: collection.failure?.stage || last?.stage || 'connection',
    status: collection.failure?.reason === 'cancelled' ? 'cancelled' : collection.failure ? 'failed' : last?.status || 'finished', legacy: true, persisted: false });
}
