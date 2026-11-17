import { TRANSITION_TIMEOUT_MS, MAX_TRANSITION_ATTEMPTS } from './source-transition-policy.js';
import { navigationErrorCode, navigationErrorState, sourceStatusError } from './source-navigation-errors.js';
import { classifySourceNavigation, sourcePageKind } from './source-navigation-status.js';
import { classifyDocumentEvent, hasNavigationAttempt, previousNavigationDocument } from './source-navigation-documents.js';
import { navigationDiagnostic } from './navigation-diagnostics.js';
import { confirmedLessonInventory, confirmedLessonRoute } from './confirmed-lesson-route.js';
import { observeSourceProgress } from './source-progress.js';
import { createSourceStallRecovery } from './source-stall-recovery.js';

const PREFIX = 'source-navigation:';
const bindingFields = ['tabId', 'ownerTabId', 'workspaceId', 'collectionId', 'bookKey'];
const sameBinding = (left, right) => bindingFields.every(key => (left?.[key] ?? null) === (right?.[key] ?? null));
const descriptor = intent => ({ id: intent.id, deadlineAt: intent.deadlineAt, attempt: intent.attempt, maxAttempts: intent.maxAttempts });
const failure = (code, message) => Object.assign(new Error(message), { code });
const changed = () => failure('source_changed', 'Исходная вкладка изменилась. Повторная загрузка остановлена.');

/** Worker-owned authority for a single bounded transition; media and page bodies never enter it. */
export function createSourceNavigation({ chrome, canonicalUrl, bookKey, authorize, sendSource,
  now = () => Date.now(), randomUUID = () => crypto.randomUUID(), onChange = () => {} }) {
  const records = new Map(), pending = new Map(), revisions = new Map(), observedNavigation = new Map(), traces = new Map();
  const confirmedInventories = new Map();
  let hydrated = false;
  const ready = chrome.storage.session.get(null).then(values => {
    for (const [key, value] of Object.entries(values || {})) {
      if (key.startsWith(PREFIX) && value?.version === 1 && Number.isInteger(value.tabId) && value.command) records.set(value.tabId, value);
    }
    hydrated = true;
  });
  void ready.catch(() => {});
  const revision = tabId => revisions.get(tabId) || 0;
  const bump = tabId => revisions.set(tabId, revision(tabId) + 1);
  const serial = (tabId, action) => {
    const task = (pending.get(tabId) || Promise.resolve()).catch(() => {}).then(action);
    pending.set(tabId, task);
    task.finally(() => { if (pending.get(tabId) === task) pending.delete(tabId); }).catch(() => {});
    return task;
  };
  async function drain(tabId) {
    while (pending.has(tabId)) {
      const task = pending.get(tabId);
      await task.catch(() => {});
      if (pending.get(tabId) === task) return;
    }
  }
  function withNavigation(intent) {
    if (!intent) return intent;
    const trace = traces.get(intent.tabId);
    if (!trace || trace.id !== intent.id) return intent;
    return { ...intent, navigation: navigationDiagnostic({ ...(intent.invalidState ? intent.navigation : trace.context), events: trace.events }) };
  }
  function observe(intent, name, event, cause, phase = intent.phase) {
    const previous = traces.get(intent.tabId);
    const events = previous?.id === intent.id ? previous.events : intent.navigation?.events || [];
    const context = navigationDiagnostic({ event: name, phase, cause, sourceDocumentId: intent.attemptSourceBrowserDocumentId,
      documentId: event.documentId, currentDocumentId: intent.browserDocumentId, expectedUrl: intent.observedUrl || intent.targetUrl || intent.attemptSourceUrl,
      observedUrl: canonicalUrl(event.url), timeStamp: event.timeStamp, attempt: intent.attempt });
    const trace = { id: intent.id, context, events: [...events, context].slice(-32) };
    traces.set(intent.tabId, trace);
    return navigationDiagnostic({ ...context, events: trace.events });
  }
  function assertAttempt(intent) {
    if (!hasNavigationAttempt(intent)) throw Object.assign(failure('source_update_required', 'Обновите расширение и начните сбор книги заново.'), {
      navigation: navigationDiagnostic({ cause: 'legacy_transition', phase: intent.phase, attempt: intent.attempt }) });
  }
  async function load(tabId) {
    await ready;
    return records.get(tabId) || null;
  }
  async function save(tabId, value) {
    if (value) records.set(tabId, value); else records.delete(tabId);
    if (value) await chrome.storage.session.set({ [`${PREFIX}${tabId}`]: value });
    else await chrome.storage.session.remove(`${PREFIX}${tabId}`);
  }
  const browserFrame = tabId => chrome.webNavigation?.getFrame
    ? chrome.webNavigation.getFrame({ tabId, frameId: 0 }).catch(() => null) : Promise.resolve(null);
  async function browserState(tabId) {
    const [tab, frame] = await Promise.all([chrome.tabs.get(tabId).catch(() => null), browserFrame(tabId)]);
    return { tab, frame };
  }
  async function failedFrameMatches(tabId, failed) {
    const frame = failed && await browserFrame(tabId);
    return Boolean(frame?.errorOccurred && frame.documentId === failed.documentId && canonicalUrl(frame.url) === failed.url);
  }
  async function checkRevision(tabId, before, intent) {
    await drain(tabId);
    if (before === revision(tabId)) return;
    const current = withNavigation(await load(tabId));
    if (current?.id === intent.id && current.invalidState) throw sourceStatusError({ state: current.invalidState,
      networkError: current.failure?.error, expectedUrl: current.observedUrl || current.sourceUrl, attempt: current.attempt, navigation: current.navigation });
    if (current?.id === intent.id && !current.invalidState && current.failure &&
      ['browser_retry', 'failed'].includes(current.phase) && await failedFrameMatches(tabId, current.failure)) {
      throw sourceStatusError({ state: current.phase === 'browser_retry' ? 'loading' : 'network_error',
        networkError: current.failure.error, expectedUrl: current.failure.url, attempt: current.attempt, navigation: current.navigation });
    }
    throw Object.assign(changed(), { navigation: current?.navigation });
  }
  function targetMatches(intent, value, requireIdentity = false) {
    const url = canonicalUrl(value);
    if (!url || bookKey(url) !== intent.bookKey) return false;
    if (intent.command.type === 'NAVIGATE_SOURCE') return url === intent.targetUrl;
    if (!intent.target?.kind) return false;
    if (requireIdentity && !intent.target.sourceId) return false;
    const path = new URL(url).pathname, lessonId = path.match(/\/lesson\/(\d+)(?:\/|$)/)?.[1];
    const sectionId = path.match(/\/section\/(\d+|for-homework)\/?$/)?.[1];
    if (intent.target.kind === 'lesson') return Boolean(lessonId) && (!intent.target.sourceId || lessonId === intent.target.sourceId);
    return lessonId === intent.target.lessonId && Boolean(sectionId) && (!intent.target.sourceId || sectionId === intent.target.sourceId);
  }
  async function boundIntent(binding, id) {
    const intent = await load(binding.tabId);
    if (!intent || !sameBinding(intent, { ...binding, bookKey: binding.bookKey || intent.bookKey }) || id && intent.id !== id) throw failure('stale_collection', 'Этот переход уже завершён или относится к другому сбору.');
    const check = await authorize(intent);
    assertAttempt(intent);
    return { intent: withNavigation(intent), check };
  }
  function checkBudget(intent) {
    if (now() >= intent.deadlineAt) throw failure('transition_timeout', 'Страница книги не загрузилась за три минуты. Проверьте соединение или VPN и повторите сбор.');
    if (intent.attempt >= intent.maxAttempts) throw failure('retry_exhausted', 'Не удалось загрузить страницу книги после повторных попыток. Проверьте исходную вкладку и повторите сбор.');
    if (intent.invalidState) throw sourceStatusError({ state: intent.invalidState, navigation: withNavigation(intent).navigation });
  }
  function watch(name, handler) {
    chrome.webNavigation?.[name]?.addListener(details => {
      if (!Number.isInteger(details.tabId) || details.frameId !== 0) return;
      const handle = () => {
        const received = records.get(details.tabId);
        if (!received) return;
        void serial(details.tabId, async () => {
          const intent = await load(details.tabId);
          if (!intent || intent.id !== received.id || intent.attempt !== received.attempt) return;
          try { await authorize(intent); } catch { bump(details.tabId); await save(details.tabId, null); return; }
          if (!hasNavigationAttempt(intent)) return;
          if (intent.lastEventAt !== undefined && details.timeStamp < intent.lastEventAt) {
            observe(intent, name, details, 'stale_event_ignored'); return;
          }
          if (intent.invalidState) return;
          const result = await handler(intent, { ...details, name });
          if (!result) return;
          const navigation = observe(intent, name, details, result.ignored || result.cause, result.next?.phase);
          if (result.ignored) return;
          bump(details.tabId);
          await save(details.tabId, { ...result.next, navigation, lastEventAt: details.timeStamp });
          onChange(details.tabId);
        }).catch(() => {});
      };
      if (hydrated) handle(); else void ready.then(handle).catch(() => {});
    });
  }
  const accept = (next, cause) => ({ next, cause });
  const invalidate = (intent, url, cause = 'unexpected_target', unavailable = false) => accept({ ...intent,
    invalidState: unavailable ? 'unavailable' : sourcePageKind(url, intent.bookKey, { canonicalUrl, bookKey }) === 'same_book'
      ? 'source_changed' : sourcePageKind(url, intent.bookKey, { canonicalUrl, bookKey }), failure: null }, cause);
  watch('onBeforeNavigate', async (intent, event) => {
    const url = canonicalUrl(event.url);
    if (intent.failure && intent.failure.url === url && ['failed', 'browser_retry'].includes(intent.phase)) {
      if (await failedFrameMatches(intent.tabId, intent.failure)) return accept({ ...intent, phase: 'browser_retry' }, 'expected_navigation');
      return invalidate(intent, event.url, 'unexpected_document');
    }
    if (!targetMatches(intent, url) || intent.observedUrl && intent.observedUrl !== url) return invalidate(intent, event.url);
    if (['failed', 'committed'].includes(intent.phase)) return invalidate(intent, event.url, 'navigation_after_commit');
    return accept({ ...intent, phase: 'loading', observedUrl: url, failure: null, browserDocumentId: null }, 'expected_navigation');
  });
  const documentEvent = (intent, event) => {
    const result = classifyDocumentEvent(intent, event, { canonicalUrl, targetMatches });
    return result.invalid ? invalidate(intent, event.url, result.invalid, result.unavailable) : result;
  };
  watch('onCommitted', documentEvent);
  watch('onHistoryStateUpdated', documentEvent);
  watch('onReferenceFragmentUpdated', (intent, event) => {
    if (previousNavigationDocument(intent, event.documentId)) return { ignored: 'old_document_ignored' };
    return bookKey(event.url) === intent.bookKey ? { ignored: 'same_url_history_ignored' } : invalidate(intent, event.url);
  });
  watch('onErrorOccurred', async (intent, event) => {
    if (intent.phase === 'committed' && previousNavigationDocument(intent, event.documentId)) return { ignored: 'old_document_ignored' };
    const previous = intent.failure || intent.lastFailure;
    if (navigationErrorCode(event.error) === 'net::ERR_ABORTED' && /^0+(?:-0+)*$/.test(event.documentId || '') &&
      previous && canonicalUrl(event.url) === previous.url && await failedFrameMatches(intent.tabId, previous)) {
      return accept({ ...intent, phase: 'failed', failure: previous, browserDocumentId: previous.documentId },
        navigationErrorState(previous.error) === 'network_error' ? 'network_error' : 'navigation_error');
    }
    if (navigationErrorCode(event.error) === 'net::ERR_ABORTED' && intent.observedUrl === canonicalUrl(event.url) && targetMatches(intent, event.url)) {
      if (intent.phase === 'committed' && intent.browserDocumentId !== event.documentId) return { ignored: 'old_document_ignored' };
      return accept({ ...intent, invalidState: 'interrupted', failure: { url: intent.observedUrl,
        documentId: event.documentId || null, error: 'net::ERR_ABORTED' } }, 'navigation_interrupted');
    }
    if (!intent.observedUrl || canonicalUrl(event.url) !== intent.observedUrl ||
      !targetMatches(intent, event.url, true) || !event.documentId || /^0+(?:-0+)*$/.test(event.documentId)) return { ignored: 'stale_event_ignored' };
    if (!await failedFrameMatches(intent.tabId, { url: intent.observedUrl, documentId: event.documentId })) return { ignored: 'old_document_ignored' };
    return accept({ ...intent, phase: 'failed', failure: { url: intent.observedUrl, documentId: event.documentId,
      error: navigationErrorCode(event.error) || null }, browserDocumentId: event.documentId },
      navigationErrorState(event.error) === 'network_error' ? 'network_error' : 'navigation_error');
  });
  chrome.webNavigation?.onTabReplaced?.addListener(details => {
    const tabId = details.replacedTabId;
    if (Number.isInteger(tabId)) void ready.then(() => {
      if (records.has(tabId)) { bump(tabId); return serial(tabId, () => save(tabId, null)); }
    }).catch(() => {});
  });

  async function navigate(binding, command) {
    await ready;
    await drain(binding.tabId);
    const check = await authorize(binding), before = revision(binding.tabId);
    const previous = await load(binding.tabId);
    if (previous && sameBinding(previous, binding)) assertAttempt(previous);
    if (previous && sameBinding(previous, binding) && previous.command.type === command.type &&
      previous.command.key === command.key && (command.type === 'OPEN_CONFIRMED_LESSON' || previous.command.url === command.url) &&
      previous.sourceDocumentToken === command.expectedDocumentToken && previous.sourceUrl === canonicalUrl(command.expectedUrl)) {
      if (now() >= previous.deadlineAt) throw failure('transition_timeout', 'Страница книги не загрузилась за три минуты. Проверьте соединение или VPN и повторите сбор.');
      if (previous.invalidState) throw sourceStatusError({ state: previous.invalidState, navigation: withNavigation(previous).navigation });
      return { ok: true, transition: descriptor(previous) };
    }
    if (previous && sameBinding(previous, binding) && command.type === 'NAVIGATE_SOURCE' &&
      canonicalUrl(command.url) === canonicalUrl(command.expectedUrl) &&
      ([previous.observedUrl, previous.targetUrl, previous.sourceUrl].includes(canonicalUrl(command.url)) || targetMatches(previous, command.url))) {
      throw failure('stale_collection', 'Повторная загрузка этой страницы уже относится к текущему сбору. Начните новый сбор книги.');
    }
    const remembered = observedNavigation.get(binding.tabId);
    const navigation = remembered?.documentToken === command.expectedDocumentToken &&
      canonicalUrl(remembered.url) === canonicalUrl(command.expectedUrl) ? remembered
      : { url: command.expectedUrl, documentToken: command.expectedDocumentToken };
    if (bookKey(command.expectedUrl) !== binding.bookKey) throw changed();
    const browser = await browserState(binding.tabId), frame = browser.frame;
    const state = classifySourceNavigation({ ...browser, expectedBookKey: binding.bookKey, canonicalUrl, bookKey, now: now() });
    if (state.state !== 'same_book') throw sourceStatusError(state);
    if (!frame?.documentId || canonicalUrl(frame.url) !== canonicalUrl(command.expectedUrl)) {
      throw sourceStatusError({ state: 'unavailable', navigation: navigationDiagnostic({ cause: 'unexpected_document',
        phase: 'armed', expectedUrl: canonicalUrl(command.expectedUrl), observedUrl: canonicalUrl(frame?.url), currentDocumentId: frame?.documentId }) });
    }
    const freshInventory = confirmedLessonInventory(navigation);
    const retainedInventory = confirmedInventories.get(binding.tabId);
    const inventory = freshInventory || (retainedInventory && sameBinding(retainedInventory, binding) ? retainedInventory.inventory : null);
    const direct = command.type === 'OPEN_CONFIRMED_LESSON';
    if (direct) {
      const url = confirmedLessonRoute(inventory, { key: command.key });
      if (!url || bookKey(url) !== binding.bookKey || command.url !== undefined && canonicalUrl(command.url) !== url) {
        throw failure('source_lesson_unconfirmed', 'Для прямого перехода не подтверждён идентификатор урока. Откройте его через содержание книги.');
      }
      command = { ...command, url };
    }
    const item = direct ? inventory.items.find(candidate => candidate.key === command.key) : navigation.items?.find(candidate => candidate.key === command.key);
    const target = item && { kind: item.kind, ...(item.sourceId ? { sourceId: String(item.sourceId) } : {}),
      ...(navigation.lessonId ? { lessonId: String(navigation.lessonId) } : {}) };
    const intent = { version: 1, ...binding, id: randomUUID(), command: { ...command }, sourceUrl: canonicalUrl(navigation.url),
      sourceDocumentToken: navigation.documentToken, sourceBrowserDocumentId: frame.documentId,
      attemptMode: command.type === 'NAVIGATE_SOURCE' || direct ? 'document' : 'item',
      attemptSourceUrl: canonicalUrl(frame.url), attemptSourceBrowserDocumentId: frame.documentId,
      previousBrowserDocumentIds: [frame.documentId],
      target, targetUrl: command.type === 'NAVIGATE_SOURCE' || direct ? canonicalUrl(command.url) : null,
      deadlineAt: now() + TRANSITION_TIMEOUT_MS, attempt: 1, maxAttempts: MAX_TRANSITION_ATTEMPTS, phase: 'armed',
      progress: observeSourceProgress(null, null, now()) };
    await serial(binding.tabId, () => save(binding.tabId, intent));
    await checkRevision(binding.tabId, before, intent);
    const finalCheck = await authorize(intent);
    const latestBrowser = await browserState(binding.tabId);
    await checkRevision(binding.tabId, before, intent);
    if (latestBrowser.frame?.documentId !== frame.documentId || canonicalUrl(latestBrowser.frame?.url) !== canonicalUrl(frame.url)) {
      throw sourceStatusError({ state: 'unavailable', navigation: navigationDiagnostic({ cause: 'unexpected_document', phase: 'armed',
        sourceDocumentId: frame.documentId, currentDocumentId: latestBrowser.frame?.documentId,
        expectedUrl: canonicalUrl(command.expectedUrl), observedUrl: canonicalUrl(latestBrowser.frame?.url) }) });
    }
    const latestState = classifySourceNavigation({ ...latestBrowser, expectedBookKey: binding.bookKey, canonicalUrl, bookKey, now: now() });
    if (latestState.state !== 'same_book') throw sourceStatusError(latestState);
    check(); finalCheck();
    if (freshInventory) confirmedInventories.set(binding.tabId, { ...binding, inventory: freshInventory });
    const response = await sendSource(binding.tabId, command);
    if (response?.ok === false) await serial(binding.tabId, () => save(binding.tabId, null));
    return { ...response, transition: descriptor(intent) };
  }
  async function status(binding, id) {
    await ready;
    await drain(binding.tabId);
    let intent = await load(binding.tabId);
    if (!sameBinding(intent, { ...binding, bookKey: binding.bookKey || intent?.bookKey })) { if (id) throw failure('stale_collection', 'Этот переход относится к другому сбору.'); intent = null; }
    if (intent && id && intent.id !== id) throw failure('stale_collection', 'Этот переход уже завершён.');
    if (intent) { try { await authorize(intent); } catch (error) { if (id) throw error; intent = null; } }
    intent = withNavigation(intent);
    const browser = await browserState(binding.tabId);
    return classifySourceNavigation({ ...browser, intent, expectedBookKey: binding.bookKey || intent?.bookKey || bookKey(browser.tab?.pendingUrl) || bookKey(browser.frame?.url || browser.tab?.url),
      canonicalUrl, bookKey, now: now() });
  }
  async function retry(binding, id) {
    await ready;
    if (typeof id !== 'string' || !id) throw failure('stale_collection', 'Не удалось подтвердить переход для повторной загрузки.');
    await drain(binding.tabId);
    const { intent, check } = await boundIntent(binding, id);
    checkBudget(intent);
    const before = revision(binding.tabId), browser = await browserState(binding.tabId);
    const state = classifySourceNavigation({ ...browser, intent, expectedBookKey: binding.bookKey, canonicalUrl, bookKey, now: now() });
    if (state.browserLoading || !['same_book', 'network_error'].includes(state.state)) throw sourceStatusError(state);
    let command, previousDocumentToken, reloaded = true, native = false;
    if (intent.failure) {
      if (!state.canRetry || !browser.frame?.documentId || browser.frame.documentId !== intent.failure.documentId ||
        browser.frame.errorOccurred !== true || canonicalUrl(browser.frame.url) !== intent.failure.url) throw changed();
      native = true; previousDocumentToken = intent.sourceDocumentToken;
    } else {
      const response = await sendSource(binding.tabId, { type: 'MATERIAL_NAVIGATION' });
      if (!response?.ok || !response.navigation) throw failure('source_unavailable', 'Не удалось подтвердить текущую страницу книги перед повторной загрузкой.');
      const nav = response.navigation, url = canonicalUrl(nav.url);
      if (bookKey(url) !== intent.bookKey || browser.frame?.errorOccurred) throw changed();
      if (!intent.observedUrl && url === intent.sourceUrl && nav.documentToken === intent.sourceDocumentToken &&
        ['OPEN_MATERIAL_ITEM', 'OPEN_CONFIRMED_LESSON'].includes(intent.command.type)) {
        command = { ...intent.command }; reloaded = false;
      } else {
        if (!targetMatches(intent, url) || intent.observedUrl && intent.observedUrl !== url) throw changed();
        command = { type: 'NAVIGATE_SOURCE', expectedUrl: url, url, expectedDocumentToken: nav.documentToken,
          ...(nav.sectionVisit?.token ? { expectedVisitToken: nav.sectionVisit.token } : {}), reload: true };
        previousDocumentToken = nav.documentToken;
      }
    }
    checkBudget(intent); check(); await checkRevision(binding.tabId, before, intent);
    if (!browser.frame?.documentId || !canonicalUrl(browser.frame.url)) throw sourceStatusError({ state: 'unavailable',
      navigation: navigationDiagnostic({ ...intent.navigation, cause: 'unexpected_document' }) });
    const next = { ...intent, attempt: intent.attempt + 1, phase: 'armed', lastFailure: intent.failure || intent.lastFailure,
      attemptMode: native || ['NAVIGATE_SOURCE', 'OPEN_CONFIRMED_LESSON'].includes(command.type) ? 'document' : 'item',
      attemptSourceUrl: canonicalUrl(browser.frame.url), attemptSourceBrowserDocumentId: browser.frame.documentId,
      previousBrowserDocumentIds: [...new Set([...(intent.previousBrowserDocumentIds || []), intent.browserDocumentId, browser.frame.documentId].filter(Boolean))].slice(-8),
      failure: null, browserDocumentId: null };
    await serial(binding.tabId, async () => {
      const current = await load(binding.tabId);
      if (current?.id !== intent.id || current.attempt !== intent.attempt || revision(binding.tabId) !== before) throw changed();
      const finalCheck = await authorize(current); finalCheck();
      await save(binding.tabId, next);
    });
    check(); await checkRevision(binding.tabId, before, next);
    const finalCheck = await authorize(next);
    const latestBrowser = await browserState(binding.tabId);
    await checkRevision(binding.tabId, before, next);
    if (latestBrowser.frame?.documentId !== browser.frame.documentId || canonicalUrl(latestBrowser.frame?.url) !== canonicalUrl(browser.frame.url)) {
      throw sourceStatusError({ state: 'unavailable', navigation: navigationDiagnostic({ ...next.navigation, cause: 'unexpected_document',
        sourceDocumentId: browser.frame.documentId, currentDocumentId: latestBrowser.frame?.documentId,
        expectedUrl: canonicalUrl(browser.frame.url), observedUrl: canonicalUrl(latestBrowser.frame?.url) }) });
    }
    const latestState = classifySourceNavigation({ ...latestBrowser, intent, expectedBookKey: binding.bookKey, canonicalUrl, bookKey, now: now() });
    if (latestState.browserLoading || !['same_book', 'network_error'].includes(latestState.state)) throw sourceStatusError(latestState);
    check(); finalCheck();
    const response = native ? await chrome.tabs.update(binding.tabId, { url: intent.failure.url }) : await sendSource(binding.tabId, command);
    return { ...(native ? { ok: true } : response), transition: descriptor(next), reloaded,
      ...(previousDocumentToken ? { previousDocumentToken } : {}) };
  }
  const stalled = createSourceStallRecovery({ chrome, now, canonicalUrl, bookKey, targetMatches,
    boundIntent, checkBudget, browserState, save, serial, descriptor });
  return { navigate, status, retry, recoverStalled: stalled.reload, recoveryIntent: stalled.inspect,
    async installReplacement(intent, tabId, documentId) {
      await drain(tabId);
      const existing = await load(tabId);
      if (existing?.id === intent.id && existing.attempt === 3) {
        const check = await authorize(existing); check();
        if (existing.invalidState) throw sourceStatusError({ state: existing.invalidState });
        return { ok: true, transition: descriptor(existing), reloaded: true, recovery: 'replace', previousDocumentToken: intent.sourceDocumentToken };
      }
      const next = { ...intent, tabId, attempt: 3, phase: 'armed', observedUrl: null, failure: null, browserDocumentId: null,
        attemptMode: 'document', attemptSourceUrl: intent.recoveryUrl, attemptSourceBrowserDocumentId: documentId,
        previousBrowserDocumentIds: [documentId], progress: observeSourceProgress(null, null, now()), recovery: 'replace' };
      await save(tabId, next);
      return { ok: true, transition: descriptor(next), reloaded: true, recovery: 'replace', previousDocumentToken: intent.sourceDocumentToken };
    },
    async complete(tabId, value) {
      await ready;
      await serial(tabId, async () => {
        const intent = await load(tabId), url = canonicalUrl(value);
        if (intent && !intent.invalidState && url && (intent.observedUrl === url || targetMatches(intent, url))) await save(tabId, null);
      });
    },
    async validate(binding, id) {
      await ready;
      await drain(binding.tabId);
      const { intent } = await boundIntent(binding, id);
      if (now() >= intent.deadlineAt) throw failure('transition_timeout', 'Страница книги не загрузилась за три минуты. Проверьте соединение или VPN и повторите сбор.');
      if (intent.invalidState) throw sourceStatusError({ state: intent.invalidState, navigation: withNavigation(intent).navigation });
      return descriptor(intent);
    },
    async remember(tabId, navigation) {
      if (!navigation || !canonicalUrl(navigation.url) || typeof navigation.documentToken !== 'string') return;
      observedNavigation.set(tabId, navigation);
      await ready;
      await serial(tabId, async () => {
        const intent = await load(tabId);
        if (!intent || intent.invalidState || !targetMatches(intent, navigation.url)) return;
        if (intent.attemptMode === 'document' && intent.phase !== 'committed' &&
          navigation.documentToken === (intent.recoverySourceDocumentToken || intent.sourceDocumentToken)) return;
        const progress = observeSourceProgress(intent.progress, navigation, now());
        if (progress.sequence !== intent.progress?.sequence) await save(tabId, { ...intent, progress });
      });
    },
    async clear(tabId) {
      await ready;
      if (!records.has(tabId) && !observedNavigation.has(tabId) && !confirmedInventories.has(tabId)) return;
      bump(tabId); observedNavigation.delete(tabId); traces.delete(tabId); confirmedInventories.delete(tabId);
      if (records.has(tabId)) await serial(tabId, () => save(tabId, null));
    } };
}
