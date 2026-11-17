import { classifyMaterialPayload, sanitizeUrl } from './security.js';
import { isTrustedSourceOrigin } from './source-origins.js';

// Keep each record small enough for a bounded Chrome runtime message. The
// exporter retrieves the complete workspace in pages instead of one message.
export const LIMITS = Object.freeze({ captures: 6997, snapshots: 1000, bytes: 256 * 1024 * 1024, eventBytes: 8 * 1024 * 1024 });
const encoder = new TextEncoder();
const recordSizes = new WeakMap();
const arraySizes = new WeakMap();
const captureIndexes = new WeakMap();

export function isSourceUrl(value) {
  try {
    const url = new URL(value);
    return isTrustedSourceOrigin(url.origin) && !url.username && !url.password &&
      (/^\/cabinet\/(?:school|teacher)\/materials(?:\/|$)/.test(url.pathname) || /^\/lesson-editor\//.test(url.pathname));
  } catch { return false; }
}

export function createWorkspace(tabId) {
  return { id: tabId, snapshots: [], captures: [], warnings: [], dropped: 0, bytes: 0, updatedAt: new Date().toISOString() };
}

function bytesOf(value) { return encoder.encode(JSON.stringify(value)).length; }
function sizeOf(record) {
  if (!recordSizes.has(record)) recordSizes.set(record, bytesOf(record));
  return recordSizes.get(record);
}
function sizeOfArray(records) {
  let cached = arraySizes.get(records);
  if (!cached || cached.length !== records.length) {
    cached = { length: records.length, total: records.reduce((sum, record) => sum + sizeOf(record), 0) };
    arraySizes.set(records, cached);
  }
  return cached.total + Math.max(0, records.length - 1);
}
function workspaceBytes(snapshots, captures) {
  return bytesOf({ snapshots: [], captures: [] }) + sizeOfArray(snapshots) + sizeOfArray(captures);
}
function signatureOf(event) { return JSON.stringify([event.kind, event.url, event.pageUrl, event.data]); }
function signatureHash(signature) {
  let hash = 2166136261;
  for (let index = 0; index < signature.length; index++) hash = Math.imul(hash ^ signature.charCodeAt(index), 16777619) >>> 0;
  return `${signature.length}:${hash}`;
}
function captureIndex(records) {
  let index = captureIndexes.get(records);
  if (!index || index.count !== records.length) {
    index = { count: records.length, hashes: new Map() };
    records.forEach((record, position) => {
      const hash = signatureHash(signatureOf(record));
      if (!index.hashes.has(hash)) index.hashes.set(hash, []);
      index.hashes.get(hash).push(position);
    });
    captureIndexes.set(records, index);
  }
  return index;
}

function warning(state, text) {
  if (!state.warnings.includes(text)) state.warnings.push(text);
}

function updateMetadata(state) {
  state.bytes = workspaceBytes(state.snapshots, state.captures);
  state.updatedAt = new Date().toISOString();
  return { ...state };
}

function rejectIncoming(state, message) {
  state.dropped++;
  warning(state, message);
  return updateMetadata(state);
}

export function exceedsWorkspaceCapacity({ snapshotCount, captureCount, bytes }) {
  return snapshotCount > LIMITS.snapshots || captureCount > LIMITS.captures || bytes > LIMITS.bytes;
}

function retainIfWithinLimits(state, snapshots, captures) {
  const bytes = workspaceBytes(snapshots, captures);
  if (exceedsWorkspaceCapacity({ snapshotCount: snapshots.length, captureCount: captures.length, bytes })) {
    return rejectIncoming(state, 'Достигнут лимит локального сбора: новая запись не сохранена. Ранее собранные данные сохранены. Скачайте архив и начните следующий набор.');
  }
  state.snapshots = snapshots;
  state.captures = captures;
  state.bytes = bytes;
  state.contentRevision = (state.contentRevision || 0) + 1;
  state.updatedAt = new Date().toISOString();
  return { ...state };
}

export function appendCapture(state, incoming) {
  if (!incoming || !['fetch', 'xhr', 'websocket'].includes(incoming.kind) || incoming.data == null) return state;
  if (incoming.pageUrl !== undefined && !isSourceUrl(incoming.pageUrl)) return state;
  if (!classifyMaterialPayload(incoming)) return state;
  if (bytesOf(incoming) > LIMITS.eventBytes) {
    return rejectIncoming(state, 'Один из ответов превышает 8 МБ и пропущен. Ранее собранные данные сохранены.');
  }
  const event = { kind: incoming.kind, url: sanitizeUrl(incoming.url),
    ...(incoming.pageUrl !== undefined ? { pageUrl: sanitizeUrl(incoming.pageUrl) } : {}),
    receivedAt: incoming.receivedAt, data: incoming.data };
  // Compare full source data, rather than relying on a collision-prone hash.
  const signature = signatureOf(event), hash = signatureHash(signature);
  const index = captureIndex(state.captures);
  if (index.hashes.get(hash)?.some(position => signatureOf(state.captures[position]) === signature)) return state;
  const captures = [...state.captures, event];
  arraySizes.set(captures, { length: captures.length, total: sizeOfArray(state.captures) - Math.max(0, state.captures.length - 1) + sizeOf(event) });
  const retained = retainIfWithinLimits(state, state.snapshots, captures);
  if (retained.captures === captures) {
    if (!index.hashes.has(hash)) index.hashes.set(hash, []);
    index.hashes.get(hash).push(captures.length - 1); index.count = captures.length;
    captureIndexes.set(captures, index);
  }
  return retained;
}

export function appendSnapshot(state, incoming) {
  if (!incoming || !isSourceUrl(incoming.url)) throw new Error('Откройте материал или редактор урока на учебной платформе.');
  if (bytesOf(incoming) > LIMITS.eventBytes) {
    return rejectIncoming(state, 'Снимок превышает 8 МБ и пропущен. Ранее собранные данные сохранены. Откройте меньший раздел урока.');
  }
  const snapshot = { ...incoming };
  snapshot.url = sanitizeUrl(incoming.url);
  const existing = state.snapshots.findIndex(page => page.url === snapshot.url);
  const snapshots = [...state.snapshots];
  const total = sizeOfArray(state.snapshots) - Math.max(0, state.snapshots.length - 1) + sizeOf(snapshot) - (existing >= 0 ? sizeOf(state.snapshots[existing]) : 0);
  if (existing >= 0) snapshots[existing] = snapshot;
  else snapshots.push(snapshot);
  arraySizes.set(snapshots, { length: snapshots.length, total });
  const retained = retainIfWithinLimits(state, snapshots, state.captures);
  if (retained.snapshots === snapshots) retained.snapshotRevision = (state.snapshotRevision || 0) + 1;
  return retained;
}
