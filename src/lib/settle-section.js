import { MAX_TRANSITION_ATTEMPTS } from './source-transition-policy.js';
import { isLessonBootstrapUrl } from './source-navigation-lesson-landing.js';

const RETRYABLE = new Set(['section_loading_timeout', 'section_render_timeout', 'author_data_missing', 'author_data_incomplete', 'navigation_timeout', 'document_load_timeout']);

export async function settleSection({ matches, context, verifySections, settled, request, activeSection,
  startStage, log, pageError, blockedPageError, transition, pollMs, initialOptions = {} }) {
  let match = matches, options = { watchSection: true, ...initialOptions };
  let original, verify = verifySections;
  for (;;) {
    try { return await settled(match, context, options); }
    catch (error) {
      if (!RETRYABLE.has(error.code) || !transition.remaining() || transition.attempt() >= MAX_TRANSITION_ATTEMPTS) throw error;
      const expected = error.pageNavigation;
      const bootstrap = !original && options.watchSection && expected?.kind === 'lesson' &&
        isLessonBootstrapUrl(expected.url) && matches(expected);
      if (expected && !bootstrap && matches(expected)) original ||= expected;
      const key = original && activeSection(original)?.key;
      const changed = current => pageError('Исходная вкладка изменилась. Обход остановлен.', context, current?.url || expected?.url, 'source_changed');
      if (original && !verify) verify = nav => {
        if (original.items.length && JSON.stringify(nav.items.map(item => item.key)) !== JSON.stringify(original.items.map(item => item.key))) {
          throw pageError('Список разделов изменился во время обхода. Повторите сбор урока.', context, original.url, 'section_list_changed');
        }
      };
      if (expected) {
        let current;
        try {
          ({ navigation: current } = await transition.run(() => request('GET_NAVIGATION', {
            ...(!bootstrap ? { expectedUrl: expected.url } : {}), expectedDocumentToken: expected.documentToken,
            ...(!bootstrap && expected.sectionVisit ? { expectedVisitToken: expected.sectionVisit.token } : {}),
            transitionId: transition.id(), sourceTimeoutMs: Math.min(10_000, transition.remaining()) })));
        } catch (recheckError) {
          if (!['source_timeout', 'source_disconnected', 'source_loading', 'source_network_error', 'source_unavailable'].includes(recheckError.code) || !transition.remaining()) throw recheckError;
          log('waiting', { reason: recheckError.code, attempt: transition.attempt(), remainingMs: Math.floor(transition.remaining()) });
          if (transition.attemptRemaining() > 0) { await transition.pause(pollMs); continue; }
          current = expected;
        }
        if (!current || current.kind !== expected.kind || current.lessonId !== expected.lessonId ||
          (bootstrap ? !matches(current) : current.url !== expected.url) ||
          key && activeSection(current) && activeSection(current).key !== key) throw changed(current);
        if (current.kind === 'book' && JSON.stringify(current.items) !== JSON.stringify(expected.items)) {
          throw pageError('Список уроков изменился. Повторите сбор из содержания книги.', context, current.url, 'source_changed');
        }
        if (current.blocked) throw blockedPageError(current, context);
        if (current.ready && original) verify?.(current);
        // Completion can race with the soft deadline. Observe stability without
        // restarting a page whose source data has already arrived.
        if (matches(current) && current.ready && (!options.watchSection || current.sectionVisit?.received) &&
          (!options.previousDocumentToken || current.documentToken !== options.previousDocumentToken)) {
          options = { ...options, previousDocumentToken: '' };
          continue;
        }
      }
      const idleMs = Math.floor(transition.idleMs());
      const result = await transition.recover(error.code);
      if (!result) {
        if (!transition.remaining() || transition.attempt() >= MAX_TRANSITION_ATTEMPTS) throw error;
        await transition.pause(pollMs);
        continue;
      }
      startStage(result.recovery === 'request' ? 'retry_definition' : result.recovery === 'replace' ? 'replace_source' :
        options.watchSection ? expected?.kind === 'book' ? 'open_lesson' : 'reload_section' : 'book', transition.attempt());
      log('retrying', { reason: error.code, recovery: result.recovery, idleMs, definitionRetrySkipped: result.definitionRetrySkipped });
      match = nav => {
        if (!original) return matches(nav);
        if (nav.url !== original.url || nav.kind !== original.kind || nav.lessonId !== original.lessonId) return false;
        if (nav.ready) {
          if (!matches(nav)) throw changed(nav);
          if (key && activeSection(nav)?.key !== key) throw changed(nav);
          verify?.(nav);
        }
        return true;
      };
      options = { ...options, reloadUrl: original?.url || '', previousDocumentToken: result.previousDocumentToken || '',
        reloaded: result.reloaded === true };
    }
  }
}
