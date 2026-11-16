import { collectAssets } from '../src/ui/assets.js';
import { createProblemReportStore } from '../src/lib/problem-report-store.js';

// Local visual fixture only. Serve the exporter directory with an HTTP server.
// /test/preview.html?tab=7&scenario=ready|collecting|finished|partial|unavailable|download
// Optional: lessons=2, permission=ask|denied, files=failed, empty=1, diagnostics=1,
// overflow=1 (media preflight), badAttachment=1 (unexpected source metadata),
// largeFiles=1 (six 40 MiB files, beyond the former media/archive budgets).
// mediaResolution=fallback|observed|ambiguous (legacy image alias and synthetic CDN observations).
// pngMime=valid|corrupt|html|text (opaque PNG URL served as text/plain).
// author=retry|missing (first section needs a reload, or never returns definitions).
// reload=delayed (the old, ready document keeps replying before a full navigation).
const parameters = new URL(location.href).searchParams;
const reportStorage = {
  async get(key) { return { [key]: JSON.parse(sessionStorage.getItem(`preview:${key}`) || 'null') }; },
  async set(values) { for (const [key, value] of Object.entries(values)) sessionStorage.setItem(`preview:${key}`, JSON.stringify(value)); },
  async remove(key) { sessionStorage.removeItem(`preview:${key}`); },
};
const problemReports = createProblemReportStore({ sessionStorage: reportStorage });
const scenario = parameters.get("scenario") || "ready";
const previewTabId = Number(parameters.get("tab")) || 7;
const mediaResolution = ['fallback', 'observed', 'ambiguous'].includes(parameters.get('mediaResolution'))
  ? parameters.get('mediaResolution') : '';
const pngMime = ['valid', 'corrupt', 'html', 'text'].includes(parameters.get('pngMime')) ? parameters.get('pngMime') : '';
const pngMimeId = '4cd13f5d-6524-491f-9385-e9c5b984acf3';
const pngMimeUrl = `https://media.docstorio.com/files/Rules/${pngMimeId}`;
const resolutionImageName = '883a1997-622d-447f-8910-0a7dd7ba2040.jpg';
const resolutionSuffix = `/files/LessonExerciseImages/${resolutionImageName}`;
const resolutionUrls = {
  alias: `https://platform.desharschool.ru/lesson-editor/book/867169/lesson/101/section${resolutionSuffix}`,
  fallback: `https://media-y.progressme.ru${resolutionSuffix}`,
  observed: `https://media-a.edvibe.com${resolutionSuffix}`,
  other: `https://media-b.edvibe.com${resolutionSuffix}`,
};

const nativeFetch = window.fetch.bind(window);
const rootUrl = "https://progressme.ru/cabinet/school/materials/book/867169/content";
const materialId = "867169";
const fixedTime = "2026-10-23T10:00:00.000Z";
const lessonTitles = ["Hello, world!", "People around us", "My everyday life", "At home", "Food and drinks", "Let's travel"];
const lessonCount = parameters.get("lessons") === "2" ? 2 : 6;
const lessons = lessonTitles.slice(0, lessonCount).map((title, index) => ({ id: String(101 + index), title, key: `lesson-${101 + index}`, index }));
const sectionNames = ["Vocabulary", "Practice", "Homework"];
let position = { lesson: null, section: 0 };
let previewState = { enabled: false, snapshots: [], captures: [], warnings: [], dropped: 0 };
let mediaGranted = !["ask", "denied"].includes(parameters.get("permission"));
let sourceAvailable = scenario !== "unavailable";
let collectionOwned = false;
let collectionId = null;
let sourceDisconnected = scenario === "disconnected";
let groupsOpen = scenario !== "grouped";
let loadedLessons = groupsOpen ? lessons.length : 0;
let groupPreparations = 0;
let previewRevision = 0;
let sameSectionReloads = 0;
let documentToken = crypto.randomUUID();
const authorCase = parameters.get('author');
const authorReceived = () => !authorCase || !position.lesson || position.lesson.id !== lessons[0].id || position.section !== 0 || authorCase === 'retry' && sameSectionReloads > 0;
const calls = [];
const downloads = [];
let permissionRequests = 0;
let fileRequests = 0;
let failedFileRequests = 0;
const requestedFileUrls = [];
const requestedPermissionOrigins = [];
const checkedPermissionOrigins = [];

function inspectZip(buffer) {
  const bytes = new Uint8Array(buffer);
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const zipMagicValid = bytes.byteLength >= 4 && data.getUint32(0, true) === 0x04034b50;
  const entries = [];
  let manifest = null;
  let offset = 0;
  while (offset + 30 <= bytes.byteLength && data.getUint32(offset, true) === 0x04034b50) {
    const flags = data.getUint16(offset + 6, true);
    if (flags & 8) throw new Error("Preview ZIP reader does not support data descriptors.");
    const compressedSize = data.getUint32(offset + 18, true);
    const filenameLength = data.getUint16(offset + 26, true);
    const extraLength = data.getUint16(offset + 28, true);
    const dataOffset = offset + 30 + filenameLength + extraLength;
    if (dataOffset + compressedSize > bytes.byteLength) throw new Error("Truncated ZIP entry.");
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + filenameLength));
    entries.push(name);
    if ((mediaResolution || pngMime) && name === 'manifest.json' && data.getUint16(offset + 8, true) === 0) {
      manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(dataOffset, dataOffset + compressedSize)));
    }
    offset = dataOffset + compressedSize;
  }
  const centralDirectoryFound = offset + 4 <= bytes.byteLength && data.getUint32(offset, true) === 0x02014b50;
  return { size: bytes.byteLength, zipMagicValid, centralDirectoryFound, entryCount: entries.length, entries,
    ...(manifest ? { manifest } : {}) };
}

function renderDiagnostics() {
  if (parameters.get("diagnostics") !== "1") return;
  const output = document.getElementById("preview-diagnostics-output");
  if (!output) return;
  output.textContent = JSON.stringify({
    scenario, sourceAvailable, collectionOwned, groupPreparations, book: previewState.book || null,
    collectionStatus: previewState.collection?.status || "none",
    savedPages: previewState.snapshots.length,
    lessonsDone: (previewState.collection?.items || []).filter((item) => item.kind === "lesson" && item.status === "visited").length,
    clearCaptureCalls: calls.filter((call) => call.type === "CLEAR_CAPTURE").length,
    resetCaptureCalls: calls.filter((call) => call.type === "RESET_CAPTURE").length,
    mediaGranted, permissionRequests, fileRequests, failedFileRequests,
    ...(mediaResolution || pngMime ? { mediaResolution, pngMime, requestedFileUrls, requestedPermissionOrigins, checkedPermissionOrigins } : {}),
    summaryReads: calls.filter(call => call.type === 'GET_STATE' && call.summary).length,
    fullStateReads: calls.filter(call => call.type === 'GET_STATE' && !call.summary).length,
    rawRecordBatches: calls.filter(call => call.type === 'GET_EXPORT_RECORDS').length,
    sameSectionReloads,
    authorStatusChecks: calls.filter(call => call.type === 'GET_EXERCISE_CAPTURE_STATUS').length,
    interceptedDownloads: downloads.length,
    downloads: downloads.map(({ name, bytes, zip, error }) => ({ name, completed: Boolean(bytes), ...(zip || {}), ...(error ? { error } : {}) })),
  }, null, 2);
}

function event() {
  const listeners = new Set();
  return {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    hasListener: (listener) => listeners.has(listener),
    emit: (...args) => { for (const listener of listeners) listener(...args); },
  };
}
const messages = event();
const tabUpdates = event();
const tabRemovals = event();
const clone = (value) => structuredClone(value);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const notify = () => { previewRevision++; messages.emit({ type: "STATE_CHANGED", workspaceId: "preview-book", tabId: previewTabId }); renderDiagnostics(); };

function sectionUrl(lesson, section = 0) {
  return `https://progressme.ru/lesson-editor/book/${materialId}/lesson/${lesson.id}/${section === 2 ? "homework/" : ""}section/${Number(lesson.id) * 10 + section}`;
}

function navigation() {
  if (!position.lesson) return {
    kind: "book", title: "Starter Pack", url: rootUrl, materialId,
    ready: groupsOpen && loadedLessons === lessons.length, blocked: false, warnings: [], contentSignature: `starter-pack-${loadedLessons}-lessons`,
    readinessReason: !groupsOpen ? "Раскрываем разделы учебника." : loadedLessons < lessons.length ? `Загружаем список уроков: ${loadedLessons} из ${lessons.length}.` : "",
    items: lessons.slice(0, loadedLessons).map((lesson) => ({ kind: "lesson", key: lesson.key, title: lesson.title, active: false })),
  };
  const lesson = position.lesson;
  return {
    kind: "lesson", title: lesson.title, url: sectionUrl(lesson, position.section), materialId, lessonId: lesson.id,
    ready: true, blocked: false, warnings: [], contentSignature: `${lesson.id}-${position.section}`,
    items: sectionNames.map((title, index) => ({
      kind: index === 2 ? "homework" : "section", key: `section-${lesson.id}-${index}`, title,
      active: position.section === index,
    })),
  };
}

function assetsFor(lesson, section) {
  if (!lesson) return [];
  const types = ["jpg", "mp3", "pdf"];
  const names = ["Vocabulary cards", "Listening practice", "Homework worksheet"];
  const firstPngMimeImage = pngMime && lesson.id === lessons[0].id && section === 0;
  const firstResolutionImage = !pngMime && mediaResolution && lesson.id === lessons[0].id && section === 0;
  const assets = [{ url: firstPngMimeImage ? pngMimeUrl : firstResolutionImage ? resolutionUrls.alias : `https://preview-files.example/starter-pack/${lesson.id}-${section}.${types[section]}`,
    name: `${lesson.title} — ${names[section]}.${firstPngMimeImage ? 'png' : types[section]}`,
    kind: ["image", "audio", "file"][section], mimeType: firstPngMimeImage ? 'image/png' : ["image/jpeg", "audio/mpeg", "application/pdf"][section] }];
  if (firstResolutionImage && ['observed', 'ambiguous'].includes(mediaResolution)) {
    assets.push({ url: resolutionUrls.observed, name: 'Observed image.jpg', kind: 'image', mimeType: 'image/jpeg' });
    if (mediaResolution === 'ambiguous') assets.push({ url: resolutionUrls.other, name: 'Other observed image.jpg', kind: 'image', mimeType: 'image/jpeg' });
  }
  return assets;
}

function saveCurrentPage() {
  const nav = navigation();
  const lesson = position.lesson;
  const snapshot = {
    url: nav.url, title: lesson ? `${lesson.title} · ${sectionNames[position.section]}` : "Starter Pack",
    capturedAt: fixedTime, kind: nav.kind, pageType: nav.kind,
    route: { materialId, ...(lesson ? { lessonId: lesson.id, sectionId: String(Number(lesson.id) * 10 + position.section), kind: position.section === 2 ? "homework" : "section" } : {}) },
    text: lesson ? `${lesson.title}\n${sectionNames[position.section]}\nRead, listen and practise.` : "Starter Pack\nEnglish A1\n6 lessons",
    assets: assetsFor(lesson, position.section), warnings: [],
    links: lesson ? sectionNames.map((title, index) => ({ title, url: sectionUrl(lesson, index) })) : lessons.map((item) => ({ title: item.title, url: sectionUrl(item) })),
  };
  const previous = previewState.snapshots.findIndex((item) => item.url === nav.url);
  if (previous < 0) previewState.snapshots.push(snapshot);
  else previewState.snapshots[previous] = snapshot;
  if (!previewState.captures.some((item) => item.pageUrl === nav.url)) {
    previewState.captures.push({ kind: "fetch", url: `https://progressme.ru/api/materials/${materialId}/${lesson?.id || "content"}`,
      pageUrl: nav.url, receivedAt: fixedTime,
      data: lesson ? { lessonId: lesson.id, title: lesson.title, exercises: [{ id: `${lesson.id}-${position.section}`, type: "text", text: snapshot.text, media: snapshot.assets.map(({ url, mimeType }) => ({ url, mimeType })) }] }
        : { bookId: materialId, title: "Starter Pack", lessons: lessons.map(({ id, title }) => ({ id, title })) },
    });
  }
  return nav.url;
}

function seedResult(completedLessons, status) {
  saveCurrentPage();
  const items = lessons.map((lesson, index) => ({ key: lesson.key, kind: "lesson", title: lesson.title,
    status: index < completedLessons ? "visited" : "pending", url: sectionUrl(lesson) }));
  for (const lesson of lessons.slice(0, completedLessons)) {
    for (let section = 0; section < sectionNames.length; section++) {
      position = { lesson, section };
      const url = saveCurrentPage();
      items.push({ key: `section-${lesson.id}-${section}`, kind: section === 2 ? "homework" : "section", title: sectionNames[section], lessonId: lesson.id, status: "visited", url });
    }
  }
  position = { lesson: null, section: 0 };
  const urls = previewState.snapshots.map((item) => item.url);
  previewState.collection = {
    status, title: "Starter Pack", rootUrl, startedAt: fixedTime, finishedAt: fixedTime,
    items, expected: urls, visited: urls,
    failed: status === "failed" ? [{ url: sectionUrl(lessons[Math.min(completedLessons, lessons.length - 1)]), error: "Следующий урок не загрузился. Уже собранные материалы сохранены." }] : [],
    warnings: [],
  };
}

if (["finished", "download", "unavailable", "switched"].includes(scenario) && parameters.get("empty") !== "1") seedResult(lessons.length, "finished");
if (scenario === "partial") seedResult(Math.min(2, lessons.length), "failed");
if (parameters.get("overflow") === "1") {
  let remaining = 2001;
  for (const [index, snapshot] of previewState.snapshots.entries()) {
    const count = Math.min(300, remaining);
    snapshot.assets = Array.from({ length: count }, (_, id) => ({ url: `https://cdn.example.org/overflow-${index}-${id}.png`, name: `image-${index}-${id}.png` }));
    remaining -= count;
  }
}
if (parameters.get("badAttachment") === "1" && previewState.captures.length) {
  previewState.captures[0].data.attachment = {
    url: "https://preview-files.example/fixture-picture.png", mimeType: "image/png", name: { en: "Unexpected source filename" },
  };
}

// Reproduce a single tab reused for another textbook while old records remain.
let switchedTitle = "AEF elementary (2nd edition)";
const switchedUrl = "https://progressme.ru/cabinet/school/materials/book/857133/content";
if (scenario === "switched") {
  previewState.collection.title = "AmEF Starter";
  const controls = document.createElement("div");
  controls.id = "preview-source-controls";
  const button = document.createElement("button"); button.textContent = "Переименовать открытую книгу";
  button.addEventListener("click", () => {
    switchedTitle = "AEF elementary — updated";
    tabUpdates.emit(previewTabId, { title: switchedTitle }, { id: previewTabId, title: switchedTitle, url: switchedUrl });
  });
  controls.append(button);
  // Append after the shipping UI has been mounted below.
  window.addEventListener("preview-mounted", () => document.body.append(controls), { once: true });
}
const previewVisits = new Map();
function currentNavigation() {
  const nav = navigation();
  const current = scenario === "switched" ? { ...nav, kind: "book", title: switchedTitle, url: switchedUrl, materialId: "857133" } : nav;
  const visitKey = `${documentToken}:${current.url}`;
  if (!previewVisits.has(visitKey)) previewVisits.set(visitKey, crypto.randomUUID());
  return { ...current, documentToken,
    ...(current.kind === 'lesson' ? { sectionVisit: { token: previewVisits.get(visitKey), revision: 1, received: authorReceived(), idleMs: 5000 }, exerciseState: { loaderVisible: false } } : {}),
    ...(parameters.get('reload') === 'delayed' ? { network: { pending: 0, idleMs: 5000 } } : {}) };
}

async function sendMessage(message) {
  calls.push(clone(message));
  renderDiagnostics();
  const runMutations = ['END_COLLECTION', 'SAVE_COLLECTION', 'START_CAPTURE', 'STOP_CAPTURE', 'CLEAR_CAPTURE', 'TAKE_SNAPSHOT', 'PREPARE_BOOK', 'OPEN_MATERIAL_ITEM', 'NAVIGATE_SOURCE'];
  if (runMutations.includes(message.type) && (!collectionId || message.collectionId !== collectionId)) return { ok: false, code: 'stale_collection', error: 'Этот сбор уже остановлен.' };
  if (['TAKE_SNAPSHOT', 'PREPARE_BOOK', 'OPEN_MATERIAL_ITEM', 'NAVIGATE_SOURCE'].includes(message.type) && !message.expectedDocumentToken) return { ok: false, code: 'source_update_required', error: 'Обновите расширение и вкладку источника.' };
  if (message.expectedDocumentToken !== undefined && message.expectedDocumentToken !== documentToken) return { ok: false, code: 'source_changed', error: 'Документ исходной вкладки изменился.' };
  switch (message.type) {
    case "RESOLVE_WORKSPACE": return { ok: true, workspaceId: "preview-book", sourceTabId: previewTabId, book: { title: "Starter Pack", rootUrl } };
    case "RECORD_DOWNLOAD_RESULT": previewState.downloadResult = { loaded: message.loaded, missing: message.missing }; return { ok: true };
    case "CANCEL_COLLECTION": collectionOwned = false; collectionId = null; previewState.enabled = false;
      if (previewState.collection) previewState.collection.status = "cancelled";
      notify(); return { ok: true };

    case 'BEGIN_PROBLEM_REPORT': return { ok: true, ...await problemReports.begin(previewTabId, { ...message, ownerTabId: 17 }) };
    case 'APPEND_PROBLEM_EVENTS': return { ok: true, ...await problemReports.append(previewTabId, { ...message, ownerTabId: 17 }) };
    case 'GET_PROBLEM_REPORT': return { ok: true, ...await problemReports.get(previewTabId) };
    case "GET_STATE": {
      const state = clone(previewState);
      state.exportRevision = previewRevision;
      if (collectionOwned) state.collectionId = collectionId;
      if (message.summary) {
        state.assetInventory = collectAssets(state.snapshots, state.captures);
        state.snapshots = state.snapshots.map(({ blocks, assets, ...metadata }) => metadata);
        state.captures = state.captures.map(({ data, ...metadata }) => ({ ...metadata, data: data == null ? null : true }));
      }
      return { ok: true, state };
    }
    case "GET_EXPORT_INFO": return { ok: true, revision: previewRevision,
      snapshotCount: previewState.snapshots.length, captureCount: previewState.captures.length };
    case "GET_EXPORT_RECORDS": {
      if (message.revision !== previewRevision) return { ok: false, code: 'export_changed', error: 'Preview source changed.' };
      const records = previewState[message.kind];
      if (!Array.isArray(records)) return { ok: false, error: 'Unknown preview records.' };
      const batch = clone(records.slice(message.offset, message.offset + message.limit));
      return { ok: true, records: batch, nextOffset: message.offset + batch.length,
        total: records.length, revision: previewRevision };
    }
    case "GET_SOURCE": return sourceAvailable ? { ok: true, source: { tabId: previewTabId, title: scenario === "switched" ? "Deshar School" : "Starter Pack — ProgressMe", url: currentNavigation().url } } : { ok: false, code: "source_closed", error: "Исходная вкладка закрыта." };
    case "GET_NAVIGATION": return sourceDisconnected ? { ok: false, code: "source_disconnected", error: "Нет связи с книгой. Обновите вкладку книги и снова нажмите значок exporter." } : sourceAvailable ? { ok: true, navigation: clone(currentNavigation()) } : { ok: false, code: "source_closed", error: "Исходная вкладка закрыта." };
    case "RECONNECT_SOURCE": await delay(500); documentToken = crypto.randomUUID(); sourceDisconnected = false; notify(); return { ok: true };
    case "BEGIN_COLLECTION": collectionOwned = true; collectionId = crypto.randomUUID(); return { ok: true, collectionId };
    case "END_COLLECTION": collectionOwned = false; collectionId = null; previewState.enabled = false; notify(); return { ok: true };
    case "SAVE_COLLECTION": previewState.collection = clone(message.collection); notify(); return { ok: true };
    case "START_CAPTURE": previewState.enabled = true; notify(); return { ok: true };
    case "PREPARE_BOOK": {
      if (message.expectedUrl !== rootUrl || position.lesson) return { ok: false, error: "Страница изменилась." };
      if (!groupsOpen) {
        groupsOpen = true; groupPreparations++;
        setTimeout(() => { loadedLessons = lessons.length; notify(); }, 500);
      }
      return { ok: true, opened: groupPreparations, navigation: clone(currentNavigation()) };
    }
    case "STOP_CAPTURE": previewState.enabled = false; notify(); return { ok: true };
    case "CLEAR_CAPTURE": previewState = { enabled: false, snapshots: [], captures: [], warnings: [], dropped: 0 }; notify(); return { ok: true };
    case "RESET_CAPTURE": {
      await problemReports.clear(previewTabId);
      collectionOwned = false; collectionId = null;
      previewState = { enabled: false, snapshots: [], captures: [], warnings: [], dropped: 0, ...(message.book ? { book: clone(message.book) } : {}) };
      notify(); return { ok: true, state: { ...clone(previewState), exportRevision: previewRevision, collectionLocked: false } };
    }
    case "TAKE_SNAPSHOT": {
      if (message.expectedUrl && message.expectedUrl !== navigation().url) return { ok: false, error: "Страница изменилась." };
      const snapshotUrl = saveCurrentPage(); notify(); return { ok: true, snapshotUrl,
        ...(authorCase ? { retained: { dropped: 0, ...(position.lesson ? { authorData: authorReceived() } : {}) } } : {}) };
    }
    case 'GET_EXERCISE_CAPTURE_STATUS': return { ok: true, url: navigation().url, received: authorReceived() };
    case "NAVIGATE_SOURCE": {
      if (message.expectedUrl && message.expectedUrl !== navigation().url) return { ok: false, error: "Страница изменилась." };
      const sameSection = position.lesson && message.url === navigation().url;
      if (!sameSection && message.url !== rootUrl) return { ok: false, error: "В макете доступно содержание Starter Pack." };
      const navigatingCollectionId = collectionId;
      const commit = () => {
        if (!sourceAvailable || collectionId !== navigatingCollectionId) return;
        documentToken = crypto.randomUUID();
        if (sameSection) sameSectionReloads++;
        else {
          position = { lesson: null, section: 0 };
          if (scenario === "grouped") { groupsOpen = false; loadedLessons = 0; }
        }
        notify();
        tabUpdates.emit(previewTabId, { status: "complete", url: message.url }, { id: previewTabId, url: message.url });
      };
      if (parameters.get('reload') === 'delayed') setTimeout(commit, 2100);
      else commit();
      return { ok: true };
    }
    case "OPEN_MATERIAL_ITEM": {
      if (message.expectedUrl && message.expectedUrl !== navigation().url) return { ok: false, error: "Страница изменилась." };
      const lesson = lessons.find((item) => item.key === message.key);
      if (lesson && !position.lesson) position = { lesson, section: 0 };
      else {
        const section = navigation().items.findIndex((item) => item.key === message.key);
        if (!position.lesson || section < 0) return { ok: false, error: "Раздел не найден." };
        position.section = section;
      }
      notify(); return { ok: true };
    }
    default: return { ok: false, error: `Команда не поддержана в preview: ${message.type}` };
  }
}

Object.defineProperty(window, "chrome", { configurable: true, value: {
  runtime: { id: "local-preview", sendMessage, onMessage: messages, getManifest: () => ({ version: '0.3.25' }), getURL: (path) => new URL(`/${path}`, location.origin).href },
  permissions: {
    contains: async ({ origins = [] } = {}) => { checkedPermissionOrigins.push(...origins); return mediaGranted; },
    request: async ({ origins = [] } = {}) => {
      requestedPermissionOrigins.push(...origins);
      permissionRequests++; mediaGranted = parameters.get("permission") !== "denied"; renderDiagnostics(); return mediaGranted;
    },
  },
  tabs: {
    query: async () => sourceAvailable ? [{ id: previewTabId, title: "Starter Pack", url: currentNavigation().url }] : [],
    update: async (id, options) => {
      if (!sourceAvailable) throw new Error("Вкладка закрыта");
      if (options.url === rootUrl) { position = { lesson: null, section: 0 }; notify(); }
      return { id, url: navigation().url, ...options };
    },
    get: async (id) => { if (!sourceAvailable) throw new Error("Вкладка закрыта"); return { id, title: "Starter Pack", url: navigation().url }; },
    onUpdated: tabUpdates, onRemoved: tabRemovals,
  },
} });

// A real browser-generated JPEG keeps the resolution cases entirely synthetic and decodable.
let resolutionJpeg;
if (mediaResolution) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d');
  context.fillStyle = '#8ba1b7'; context.fillRect(0, 0, 1, 1);
  resolutionJpeg = Uint8Array.from(atob(canvas.toDataURL('image/jpeg').split(',')[1]), character => character.charCodeAt(0));
}
let pngMimeBytes;
if (pngMime) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 2;
  const context = canvas.getContext('2d');
  context.fillStyle = '#8ba1b7'; context.fillRect(0, 0, 2, 2);
  pngMimeBytes = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), character => character.charCodeAt(0));
  // IHDR consists of signature(8), length(4), type(4), data(13), CRC(4).
  // Changing only a CRC byte keeps the signature and complete chunk layout intact.
  if (pngMime === 'corrupt') pngMimeBytes[32] ^= 1;
}

// Synthetic streamed file bodies exercise progress and cancellation without network access.
window.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url, location.href);
  const resolutionFile = Boolean(mediaResolution && url.pathname.includes(resolutionImageName));
  const pngMimeFile = Boolean(pngMime && url.pathname.includes(pngMimeId));
  if (url.origin !== "https://preview-files.example" && !resolutionFile && !pngMimeFile) return nativeFetch(input, options);
  if (options.signal?.aborted) throw new DOMException("Отменено", "AbortError");
  fileRequests++;
  requestedFileUrls.push(url.href);
  const firstImage = resolutionFile || pngMimeFile || /\/101-0\.jpg$/.test(url.pathname);
  if (firstImage && ['html', 'wrongmime'].includes(parameters.get('files'))) {
    failedFileRequests++; renderDiagnostics();
    return parameters.get('files') === 'html'
      ? new Response('<!doctype html><html><body>Preview login page</body></html>', { headers: { 'content-type': 'text/html' } })
      : new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), { headers: { 'content-type': 'text/plain', 'content-length': '8' } });
  }
  if (parameters.get("files") === "failed" && (resolutionFile || pngMimeFile || /\/101-[01]\.(jpg|mp3)$/.test(url.pathname))) {
    failedFileRequests++; renderDiagnostics();
    return new Response("Preview file unavailable", { status: url.pathname.endsWith(".jpg") ? 404 : 503 });
  }
  if (pngMimeFile) {
    const expectedUrl = url.href === pngMimeUrl;
    const rejected = !expectedUrl || pngMime !== 'valid';
    if (rejected) failedFileRequests++;
    renderDiagnostics();
    const body = !expectedUrl || pngMime === 'html' ? '<!doctype html><html><body>Preview page instead of image</body></html>'
      : pngMime === 'text' ? 'https://preview-text.example/not-an-image.png' : pngMimeBytes;
    const length = typeof body === 'string' ? new TextEncoder().encode(body).byteLength : body.byteLength;
    return new Response(body, { headers: { 'content-type': 'text/plain; charset=UTF-8', 'content-length': String(length) } });
  }
  if (resolutionFile) {
    const accepted = mediaResolution === 'fallback' ? [resolutionUrls.fallback]
      : mediaResolution === 'observed' ? [resolutionUrls.observed] : [resolutionUrls.observed, resolutionUrls.other];
    if (!accepted.includes(url.href)) {
      failedFileRequests++; renderDiagnostics();
      return new Response('<!doctype html><html><body>Unresolved preview image alias</body></html>', { headers: { 'content-type': 'text/html' } });
    }
    renderDiagnostics();
    return new Response(resolutionJpeg, { headers: { 'content-type': 'image/jpeg', 'content-length': String(resolutionJpeg.byteLength) } });
  }
  renderDiagnostics();
  const mimeType = url.pathname.endsWith(".mp3") ? "audio/mpeg" : url.pathname.endsWith(".pdf") ? "application/pdf" : "image/jpeg";
  let sent = 0;
  let cancelled = false;
  const largeFiles = parameters.get('largeFiles') === '1';
  const chunkSize = largeFiles ? 1024 * 1024 : 48 * 1024;
  const chunkCount = largeFiles ? 40 : 12;
  const body = new ReadableStream({
    async pull(controller) {
      await delay(largeFiles ? 25 : 110);
      if (cancelled) return;
      if (options.signal?.aborted) { cancelled = true; controller.error(new DOMException("Отменено", "AbortError")); return; }
      if (sent === chunkCount) { controller.close(); return; }
      const chunk = new Uint8Array(chunkSize).fill(32 + sent);
      controller.enqueue(chunk); sent++;
    },
    cancel() { cancelled = true; },
  });
  return new Response(body, { status: 200, headers: { "content-type": mimeType, "content-length": String(chunkSize * chunkCount) } });
};

// Keep visual checks from downloading a synthetic archive; the blob remains inspectable.
document.addEventListener("click", (event) => {
  const anchor = event.target instanceof Element ? event.target.closest("a[download]") : null;
  if (!anchor || !anchor.href.startsWith("blob:")) return;
  event.preventDefault();
  const record = { name: anchor.download, url: anchor.href, bytes: null };
  downloads.push(record);
  renderDiagnostics();
  void nativeFetch(anchor.href).then((response) => response.arrayBuffer()).then((bytes) => {
    record.bytes = bytes; record.zip = inspectZip(bytes); renderDiagnostics();
  }).catch((error) => { record.error = error.message; renderDiagnostics(); });
}, true);

window.__exporterPreview = {
  scenario, calls, downloads, mediaResolution, resolutionUrls, pngMime, pngMimeUrl, requestedFileUrls, requestedPermissionOrigins, checkedPermissionOrigins,
  get pngMimeBytes() { return pngMimeBytes?.slice(); },
  getProblemReport: () => problemReports.get(previewTabId),
  get state() { return clone(previewState); },
  get navigation() { return clone(navigation()); },
  get collectionOwned() { return collectionOwned; },
  closeSource() { sourceAvailable = false; tabRemovals.emit(previewTabId); notify(); },
  restoreSource() { sourceAvailable = true; position = { lesson: null, section: 0 }; notify(); },
};

const markup = await nativeFetch("/exporter.html", { cache: "no-store" }).then((response) => response.text());
const page = new DOMParser().parseFromString(markup, "text/html");
document.title = `${page.title} · preview ${scenario}`;
for (const link of page.head.querySelectorAll('link[rel="stylesheet"],link[rel="icon"]')) {
  const asset = document.importNode(link, true);
  asset.href = `${link.getAttribute('href')}?preview=${Date.now()}`;
  document.head.append(asset);
}
document.body.replaceChildren(...[...page.body.childNodes].map((node) => document.importNode(node, true)));
if (parameters.get("diagnostics") === "1") {
  const diagnostics = document.createElement("section");
  diagnostics.id = "preview-diagnostics";
  diagnostics.style.cssText = "max-width:960px;margin:32px auto;padding:24px;border:1px solid #d4d4d8;background:#fff;border-radius:12px;color:#27272a";
  const heading = document.createElement("h2");
  heading.textContent = "Preview diagnostics";
  const output = document.createElement("pre");
  output.id = "preview-diagnostics-output";
  output.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.6";
  diagnostics.append(heading, output);
  document.body.append(diagnostics);
  renderDiagnostics();
}
await import(`/src/ui/help.js?preview=${Date.now()}`);
await import(`/src/ui/exporter.js?preview=${Date.now()}`);
window.dispatchEvent(new Event("preview-mounted"));

if (["collecting", "download"].includes(scenario)) {
  const id = scenario === "collecting" ? "collect-book" : "export";
  for (let attempt = 0; attempt < 50; attempt++) {
    const button = document.getElementById(id);
    if (button && !button.disabled) { button.click(); break; }
    await delay(100);
  }
}
