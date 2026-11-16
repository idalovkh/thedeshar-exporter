// Install the replay-only source before loading the unchanged production UI.
import { collectAssets } from './src/ui/assets.js';
import { buildMediaRequestUrls } from './src/lib/media-request-urls.js';

const nativeFetch = globalThis.fetch.bind(globalThis);
const runtime = chrome.runtime;
const mediaBase = new URL(location.href).searchParams.get('mediaBase');
const fixture = await nativeFetch(runtime.getURL('replay.json')).then(response => response.json());
const assets = collectAssets(fixture.snapshots, fixture.captures);
const requests = buildMediaRequestUrls(assets);
const fixtureAssets = new Map(fixture.assets.map((asset, index) => [asset.url, { asset, index }]));
const files = new Map();
for (const asset of assets) {
  const request = requests.get(asset.url);
  const replay = fixtureAssets.get(asset.url);
  if (!replay || request?.reason || asset.downloadUnavailable) throw new Error(`Unreplayable media at ${asset.id}`);
  const url = request?.url || asset.url;
  const existing = files.get(url);
  if (existing && (existing.asset.sha256 !== replay.asset.sha256 || existing.asset.mimeType !== replay.asset.mimeType)) {
    throw new Error('Replay URLs resolve to differing content');
  }
  files.set(url, replay);
}
if (assets.length !== fixture.assets.length) throw new Error('Media inventory changed since the capture');

const noop = () => {};
const event = { addListener: noop, removeListener: noop };
const revision = 1;
const source = { ...fixture.source, url: fixture.collection.rootUrl, tabId: 7 };
const summary = { enabled: false, exportRevision: revision, collection: fixture.collection,
  warnings: fixture.warnings, dropped: fixture.dropped, assetInventory: assets,
  snapshots: fixture.snapshots.map(({ blocks, assets, ...metadata }) => metadata),
  captures: fixture.captures.map(({ data, ...metadata }) => ({ ...metadata, data: data == null ? null : true })),
};
const telemetry = { mediaRequests: 0, downloadedBytes: 0, messageKinds: {}, codecFailures: 0 };
async function sendMessage(message) {
  telemetry.messageKinds[message.type] = (telemetry.messageKinds[message.type] || 0) + 1;
  switch (message.type) {
    case 'GET_STATE': return { ok: true, state: structuredClone(summary) };
    case 'GET_SOURCE': return { ok: true, source };
    case 'GET_NAVIGATION': return { ok: true, navigation: { kind: 'book', url: source.url, title: source.title, ready: true } };
    case 'GET_EXPORT_INFO': return { ok: true, revision, snapshotCount: fixture.snapshots.length, captureCount: fixture.captures.length };
    case 'GET_EXPORT_RECORDS': {
      if (message.revision !== revision) throw new Error('Unexpected capture revision');
      const records = fixture[message.kind];
      const nextOffset = Math.min(records.length, message.offset + message.limit);
      return { ok: true, revision, records: structuredClone(records.slice(message.offset, nextOffset)), nextOffset, total: records.length };
    }
    case 'GET_PROBLEM_REPORT': return { ok: true };
    case 'BEGIN_PROBLEM_REPORT': return { ok: true, reportId: 'replay-report', attemptId: 'replay-attempt' };
    case 'APPEND_PROBLEM_EVENTS': {
      telemetry.lastEvents = message.events.slice(-4).map(({stage,status,reason}) => ({stage,status,reason}));
      telemetry.codecFailures += message.events.filter(event => event.reason?.startsWith('codec_') || event.reason?.startsWith('webp_')).length;
      return { ok: true };
    }
    default: throw new Error(`Unsupported replay message ${message.type}`);
  }
}
Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
  runtime: { id: runtime.id, getURL: runtime.getURL.bind(runtime), getManifest: runtime.getManifest.bind(runtime), sendMessage, onMessage: event },
  permissions: { contains: async () => true, request: async () => true },
  tabs: { onUpdated: event },
} });

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (url.origin === location.origin) return nativeFetch(input, options);
  const replay = files.get(url.href);
  if (!replay) throw new Error('Replay refused a non-fixture URL');
  const { asset, index } = replay;
  const response = await nativeFetch(`${mediaBase}/${index}.bin`, { signal: options.signal, cache: 'no-store' });
  if (!response.ok) throw new Error('Missing local replay fixture');
  telemetry.mediaRequests++;
  telemetry.downloadedBytes += asset.size;
  return new Response(response.body, { headers: { 'content-type': asset.mimeType || 'application/octet-stream', 'content-length': String(asset.size) } });
};

const originalSlice = Blob.prototype.slice;
const originalArrayBuffer = Blob.prototype.arrayBuffer;
const origins = new WeakMap();
Blob.prototype.slice = function(...args) {
  const sub = originalSlice.apply(this, args);
  origins.set(sub, [this.size, args[0], args[1]]);
  return sub;
};
Blob.prototype.arrayBuffer = function() {
  return originalArrayBuffer.call(this).catch(error => {
    telemetry.blobReadError = { name: error.name, size: this.size, slice: origins.get(this) };
    throw error;
  });
};
const createObjectURL = URL.createObjectURL.bind(URL);
URL.createObjectURL = blob => {
  const url = createObjectURL(blob);
  if (blob.type === 'application/zip') telemetry.zip = { size: blob.size, readyMs: performance.now() - telemetry.started };
  return url;
};
globalThis.__replay = telemetry;
await import('./src/ui/help.js');
await import('./src/ui/exporter.js');
