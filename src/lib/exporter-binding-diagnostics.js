const CAUSES = new Set(['context_lookup_failed', 'context_missing', 'context_ambiguous', 'document_mismatch',
  'dashboard_url_mismatch', 'workspace_mismatch', 'source_tab_mismatch']);
const OPERATIONS = new Set(['RESOLVE_WORKSPACE', 'BEGIN_COLLECTION', 'END_COLLECTION', 'CANCEL_COLLECTION',
  'GET_SOURCE', 'GET_SOURCE_STATUS', 'RETRY_SOURCE_NAVIGATION', 'GET_STATE', 'GET_EXPORT_INFO',
  'RECORD_DOWNLOAD_RESULT', 'GET_EXPORT_RECORDS', 'START_CAPTURE', 'STOP_CAPTURE', 'TAKE_SNAPSHOT',
  'GET_NAVIGATION', 'PREPARE_BOOK', 'OPEN_MATERIAL_ITEM', 'NAVIGATE_SOURCE', 'SAVE_COLLECTION',
  'CLEAR_CAPTURE', 'RESET_CAPTURE', 'RECONNECT_SOURCE', 'BEGIN_PROBLEM_REPORT', 'APPEND_PROBLEM_EVENTS',
  'GET_PROBLEM_REPORT']);

export function exporterBindingDiagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !CAUSES.has(value.cause)) return undefined;
  return { cause: value.cause, ...(OPERATIONS.has(value.operation) ? { operation: value.operation } : {}) };
}
