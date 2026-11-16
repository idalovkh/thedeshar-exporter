const MIB = 1024 * 1024;
const LOW_MEMORY = 512 * MIB;
const MAX_DECODE_BUDGET = 2 * 1024 * MIB;
const aborted = () => new DOMException('Скачивание отменено.', 'AbortError');

export function exportResourceError() {
  return Object.assign(new Error('Компьютеру не хватает свободной памяти для подготовки книги. Закройте лишние приложения и повторите скачивание.'), { code: 'export_resources' });
}

/** OS readings choose admission, never promise how much native decoder memory Chrome uses. */
export function createExportResources({ signal, system = globalThis.chrome?.system,
  intervalMs = 2000, now = () => performance.now(), onPressure } = {}) {
  let available = null, capacity = null, cpu = null, previousCPU, sampling, timer, closed = false;
  let concurrency = 2, active = 0, good = 0, lastSlowWrite = -Infinity, sampledAt = -Infinity;
  const waiting = new Set();
  const wake = () => { for (const resolve of waiting) resolve(); waiting.clear(); };
  function check() {
    if (signal?.aborted || closed) throw aborted();
    if (available !== null && available < LOW_MEMORY) throw exportResourceError();
  }
  async function sample() {
    if (sampling) return sampling;
    sampling = (async () => {
      const [memory, processors] = await Promise.allSettled([
        system?.memory?.getInfo ? system.memory.getInfo() : Promise.resolve(null),
        system?.cpu?.getInfo ? system.cpu.getInfo() : Promise.resolve(null),
      ]);
      const info = memory.status === 'fulfilled' ? memory.value : null;
      available = Number.isFinite(info?.availableCapacity) && info.availableCapacity >= 0 ? info.availableCapacity : null;
      capacity = Number.isFinite(info?.capacity) && info.capacity > 0 ? info.capacity : null;
      const rows = processors.status === 'fulfilled' ? processors.value?.processors : null;
      if (Array.isArray(rows) && rows.length && rows.every(row => Number.isFinite(row.usage?.total) && Number.isFinite(row.usage?.idle))) {
        const totals = rows.reduce((sum, row) => ({ total: sum.total + row.usage.total, idle: sum.idle + row.usage.idle }), { total: 0, idle: 0 });
        if (previousCPU && totals.total > previousCPU.total) cpu = Math.max(0, Math.min(1, 1 - (totals.idle - previousCPU.idle) / (totals.total - previousCPU.total)));
        previousCPU = totals;
      } else cpu = null;
      if (available === null || capacity === null) concurrency = 1;
      else if (available < LOW_MEMORY || cpu !== null && cpu > .85) { concurrency = Math.max(1, concurrency - 1); good = 0; }
      sampledAt = now();
      if (!closed && available !== null && available < LOW_MEMORY) onPressure?.(exportResourceError());
      wake();
    })().finally(() => { sampling = null; });
    return sampling;
  }
  async function refreshIfDue() {
    if (sampling) return sampling;
    if (now() - sampledAt >= intervalMs) await sample();
  }
  const abortedWait = () => wake();
  signal?.addEventListener('abort', abortedWait, { once: true });
  async function wait() {
    check();
    await new Promise(resolve => waiting.add(resolve));
    check();
  }
  return Object.freeze({
    async sample() {
      await sample();
      if (!timer && !closed) {
        timer = setInterval(() => { void refreshIfDue(); }, intervalMs);
        timer.unref?.();
      }
      check();
      return { available, capacity, cpu, concurrency };
    },
    check,
    snapshot: () => ({ available, capacity, cpu, concurrency, active }),
    async acquireDownload() {
      await refreshIfDue();
      while (active >= concurrency) await wait();
      check(); active++;
      let released = false;
      return () => { if (!released) { released = true; active--; wake(); } };
    },
    recordWrite(milliseconds) {
      if (milliseconds > 100) { concurrency = Math.max(1, concurrency - 1); good = 0; lastSlowWrite = now(); wake(); }
    },
    recordDownload(backlog = 0) {
      if (available !== null && available >= 2 * LOW_MEMORY && (cpu === null || cpu < .7) && backlog === 0 && now() - lastSlowWrite > 5000) {
        if (++good >= 3) { concurrency = Math.min(6, concurrency + 1); good = 0; wake(); }
      } else good = 0;
    },
    async admitImage(metadata, sourceBytes) {
      await refreshIfDue(); check();
      if (available === null || capacity === null) return false;
      const pixels = Math.max(metadata.width * metadata.height, (metadata.decodeWidth || metadata.width) * (metadata.decodeHeight || metadata.height));
      const targetPixels = Math.min(pixels, 1920 * 1080);
      const frames = metadata.animated ? metadata.frameCount : 1;
      if (!Number.isSafeInteger(pixels) || !Number.isSafeInteger(frames) || frames < 1) return false;
      // Reserve four original RGBA buffers, target/verification buffers, the
      // maximum WASM heap, compressed input, and possible animation frame storage.
      const reserved = 16 * pixels + 32 * targetPixels + 384 * MIB + sourceBytes + (metadata.animated ? 4 * pixels * frames : 0);
      return Number.isSafeInteger(reserved) && reserved <= Math.min(MAX_DECODE_BUDGET, available / 4);
    },
    close() { closed = true; clearInterval(timer); signal?.removeEventListener('abort', abortedWait); wake(); },
  });
}
