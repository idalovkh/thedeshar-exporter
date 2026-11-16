import { createExportSpool } from './src/lib/export-spool.js';
import { createExportPackage, replacePackageAssets } from './src/lib/package.js';
import { writeZipFile } from './src/lib/archive-stream.js';
import { prepareDiskExport } from './src/ui/export-record-stream.js';
import { downloadDiskMedia } from './src/ui/download-disk-media.js';
import { createWorkspaceStore } from './src/lib/store.js';
import { runExportStoreChecks } from './test/export-store-checks.js';

const MIB = 1024 * 1024;
const sourceURL = 'https://progressme.ru/cabinet/school/materials/book/71/content';
const sectionURL = 'https://progressme.ru/lesson-editor/book/71/lesson/2/section/3';
let measurements;
const nativeArrayBuffer = Blob.prototype.arrayBuffer;
Blob.prototype.arrayBuffer = function () {
  if (measurements) {
    measurements.largestRead = Math.max(measurements.largestRead, this.size);
    if (this.size > MIB) {
      measurements.wholeFileReads++;
      throw Error('Acceptance forbids whole-file reads above 1 MiB');
    }
  }
  return nativeArrayBuffer.call(this);
};

function check(condition, description) {
  if (!condition) throw Error(description);
}

async function rejects(action, expected) {
  try { await action(); }
  catch (error) {
    check(!expected.code || error.code === expected.code, 'Unexpected error code: ' + error.code);
    check(!expected.name || error.name === expected.name, 'Unexpected error type: ' + error.name);
    return { name: error.name, code: error.code || null };
  }
  throw Error('Expected a rejected operation');
}

function instrumentSpool(spool) {
  return {
    ...spool,
    async open(name) {
      const writer = await spool.open(name);
      return {
        async write(bytes) {
          measurements.largestWrite = Math.max(measurements.largestWrite, bytes.byteLength || bytes.size || 0);
          measurements.writes++;
          return writer.write(bytes);
        },
        close: () => writer.close(),
        abort: () => writer.abort(),
      };
    },
  };
}

function destination(handle, settings = {}) {
  const state = { opened: 0, aborted: 0, closed: 0, writes: 0 };
  return {
    state,
    async createWritable() {
      state.opened++;
      const writable = await handle.createWritable();
      return {
        async write(bytes) {
          state.writes++;
          if (settings.failWrite && state.writes === 3) throw new DOMException('Injected disk write failure', 'QuotaExceededError');
          measurements.largestWrite = Math.max(measurements.largestWrite, bytes.byteLength || bytes.size || 0);
          return writable.write(bytes);
        },
        seek: offset => writable.seek(offset),
        async close() {
          if (settings.failClose) throw new DOMException('Injected close failure', 'UnknownError');
          await writable.close();
          state.closed++;
        },
        async abort() { state.aborted++; await writable.abort(); },
      };
    },
    async getFile() {
      if (settings.corruptReadback) {
        const writer = await handle.createWritable({ keepExistingData: true });
        await writer.write({ type: 'write', position: 0, data: new Uint8Array([0]) });
        await writer.close();
      }
      return handle.getFile();
    },
  };
}

async function readRange(file, offset, length) {
  const bytes = new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
  check(bytes.length === length, 'Truncated ZIP range');
  return bytes;
}

/** Independent ZIP structure reader; the host supplies zlib's expected media CRC. */
async function inspectZip(file, expectedMediaCRC) {
  const end = new DataView((await readRange(file, file.size - 22, 22)).buffer);
  check(end.getUint32(0, true) === 0x06054b50 && end.getUint16(20, true) === 0, 'Invalid ZIP end record');
  const count = end.getUint16(10, true);
  const centralSize = end.getUint32(12, true);
  const centralOffset = end.getUint32(16, true);
  check(centralOffset + centralSize + 22 === file.size, 'ZIP central-directory bounds differ');
  const entries = new Map();
  let cursor = centralOffset;
  for (let index = 0; index < count; index++) {
    const header = new DataView((await readRange(file, cursor, 46)).buffer);
    check(header.getUint32(0, true) === 0x02014b50 && header.getUint16(10, true) === 0, 'ZIP entry is not STORE');
    const nameLength = header.getUint16(28, true);
    const extraLength = header.getUint16(30, true);
    const commentLength = header.getUint16(32, true);
    const name = new TextDecoder().decode(await readRange(file, cursor + 46, nameLength));
    check(!entries.has(name), 'Duplicate ZIP path');
    const size = header.getUint32(24, true);
    const crc = header.getUint32(16, true);
    const offset = header.getUint32(42, true);
    const local = new DataView((await readRange(file, offset, 30)).buffer);
    check(local.getUint32(0, true) === 0x04034b50 && local.getUint16(8, true) === 0, 'Invalid local ZIP header');
    check(header.getUint32(20, true) === size && local.getUint32(18, true) === size &&
      local.getUint32(22, true) === size && local.getUint32(14, true) === crc, 'ZIP sizes/CRC headers differ');
    check(new TextDecoder().decode(await readRange(file, offset + 30, nameLength)) === name, 'ZIP names differ');
    if (expectedMediaCRC !== undefined && name.startsWith('media/')) {
      check(size === 64 * MIB && crc === expectedMediaCRC, 'Large media CRC differs from independent host zlib');
    }
    entries.set(name, { name, size, crc, body: offset + 30 + nameLength });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  check(cursor === file.size - 22, 'ZIP directory was not fully read');
  const manifestEntry = entries.get('manifest.json');
  check(manifestEntry && manifestEntry.size < MIB, 'Manifest is missing or unexpectedly large');
  const manifest = JSON.parse(new TextDecoder().decode(await readRange(file, manifestEntry.body, manifestEntry.size)));
  for (const item of [...manifest.inventory.pages, ...manifest.inventory.responses, ...manifest.inventory.assets]) {
    if (item.file) check(entries.has(item.file), 'Manifest references an absent ZIP entry: ' + item.file);
  }
  return { entries, manifest };
}

async function outputHandle(name) {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle('streaming-acceptance-output', { create: true });
  return { directory, handle: await directory.getFileHandle(name, { create: true }) };
}

function resources() {
  return { async sample() {}, check() {}, async acquireDownload() { return () => {}; },
    async admitImage() { return false; }, recordWrite() {}, recordDownload() {} };
}

async function smallCase() {
  const storeChecks = await runExportStoreChecks(indexedDB, 'streaming-store-' + crypto.randomUUID());
  const sessionValues = {};
  const store = createWorkspaceStore({ indexedDB, databaseName: 'streaming-source-' + crypto.randomUUID(),
    sessionStorage: { get: async key => ({ [key]: sessionValues[key] }), set: async next => Object.assign(sessionValues, next) } });
  const snapshots = [
    { url: sourceURL, title: 'Streaming book', blocks: [{ text: '😀'.repeat(140000) }], assets: ['https://cdn.example.org/audio-one.mp3'] },
    { url: sectionURL, title: 'Section', blocks: [{ text: 'Retained raw page' }], assets: ['https://cdn.example.org/photo.png', 'https://cdn.example.org/audio-two.mp3'] },
  ];
  const captures = [{ kind: 'websocket', pageUrl: sectionURL, url: 'wss://proxy.progressme.ru/websocket',
    receivedAt: '2026-11-15T10:00:00Z',
    data: { Class: 'GetExerciseWsController', IsSuccess: true, Method: 'LoadExercises', Value: { SectionId: 3, Items: [
      { Id: 101, Type: 27, SectionId: 3, Images: [{ Url: 'https://cdn.example.org/photo.png' }] },
      { Id: 102, Type: 4, SectionId: 3, Audios: [{ Url: 'https://cdn.example.org/audio-one.mp3' }] },
    ] } } }];
  const summary = { exportRevision: 3, warnings: [], dropped: 0,
    collection: { status: 'finished', rootUrl: sourceURL, title: 'Streaming book' },
    snapshots: snapshots.map(({ url, title }) => ({ url, title })), captures: [{ data: true }] };
  await store.updateWorkspace(7, state => ({ ...state, ...summary, snapshots, captures }));
  await store.saveExportSummary(7, summary);
  await store.releaseWorkspace(7);
  const send = async (type, payload) => {
    if (type === 'GET_EXPORT_INFO') return store.readExportMetadata(7);
    return store.readExportRecordPage(7, payload);
  };
  const rawSpool = await createExportSpool({ jobId: 'small-' + crypto.randomUUID() });
  const spool = instrumentSpool(rawSpool);
  const output = await outputHandle('small.zip');
  try {
    const prepared = await prepareDiskExport(summary, { send, spool, source: { platform: 'deshar-progressme', url: sourceURL } });
    const old = createExportPackage({ snapshots, captures, assets: prepared.assets, source: { platform: 'deshar-progressme', url: sourceURL },
      dropped: 0, warnings: [], collection: summary.collection, exportedAt: prepared.prepared.manifest.exportedAt });
    check(JSON.stringify(prepared.prepared.manifest) === JSON.stringify(old.manifest), 'Streamed inventory differs from established package');
    for (const entry of prepared.prepared.entries) {
      const before = old.entries.find(candidate => candidate.name === entry.name);
      check((entry.data instanceof Blob ? await entry.data.text() : entry.data) === before.data, 'Spooled raw record bytes changed');
    }
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg=='), character => character.charCodeAt(0));
    let requests = 0;
    const files = await downloadDiskMedia(prepared.assets, { spool, resources: resources(),
      fetchFile: async url => {
        requests++;
        return new Response(url.endsWith('.png') ? png : 'ID3same audio bytes', { headers: { 'content-type': url.endsWith('.png') ? 'image/png' : 'audio/mpeg' } });
      } });
    check(files.every(file => file.status === 'downloaded'), 'Synthetic media did not finish');
    const audioFiles = files.filter(file => file.mimeType === 'audio/mpeg');
    check(audioFiles.length === 2 && audioFiles[0].data === audioFiles[1].data, 'Content deduplication did not share a disk file');
    const originalPNG = files.find(file => file.mimeType === 'image/png');
    check(originalPNG?.originalImage, 'Resource admission did not preserve the original PNG');
    const pngBytes = new Uint8Array(await originalPNG.data.arrayBuffer());
    check(pngBytes.length === png.length && pngBytes.every((byte, index) => byte === png[index]), 'Original PNG bytes changed');
    const packaged = replacePackageAssets(prepared.prepared, files);
    const written = await writeZipFile(packaged.entries, destination(output.handle), { manifest: packaged.manifest });
    const file = await output.handle.getFile();
    const inspected = await inspectZip(file);
    check(inspected.entries.size === written.entries, 'ZIP entry count differs');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    const base64 = btoa(binary);
    const changed = await rejects(() => prepareDiskExport({ ...summary, exportRevision: 4 }, { send, spool }), { code: 'export_changed' });
    let changedDuringRead = false;
    const changingSend = async (type, payload) => {
      if (type === 'GET_EXPORT_RECORDS' && payload.kind === 'snapshots' && payload.offset === 1 && !changedDuringRead) {
        changedDuringRead = true;
        await store.updateWorkspace(7, previous => ({ ...previous, exportRevision: 4 }));
      }
      return send(type, payload);
    };
    await rejects(() => prepareDiskExport(summary, { send: changingSend, spool }), { code: 'export_changed' });
    check(changedDuringRead, 'Source revision was not changed during record paging');
    return { checks: { indexedDB: storeChecks, packageEquivalent: true, rawRecordsEquivalent: true, originalPNG: true, contentDeduplicated: true,
      sourceChanged: changed.code, sourceChangedDuringPaging: changedDuringRead },
      requests, logicalMedia: files.length, physicalMedia: [...inspected.entries.keys()].filter(name => name.startsWith('media/')).length,
      archiveBytes: written.size, archiveEntries: written.entries, base64 };
  } finally {
    await rawSpool.dispose();
    await output.directory.removeEntry('small.zip');
  }
}

async function failureCases() {
  const output = await outputHandle('fault.zip');
  const entries = [{ name: 'manifest.json', data: '{"inventory":{"pages":[],"responses":[],"assets":[]}}' },
    { name: 'media/a.mp3', data: new Blob(['ID3fault fixture']) }];
  const results = {};
  try {
    for (const [name, settings] of [['write', { failWrite: true }], ['close', { failClose: true }], ['cancel', {}], ['corrupt', { corruptReadback: true }]]) {
      const initial = await output.handle.createWritable();
      await initial.write('original destination');
      await initial.close();
      const wrapped = destination(output.handle, settings);
      const controller = new AbortController();
      const error = await rejects(() => writeZipFile(entries, wrapped, {
        signal: controller.signal,
        onProgress: event => { if (name === 'cancel' && !event.verifying) controller.abort(); },
      }), name === 'cancel' ? { name: 'AbortError' } : name === 'corrupt' ? { code: 'zip_verification' } : { code: 'zip_write' });
      if (name !== 'corrupt') {
        check(wrapped.state.aborted === 1, 'Uncommitted destination was not aborted');
        check(await (await output.handle.getFile()).text() === 'original destination', 'Failure changed the committed destination');
      }
      results[name] = { ...error, aborted: wrapped.state.aborted, committed: wrapped.state.closed };
    }
    const first = await createExportSpool({ jobId: 'live-first-' + crypto.randomUUID() });
    try {
      const writer = await first.open('keep.bin'); await writer.write(new Uint8Array([17])); await writer.close();
      const second = await createExportSpool({ jobId: 'live-second-' + crypto.randomUUID() });
      try { check((await first.file('keep.bin')).size === 1, 'Another export removed a live spool'); }
      finally { await second.dispose(); }
    } finally { await first.dispose(); }
    results.liveSpoolPreserved = true;
    const mediaSpool = await createExportSpool({ jobId: 'missing-media-' + crypto.randomUUID() });
    try {
      const candidates = Array.from({ length: 3 }, (_, index) => ({
        id: 'missing-' + index, url: 'https://cdn.example.org/missing-' + index + '.mp3', name: 'missing-' + index + '.mp3',
      }));
      const accepted = await downloadDiskMedia(candidates, { spool: mediaSpool, resources: resources(),
        fetchFile: async url => url.endsWith('0.mp3')
          ? new Response('ID3audio', { headers: { 'content-type': 'audio/mpeg' } })
          : new Response('Forbidden', { status: 403 }) });
      check(accepted.filter(file => file.status === 'failed').length === 2, 'Two missing files were not handled as a bounded partial result');
      results.twoMissingAllowed = true;
      results.threeMissingRefused = await rejects(() => downloadDiskMedia(candidates, {
        spool: mediaSpool, resources: resources(), fetchFile: async () => new Response('Forbidden', { status: 403 }),
      }), { code: 'incomplete_export' });
    } finally { await mediaSpool.dispose(); }
    return results;
  } finally { await output.directory.removeEntry('fault.zip'); }
}

async function largeCase(count, expectedCRC) {
  check(count === 16 || count === 59, 'Unexpected large archive size');
  const rawSpool = await createExportSpool({ jobId: 'large-' + count + '-' + crypto.randomUUID() });
  const spool = instrumentSpool(rawSpool);
  const output = await outputHandle('large-' + count + '.zip');
  try {
    globalThis.streamingAcceptance.phase = 'source';
    const writer = await spool.open('source.mp3');
    const chunk = new Uint8Array(MIB).fill(17);
    chunk.set([73, 68, 51]);
    for (let index = 0; index < 64; index++) {
      await writer.write(chunk);
      if (index === 0) chunk.fill(17);
    }
    await writer.close();
    const source = await spool.file('source.mp3');
    check(source.size === 64 * MIB, 'Large source size differs');
    const assets = Array.from({ length: count }, (_, index) => ({
      id: 'asset-' + index, url: 'https://cdn.example.org/large-' + index + '.mp3',
      name: 'large-' + index + '.mp3', mimeType: 'audio/mpeg', status: 'downloaded', data: source,
    }));
    const prepared = createExportPackage({ snapshots: [{ url: sourceURL, title: 'Synthetic large book', blocks: [{ text: 'Streaming archive test' }] }],
      captures: [], assets, source: { platform: 'deshar-progressme', url: sourceURL }, warnings: [] });
    const started = performance.now();
    const wrapped = destination(output.handle);
    const written = await writeZipFile(prepared.entries, wrapped, { manifest: prepared.manifest, onProgress(event) {
      Object.assign(globalThis.streamingAcceptance, { phase: event.verifying ? 'verify' : 'write', bytes: event.loaded, total: event.total });
    } });
    const file = await output.handle.getFile();
    globalThis.streamingAcceptance.phase = 'inspect';
    const inspected = await inspectZip(file, expectedCRC);
    const media = [...inspected.entries.values()].filter(entry => entry.name.startsWith('media/'));
    check(media.length === count, 'Large ZIP lost media entries');
    check(file.size < 4_000_000_000, 'Large ZIP crossed the supported archive limit');
    let sizeLimitRejected = null;
    if (count === 59) {
      let opened = false;
      const tooLarge = [...prepared.entries, { name: 'media/overflow.mp3', data: source }];
      sizeLimitRejected = await rejects(() => writeZipFile(tooLarge, {
        async createWritable() { opened = true; throw Error('Must fail before opening'); },
        async getFile() { throw Error('Must fail before reading'); },
      }), { code: 'archive_limit' });
      check(!opened, 'Archive limit was checked after opening the destination');
    }
    return { archiveBytes: written.size, mediaBytes: count * 64 * MIB, mediaFiles: count, archiveEntries: written.entries,
      independentMediaCRC: expectedCRC, sourceBytesOnDisk: source.size, repeatedSyntheticSource: true,
      elapsedMs: Math.round(performance.now() - started), sizeLimitRejected };
  } finally {
    await rawSpool.dispose();
    await output.directory.removeEntry('large-' + count + '.zip');
  }
}

globalThis.streamingAcceptance = { ready: true, running: false };
globalThis.startStreamingAcceptance = function (kind, expectedCRC) {
  check(!globalThis.streamingAcceptance.running, 'A previous acceptance case is still running');
  measurements = { largestRead: 0, largestWrite: 0, wholeFileReads: 0, writes: 0 };
  globalThis.streamingAcceptance = { ready: true, running: true, kind, phase: 'starting' };
  void (async () => {
    try {
      const result = kind === 'small' ? await smallCase() : kind === 'failures' ? await failureCases() : await largeCase(kind, expectedCRC);
      check(measurements.largestWrite <= MIB && measurements.largestRead <= MIB && measurements.wholeFileReads === 0, 'Application I/O buffers exceeded 1 MiB');
      globalThis.streamingAcceptance = { ready: true, running: false, done: true, kind, result, measurements };
    } catch (error) {
      globalThis.streamingAcceptance = { ready: true, running: false, done: true, kind, error: { message: error.message, stack: error.stack, code: error.code, name: error.name }, measurements };
    }
  })();
};
