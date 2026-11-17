/** The replacement's initial blank document is not a departure from its pending book. */
export function isReplacementLoading({ tab, frame, intent, expectedBookKey, canonicalUrl, bookKey, now }) {
  if (frame?.url !== 'about:blank' || frame.errorOccurred || !frame.documentId ||
    intent?.recovery !== 'replace' || intent.attemptMode !== 'document' ||
    !['armed', 'loading'].includes(intent.phase) || intent.invalidState || intent.failure ||
    !(now < intent.deadlineAt) || tab.id !== intent.tabId ||
    frame.documentId !== intent.attemptSourceBrowserDocumentId) return false;
  const target = canonicalUrl(intent.recoveryUrl);
  if (!target || bookKey(target) !== expectedBookKey || intent.bookKey !== expectedBookKey ||
    canonicalUrl(intent.attemptSourceUrl) !== target ||
    intent.observedUrl && canonicalUrl(intent.observedUrl) !== target) return false;
  const pending = canonicalUrl(tab.pendingUrl), current = canonicalUrl(tab.url);
  if (tab.pendingUrl && pending !== target || tab.url && tab.url !== 'about:blank' && current !== target) return false;
  return (tab.status === 'loading' || Boolean(tab.pendingUrl)) && (pending === target || current === target);
}
