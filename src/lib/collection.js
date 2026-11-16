import { settleSection } from './settle-section.js';
import { createCollectionTransition } from './collection-transition.js';
import { MAX_TRANSITION_ATTEMPTS, TRANSITION_RETRY_AFTER_MS, TRANSITION_RETRY_DELAYS_MS, TRANSITION_TIMEOUT_MS } from './source-transition-policy.js';
import { isSourceUrl } from './state.js';
import { appendCollectionDiagnostic, createCollectionDiagnostics, recordCollectionFailure } from './collection-diagnostics.js';
import { navigationDiagnostic } from './navigation-diagnostics.js';
import { exporterBindingDiagnostic } from './exporter-binding-diagnostics.js';

// The dashboard drives a bounded, read-only tour using the source's own navigation.
// Every checkpoint is persisted; closing the dashboard leaves an unfinished report.
export async function collectBook({ request, signal, reset = false, extensionVersion, onProgress = () => {}, onDiagnostic = () => {}, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => performance.now(), pollMs = 700, attempts, fastPollMs = 250, quietMs = 500, pendingGraceMs = 5000, maxPages = Infinity,
  transitionTimeoutMs = TRANSITION_TIMEOUT_MS, retryAfterMs = attempts === undefined ? TRANSITION_RETRY_AFTER_MS : attempts * pollMs,
  retryDelaysMs = TRANSITION_RETRY_DELAYS_MS }) {
  const diagnostics = createCollectionDiagnostics(extensionVersion);
  const report = { status: 'running', rootUrl: '', title: '', startedAt: new Date().toISOString(), expected: [], visited: [], failed: [], items: [], warnings: [], diagnostics };
  const titleOf = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
  let lastUrl = '';
  let lastSavedUrl = '';
  let target = {};
  let step;
  const elapsed = () => Math.max(0, Math.round(now() - step.startedAt));
  const log = (status, details = {}) => {
    appendCollectionDiagnostic(diagnostics, {
      at: new Date().toISOString(), stage: step.stage, status, attempt: step.attempt, elapsedMs: elapsed(),
      url: lastUrl, lastSavedUrl, ...details,
    });
    try { onDiagnostic(structuredClone(diagnostics.events.at(-1))); }
    catch { /* A diagnostic consumer must not interrupt the collection. */ }
  };
  const startStage = (stage, attempt) => {
    step = { stage, attempt, startedAt: now() };
    log('started');
  };
  function recordFailure(reason, url = lastUrl, status = 'failed', logged = false, details = {}) {
    recordCollectionFailure(diagnostics, { ...target, stage: step.stage, reason, url, lastSavedUrl, elapsedMs: elapsed(), ...details });
    if (!logged) log(status, { reason, url, ...details });
  }
  startStage('book');
  let startedCapture = false;
  let ownsCollection = false;
  let collectionId;
  let transition;
  let lastPageObservation;
  const visitedLessons = new Set();
  const check = () => { if (signal?.aborted) throw new DOMException('Обход остановлен.', 'AbortError'); };
  const send = request;
  const runMutations = new Set(['END_COLLECTION', 'SAVE_COLLECTION', 'START_CAPTURE', 'STOP_CAPTURE', 'CLEAR_CAPTURE', 'TAKE_SNAPSHOT', 'PREPARE_BOOK', 'OPEN_MATERIAL_ITEM', 'NAVIGATE_SOURCE', 'RETRY_SOURCE_NAVIGATION', 'GET_SOURCE_STATUS']);
  request = async (type, payload) => {
    if (!['STOP_CAPTURE', 'SAVE_COLLECTION', 'END_COLLECTION'].includes(type)) check();
    const response = await send(type, { ...payload, ...(runMutations.has(type) ? { collectionId } : {}) });
    if (type === 'BEGIN_COLLECTION') {
      if (typeof response?.collectionId !== 'string' || !response.collectionId) throw Object.assign(new Error('Обновите расширение и откройте его заново, чтобы начать новый сбор.'), { code: 'source_update_required' });
      collectionId = response.collectionId;
    }
    if (response?.navigation) {
      const token = response.navigation.documentToken;
      if (typeof token !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(token)) throw Object.assign(new Error('Обновите расширение и перезагрузите вкладку учебника перед сбором.'), { code: 'source_update_required' });
      if (payload?.expectedDocumentToken && token !== payload.expectedDocumentToken) throw Object.assign(new Error('Исходная вкладка была перезагружена. Обход остановлен.'), { code: 'source_changed' });
    }
    return response;
  };
  const beginTransition = async (type, payload) => {
    lastPageObservation = undefined;
    transition = createCollectionTransition({ request, now, wait, signal, timeoutMs: transitionTimeoutMs,
      attemptTimeoutMs: retryAfterMs, retryDelaysMs });
    try {
      const response = await transition.run(() => request(type, { ...payload, sourceTimeoutMs: Math.min(10_000, transition.remaining()) }));
      transition.accept(response.transition);
      return response;
    } catch (error) {
      if (!['source_timeout', 'source_disconnected', 'source_loading', 'source_network_error'].includes(error.code)) throw error;
      const status = await transition.status();
      transition.accept({ id: status?.transitionId, deadlineAt: status?.deadlineAt, attempt: status?.attempt, maxAttempts: status?.maxAttempts });
      return { transition: status };
    }
  };
  const checkpoint = async () => { await request('SAVE_COLLECTION', { collection: structuredClone(report) }); onProgress(structuredClone(report)); };
  const partialWarning = 'Обход охватывает только загруженные элементы страницы; отсутствие других уроков и разделов не подтверждается.';
  const diagnosticUrl = value => {
    try {
      const url = new URL(value);
      return isSourceUrl(url) ? `${url.origin}${url.pathname}` : '';
    } catch { return ''; }
  };
  const blockedReason = nav => nav.warnings?.filter(warning => warning !== partialWarning).at(-1) || nav.readinessReason || 'Навигация на странице недоступна для автоматического обхода.';
  const checkRetainedData = state => {
    if (state.dropped) throw new Error(`${state.warnings?.at(-1) || 'Достигнут лимит хранения.'} Обход остановлен: часть исходных данных не сохранена.`);
  };
  // Current content scripts report observed fetch/XHR still in flight. With that
  // signal a page is saved once its requests finish instead of after a fixed
  // 1.4 s of identical polls; older replies keep the fixed rule.
  const networkOf = nav => {
    const network = nav?.network;
    return network && Number.isSafeInteger(network.pending) && network.pending >= 0 &&
      Number.isFinite(network.idleMs) && network.idleMs >= 0 ? network : null;
  };
  const intervalFor = nav => networkOf(nav) ? Math.min(fastPollMs, pollMs) : pollMs;
  const pageError = (reason, context, url = lastUrl, code) => Object.assign(new Error(`${context}: ${reason}${diagnosticUrl(url) ? ` Страница: ${diagnosticUrl(url)}.` : ''}`), { code, url: diagnosticUrl(url) });
  const activeSection = nav => nav?.items?.find(item => item.active && (item.kind === 'section' || item.kind === 'homework'));
  const sectionIdFor = url => url.match(/\/section\/(\d+|for-homework)\/?$/)?.[1];
  const observation = nav => ({ exerciseState: nav?.exerciseState, network: networkOf(nav), lessonId: nav?.lessonId, sectionId: sectionIdFor(nav?.url || ''),
    readinessReason: nav?.readinessReason, ...(nav?.kind === 'book' ? { bookState: nav.bookState } : {}),
    ...(nav?.kind === 'lesson' ? { authorData: nav.sectionVisit?.received ? 'received' : nav.sectionVisit?.reason === 'incomplete' ? 'incomplete' : 'unobserved' } : {}) });
  const changedSource = 'Исходная вкладка изменилась. Обход остановлен.';
  const sectionListChanged = 'Список разделов изменился во время обхода. Повторите сбор урока.';
  async function settled(matches, context, { prepareBook = false, watchSection = false, reloadUrl = '', previousDocumentToken = '', reloaded = false } = {}) {
    lastPageObservation = undefined;
    let previous = '';
    let stable = 0;
    let stableMs = 0;
    let reason = 'Навигация страницы ещё не появилась.';
    let code;
    let interval = pollMs;
    let skipPrepare = 0;
    let observed;
    let lastNavigation;
    let lastFailureContext;
    let confirmedUrl = reloadUrl;
    let observationKey;
    let polls = 0;
    let documentLoaded = !previousDocumentToken;
    let visitToken = '';
    let visitDocument = '';
    let slowNotifiedAttempt = 0;
    let waited = 0;
    const remaining = transition.remaining;
    const pause = async ms => {
      waited = await transition.pause(ms);
    };
    while (remaining() > 0) {
      check();
      if (transition.elapsed() >= retryAfterMs && slowNotifiedAttempt !== transition.attempt()) {
        slowNotifiedAttempt = transition.attempt();
        log('waiting', { reason: 'source_loading', attempt: transition.attempt(), elapsedMs: Math.round(transition.elapsed()),
          remainingMs: Math.floor(remaining()), expectedUrl: confirmedUrl || lastUrl, ...observation(lastNavigation) });
      }
      let nav;
      let observedUrl = '';
      polls++;
      try {
        ({ navigation: nav } = await transition.run(() => request('GET_NAVIGATION', { sourceTimeoutMs: Math.min(10_000, remaining()), transitionId: transition.id() })));
        lastNavigation = nav;
        observedUrl = diagnosticUrl(nav?.url);
        if (confirmedUrl && observedUrl && observedUrl !== confirmedUrl) throw Object.assign(new Error(changedSource), { code: 'source_changed' });
        // The reload command returns before the old content script stops
        // replying. Its ready DOM and quiet network cannot confirm the new page.
        if (previousDocumentToken && nav?.documentToken === previousDocumentToken) {
          reason = 'Ожидаем новую страницу после перезагрузки.';
          if (observationKey !== 'old_document') log('waiting', { polls });
          observationKey = 'old_document';
          previous = '';
          stable = 0;
          stableMs = 0;
          interval = intervalFor(nav);
          await pause(interval);
          continue;
        }
        if (nav) { documentLoaded = true; lastFailureContext = undefined; lastPageObservation = observation(nav); }
        if (remaining() <= 0) break;
        if (prepareBook && nav?.kind === 'book' && !nav.blocked && matches(nav)) {
          if (skipPrepare > 0) skipPrepare--;
          else {
            // Returning to the contents closes ProgressMe's lazy lesson groups.
            // Expand them through their own controls before reading the inventory.
            const prepared = await transition.run(() => request('PREPARE_BOOK', { expectedUrl: nav.url, expectedDocumentToken: nav.documentToken, sourceTimeoutMs: Math.min(10_000, remaining()) }));
            nav = prepared.navigation;
            lastNavigation = nav;
            lastPageObservation = observation(nav);
            if (remaining() <= 0) break;
            // A clicked group may apply its open class after the next fast poll;
            // clicking it again would close it.
            if (prepared.opened > 0) skipPrepare = Math.ceil(pollMs / intervalFor(nav)) - 1;
          }
        }
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        if (!['source_disconnected', 'source_timeout', 'source_loading', 'source_network_error', 'source_unavailable'].includes(error.code)) {
          throw Object.assign(pageError(error.message, context, observedUrl || lastUrl, error.code), { networkError: error.networkError,
            binding: exporterBindingDiagnostic(error.binding),
            expectedUrl: error.expectedUrl, observedUrl: error.observedUrl, navigation: navigationDiagnostic(error.navigation) });
        }
        reason = error.message;
        code = error.code;
        lastFailureContext = { networkError: error.networkError, expectedUrl: error.expectedUrl,
          observedUrl: error.observedUrl, navigation: navigationDiagnostic(error.navigation) };
        if (!remaining()) break;
        const status = await transition.status();
        lastFailureContext = { networkError: status.networkError || error.networkError,
          expectedUrl: status.expectedUrl || error.expectedUrl, observedUrl: status.url || error.observedUrl,
          navigation: navigationDiagnostic(status.navigation) || lastFailureContext.navigation };
        if (status?.state === 'network_error') {
          const result = await transition.retry('source_network_error');
          if (!result) {
            if (transition.attempt() < MAX_TRANSITION_ATTEMPTS && remaining()) {
              if (observationKey !== 'browser_retry') log('waiting', { reason: 'source_loading', networkError: status.networkError,
                attempt: transition.attempt(), remainingMs: Math.floor(remaining()), navigation: navigationDiagnostic(status.navigation) });
              observationKey = 'browser_retry';
              await pause(interval);
              continue;
            }
            throw Object.assign(pageError('Не удалось загрузить страницу после повторных попыток. Проверьте соединение и повторите сбор.', context, lastUrl, 'source_network_error'), {
              networkError: status.networkError, expectedUrl: status.expectedUrl, observedUrl: status.url,
              navigation: navigationDiagnostic(status.navigation) });
          }
          startStage(watchSection ? 'reload_section' : 'book', transition.attempt());
          log('retrying', { reason: 'source_network_error', networkError: status.networkError, navigation: navigationDiagnostic(status.navigation) });
          previousDocumentToken = result.previousDocumentToken || '';
          reloaded = result.reloaded === true;
          documentLoaded = !previousDocumentToken;
          previous = ''; stable = 0; stableMs = 0; visitToken = ''; visitDocument = '';
          observed = undefined; observationKey = undefined;
          lastPageObservation = undefined;
          continue;
        }
        // Slow or temporarily missing source replies do not prove a failed
        // navigation. Keep observing the same transition within its deadline.
        observed = undefined;
        if (observationKey !== code) log('waiting', { reason: code, polls });
        observationKey = code;
        previous = '';
        stable = 0;
        await pause(interval);
        continue;
      }
      check();
      if (diagnosticUrl(nav?.url)) lastUrl = diagnosticUrl(nav.url);
      if (confirmedUrl && observedUrl && observedUrl !== confirmedUrl) throw pageError(changedSource, context, observedUrl, 'source_changed');
      if (nav?.blocked) throw pageError(blockedReason(nav), context, nav.url, 'navigation_blocked');
      code = undefined;
      interval = intervalFor(nav);
      const network = networkOf(nav);
      const matched = nav && matches(nav);
      const active = watchSection && matched && activeSection(nav);
      const details = { polls, ...observation(nav) };
      if (watchSection && matched && details.sectionId) {
        const visit = nav.sectionVisit;
        if (!visit || typeof visit.token !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(visit.token) ||
          !Number.isSafeInteger(visit.revision) || visit.revision < 0 || typeof visit.received !== 'boolean' ||
          !Number.isFinite(visit.idleMs) || visit.idleMs < 0) {
          throw pageError('Обновите расширение и перезагрузите вкладку учебника перед сбором.', context, nav.url, 'source_update_required');
        }
        if (visitToken && (visitToken !== visit.token || visitDocument !== nav.documentToken)) {
          throw pageError(changedSource, context, nav.url, 'source_changed');
        }
        visitToken = visit.token;
        visitDocument = nav.documentToken;
        confirmedUrl = observedUrl;
        if (active) target.sectionTitle ||= active.title;
        const stage = nav.ready && !visit.received ? 'wait_author_data' : 'wait_exercises';
        if (step.stage !== stage) {
          if (step.stage === 'open_lesson' || step.stage === 'open_section') log('ready', details);
          startStage(stage, transition.attempt());
        }
      }
      observed = matched ? nav : undefined;
      const key = JSON.stringify([observedUrl, nav?.documentToken, Boolean(matched), nav?.ready, nav?.readinessReason, nav?.bookState, nav?.exerciseState, nav?.sectionVisit?.revision, nav?.sectionVisit?.received, network && network.pending > 0]);
      if (key !== observationKey) log('waiting', details);
      observationKey = key;
      const authorReady = !watchSection || nav?.sectionVisit?.received === true;
      if (matched && nav.ready && authorReady) {
        const fingerprint = JSON.stringify([nav.url, nav.documentToken, nav.contentSignature, nav.items, nav.sectionVisit?.token, nav.sectionVisit?.revision]);
        stable = fingerprint === previous ? stable + 1 : 0;
        stableMs = stable ? stableMs + waited : 0;
        previous = fingerprint;
        reason = network?.pending ? 'Страница ещё получает данные; сохранение ещё не началось.'
          : 'Содержимое страницы продолжает меняться; сохранение ещё не началось.';
        // A long-lived request must not stall the tour: after the grace period
        // an unchanged page is saved as it was before this signal existed.
        const quiet = network
          ? stable >= 1 && (!network.pending && network.idleMs >= quietMs || stableMs >= pendingGraceMs)
          : stable >= 2;
        if (quiet && (!watchSection || nav.sectionVisit.idleMs >= quietMs)) {
          log('ready', details);
          report.warnings = [...new Set([...report.warnings, ...(nav.warnings || [])])];
          return nav;
        }
      } else {
        reason = !nav ? 'Навигация страницы ещё не появилась.'
          : !matched ? 'Переход на выбранную страницу не завершился.'
            : !authorReady && nav.ready ? 'Ожидаем сохранения исходных заданий текущего раздела.'
              : nav.readinessReason || 'Содержимое страницы ещё не готово к сохранению.';
        previous = '';
        stable = 0;
      }
      if (!transition.attemptRemaining() && !(matched && nav.ready && authorReady)) {
        const status = await transition.status();
        if (!status?.browserLoading && status?.state !== 'loading' && !(network && network.pending > 0)) break;
      }
      await pause(interval);
    }
    if (!documentLoaded) {
      if (code !== 'source_disconnected') reason = 'Не удалось дождаться новой страницы после перезагрузки.';
      code = 'document_load_timeout';
    }
    const section = documentLoaded && watchSection && confirmedUrl && observed?.url === confirmedUrl && sectionIdFor(observed.url);
    if (section) {
      if (observed.exerciseState?.loaderVisible && !observed.ready) {
        code = 'section_loading_timeout';
        reason = reloaded ? 'Сайт не показал задания раздела после повторной загрузки.' : 'Сайт продолжает загружать задания раздела.';
      } else if (!observed.ready && observed.exerciseState) {
        code = 'section_render_timeout';
        reason = 'Адрес раздела открыт, но сайт не показал задания или пустое состояние.';
      } else if (!observed.sectionVisit?.received) {
        code = observed.sectionVisit?.reason === 'incomplete' ? 'author_data_incomplete' : 'author_data_missing';
        reason = code === 'author_data_incomplete' ? 'Получен неполный список исходных заданий раздела.' : 'Не получены исходные задания текущего раздела.';
      }
    }
    code ||= 'navigation_timeout';
    log('failed', { reason: code, polls, ...observation(observed), ...lastFailureContext });
    throw Object.assign(pageError(reason, context, lastUrl, code), { logged: true,
      ...lastFailureContext, ...(documentLoaded && lastNavigation ? { pageNavigation: section ? observed : lastNavigation } : {}) });
  }
  function settleLessonPage(matches, context, verifySections) {
    return settleSection({ matches, context, verifySections, settled, request, activeSection,
      startStage, log, pageError, transition, pollMs });
  }
  function settleBookPage(matches, context, previousDocumentToken) {
    return settleSection({ matches, context, settled, request, activeSection, startStage, log, pageError, transition, pollMs,
      initialOptions: { watchSection: false, prepareBook: true, previousDocumentToken } });
  }
  async function save(nav, onSaved = () => {}) {
    startStage('save_page');
    check();
    if (report.visited.length >= maxPages) throw new Error(`Достигнут предел обхода (${maxPages} страниц). Частичный архив скачать нельзя.`);
    const result = await request('TAKE_SNAPSHOT', { expectedUrl: nav.url, expectedDocumentToken: nav.documentToken,
      ...(nav.kind === 'lesson' ? { expectedVisitToken: nav.sectionVisit.token, requireExerciseCapture: true } : {}) });
    if (result.snapshotUrl !== nav.url) throw Object.assign(new Error('Исходная вкладка изменилась во время сохранения. Обход остановлен.'), { code: 'source_changed' });
    const savedUrl = result.savedSnapshotUrl || nav.url;
    if (diagnosticUrl(savedUrl) !== diagnosticUrl(nav.url)) throw new Error('Адрес сохранённого снимка не соответствует открытой секции.');
    if (!report.expected.includes(savedUrl)) report.expected.push(savedUrl);
    if (!report.visited.includes(savedUrl)) report.visited.push(savedUrl);
    lastUrl = savedUrl;
    lastSavedUrl = savedUrl;
    const retained = result.retained;
    const state = Number.isSafeInteger(retained?.dropped)
      ? { dropped: retained.dropped, warnings: typeof retained.warning === 'string' ? [retained.warning] : [] }
      : (await request('GET_STATE', { summary: true })).state;
    checkRetainedData(state);
    log('saved', { authorData: retained?.authorData === true ? 'received' : undefined });
    onSaved(nav);
    await checkpoint();
    return nav;
  }
  try {
    const { navigation: initial } = await request('GET_NAVIGATION');
    if (initial?.blocked) throw pageError(blockedReason(initial), 'Содержание учебника', initial.url, 'navigation_blocked');
    if (initial?.kind !== 'book') throw pageError(initial?.readinessReason || 'Откройте содержание книги со списком уроков и дождитесь загрузки.', 'Содержание учебника', initial?.url);
    report.rootUrl = initial.url;
    report.title = titleOf(initial.title);
    lastUrl = initial.url;
    const origin = new URL(initial.url).origin;
    const sameBook = nav => nav.materialId === initial.materialId && new URL(nav.url).origin === origin;
    report.items = (initial.items || []).filter(item => item.kind === 'lesson').map(item => ({ key: item.key, title: item.title, kind: 'lesson', status: 'pending' }));
    await request('BEGIN_COLLECTION');
    ownsCollection = true;
    if (reset) await request('CLEAR_CAPTURE');
    await checkpoint();
    await request('START_CAPTURE');
    startedCapture = true;
    // Capture must be active before the initial book response arrives.
    await beginTransition('NAVIGATE_SOURCE', { url: report.rootUrl, expectedUrl: initial.url, expectedDocumentToken: initial.documentToken });
    let book = await settleBookPage(nav => sameBook(nav) && nav.kind === 'book', 'Содержание учебника', initial.documentToken);
    report.title = titleOf(book.title) || report.title;
    const lessons = book.items.filter(item => item.kind === 'lesson');
    report.items = lessons.map(item => ({ key: item.key, title: item.title, kind: 'lesson', status: 'pending' }));
    book = await save(book);
    for (const lesson of lessons) {
      target = { lessonTitle: lesson.title };
      startStage('open_lesson', 1);
      check();
      if (!book.items.some(item => item.key === lesson.key)) throw new Error('Список уроков изменился. Повторите сбор из содержания книги.');
      const lessonItem = report.items.find(item => item.key === lesson.key);
      lessonItem.status = 'running';
      const context = `Урок «${lesson.title}»`;
      let firstLessonId;
      const matches = nav => {
        if (!sameBook(nav) || nav.kind !== 'lesson') return false;
        if (lesson.sourceId && nav.lessonId !== lesson.sourceId) return false;
        firstLessonId ||= nav.lessonId;
        return nav.lessonId === firstLessonId;
      };
      await beginTransition('OPEN_MATERIAL_ITEM', { key: lesson.key, expectedUrl: book.url, expectedDocumentToken: book.documentToken });
      let page = await settleLessonPage(matches, context);
      if (visitedLessons.has(page.lessonId)) throw new Error('Разные карточки открыли один урок. Возможно, исходная вкладка была переключена. Обход остановлен.');
      visitedLessons.add(page.lessonId);
      lessonItem.url = page.url;
      lessonItem.lessonId = page.lessonId;
      page = await save(page);
      const lessonId = page.lessonId;
      const sections = page.items.filter(item => item.kind === 'section' || item.kind === 'homework');
      if (!sections.length) throw new Error('Не найден список разделов урока. Обход остановлен для проверки.');
      const expectedSections = JSON.stringify(sections.map(item => item.key));
      const verifySections = nav => {
        if (JSON.stringify(nav.items.filter(item => item.kind === 'section' || item.kind === 'homework').map(item => item.key)) !== expectedSections) throw Object.assign(new Error(sectionListChanged), { code: 'section_list_changed' });
      };
      report.items.push(...sections.map(section => ({ key: section.key, title: section.title, kind: section.kind, lessonId, status: 'pending' })));
      await checkpoint();
      for (const section of sections) {
        const item = report.items.find(item => item.key === section.key && item.lessonId === lessonId);
        const visit = (saved = page) => { item.url = saved.url; item.status = report.failed.some(failure => diagnosticUrl(failure.url) === diagnosticUrl(saved.url)) ? 'failed' : 'visited'; };
        if (!page.items.some(candidate => candidate.key === section.key && candidate.active)) {
          target = { lessonTitle: lesson.title, sectionTitle: section.title };
          startStage('open_section');
          const { navigation: current } = await request('GET_NAVIGATION', { expectedUrl: page.url, expectedDocumentToken: page.documentToken, expectedVisitToken: page.sectionVisit.token });
          if (current?.url !== page.url || current.kind !== 'lesson' || current.lessonId !== lessonId ||
            activeSection(current)?.key !== activeSection(page)?.key) throw pageError(changedSource, 'Открытие раздела', current?.url || page.url, 'source_changed');
          if (current.blocked) throw pageError(blockedReason(current), 'Открытие раздела', current.url, 'navigation_blocked');
          verifySections(current);
          if (!current.ready) throw pageError(current.readinessReason || 'Страница ещё не готова к переходу.', 'Открытие раздела', current.url, 'navigation_stale');
          page = current;
          await beginTransition('OPEN_MATERIAL_ITEM', { key: section.key, expectedUrl: page.url, expectedDocumentToken: page.documentToken, expectedVisitToken: page.sectionVisit.token });
          const previousUrl = page.url;
          page = await settleLessonPage(nav => sameBook(nav) && nav.kind === 'lesson' && nav.lessonId === lessonId &&
            nav.url !== previousUrl && activeSection(nav)?.key === section.key &&
            (!section.sourceId || sectionIdFor(nav.url) === section.sourceId),
          `${section.kind === 'homework' ? 'Домашняя работа' : 'Раздел'} «${section.title}» урока «${lesson.title}»`, verifySections);
          verifySections(page);
          // One checkpoint records both the retained page and its visited item.
          page = await save(page, visit);
        } else {
          visit();
          await checkpoint();
        }
      }
      const { navigation: finalPage } = await request('GET_NAVIGATION', { expectedUrl: page.url, expectedDocumentToken: page.documentToken, expectedVisitToken: page.sectionVisit.token });
      if (finalPage?.url !== page.url) throw Object.assign(new Error('Исходная вкладка была переключена. Обход остановлен.'), { code: 'source_changed', url: diagnosticUrl(finalPage?.url) });
      verifySections(finalPage);
      lessonItem.status = report.items.some(item => item.lessonId === lessonId && item.kind !== 'lesson' && item.status === 'failed') ? 'failed' : 'visited';
      await checkpoint();
      target = {};
      startStage('book');
      await beginTransition('NAVIGATE_SOURCE', { url: report.rootUrl, expectedUrl: page.url, expectedDocumentToken: page.documentToken, expectedVisitToken: page.sectionVisit.token });
      book = await settleBookPage(nav => sameBook(nav) && nav.kind === 'book', 'Возврат к содержанию учебника', page.documentToken);
      if (JSON.stringify(book.items.map(item => item.key)) !== JSON.stringify(lessons.map(item => item.key))) throw new Error('Список уроков изменился во время обхода. Повторите сбор из содержания книги.');
    }
    // Drain queued source events before claiming completion. A capture issue
    // arriving after the final snapshot must still leave an incomplete report.
    startStage('finish');
    await request('STOP_CAPTURE');
    startedCapture = false;
    const { state: retained } = await request('GET_STATE', { summary: true });
    checkRetainedData(retained);
    report.status = report.failed.length ? 'failed' : 'finished';
    log(report.status);
  } catch (error) {
    report.status = error.name === 'AbortError' ? 'cancelled' : 'failed';
    report.failed.push({ url: error.url || lastUrl || report.rootUrl, error: error.message });
    const reason = report.status === 'cancelled' ? 'cancelled' : error.code || (step.stage === 'save_page' ? 'snapshot_error' : 'operation_failed');
    recordFailure(reason, error.url || lastUrl || report.rootUrl, report.status, error.logged, {
      ...(error.pageNavigation ? observation(error.pageNavigation) : lastPageObservation),
      binding: exporterBindingDiagnostic(error.binding),
      networkError: error.networkError, expectedUrl: error.expectedUrl || error.url || lastUrl,
      observedUrl: error.observedUrl, navigation: navigationDiagnostic(error.navigation),
      attempt: transition?.attempt(), remainingMs: transition ? Math.floor(transition.remaining()) : undefined,
    });
    for (const item of report.items) if (item.status === 'running') item.status = report.status;
  } finally {
    report.finishedAt = new Date().toISOString();
    if (startedCapture) try { await request('STOP_CAPTURE'); } catch { /* The source can be closed; checkpoint still works. */ }
    if (ownsCollection) {
      try { await checkpoint(); }
      finally { await request('END_COLLECTION'); }
    }
  }
  return report;
}
