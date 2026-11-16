import { canAdvanceLessonLanding } from './source-navigation-lesson-landing.js';

/** Attempt identity belongs to the command actually sent, not the original click. */
export const hasNavigationAttempt = intent => ['document', 'item'].includes(intent?.attemptMode) &&
  typeof intent.attemptSourceUrl === 'string' && Boolean(intent.attemptSourceUrl) &&
  typeof intent.attemptSourceBrowserDocumentId === 'string' && Boolean(intent.attemptSourceBrowserDocumentId);

export function previousNavigationDocument(intent, documentId) {
  return Boolean(documentId && documentId !== intent.browserDocumentId &&
    (intent.previousBrowserDocumentIds || []).includes(documentId));
}

export function classifyDocumentEvent(intent, event, { canonicalUrl, targetMatches }) {
  const url = canonicalUrl(event.url), documentId = event.documentId;
  if (event.documentLifecycle && event.documentLifecycle !== 'active') return { ignored: 'old_document_ignored' };
  if (event.name === 'onHistoryStateUpdated' && intent.phase === 'committed' && previousNavigationDocument(intent, documentId)) {
    return { ignored: 'old_document_ignored' };
  }
  const originalDocument = documentId === intent.attemptSourceBrowserDocumentId;
  if (event.name === 'onHistoryStateUpdated') {
    if (originalDocument && url === intent.attemptSourceUrl && ['armed', 'loading'].includes(intent.phase)) {
      return { ignored: 'same_url_history_ignored' };
    }
    if (intent.phase === 'committed' && documentId === intent.browserDocumentId && url === intent.observedUrl) {
      return { ignored: 'same_url_history_ignored' };
    }
    const landing = canAdvanceLessonLanding(intent, url, documentId);
    if (!targetMatches(intent, url) || intent.observedUrl && intent.observedUrl !== url && !landing || intent.phase === 'failed') {
      return { invalid: 'unexpected_target' };
    }
    if (originalDocument && intent.attemptMode === 'document' && ['armed', 'loading'].includes(intent.phase)) {
      return { invalid: 'unexpected_target' };
    }
    if (intent.attemptMode === 'document' && intent.phase !== 'committed' ||
      intent.phase === 'loading' && originalDocument) return { ignored: 'old_document_ignored' };
    if (!documentId || intent.phase === 'committed' && documentId !== intent.browserDocumentId ||
      intent.phase === 'armed' && !originalDocument) return { invalid: 'unexpected_document', unavailable: true };
    return { cause: 'expected_spa', next: { ...intent, phase: 'committed', observedUrl: url, browserDocumentId: documentId, failure: null } };
  }
  if (originalDocument && url === intent.attemptSourceUrl && ['armed', 'loading'].includes(intent.phase)) {
    return { ignored: 'old_document_ignored' };
  }
  if (!targetMatches(intent, url) || intent.observedUrl && intent.observedUrl !== url) return { invalid: 'unexpected_target' };
  if (!documentId) return { invalid: 'unexpected_document', unavailable: true };
  if (intent.phase === 'committed' && intent.browserDocumentId && intent.browserDocumentId !== documentId) {
    return { invalid: 'unexpected_document' };
  }
  if (intent.phase === 'committed' && intent.browserDocumentId === documentId && intent.observedUrl === url) {
    return { ignored: 'stale_event_ignored' };
  }
  return { cause: 'expected_commit', next: { ...intent, phase: 'committed', observedUrl: url, browserDocumentId: documentId, failure: null } };
}
