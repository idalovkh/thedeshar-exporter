export function memoryOPFS({ failWrites = false } = {}) {
  const stats = { largestWrite: 0, writes: 0, wholeReads: 0, directories: new Map() };
  class DiskFile extends Blob {
    async arrayBuffer() { stats.wholeReads++; throw Error('Whole file reads are forbidden'); }
  }
  function directory() {
    const entries = new Map();
    return { kind: 'directory', entries: async function* () { yield* entries; },
      async getDirectoryHandle(name, { create } = {}) {
        if (!entries.has(name)) { if (!create) throw new DOMException('Missing directory', 'NotFoundError'); entries.set(name, directory()); }
        return entries.get(name);
      },
      async getFileHandle(name, { create } = {}) {
        if (!entries.has(name)) { if (!create) throw new DOMException('Missing file', 'NotFoundError'); entries.set(name, { kind: 'file', value: new DiskFile() }); }
        const item = entries.get(name);
        return { async getFile() { return item.value; }, async createWritable() {
          let parts = [], stopped = false;
          return { async write(bytes) {
            if (failWrites) throw new DOMException('Disk full', 'QuotaExceededError');
            if (stopped) throw Error('Closed');
            stats.largestWrite = Math.max(stats.largestWrite, bytes.byteLength || bytes.size || 0); stats.writes++; parts.push(bytes);
          }, async close() { item.value = new DiskFile(parts); parts = []; stopped = true; }, async abort() { parts = []; stopped = true; } };
        } };
      },
      async removeEntry(name) { if (!entries.delete(name)) throw new DOMException('Missing entry', 'NotFoundError'); },
      _entries: entries,
    };
  }
  const root = directory();
  return { stats, root, storage: { getDirectory: async () => root } };
}

export function testResources({ admit = true } = {}) {
  let active = 0;
  return { async sample() {}, check() {}, async acquireDownload() { active++; return () => active--; },
    async admitImage() { return admit; }, recordWrite() {}, recordDownload() {}, close() {}, get active() { return active; } };
}
