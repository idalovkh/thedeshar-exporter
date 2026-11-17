import { redactSensitive } from './security.js';
import { navigationErrorCode } from './source-navigation-errors.js';
import { diagnosticPageUrl, navigationDiagnostic } from './navigation-diagnostics.js';
import { pageReadinessDiagnostic } from './page-readiness-diagnostics.js';
import { exporterBindingDiagnostic } from './exporter-binding-diagnostics.js';
export { diagnosticPageUrl };

const MAX_EVENTS = 200;
const MAX_TITLE_LENGTH = 500;
const STATUSES = new Set(['started', 'waiting', 'ready', 'saved', 'retrying', 'finished', 'failed', 'cancelled']);
const REASONS = new Set(['section_loading_timeout', 'section_render_timeout', 'navigation_timeout', 'source_disconnected', 'source_timeout', 'source_closed', 'source_changed', 'source_update_required',
  'navigation_blocked', 'snapshot_error', 'author_data_missing', 'author_data_incomplete', 'interrupted',
  'operation_failed', 'section_list_changed', 'document_load_timeout', 'navigation_stale', 'cancelled',
  'source_loading', 'source_network_error', 'source_security_error', 'source_interrupted', 'source_unavailable',
  'source_left_page', 'transition_timeout', 'retry_exhausted', 'exporter_binding_mismatch', 'resume_structure_changed', 'resume_unavailable']);
const AUTHOR_STATES = new Set(['received', 'incomplete', 'unobserved', 'unknown']);

export const COLLECTION_STAGE_LABELS = Object.freeze({
  book: 'Чтение содержания книги',
  open_lesson: 'Открытие урока',
  open_section: 'Открытие раздела',
  wait_exercises: 'Ожидание заданий',
  save_page: 'Сохранение страницы',
  wait_author_data: 'Ожидание исходных заданий',
  reload_section: 'Повторная загрузка раздела',
  retry_definition: 'Повторный запрос заданий',
  replace_source: 'Восстановление в новой вкладке',
  finish: 'Завершение сбора',
});

const nonnegativeInteger = value => Number.isSafeInteger(value) && value >= 0;
const numericId = value => typeof value === 'string' && /^\d{1,32}$/.test(value);
const validTimestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));

function titleForDiagnostics(value) {
  if (typeof value !== 'string') return '';
  const bounded = value.slice(0, MAX_TITLE_LENGTH * 2).replace(/\s+/g, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '');
  const withoutLinks = bounded.replace(/(?:\b(?:https?|wss):)?\/\/[^\s<>"']+/gi, '[REDACTED]');
  return redactSensitive(withoutLinks).trim().slice(0, MAX_TITLE_LENGTH);
}

function diagnosticContext(value) {
  if (!value || typeof value.stage !== 'string' || !Object.hasOwn(COLLECTION_STAGE_LABELS, value.stage)) return null;
  const context = { stage: value.stage, ...pageReadinessDiagnostic(value) };
  for (const key of ['url', 'lastSavedUrl', 'expectedUrl', 'observedUrl']) {
    const url = diagnosticPageUrl(value[key]);
    if (url) context[key] = url;
  }
  if (nonnegativeInteger(value.elapsedMs)) context.elapsedMs = value.elapsedMs;
  for (const key of ['attempt', 'remainingMs', 'retryDelayMs', 'idleMs']) if (nonnegativeInteger(value[key])) context[key] = value[key];
  if (['request', 'reload', 'replace'].includes(value.recovery)) context.recovery = value.recovery;
  if (typeof value.definitionRetrySkipped === 'boolean') context.definitionRetrySkipped = value.definitionRetrySkipped;
  const networkError = navigationErrorCode(value.networkError);
  if (networkError) context.networkError = networkError;
  const navigation = navigationDiagnostic(value.navigation);
  if (navigation) context.navigation = navigation;
  const binding = exporterBindingDiagnostic(value.binding);
  if (binding) context.binding = binding;
  if (typeof value.browserLoading === 'boolean') context.browserLoading = value.browserLoading;
  if (REASONS.has(value.reason)) context.reason = value.reason;
  return context;
}

function diagnosticEvent(value, at = value?.at) {
  const context = diagnosticContext(value);
  if (!context || !STATUSES.has(value.status) || !validTimestamp(at)) return null;
  const event = { at, ...context, status: value.status };
  if (numericId(value.lessonId)) event.lessonId = value.lessonId;
  if (numericId(value.sectionId) || value.sectionId === 'for-homework') event.sectionId = value.sectionId;
  for (const key of ['attempt', 'polls']) {
    if (nonnegativeInteger(value[key])) event[key] = value[key];
  }
  const state = value.exerciseState;
  if (state && [state.loaderVisible, state.listVisible, state.emptyVisible].every(flag => typeof flag === 'boolean')) {
    event.exerciseState = { loaderVisible: state.loaderVisible, listVisible: state.listVisible, emptyVisible: state.emptyVisible };
  }
  const network = value.network;
  if (network && nonnegativeInteger(network.pending) && nonnegativeInteger(network.idleMs)) {
    event.network = { pending: network.pending, idleMs: network.idleMs };
  }
  if (AUTHOR_STATES.has(value.authorData)) event.authorData = value.authorData;
  return event;
}

function diagnosticFailure(value) {
  const failure = diagnosticContext(value);
  if (!failure) return null;
  for (const key of ['lessonTitle', 'sectionTitle']) {
    const title = titleForDiagnostics(value[key]);
    if (title) failure[key] = title;
  }
  return failure;
}

export function createCollectionDiagnostics(extensionVersion) {
  const knownVersion = typeof extensionVersion === 'string' && /^\d{1,5}(?:\.\d{1,5}){0,3}$/.test(extensionVersion);
  return { version: 1, extensionVersion: knownVersion ? extensionVersion : 'unknown', omittedEvents: 0, events: [] };
}

export function appendCollectionDiagnostic(diagnostics, value) {
  if (!Array.isArray(diagnostics?.events)) return;
  const event = diagnosticEvent(value, value?.at ?? new Date().toISOString());
  if (!event) return;
  diagnostics.events.push(event);
  const overflow = diagnostics.events.length - MAX_EVENTS;
  if (overflow > 0) {
    diagnostics.events.splice(0, overflow);
    diagnostics.omittedEvents += overflow;
  }
}

export function recordCollectionFailure(diagnostics, context) {
  const failure = diagnosticFailure(context);
  if (diagnostics && failure) diagnostics.failure = failure;
}

export function collectionDiagnosticsForDownload(diagnostics) {
  if (diagnostics?.version !== 1 || !Array.isArray(diagnostics.events)) return null;
  const result = createCollectionDiagnostics(diagnostics.extensionVersion);
  const previousOmitted = nonnegativeInteger(diagnostics.omittedEvents) ? diagnostics.omittedEvents : 0;
  const overflow = Math.max(0, diagnostics.events.length - MAX_EVENTS);
  result.omittedEvents = Math.min(Number.MAX_SAFE_INTEGER, previousOmitted + overflow);
  result.events = diagnostics.events.slice(-MAX_EVENTS).map(value => diagnosticEvent(value)).filter(Boolean);
  const failure = diagnosticFailure(diagnostics.failure);
  if (failure) result.failure = failure;
  return result;
}
