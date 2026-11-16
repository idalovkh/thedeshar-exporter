import { navigationErrorCode, navigationErrorState } from './source-navigation-errors.js';
import { hasNavigationAttempt } from './source-navigation-documents.js';
import { navigationDiagnostic } from './navigation-diagnostics.js';

const LOGIN_PATH = /(?:^|\/)(?:login|log-in|signin|sign-in|auth|oauth|authorization)(?:\/|$)/i;
export function sourcePageKind(value, expectedBookKey, { canonicalUrl, bookKey }) {
  if (!value) return 'unavailable';
  const key = bookKey(value);
  if (key) return key === expectedBookKey ? 'same_book' : 'other_book';
  try {
    const url = new URL(value), expected = new URL(expectedBookKey);
    if (url.origin === expected.origin && LOGIN_PATH.test(url.pathname)) return 'security_error';
    return canonicalUrl(value) ? 'same_book' : 'source_changed';
  } catch { return 'unavailable'; }
}

export function classifySourceNavigation({ tab, frame, intent, expectedBookKey, canonicalUrl, bookKey, now }) {
  if (!tab) return { state: 'closed', browserLoading: false, canRetry: false };
  const browserLoading = tab.status === 'loading' || Boolean(tab.pendingUrl) || intent?.phase === 'browser_retry';
  const common = { browserLoading, canRetry: false };
  if (intent) Object.assign(common, { transitionId: intent.id, deadlineAt: intent.deadlineAt,
    attempt: intent.attempt, maxAttempts: intent.maxAttempts, remainingMs: Math.max(0, intent.deadlineAt - now),
    expectedUrl: intent.observedUrl || intent.targetUrl || intent.sourceUrl,
    ...(navigationDiagnostic({ ...intent.navigation, currentDocumentId: frame?.documentId }) ? { navigation: navigationDiagnostic({ ...intent.navigation, currentDocumentId: frame?.documentId }) } : {}) });
  const currentUrl = frame?.url || tab.url;
  const url = canonicalUrl(currentUrl);
  if (url) Object.assign(common, { url, bookKey: bookKey(url) });
  if (intent && !hasNavigationAttempt(intent)) return { ...common, state: 'unavailable',
    navigation: navigationDiagnostic({ cause: 'legacy_transition', phase: intent.phase, attempt: intent.attempt }) };
  const pendingKind = sourcePageKind(tab.pendingUrl, expectedBookKey, { canonicalUrl, bookKey });
  if (tab.pendingUrl && pendingKind !== 'same_book') return { ...common, state: pendingKind,
    ...(pendingKind === 'security_error' ? { reason: 'login_required' } : {}) };
  if (intent?.invalidState) return { ...common, state: intent.invalidState,
    ...(navigationErrorCode(intent.failure?.error) ? { networkError: navigationErrorCode(intent.failure.error) } : {}),
    ...(intent.invalidState === 'security_error' ? { reason: 'login_required' } : {}) };
  const state = sourcePageKind(currentUrl, expectedBookKey, { canonicalUrl, bookKey });
  if (state === 'other_book' || state === 'security_error' || state === 'source_changed') return { ...common, state,
    ...(state === 'security_error' ? { reason: 'login_required' } : {}) };
  if (browserLoading) return { ...common, state: 'loading' };
  if (intent?.failure) {
    if (frame?.documentId && frame.documentId !== intent.failure.documentId) return { ...common, state: 'source_changed' };
    const networkError = navigationErrorCode(intent.failure.error);
    const errorState = navigationErrorState(networkError);
    return { ...common, state: errorState, ...(networkError ? { networkError } : {}),
      canRetry: errorState === 'network_error' && frame?.errorOccurred === true &&
        frame.documentId === intent.failure.documentId && url === intent.failure.url &&
        common.remainingMs > 0 && intent.attempt < intent.maxAttempts };
  }
  if (frame?.errorOccurred) return { ...common, state: 'unavailable', reason: 'unknown_page' };
  return { ...common, state, ...(state === 'unavailable' ? { reason: 'unknown_page' } : {}),
    canRetry: state === 'same_book' && Boolean(intent) && common.remainingMs > 0 && intent.attempt < intent.maxAttempts };
}
