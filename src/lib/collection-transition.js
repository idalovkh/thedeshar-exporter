import { MAX_TRANSITION_ATTEMPTS, TRANSITION_RETRY_AFTER_MS, TRANSITION_RETRY_DELAYS_MS, TRANSITION_TIMEOUT_MS } from './source-transition-policy.js';
import { sourceStatusError } from './source-navigation-errors.js';
import { observeSourceProgress } from './source-progress.js';
import { SOURCE_STALL_MS, SOURCE_RECOVERY_STALL_MS, DEFINITION_RETRY_WAIT_MS } from './source-transition-policy.js';

const STOP_STATES = new Set(['other_book', 'source_changed', 'security_error', 'interrupted', 'closed']);
const SOURCE_STATES = new Set(['loading', 'same_book', 'other_book', 'source_changed', 'network_error', 'security_error', 'interrupted', 'unavailable', 'closed']);

/** One logical navigation owns its deadline and every kind of restart. */
export function createCollectionTransition({ request, now, wait, signal,
  timeoutMs = TRANSITION_TIMEOUT_MS, attemptTimeoutMs = TRANSITION_RETRY_AFTER_MS,
  retryDelaysMs = TRANSITION_RETRY_DELAYS_MS } = {}) {
  const startedAt = now();
  let spent = 0, descriptor;
  let progress = observeSourceProgress(null, null, 0), requestTried = false, requestWaiting = false;
  const elapsed = () => Math.max(spent, now() - startedAt);
  const check = () => {
    if (signal?.aborted) throw new DOMException('Обход остановлен.', 'AbortError');
  };
  const remaining = () => Math.max(0, timeoutMs - elapsed());
  const accept = transition => {
    if (!transition || typeof transition.id !== 'string' || !transition.id ||
      !Number.isInteger(transition.attempt) || transition.attempt < 1 || transition.attempt > MAX_TRANSITION_ATTEMPTS ||
      transition.maxAttempts !== MAX_TRANSITION_ATTEMPTS || !Number.isFinite(transition.deadlineAt) || transition.deadlineAt <= 0) {
      throw Object.assign(new Error('Обновите расширение и повторите сбор книги.'), { code: 'source_update_required' });
    }
    if (descriptor && transition.id !== descriptor.id) throw Object.assign(new Error('Переход к странице книги изменился. Сбор остановлен.'), { code: 'source_changed' });
    descriptor = transition;
  };
  async function run(operation) {
    check();
    const duration = remaining();
    if (!duration) throw Object.assign(new Error('Не удалось дождаться загрузки страницы за отведённое время.'), { code: 'transition_timeout' });
    const before = now();
    let timer, abort;
    try {
      return await Promise.race([
        Promise.resolve().then(() => { check(); return operation(); }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('Не удалось дождаться загрузки страницы за отведённое время.'), { code: 'transition_timeout' })), duration);
          abort = () => reject(new DOMException('Обход остановлен.', 'AbortError'));
          signal?.addEventListener('abort', abort, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      spent += Math.max(0, now() - before);
    }
  }
  async function pause(ms) {
    const duration = Math.min(ms, remaining());
    if (duration <= 0) return 0;
    const before = now();
    await run(() => wait(duration));
    spent += Math.max(0, duration - Math.max(0, now() - before));
    check();
    return duration;
  }
  async function status() {
    const response = await run(() => request('GET_SOURCE_STATUS', { transitionId: descriptor?.id, sourceTimeoutMs: Math.min(10_000, remaining()) }));
    const value = response.sourceStatus;
    if (!SOURCE_STATES.has(value?.state)) throw Object.assign(new Error('Не удалось определить состояние исходной страницы.'), { code: 'source_unavailable' });
    if (STOP_STATES.has(value.state)) throw Object.assign(sourceStatusError(value), { expectedUrl: value.expectedUrl, observedUrl: value.url });
    if (value?.transitionId && descriptor && value.transitionId !== descriptor.id) throw Object.assign(new Error('Переход к странице книги изменился. Сбор остановлен.'), { code: 'source_changed' });
    if (Number.isFinite(value?.remainingMs)) spent = Math.max(spent, timeoutMs - value.remainingMs);
    return value;
  }
  async function retry(reason) {
    check();
    if (!descriptor || descriptor.attempt >= MAX_TRANSITION_ATTEMPTS || !remaining()) return null;
    let current = await status();
    if (current?.browserLoading || current?.state === 'loading' || current?.canRetry === false) return null;
    await pause(retryDelaysMs[descriptor.attempt - 1] ?? 0);
    if (!remaining()) return null;
    current = await status();
    if (current?.browserLoading || current?.state === 'loading' || current?.canRetry === false) return null;
    let response;
    try {
      response = await run(() => request('RETRY_SOURCE_NAVIGATION', { transitionId: descriptor.id, reason,
        sourceTimeoutMs: Math.min(10_000, remaining()) }));
    } catch (error) {
      // Chrome can start its own provisional retry after our status check.
      // The worker refuses it before consuming our retry grant.
      if (error.code === 'source_loading') return null;
      throw error;
    }
    const previousAttempt = descriptor.attempt;
    accept(response.transition);
    if (descriptor.attempt !== previousAttempt + 1) throw Object.assign(new Error('Не удалось подтвердить повторную загрузку страницы.'), { code: 'source_changed' });
    progress = observeSourceProgress(null, null, elapsed());
    return response;
  }
  async function recoverInner(reason) {
    check();
    if (!descriptor || descriptor.attempt >= MAX_TRANSITION_ATTEMPTS || !remaining()) return null;
    const current = await status();
    if (!['loading', 'same_book', 'network_error'].includes(current.state)) return null;
    if (descriptor.attempt === 1 && !requestTried) {
      const result = await run(() => request('RETRY_DEFINITION_REQUEST', { transitionId: descriptor.id,
        sourceTimeoutMs: Math.min(10_000, remaining()) }));
      requestTried = true;
      if (result.retried) {
        requestWaiting = true; progress = observeSourceProgress(null, null, elapsed());
        return { ...result, recovery: 'request', reloaded: false };
      }
    }
    const previousAttempt = descriptor.attempt;
    const result = await run(() => request(previousAttempt === 1 ? 'RETRY_SOURCE_NAVIGATION' : 'REPLACE_SOURCE_TAB', {
      transitionId: descriptor.id, reason, stalled: true, sourceTimeoutMs: Math.min(10_000, remaining()) }));
    accept(result.transition);
    if (descriptor.attempt !== previousAttempt + 1) throw Object.assign(new Error('Не удалось подтвердить восстановление страницы.'), { code: 'source_changed' });
    requestWaiting = false; progress = observeSourceProgress(null, null, elapsed());
    return { ...result, recovery: previousAttempt === 1 ? 'reload' : 'replace', definitionRetrySkipped: previousAttempt === 1 };
  }
  async function recover(reason) {
    try { return await recoverInner(reason); }
    catch (error) { if (error.code === 'source_loading') return null; throw error; }
  }
  return Object.freeze({ run, pause, status, retry, recover, accept, remaining,
    progress: navigation => { progress = observeSourceProgress(progress, navigation, elapsed()); },
    idleMs: () => Math.max(0, elapsed() - progress.at),
    attemptRemaining: () => Math.min(remaining(), Math.max(0, (requestWaiting ? DEFINITION_RETRY_WAIT_MS :
      descriptor?.attempt > 1 ? Math.min(SOURCE_RECOVERY_STALL_MS, attemptTimeoutMs) : Math.min(SOURCE_STALL_MS, attemptTimeoutMs)) - (elapsed() - progress.at))),
    elapsed, attempt: () => descriptor?.attempt || 1, id: () => descriptor?.id });
}
