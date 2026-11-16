export const SOURCE_REQUEST_TIMEOUT_MS = 10_000;

/** Bound a source RPC independently of the source tab's response or lifetime. */
export function requestSource(send, { signal, timeoutMs = SOURCE_REQUEST_TIMEOUT_MS } = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason || new DOMException('Сбор остановлен.', 'AbortError'));
  const duration = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.min(timeoutMs, SOURCE_REQUEST_TIMEOUT_MS) : SOURCE_REQUEST_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (callback, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      callback(result);
    };
    const abort = () => finish(reject, signal.reason || new DOMException('Сбор остановлен.', 'AbortError'));
    const timer = setTimeout(() => finish(reject, Object.assign(
      new Error('Вкладка книги не отвечает. Проверьте её загрузку и восстановите связь.'), { code: 'source_timeout' },
    )), duration);
    signal?.addEventListener('abort', abort, { once: true });
    try { Promise.resolve(send()).then(value => finish(resolve, value), error => finish(reject, error)); }
    catch (error) { finish(reject, error); }
  });
}
