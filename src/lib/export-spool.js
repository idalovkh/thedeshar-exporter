const DIRECTORY = 'export-spool-v1';
const validName = name => typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,150}$/.test(name) && !name.includes('..');
const storageFailure = error => error?.name === 'AbortError' || error?.code === 'storage_error' ? error :
  Object.assign(new Error('Не удалось записать временные файлы книги. Освободите место на диске и повторите скачивание. Скачайте отчёт и пришлите нам, если ошибка повторяется.'), { code: 'storage_error', cause: error });

/** Each tab owns a private disk directory and a lock released on tab destruction. */
export async function createExportSpool({ jobId = globalThis.crypto.randomUUID(), signal,
  storage = globalThis.navigator?.storage, locks = globalThis.navigator?.locks } = {}) {
  if (!validName(jobId)) throw new Error('Недопустимый идентификатор подготовки архива.');
  if (!storage?.getDirectory) throw Object.assign(new Error('Этот браузер не поддерживает безопасную подготовку книги на диске. Откройте экспортёр в Chrome.'), { code: 'storage_unavailable' });
  signal?.throwIfAborted();
  const writers = new Set();
  let directory, parent, disposed = false, unlock;
  const check = () => { signal?.throwIfAborted(); if (disposed) throw new DOMException('Подготовка архива завершена.', 'AbortError'); };
  try {
    parent = await (await storage.getDirectory()).getDirectoryHandle(DIRECTORY, { create: true });
    if (locks?.request) {
      let acquired, rejected;
      const ready = new Promise((resolve, reject) => { acquired = resolve; rejected = reject; });
      const held = new Promise(resolve => { unlock = resolve; });
      void locks.request(`thedeshar-export-spool:${jobId}`, { mode: 'exclusive', ...(signal ? { signal } : {}) }, async () => {
        acquired(); await held;
      }).catch(rejected);
      await ready;
      // A live tab holds its directory lock. Only unowned crash leftovers may go.
      if (parent.entries) for await (const [name, entry] of parent.entries()) {
        if (name === jobId || entry.kind !== 'directory' || !validName(name)) continue;
        await locks.request(`thedeshar-export-spool:${name}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
          if (lock) try { await parent.removeEntry(name, { recursive: true }); } catch { /* Retry cleanup on the next export. */ }
        });
      }
    }
    check();
    directory = await parent.getDirectoryHandle(jobId, { create: true });
  } catch (error) { unlock?.(); throw storageFailure(error); }
  return Object.freeze({
    jobId,
    async open(name) {
      check();
      if (!validName(name)) throw new Error('Недопустимое имя временного файла.');
      let writable;
      try { writable = await (await directory.getFileHandle(name, { create: true })).createWritable(); }
      catch (error) { throw storageFailure(error); }
      const writer = {
        async write(bytes) { check(); try { await writable.write(bytes); } catch (error) { throw storageFailure(error); } },
        async close() { check(); try { await writable.close(); writers.delete(writer); } catch (error) { throw storageFailure(error); } },
        async abort() { try { await writable.abort(); } finally { writers.delete(writer); } },
      };
      writers.add(writer);
      return writer;
    },
    async file(name) {
      check();
      if (!validName(name)) throw new Error('Недопустимое имя временного файла.');
      try { return await (await directory.getFileHandle(name)).getFile(); } catch (error) { throw storageFailure(error); }
    },
    async remove(name) {
      check();
      if (!validName(name)) throw new Error('Недопустимое имя временного файла.');
      try { await directory.removeEntry(name); } catch (error) { if (error.name !== 'NotFoundError') throw storageFailure(error); }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        await Promise.allSettled([...writers].map(writer => writer.abort()));
        await parent.removeEntry(jobId, { recursive: true });
      } catch { /* The next export removes crash or cleanup leftovers under the same lock. */ }
      finally { unlock?.(); }
    },
  });
}
