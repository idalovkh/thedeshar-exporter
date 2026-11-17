import { SOURCE_STALL_MS, SOURCE_RECOVERY_STALL_MS, TRANSITION_TIMEOUT_MS } from './source-transition-policy.js';
import { navigationErrorState } from './source-navigation-errors.js';

const fail = code => Object.assign(new Error(code === 'source_loading' ? 'Страница ещё загружается.' : 'Не удалось подтвердить страницу для восстановления.'), { code });

/** A stalled document can be replaced only with worker-owned target and document evidence. */
export function createSourceStallRecovery({ chrome, now, canonicalUrl, bookKey, targetMatches,
  boundIntent, checkBudget, browserState, save, serial, descriptor }) {
  async function inspect(binding, id) {
    const { intent, check } = await boundIntent(binding, id);
    checkBudget(intent);
    const required = intent.attempt === 1 ? SOURCE_STALL_MS : SOURCE_RECOVERY_STALL_MS;
    if (now() - (intent.progress?.at ?? intent.deadlineAt - TRANSITION_TIMEOUT_MS) < required) throw fail('source_loading');
    const { tab, frame } = await browserState(intent.tabId);
    if (!tab) throw fail('source_closed');
    if (frame?.errorOccurred && navigationErrorState(intent.failure?.error) !== 'network_error') throw fail('source_security_error');
    const url = canonicalUrl(frame?.url || tab.url);
    const pending = tab.pendingUrl && canonicalUrl(tab.pendingUrl);
    if (tab.pendingUrl && (!pending || bookKey(pending) !== intent.bookKey || !targetMatches(intent, pending))) throw fail('source_changed');
    if (!url || bookKey(url) !== intent.bookKey || !frame?.documentId ||
      ![intent.browserDocumentId, intent.attemptSourceBrowserDocumentId].includes(frame.documentId)) throw fail('source_changed');
    const confirmedLesson = intent.target?.kind === 'lesson' && /^[1-9]\d*$/.test(intent.target.sourceId || '')
      ? `${new URL(intent.sourceUrl).origin}/lesson-editor/book/${new URL(intent.sourceUrl).pathname.match(/\/book\/(\d+)/)?.[1]}/lesson/${intent.target.sourceId}` : null;
    const target = intent.observedUrl || intent.targetUrl || (targetMatches(intent, url) ? url : confirmedLesson);
    if (!target || !targetMatches(intent, target)) throw fail('source_unavailable');
    if (url !== intent.attemptSourceUrl && !targetMatches(intent, url)) throw fail('source_changed');
    check();
    return { ...intent, recoveryUrl: target, recoverySourceUrl: url, recoveryDocumentId: frame.documentId };
  }
  async function reload(binding, id) {
    const intent = await inspect(binding, id);
    if (intent.attempt !== 1) throw fail('retry_exhausted');
    const next = { ...intent, attempt: 2, phase: 'armed', observedUrl: null, failure: null, browserDocumentId: null,
      attemptMode: 'document', attemptSourceUrl: intent.recoverySourceUrl,
      attemptSourceBrowserDocumentId: intent.recoveryDocumentId,
      previousBrowserDocumentIds: [...new Set([...(intent.previousBrowserDocumentIds || []), intent.recoveryDocumentId])].slice(-8),
      progress: { at: now(), seen: [] }, recovery: 'reload' };
    await serial(intent.tabId, async () => {
      const current = await inspect(binding, id);
      if (current.attempt !== intent.attempt || current.recoveryDocumentId !== intent.recoveryDocumentId) throw fail('source_changed');
      await save(intent.tabId, next);
    });
    try { await chrome.tabs.update(intent.tabId, { url: intent.recoveryUrl }); }
    catch (error) { throw Object.assign(error, { code: 'source_unavailable' }); }
    return { ok: true, transition: descriptor(next), reloaded: true, recovery: 'reload', previousDocumentToken: intent.sourceDocumentToken };
  }
  return { inspect, reload };
}
