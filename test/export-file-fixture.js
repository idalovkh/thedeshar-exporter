/** Small in-memory file-system fixture; production always uses disk handles. */
export function memoryExportSpool() {
  const files = new Map();
  return {
    async open(name) { const parts = []; return {
      async write(block) { parts.push(block); },
      async close() { files.set(name, new Blob(parts)); },
      async abort() { files.delete(name); },
    }; },
    async file(name) { if (!files.has(name)) throw Error('Missing temporary file'); return files.get(name); },
    async remove(name) { files.delete(name); },
    async dispose() { files.clear(); },
  };
}

export function memorySavePicker(downloads) {
  return async options => {
    let bytes = new Uint8Array(), position = 0;
    return {
      async createWritable() { return {
        async write(block) {
          const input = new Uint8Array(block);
          if (position + input.length > bytes.length) { const next = new Uint8Array(position + input.length); next.set(bytes); bytes = next; }
          bytes.set(input, position); position += input.length;
        },
        async seek(next) { position = next; },
        async close() { downloads.push({ download: options.suggestedName, href: URL.createObjectURL(new Blob([bytes])) }); },
        async abort() { bytes = new Uint8Array(); },
      }; },
      async getFile() { return new Blob([bytes]); },
    };
  };
}
