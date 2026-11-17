export function cacheIndexedDB() {
  const databases = new Map();
  return { databases, open(name) {
    const request = {};
    setImmediate(() => {
      const fresh = !databases.has(name);
      if (fresh) databases.set(name, new Map());
      const stores = databases.get(name);
      request.result = {
        objectStoreNames: { contains: key => stores.has(key) },
        createObjectStore(key) { stores.set(key, new Map()); },
        close() {},
        transaction(key) {
          const transaction = {}, work = [], records = stores.get(key);
          transaction.objectStore = () => ({
            getAll() { throw Error('Whole media index reads are forbidden'); },
            openCursor() {
              const read = {}, values = [...records.entries()];
              let index = 0;
              const advance = () => {
                const item = values[index++];
                read.result = item ? { value: structuredClone(item[1]), delete: () => records.delete(item[0]), continue: () => work.push(advance) } : null;
                read.onsuccess?.();
              };
              work.push(advance); return read;
            },
            put(record) { work.push(() => records.set(record.key, structuredClone(record))); },
            delete(id) { work.push(() => records.delete(id)); },
          });
          setImmediate(() => { for (const run of work) run(); transaction.oncomplete?.(); });
          return transaction;
        },
      };
      if (fresh) request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  } };
}

export function cacheLocks() {
  let pending = Promise.resolve();
  return { request(_name, { signal }, run) {
    const next = pending.then(() => { signal?.throwIfAborted(); return run({}); });
    pending = next.catch(() => {});
    return next;
  } };
}
