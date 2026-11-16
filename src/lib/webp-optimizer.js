import { rasterImageCandidate } from './raster-image-metadata.js';
import { imagePreparationError, MAX_RASTER_BYTES } from './fullhd-image.js';

const ENCODE_TIMEOUT_MS = 10_000;
const ANIMATION_TIMEOUT_MS = 120_000;
const aborted = () => new DOMException('Скачивание отменено.', 'AbortError');
const startWorker = () => new Worker(new URL('./webp-worker.js', import.meta.url), { type: 'module' });

/** Queue at most one job from each download slot and send one Blob to WASM at a time. */
export function createWebpOptimizer({ signal, createWorker = startWorker, timeoutMs = ENCODE_TIMEOUT_MS, onFailure } = {}) {
  const queue = [];
  let worker, current, timer, deadline, sequence = 0, stopped = '';

  function settle(job, result, error) {
    job.signal?.removeEventListener('abort', job.abort);
    if (error) job.reject(error);
    else job.resolve(result);
  }

  function failure(reason) {
    return reason === 'cancelled' ? aborted() :
      imagePreparationError(reason === 'timeout' ? 'image_webp_timeout' : 'image_webp_failed');
  }

  function armTimer() {
    clearTimeout(timer);
    timer = setTimeout(() => stop('timeout'), Math.min(timeoutMs, Math.max(0, deadline - Date.now())));
  }

  function stop(reason) {
    if (stopped) return;
    stopped = reason;
    signal?.removeEventListener('abort', cancel);
    clearTimeout(timer);
    if (worker) {
      worker.removeEventListener('message', receive);
      worker.removeEventListener('error', workerError);
      worker.removeEventListener('messageerror', workerError);
      worker.terminate();
      worker = undefined;
    }
    const pending = current ? [current, ...queue] : [...queue];
    current = undefined;
    queue.length = 0;
    for (const job of pending) settle(job, undefined, failure(reason));
    if (reason !== 'cancelled') {
      try { onFailure?.(reason); } catch { /* Optional diagnostics cannot stop the export. */ }
    }
  }

  function cancel() { stop('cancelled'); }
  function workerError(event) { event.preventDefault(); stop('worker-error'); }

  function receive({ data }) {
    if (!current || data?.id !== current.id) return;
    if (data.progress === true) {
      armTimer();
      return;
    }
    const validOutput = data.blob instanceof Blob && data.blob.type === 'image/webp' &&
      data.blob.size > 0 && data.blob.size <= MAX_RASTER_BYTES;
    if (!data.reason && !validOutput) {
      stop('worker-error');
      return;
    }
    clearTimeout(timer);
    const job = current;
    current = undefined;
    if (data.reason) {
      settle(job, undefined, imagePreparationError(data.reason));
    } else {
      settle(job, { ...job.file, data: data.blob, mimeType: 'image/webp' });
    }
    sendNext();
  }

  function sendNext() {
    if (stopped || current || !queue.length) return;
    current = queue.shift();
    try {
      if (!worker) {
        worker = createWorker();
        worker.addEventListener('message', receive);
        worker.addEventListener('error', workerError);
        worker.addEventListener('messageerror', workerError);
      }
      deadline = Date.now() + ANIMATION_TIMEOUT_MS;
      armTimer();
      worker.postMessage({ id: current.id, blob: current.file.data, mimeType: current.file.mimeType });
    } catch {
      stop('worker-error');
    }
  }

  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  return {
    async optimize(file, { signal: jobSignal } = {}) {
      if (signal?.aborted || jobSignal?.aborted || stopped === 'cancelled') throw aborted();
      const candidate = await rasterImageCandidate(file.data, file.mimeType);
      if (signal?.aborted || jobSignal?.aborted || stopped === 'cancelled') throw aborted();
      if (!candidate) return file;
      if (stopped) throw failure(stopped);
      return new Promise((resolve, reject) => {
        const abort = () => cancel();
        jobSignal?.addEventListener('abort', abort, { once: true });
        queue.push({ id: ++sequence, file, signal: jobSignal, abort, resolve, reject });
        sendNext();
      });
    },
    close: cancel,
  };
}
