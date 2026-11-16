import { MAX_ARCHIVE_BYTES } from "../lib/archive.js";
import { replacePackageAssets, assertAssetCapacity } from "../lib/package.js";
import { collectAssets, mediaOrigins } from "./assets.js";
import { downloadExportMedia } from "./export-media.js";
import { prepareDiskExport } from "./export-record-stream.js";
import { createExportSpool } from "../lib/export-spool.js";
import { writeZipFile } from "../lib/archive-stream.js";
import { createExportResources } from "../lib/export-resources.js";
import { collectBook } from "../lib/collection.js";
import { createProblemReporter, downloadProblemReport } from "./problem-report.js";
import { exportReadiness, assertExportReady } from "../lib/export-readiness.js";
import { exportFileProblems } from "../lib/export-file-problems.js";
import { confirmPartialExport } from "./partial-export-consent.js";
import { getView } from "./view.js";
import { isSourceUrl } from "../lib/state.js";
import { archiveFilename } from "../lib/download-name.js";
import { hydrateSourceOrigins } from "../lib/source-origins.js";
import { sourceConnectionView, collectionLoadingDetail, collectionFailureNotice, sourceSetupMessage } from "./source-status-view.js";
import { navigationErrorCode } from "../lib/source-navigation-errors.js";
import { navigationDiagnostic } from "../lib/navigation-diagnostics.js";
import { exporterBindingDiagnostic } from "../lib/exporter-binding-diagnostics.js";

const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map(element => [element.id, element]));
const queryTab = new URL(location.href).searchParams.get("tab");
let tabId = queryTab && /^\d+$/.test(queryTab) && Number.isSafeInteger(Number(queryTab)) && Number(queryTab) > 0 ? Number(queryTab) : null;
let workspaceId = new URL(location.href).searchParams.get("workspace");
let workspaceBook = null;
let workspaceBookKey = "";
const verifiedBooks = new Map();
let state = { enabled: false, snapshots: [], captures: [], warnings: [], dropped: 0 };
let source = null;
let sourceNavigation = null;
let assets = [];
let busy = false;
let sourceAvailable = false;
let initialized = false;
let abortController = null;
let collectionController = null;
let collectionRequestId = null;
let refreshTimer;
let refreshing = null;
let permissionDenied = false;
let mediaPermissionGranted = false;
let lastDownload = null;
let downloadProgress = null;
let selectionGeneration = 0;
let sourceRevision = 0;
let sourceDisconnected = false;
let sourceClosed = false;
let sourceStatus = null;
let collectionLoading = "";
let latestAttemptDiagnostics = null;
const problemReporter = createProblemReporter({ send: sendTo,
  extensionVersion: globalThis.chrome?.runtime?.getManifest?.()?.version,
  browserVersion: globalThis.navigator?.userAgent || "unknown",
  onChange: () => { elements["download-diagnostics"].hidden = isBusy() || !problemReporter.available(); },
});

function selectProblemReport(book = storedBook() || selectedBook()) {
  problemReporter.select({ tabId, workspaceId, book, collectionDiagnostics: currentDiagnostics() });
}

function isBusy() { return busy; }
function currentDiagnostics() { return latestAttemptDiagnostics ?? state.collection?.diagnostics; }

function showMessage(message, error = false) {
  elements.message.textContent = message;
  elements.message.classList.toggle("error", error);
  elements.message.hidden = !message;
}

async function send(type, payload = {}) {
  return sendTo(tabId, type, payload);
}
async function sendTo(selectedTabId, type, payload = {}) {
  if (selectedTabId === null && !workspaceId && type !== "RESOLVE_WORKSPACE") throw new Error("Откройте содержание книги и нажмите значок exporter.");
  let response;
  try { response = await chrome.runtime.sendMessage({ workspaceId, ...payload, type, tabId: selectedTabId }); }
  catch {
    throw new Error("Окно расширения потеряло связь. Закройте его и снова нажмите значок exporter во вкладке учебника.");
  }
  if (!response?.ok) {
    const error = new Error(response?.error || "Не удалось подключиться. Обновите расширение и вкладку с книгой.");
    error.code = response?.code;
    const networkError = navigationErrorCode(response?.networkError);
    if (networkError) error.networkError = networkError;
    const navigation = navigationDiagnostic(response?.navigation);
    if (navigation) error.navigation = navigation;
    const binding = exporterBindingDiagnostic(response?.binding);
    if (binding) error.binding = binding;
    for (const key of ["expectedUrl", "observedUrl"]) {
      const url = pageKey(response?.[key]);
      if (url) error[key] = url;
    }
    if (Number.isInteger(response?.attempt) && response.attempt >= 1 && response.attempt <= 3) error.attempt = response.attempt;
    throw error;
  }
  return response;
}

function connectionFailureEvent(error) {
  return { stage: "connection", status: "failed", reason: error.code || "connection_error",
    networkError: error.networkError, expectedUrl: error.expectedUrl, observedUrl: error.observedUrl,
    attempt: error.attempt, navigation: navigationDiagnostic(error.navigation), binding: exporterBindingDiagnostic(error.binding) };
}

function countLabel(count, one, few, many) {
  const form = new Intl.PluralRules("ru").select(count);
  return `${count} ${{ one, few, many }[form] || many}`;
}
function bookKey(value) {
  if (!isSourceUrl(value)) return "";
  const url = new URL(value), id = url.pathname.match(/\/book\/(\d+)(?:\/|$)/)?.[1];
  const supported = /^\/cabinet\/(?:school|teacher)\/materials\/book\/\d+\/content\/?$/.test(url.pathname) ||
    /^\/lesson-editor\/book\/\d+\/lesson\/\d+(?:\/section(?:\/(?:\d+|for-homework))?)?\/?$/.test(url.pathname);
  return supported && id ? `${url.origin}/book/${id}` : "";
}
function pageKey(value) {
  if (!bookKey(value)) return "";
  const url = new URL(value); return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
}
function bookContents(value) {
  return bookKey(value) && /^\/cabinet\/(?:school|teacher)\/materials\/book\/\d+\/content\/?$/.test(new URL(value).pathname);
}
function bookPair(title, rootUrl) {
  if (!bookContents(rootUrl)) return null;
  const name = typeof title === "string" ? title.trim() : "";
  return { title: name || `Учебник ${new URL(rootUrl).pathname.match(/\/book\/(\d+)/)[1]}`, rootUrl };
}
function storedBook() {
  // A title and its address always come from the same saved record.
  return bookPair(state.collection?.title, state.collection?.rootUrl) || bookPair(state.book?.title, state.book?.rootUrl) ||
    state.snapshots.map(item => bookPair(item.title, item.url)).find(Boolean) || null;
}
function selectedBook() {
  const saved = storedBook(), currentKey = bookKey(source?.url);
  if (workspaceId) return verifiedBooks.get(workspaceBookKey) || saved || workspaceBook;
  if (!currentKey) return sourceAvailable ? null : saved;
  const matchingSaved = saved && bookKey(saved.rootUrl) === currentKey ? saved : null;
  if (collectionController && matchingSaved) return matchingSaved;
  if (sourceNavigation?.kind === "book" && pageKey(sourceNavigation.url) === pageKey(source.url)) {
    return bookPair(sourceNavigation.title, sourceNavigation.url);
  }
  if (verifiedBooks.has(currentKey)) return verifiedBooks.get(currentKey);
  if (matchingSaved) return matchingSaved;
  return { title: `Учебник ${new URL(source.url).pathname.match(/\/book\/(\d+)/)[1]}`, rootUrl: bookContents(source.url) ? source.url : "" };
}
function savedBookDiffers() {
  const saved = storedBook();
  return !workspaceId && Boolean(saved && bookKey(source?.url) && bookKey(saved.rootUrl) !== bookKey(source.url));
}
function bytes(value) {
  return value < 1024 * 1024 ? `${Math.round(value / 1024)} КБ` : `${(value / 1024 / 1024).toLocaleString("ru", { maximumFractionDigits: 1 })} МБ`;
}

function renderSteps(view) {
  const stage = lastDownload || abortController || (view.hasData && !collectionController && !state.enabled) ? 3 : view.canCollect || collectionController ? 2 : 1;
  ["step-open", "step-collect", "step-download"].forEach((id, index) => {
    const step = index + 1;
    const complete = step < stage && (step !== 2 || state.collection?.status === "finished") || (step === 3 && Boolean(lastDownload));
    const element = elements[id];
    element.dataset.complete = String(complete);
    element.toggleAttribute("aria-current", step === stage && !lastDownload);
    if (element.hasAttribute("aria-current")) element.setAttribute("aria-current", "step");
    element.querySelector(".step-number").textContent = complete ? "✓" : step;
  });
}

function renderProgress(view) {
  const visible = Boolean(collectionController || downloadProgress);
  elements["work-progress"].hidden = !visible;
  if (!visible) return;
  let progress;
  if (collectionController) {
    const report = state.collection;
    const current = report?.items?.find(item => item.kind === "lesson" && item.status === "running");
    const sections = report?.items?.filter(item => item.kind !== "lesson" && item.lessonId === current?.lessonId) || [];
    progress = {
      title: "Уроки книги",
      count: view.lessonsTotal ? `${view.lessonsDone} из ${view.lessonsTotal}` : "",
      value: view.lessonsTotal ? view.lessonsDone : null,
      max: view.lessonsTotal,
      detail: collectionLoading || (view.currentLesson ? `${view.currentLesson}${sections.length ? ` · разделы ${sections.filter(item => item.status === "visited").length} из ${sections.length}` : ""}` : ""),
    };
  } else progress = downloadProgress;
  elements["progress-title"].textContent = progress.title;
  elements["progress-count"].textContent = progress.count || "";
  elements["progress-detail"].textContent = progress.detail || "";
  elements.progress.setAttribute("aria-label", progress.title);
  const percent = progress.value == null || !(progress.max > 0) ? null : Math.min(100, Math.max(0, Math.floor(progress.value / progress.max * 100)));
  elements.progress.setAttribute("aria-valuemin", "0");
  elements.progress.setAttribute("aria-valuemax", "100");
  if (percent === null) elements.progress.removeAttribute("aria-valuenow");
  else elements.progress.setAttribute("aria-valuenow", percent);
  elements["progress-percent"].hidden = percent === null;
  elements["progress-percent"].textContent = percent === null ? "" : `${percent}%`;
}

function collectionNotice(view) {
  if (busy || !view.hasData) return "";
  const report = state.collection;
  if (state.dropped) return `${state.warnings.at(-1) || "Часть исходных данных не сохранилась."} Частичный архив скачать нельзя. Соберите книгу заново.`;
  if (report?.status === "failed") return collectionFailureNotice(report);
  const readiness = exportReadiness(state);
  if (!readiness.allowed) return readiness.reason;
  if (state.warnings.length || state.snapshots.some(snapshot => snapshot.warnings?.length)) return "Некоторые материалы сохранились с ограничениями. После переноса проверьте содержимое уроков; замечания приложены к архиву.";
  if (assets.some(asset => asset.downloadUnavailable)) return "Не все файлы доступны для скачивания. Перед сохранением архива покажем список проблем и запросим ваше согласие.";
  return "";
}

function render() {
  const busy = isBusy();
  const view = getView({ state, sourceAvailable, source, collecting: Boolean(collectionController), downloading: Boolean(abortController), busy });
  if (sourceDisconnected || sourceStatus && sourceStatus.state !== "same_book" || state.collectionLocked || workspaceId && bookKey(source?.url) !== workspaceBookKey) view.canCollect = false;
  const downloaded = Boolean(lastDownload && !busy);
  const mode = downloaded ? "downloaded" : view.mode;
  const bookTitle = selectedBook()?.title || "";
  const initial = !initialized && (tabId !== null || Boolean(workspaceId));
  elements["source-name"].textContent = bookTitle || (initial ? "Подключение к книге" : sourceAvailable && bookKey(source?.url) ? "Открытая книга" : initialized ? "Книга не открыта" : "");
  elements["connection-progress"].hidden = !initial;
  elements["source-name"].setAttribute("aria-busy", String(initial));

  elements["collection-body"].setAttribute("aria-busy", String(initial || busy || Boolean(collectionController)));
  elements["pending-status"].textContent = initial ? "Подключение к книге" : collectionController ? "Сбор материалов" : abortController ? "Подготовка архива" : "";
  elements["cancel-collection"].setAttribute("aria-busy", String(Boolean(collectionController?.signal.aborted)));
  elements.cancel.setAttribute("aria-busy", String(Boolean(abortController?.signal.aborted)));
  let host = "";
  try { host = new URL(source?.url || storedBook()?.rootUrl).hostname === "progressme.ru" ? "ProgressMe" : "Учебная платформа"; } catch { /* No source yet. */ }
  elements["source-meta"].textContent = host ? `${host}${view.lessonsTotal && !savedBookDiffers() ? ` · ${countLabel(view.lessonsTotal, "урок", "урока", "уроков")}` : ""}` : initial ? "" : "Откройте книгу на учебной платформе";
  elements["capture-status"].textContent = downloaded ? lastDownload.missing ? "Архив с проблемами" : "Архив готов" : initialized || busy ? view.statusLabel : "Книга";
  elements["capture-status"].dataset.mode = mode;
  elements["collection-title"].textContent = downloaded ? lastDownload.savedAt ? "Архив сохранён" : "Архив передан браузеру" : initial ? "Сбор книги" : view.title;
  elements["collection-status"].textContent = downloaded ? !lastDownload.savedAt
    ? "Архив был передан браузеру. Проверьте его сохранение в загрузках."
    : lastDownload.missing
    ? `Архив сохранён без ${lastDownload.missing} файлов. После импорта проверьте книгу. Скачайте отчёт о проблеме и пришлите нам — поможем разобраться.`
    : `Архив сохранён в выбранный файл.${lastDownload.originalImages ? ` Изображений сохранено без сжатия: ${lastDownload.originalImages}.` : ""}` : collectionController ? "Оставьте обе вкладки открытыми и не переключайте страницы книги." : initial ? "" : view.description;

  elements["collect-book"].hidden = busy || downloaded || view.canExport || sourceDisconnected || permissionDenied || (view.hasData && !view.canCollect) || (!view.hasData && initialized && !view.canCollect);
  elements["collect-book"].disabled = !view.canCollect;
  elements["collect-book"].classList.toggle("button-primary", true);
  elements["collect-book"].classList.toggle("button-secondary", false);
  elements["collect-book"].style.order = view.hasData ? "2" : "0";
  elements["collect-label"].textContent = view.collectLabel;
  elements.export.hidden = busy || !view.canExport;
  elements.export.classList.toggle("button-primary", true);
  elements.export.classList.toggle("button-secondary", false);
  elements.export.disabled = busy || !view.canExport;
  elements["export-label"].textContent = savedBookDiffers() ? `Скачать «${storedBook().title}»` : downloaded ? "Скачать ещё раз" : "Скачать архив";
  elements["cancel-collection"].hidden = !collectionController && !state.enabled;
  elements["cancel-collection"].disabled = Boolean(collectionController?.signal.aborted) || (busy && !collectionController);
  elements["cancel-collection"].textContent = "Остановить сбор";
  elements.cancel.hidden = !abortController;
  elements.cancel.disabled = Boolean(abortController?.signal.aborted);
  elements["result-summary"].hidden = !view.hasData || busy;
  elements["result-summary"].textContent = [
    view.lessonsTotal ? countLabel(view.lessonsDone, "урок", "урока", "уроков") : null,
    countLabel(state.snapshots.length, "страница", "страницы", "страниц"),
    countLabel(lastDownload?.loaded ?? assets.length, "файл", "файла", "файлов"),
  ].filter(Boolean).join(" · ");
  const notice = savedBookDiffers() && view.hasData
    ? `Сохранены материалы книги «${storedBook().title}». Сейчас открыта «${bookTitle}». Архив содержит сохранённую книгу; новый сбор заменит её копию.`
    : collectionNotice(view);
  elements["review-notice"].hidden = !notice;
  elements["review-text"].textContent = notice;
  elements["download-diagnostics"].hidden = busy || !problemReporter.available();
  elements["action-hint"].textContent = busy
    ? collectionController ? "Можно остановить сбор: уже собранные материалы сохранятся." : "Оставьте эту вкладку открытой до сохранения архива."
    : permissionDenied ? "Разрешите доступ к файлам и повторите скачивание. Архив без файлов недоступен."
    : downloaded ? "Для следующей книги откройте её на платформе и снова нажмите значок exporter."
    : view.hasData ? !view.canExport ? exportReadiness(state).reason : assets.length ? "Изображения, аудио и видео добавим автоматически. Chrome может запросить разрешение." : "Архив ZIP сохранится на ваш компьютер."
    : view.canCollect ? "Уроки, разделы и домашние задания соберём по порядку." : tabId === null && !workspaceId ? "Для каждой книги откроется отдельная страница exporter." : "Вернитесь сюда после открытия содержания книги.";
  renderSteps(view);
  renderProgress(view);
  if (savedBookDiffers() && view.hasData && !busy) {
    elements["capture-status"].textContent = "Другая книга";
    elements["collection-title"].textContent = "Открыта другая книга";
    elements["collection-status"].textContent = `Сейчас открыта «${bookTitle}». ${view.canExport ? "Можно собрать её или скачать завершённую предыдущую книгу." : "Чтобы скачать предыдущую книгу, сначала завершите её сбор."}`;
    elements["collect-label"].textContent = "Собрать книгу";
  }
  if (workspaceId && sourceAvailable && bookKey(source?.url) && bookKey(source?.url) !== workspaceBookKey && !busy) {
    elements["collection-title"].textContent = view.canExport ? "Книга готова к скачиванию" : "Откройте выбранную книгу";
    elements["collection-status"].textContent = view.canExport ? "Эта книга сохранена — её архив можно скачать. Для новой книги откройте её на платформе и снова нажмите значок exporter." : "В исходной вкладке открыта другая книга. Для продолжения верните содержание этой книги. Новую книгу откройте через значок exporter на её странице.";
  }
  const connection = initialized && !busy ? sourceConnectionView({ sourceStatus, sourceKey: bookKey(source?.url),
    expectedKey: workspaceBookKey, closed: sourceClosed, disconnected: sourceDisconnected }) : null;
  if (connection && connection.label !== "Другая книга" && !abortController) {
    elements["capture-status"].textContent = connection.label;
    elements["capture-status"].dataset.mode = connection.mode;
    elements["collection-title"].textContent = connection.title;
    elements["collection-status"].textContent = connection.description;
    const closeHint = sourceClosed ? "Эту страницу экспортера закройте после запуска новой." : "Эту страницу экспортера закройте перед повторным запуском.";
    elements["action-hint"].textContent = sourceStatus?.state === "loading" ? "Дождитесь загрузки книги в исходной вкладке."
      : `${view.canExport ? "Собранный архив можно скачать перед закрытием. " : ""}${closeHint}`;
    elements["review-notice"].hidden = state.collection?.status !== "failed";
  }
  if (tabId === null && !workspaceId) {
    elements["source-name"].textContent = "Книга не открыта";
    elements["source-meta"].textContent = "Откройте содержание книги и нажмите значок exporter.";
  }
}

async function refresh() {
  // Source navigation can trigger several notifications at once.
  if (tabId === null && !workspaceId) return;
  const selectedTabId = tabId, generation = selectionGeneration, sourceVersion = sourceRevision, selectedWorkspaceId = workspaceId;
  const request = (type, payload = {}) => sendTo(selectedTabId, type, { ...payload, workspaceId: selectedWorkspaceId });
  if (refreshing?.tabId === selectedTabId && refreshing.generation === generation) return refreshing.promise;
  const operation = { tabId: selectedTabId, generation };
  operation.promise = (async () => {
    const response = await request("GET_STATE", { summary: true });
    const nextState = { enabled: false, snapshots: [], captures: [], warnings: [], dropped: 0, ...response.state };
    let nextSource = null, nextAvailable = false, nextNavigation = null, nextDisconnected = sourceDisconnected, nextClosed = sourceClosed;
    let connectionFailure, nextStatus = null;
    if (!busy) {
      try { nextStatus = (await request("GET_SOURCE_STATUS")).sourceStatus || null; }
      catch { /* The direct source checks still provide a compatible error. */ }
    }
    try {
      const response = await request("GET_SOURCE"); nextSource = response.source; nextAvailable = true; nextClosed = false;
      if (!busy && pageKey(nextSource.url)) {
        try {
          const response = await request("GET_NAVIGATION", { expectedUrl: nextSource.url });
          if (pageKey(response.navigation?.url) === pageKey(nextSource.url)) nextNavigation = response.navigation;
          nextDisconnected = false;
        } catch (error) {
          connectionFailure = error;
          if (error.code === "source_loading") nextStatus = { ...nextStatus, state: "loading" };
          if (["source_disconnected", "source_timeout"].includes(error.code)) nextDisconnected = nextStatus?.state !== "loading";
          if (error.code === "source_closed") { nextClosed = true; nextAvailable = false; }
          if (error.code === "source_changed") {
            const previousPage = pageKey(nextSource.url);
            nextSource = (await request("GET_SOURCE")).source;
            if (generation === selectionGeneration && pageKey(nextSource.url) !== previousPage) scheduleRefresh();
          }
        }
      }
    } catch (error) {
      connectionFailure = error;
      if (error.code === "source_closed") nextClosed = true;
      else nextStatus ||= { state: "unavailable" };
    }
    if (generation !== selectionGeneration || selectedTabId !== tabId) return;
    if (sourceVersion !== sourceRevision) { scheduleRefresh(); return; }
    state = nextState;
    if (!busy && state.downloadResult) lastDownload = state.downloadResult;
    source = nextSource; sourceAvailable = nextAvailable;
    sourceDisconnected = nextDisconnected;
    sourceClosed = nextClosed;
    sourceStatus = nextStatus;
    sourceNavigation = nextNavigation;
    if (nextNavigation?.kind === "book" && pageKey(nextNavigation.url) === pageKey(nextSource?.url)) {
      const verified = bookPair(nextNavigation.title, nextNavigation.url);
      if (verified && nextNavigation.title?.trim()) verifiedBooks.set(bookKey(verified.rootUrl), verified);
    }
    assets = state.assetInventory ?? collectAssets(state.snapshots, state.captures);
    if (!busy) {
      const origins = mediaOrigins(assets);
      try { mediaPermissionGranted = !origins.length || await chrome.permissions.contains({ origins }); }
      catch { mediaPermissionGranted = false; }
      if (generation !== selectionGeneration || selectedTabId !== tabId) return;
    }
    if (!busy) {
      selectProblemReport();
      await problemReporter.load();
      if (generation !== selectionGeneration || selectedTabId !== tabId) return;
      if (connectionFailure?.code === "source_loading") problemReporter.record({ ...connectionFailureEvent(connectionFailure), status: "waiting" });
      else if (connectionFailure && connectionFailure.code !== "source_closed") problemReporter.record(connectionFailureEvent(connectionFailure));
      else if (!connectionFailure && !initialized) {
        problemReporter.connectionRecovered();
        if (!problemReporter.available()) problemReporter.record({ stage: "connection", status: "ready" });
      }
    }
    initialized = true;
    render();
  })().catch(error => {
    if (generation === selectionGeneration && selectedTabId === tabId) {
      selectProblemReport();
      problemReporter.record(connectionFailureEvent(error));
      throw error;
    }
  });
  refreshing = operation;
  try { await operation.promise; }
  finally { if (refreshing === operation) refreshing = null; }
}

function changeSelection(selectedTabId, selectedWorkspace = null, book = null, pinnedBookKey = "") {
  workspaceId = selectedWorkspace; workspaceBook = book;
  workspaceBookKey = pinnedBookKey || bookKey(book?.rootUrl);
  problemReporter.clear();
  mediaPermissionGranted = false;
  selectionGeneration++;
  clearTimeout(refreshTimer);
  tabId = selectedTabId;
  initialized = false;
  state = { enabled: false, snapshots: [], captures: [], warnings: [], dropped: 0 };
  latestAttemptDiagnostics = null;
  source = null; sourceNavigation = null; sourceAvailable = false; assets = []; sourceDisconnected = false; sourceClosed = false;
  sourceStatus = null; collectionLoading = "";
  clearDownloadResult();
}


async function selectWorkspace(sourceTabId, requestedWorkspaceId = null) {
  const generation = selectionGeneration;
  const resolved = await sendTo(sourceTabId, "RESOLVE_WORKSPACE", { workspaceId: null, selectedWorkspaceId: requestedWorkspaceId });
  if (generation !== selectionGeneration || isBusy()) return;
  if (resolved.ownerTabId) {
    const currentTab = await chrome.tabs.getCurrent?.();
    if (generation !== selectionGeneration || isBusy()) return;
    if (currentTab?.id !== resolved.ownerTabId) { await chrome.tabs.update(resolved.ownerTabId, { active: true }); return; }
  }
  const selectedTabId = resolved.sourceTabId ?? sourceTabId, selectedWorkspaceId = resolved.workspaceId || null;
  const url = new URL(location.href);
  if (selectedTabId === null) url.searchParams.delete("tab");
  else url.searchParams.set("tab", String(selectedTabId));
  if (selectedWorkspaceId) url.searchParams.set("workspace", selectedWorkspaceId);
  else url.searchParams.delete("workspace");
  if (url.href !== location.href) { location.replace(url.href); return; }
  changeSelection(selectedTabId, selectedWorkspaceId, resolved.book || null, resolved.bookKey);
  showMessage(""); render();
  await refresh();
}
function clearDownloadResult() {
  lastDownload = null; downloadProgress = null; permissionDenied = false;
  elements["missing-files"].hidden = true;
  elements["file-results"].replaceChildren();
}

elements["cancel-collection"].addEventListener("click", async () => {
  if (collectionController && !workspaceId) { collectionController.abort(); render(); return; }
  if (workspaceId) {
    const controller = collectionController, cancelledWorkspace = workspaceId;
    controller?.abort(); render();
    try {
      await send("CANCEL_COLLECTION", { collectionId: state.collectionId, requestId: collectionRequestId });
      if (collectionController === controller) {
        problemReporter.record({ stage: "finish", status: "cancelled", reason: "cancelled" });
        collectionController = null; busy = false; selectionGeneration++; refreshing = null;
        await refresh();
        if (workspaceId === cancelledWorkspace) { showMessage("Сбор остановлен. Полученные материалы сохранены."); render(); }
      }
    } catch (error) { if (workspaceId === cancelledWorkspace) showMessage(error.message, true); }
    return;
  }
  try { await send("STOP_CAPTURE", { collectionId: state.collectionId }); await refresh(); } catch (error) { showMessage(error.message, true); }
});
elements["download-diagnostics"].addEventListener("click", async () => {
  if (isBusy() || !problemReporter.available()) return;
  try { downloadProblemReport(await problemReporter.snapshot()); }
  catch { showMessage("Не удалось скачать отчёт о проблеме.", true); }
});
async function startCollection() {
  if (isBusy() || !sourceAvailable || sourceClosed || sourceDisconnected || !bookContents(source?.url) || state.collectionLocked || workspaceId && bookKey(source?.url) !== workspaceBookKey) return;
  if ((state.snapshots.length || state.captures.length) && !confirm("Собрать книгу заново? Текущая копия в расширении будет заменена. Завершённый сбор можно сначала скачать. Исходная книга не изменится.")) return;
  busy = true;
  latestAttemptDiagnostics = null;
  const controller = new AbortController();
  collectionController = controller;
  const requestId = crypto.randomUUID();
  collectionRequestId = requestId;
  delete state.collectionId;
  const selectedTabId = tabId, generation = selectionGeneration, selectedWorkspaceId = workspaceId;
  const diagnosticBook = selectedBook();
  let diagnosticAttempt;
  const diagnosticEvents = [];
  const onDiagnostic = event => {
    if (!isCurrent()) return;
    collectionLoading = collectionLoadingDetail(event);
    renderProgress(getView({ state, sourceAvailable, source, collecting: true, downloading: false, busy }));
    if (diagnosticAttempt) diagnosticAttempt.record(event);
    else diagnosticEvents.push(event);
  };
  const isCurrent = () => generation === selectionGeneration && selectedTabId === tabId && collectionController === controller;
  const request = async (type, payload) => {
    // A cancelled collector must still be able to release its own lease.
    // The worker rejects these scoped commands once that lease was revoked.
    const cleanup = ["STOP_CAPTURE", "END_COLLECTION"].includes(type) && typeof payload?.collectionId === "string" && payload.collectionId;
    if (!isCurrent() && !cleanup) throw new DOMException("Сбор отменён.", "AbortError");
    const result = await sendTo(selectedTabId, type, { ...payload, ...(["BEGIN_COLLECTION", "GET_NAVIGATION"].includes(type) ? { requestId } : {}), workspaceId: selectedWorkspaceId });
    if (type === "BEGIN_COLLECTION" && isCurrent()) {
      state.collectionId = result.collectionId;
      selectProblemReport(diagnosticBook);
      diagnosticAttempt = await problemReporter.begin("collection");
      diagnosticEvents.splice(0).forEach(event => diagnosticAttempt.record(event));
    }
    return result;
  };
  collectionLoading = "";
  clearDownloadResult(); showMessage(""); render();
  const task = (async () => {
    try {
      let checkpointed = false;
      const extensionVersion = chrome.runtime.getManifest?.()?.version;
      const report = await collectBook({ reset: true, request, signal: controller.signal, extensionVersion, onDiagnostic, onProgress: report => {
        checkpointed = true;
        if (isCurrent()) { state.collection = report; selectProblemReport(diagnosticBook); render(); }
      } });
      if (!isCurrent()) return;
      if (!checkpointed && report.status === "failed") latestAttemptDiagnostics = report.diagnostics;
      if (!diagnosticAttempt) {
        selectProblemReport(diagnosticBook);
        diagnosticAttempt = await problemReporter.begin("connection");
        const buffered = diagnosticEvents.splice(0);
        buffered.forEach(event => diagnosticAttempt.record(event));
        if (!buffered.length && report.status === "failed") diagnosticAttempt.record({ stage: "connection", status: "failed", reason: "operation_failed" });
      }
      await diagnosticAttempt.flush();
      await refresh();
      if (isCurrent() && report.status === "failed" && (!checkpointed || !state.snapshots.length && !state.captures.length)) showMessage(collectionFailureNotice(report), true);
    } catch (error) {
      if (isCurrent()) {
        if (!diagnosticAttempt) { selectProblemReport(diagnosticBook); diagnosticAttempt = await problemReporter.begin("connection"); }
        diagnosticEvents.splice(0).forEach(event => diagnosticAttempt.record(event));
        const cancelled = controller.signal.aborted || error.name === "AbortError";
        diagnosticAttempt.record({ ...connectionFailureEvent(error), stage: "save_page", status: cancelled ? "cancelled" : "failed",
          reason: cancelled ? "cancelled" : error.code || "operation_failed" });
        await diagnosticAttempt.flush();
        if (isCurrent()) showMessage(cancelled ? "Сбор остановлен. Полученные материалы сохранены." : error.message, !cancelled);
      }
    }
    finally {
      if (isCurrent()) { collectionController = null; busy = false; render(); scheduleRefresh(); }
    }
  })();
  await task;
}
elements["collect-book"].addEventListener("click", startCollection);
let lastProgressPaint = 0;
function setDownloadProgress(progress) {
  const previous = downloadProgress;
  downloadProgress = progress;
  const now = Date.now();
  if (progress.title !== previous?.title || progress.value === progress.max || now - lastProgressPaint >= 50) {
    lastProgressPaint = now; renderProgress({});
  }
}
function renderMissingFiles(files) {
  const missing = files.filter(asset => asset.status !== "downloaded");
  elements["missing-files"].hidden = !missing.length;
  elements["file-results"].replaceChildren(...missing.slice(0, 8).map(asset => {
    const item = document.createElement("li");
    const name = document.createElement("strong"); name.textContent = asset.name;
    const reason = document.createElement("span"); reason.textContent = asset.error || "Файл недоступен для скачивания.";
    item.append(name, reason); return item;
  }));
  elements["more-files"].hidden = missing.length <= 8;
  elements["more-files"].textContent = `И ещё ${countLabel(Math.max(0, missing.length - 8), "файл", "файла", "файлов")}. Полный список сохранён в отчёте о проблеме.`;
}

async function downloadAssets(candidates, signal, maxTotalBytes, onDiagnostic, spool, resources) {
  return downloadExportMedia(candidates, {
    signal, maxTotalBytes, onDiagnostic, spool, resources,
    onWait: () => setDownloadProgress({ title: "Подготовка файлов", detail: "Ожидает подготовки файлов. Если другая книга обрабатывается, эта начнётся следом." }),
    onCodecFailure: reason => onDiagnostic?.({ stage: 'files', status: 'failed', reason: reason === 'timeout' ? 'webp_timeout' : 'webp_unavailable' }),
    hasPermission: origin => chrome.permissions.contains({ origins: [origin] }),
    onProgress: ({ completed, total, loadedBytes, active, encoding, originalImages = 0 }) => {
      if (signal.aborted) return;
      const fraction = active.reduce((sum, item) => sum + (item.total ? Math.min(item.loaded / item.total, 1) : 0), 0);
      setDownloadProgress({
        title: encoding && !active.length ? "Подготовка изображений" : "Файлы книги", count: total > 0 ? `${completed} из ${total}` : "",
        value: completed + fraction, max: total,
        detail: `${bytes(loadedBytes)} загружено${active.length ? ` · одновременно ${active.length} ${active.length === 1 ? "файл" : "файла"}` : ""}${originalImages ? ` · без сжатия: ${originalImages}` : ""}`,
      });
    },
  });
}

elements.cancel.addEventListener("click", () => { abortController?.abort(); render(); });

async function exportArchive({ selection, permission } = {}) {
  busy = true;
  const controller = new AbortController();
  abortController = controller;
  const selectedTabId = tabId, generation = selectionGeneration, selectedWorkspaceId = workspaceId;
  const saved = storedBook();
  const archivedBook = saved || workspaceBook;
  const selectedSource = archivedBook ? { ...source, title: archivedBook.title, url: archivedBook.rootUrl } : source;
  const isCurrent = () => generation === selectionGeneration && selectedTabId === tabId && abortController === controller;
  const assertCurrent = () => {
    if (!isCurrent() || controller.signal.aborted) throw new DOMException("Скачивание отменено.", "AbortError");
  };
  const request = (type, payload) => { assertCurrent(); return sendTo(selectedTabId, type, { ...payload, workspaceId: selectedWorkspaceId }); };
  const onProgress = progress => { if (isCurrent() && !controller.signal.aborted) setDownloadProgress(progress); };
  selectProblemReport(saved || selectedBook());
  let diagnosticAttempt = { record() {}, flush: async () => {} };
  // A rejected permission prompt must already have a handler while diagnostics starts.
  if (selection) void Promise.resolve(selection).catch(() => {});
  if (permission) void Promise.resolve(permission).catch(() => {});
  const diagnosticStartedAt = Date.now();
  let diagnosticStage = "permissions";
  let askedForConsent = false;
  let spool;
  let resources, resourceFailure;
  const diagnose = (stage, status, details = {}) => {
    if (isCurrent()) diagnosticAttempt.record({ stage, status, elapsedMs: Date.now() - diagnosticStartedAt, ...details });
  };
  clearDownloadResult(); showMessage("");
  downloadProgress = { title: "Файлы книги", value: null, detail: "" };
  render();
  try {
    diagnosticAttempt = await problemReporter.begin("download");
    assertCurrent();
    const selectedState = state;
    assertExportReady(selectedState);
    assertAssetCapacity(assets);
    diagnose("permissions", "started");
    if (permission) {
      const allowed = await abortablePermission(permission, controller.signal);
      assertCurrent();
      mediaPermissionGranted = allowed;
      permissionDenied = !allowed;
      diagnose("permissions", allowed ? "ready" : "failed", allowed ? {} : { reason: "permission_denied" });
      showMessage(allowed ? "Доступ к файлам разрешён. Нажмите «Скачать архив» и выберите место сохранения."
        : "Chrome не разрешил доступ к файлам книги. Нажмите «Скачать архив» и разрешите доступ.", !allowed);
      return;
    }
    let destination;
    try { destination = await abortablePermission(selection, controller.signal); }
    catch (error) {
      if (error.name === "AbortError") throw error;
      throw Object.assign(new Error("Не удалось выбрать файл ZIP. Проверьте разрешение Chrome на сохранение файлов и попробуйте ещё раз."), { code: "file_save_unavailable", cause: error });
    }
    assertCurrent();
    diagnose("permissions", "ready");
    resources = createExportResources({ signal: controller.signal, onPressure(error) { resourceFailure = error; controller.abort(); } });
    await resources.sample();
    spool = await createExportSpool({ jobId: crypto.randomUUID(), signal: controller.signal });
    diagnosticStage = "hydrate";
    diagnose("hydrate", "started");
    const disk = await prepareDiskExport(selectedState, {
      send: request, spool, signal: controller.signal, source: selectedSource || { platform: "deshar-progressme" },
      onProgress: ({ loaded, total }) => onProgress({ title: "Материалы книги", count: total > 0 ? `${loaded} из ${total}` : "", value: loaded, max: total, detail: "" }),
    });
    const exportState = disk.state;
    assertCurrent();
    assertExportReady(exportState);
    diagnose("hydrate", "finished");
    diagnosticStage = "package";
    diagnose("package", "started");
    const exportAssets = disk.assets;
    assertAssetCapacity(exportAssets);
    const prepared = disk.prepared;
    diagnose("package", "finished");
    diagnosticStage = "files";
    diagnose("files", "started", { totalFiles: exportAssets.length });
    // Bound selected media immediately; the ZIP writer checks the combined
    // size including manifest, raw records and ZIP headers before it reads bodies.
    const files = await downloadAssets(exportAssets, controller.signal, MAX_ARCHIVE_BYTES, event => {
      if (isCurrent()) diagnosticAttempt.record(event);
    }, spool, resources);
    assertCurrent();
    renderMissingFiles(files);
    const problems = exportFileProblems(files, exportAssets);
    if (problems.length) {
      diagnose("files", "waiting");
      askedForConsent = true;
      const accepted = await confirmPartialExport({ elements, signal: controller.signal,
        onReport: async () => {
          await diagnosticAttempt.flush();
          assertCurrent();
          const report = await problemReporter.snapshot();
          assertCurrent();
          if (!report) throw new Error("Отчёт недоступен.");
          downloadProblemReport(report);
        },
      });
      assertCurrent();
      if (!accepted) throw new DOMException("Скачивание отменено.", "AbortError");
    }
    diagnose("files", "finished");
    diagnosticStage = "zip";
    diagnose("zip", "started");
    setDownloadProgress({ title: "Архив ZIP", value: null, detail: "" });
    const current = await request("GET_EXPORT_INFO");
    if (current.revision !== disk.revision) throw Object.assign(new Error("Собранная книга изменилась. Повторите скачивание."), { code: "export_changed" });
    assertCurrent();
    const { entries, manifest } = replacePackageAssets(prepared, files);
    await writeZipFile(entries, destination, {
      signal: controller.signal, manifest,
      onProgress: ({ loaded, total, verifying }) => onProgress({ title: verifying ? "Проверка сохранённого ZIP" : "Архив ZIP", value: loaded, max: total, detail: `${bytes(loaded)} из ${bytes(total)}` }),
    });
    assertCurrent();
    const loaded = files.filter(asset => asset.status === "downloaded").length;
    const originalImages = files.filter(asset => asset.originalImage).length;
    lastDownload = { loaded, missing: problems.length, savedAt: new Date().toISOString(), ...(originalImages ? { originalImages } : {}) };
    if (selectedWorkspaceId) {
      try {
        const recorded = await request("RECORD_DOWNLOAD_RESULT", { revision: exportState.exportRevision, ...lastDownload });
        if (isCurrent() && Number.isSafeInteger(recorded.revision)) state.exportRevision = recorded.revision;
      }
      catch { if (isCurrent()) showMessage("ZIP сохранён. Не удалось сохранить отметку о скачивании в расширении."); }
    }
    diagnose("zip", "finished");
    diagnose("export", "finished");
  } catch (error) {
    if (resourceFailure) error = resourceFailure;
    if (!isCurrent()) return;
    diagnose(diagnosticStage, error.name === "AbortError" ? "cancelled" : "failed", { reason: error.name === "AbortError" ? "cancelled" : error.code || "export_error" });
    if (error.name === "AbortError") showMessage("Скачивание отменено. Собранные материалы сохранены — можно попробовать ещё раз.");
    else showMessage(`Не удалось подготовить архив. ${error.message}`, true);
  } finally {
    resources?.close();
    if (spool) try { await spool.dispose(); } catch { /* Orphan cleanup retries on the next export. */ }
    await diagnosticAttempt.flush();
    if (isCurrent()) {
      busy = false; abortController = null; downloadProgress = null; render();
      if (askedForConsent && !elements.export.hidden && !elements.export.disabled) elements.export.focus?.();
    }
  }
}

function abortablePermission(permission, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new DOMException("Скачивание отменено.", "AbortError")); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    Promise.resolve(permission).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
  });
}

elements.export.addEventListener("click", () => {
  if (isBusy() || (!state.snapshots.length && !state.captures.length)) return;
  // Request from the click itself: awaiting anything first loses Chrome's user gesture.
  try {
    assertExportReady(state);
    assertAssetCapacity(assets);
    const origins = mediaOrigins(assets);
    if (origins.length && !mediaPermissionGranted) {
      void exportArchive({ permission: chrome.permissions.request({ origins }) });
      return;
    }
    if (typeof globalThis.showSaveFilePicker !== "function") throw Object.assign(new Error("Для безопасного сохранения нужен Chrome с выбором файла. Обновите Chrome и попробуйте снова."), { code: "file_save_unavailable" });
    const selection = globalThis.showSaveFilePicker({ suggestedName: archiveFilename({ collection: state.collection,
      snapshots: state.snapshots, navigation: sourceNavigation }), types: [{ description: "Архив книги ZIP", accept: { "application/zip": [".zip"] } }] });
    void exportArchive({ selection });
  } catch (error) {
    selectProblemReport();
    problemReporter.record({ stage: "permissions", status: "failed", reason: error.code || "file_save_unavailable" });
    showMessage(["asset_limit", "incomplete_export", "file_save_unavailable"].includes(error.code) ? error.message
      : "Не удалось выбрать файл ZIP. Проверьте разрешения Chrome и попробуйте ещё раз.", true);
  }
});

function scheduleRefresh() {
  if (!globalThis.chrome?.runtime || tabId === null && !workspaceId) return;
  clearTimeout(refreshTimer);
  // During a tour the report arrives through onProgress; fewer summary reads
  // leave the source tab's request queue to navigation polling.
  refreshTimer = setTimeout(() => { void refresh().catch(error => showMessage(error.message, true)); }, collectionController ? 1000 : 200);
}
if (globalThis.chrome?.runtime) {
  chrome.runtime.onMessage.addListener(message => {
    if (message.type === "STATE_CHANGED" && (workspaceId ? message.workspaceId === workspaceId : message.tabId === tabId)) scheduleRefresh();
  });
  chrome.tabs.onUpdated?.addListener((updatedTabId, changeInfo, tab) => {
    if (!changeInfo.url && !changeInfo.title && !changeInfo.status) return;
    if (updatedTabId === tabId) {
      sourceRevision++;
      if (changeInfo.url) {
        const changed = bookKey(source?.url) !== bookKey(changeInfo.url);
        source = { tabId, url: changeInfo.url, title: tab?.title || "" };
        sourceAvailable = isSourceUrl(changeInfo.url);
        sourceNavigation = null;
        if (changed && !workspaceId) { latestAttemptDiagnostics = null; clearDownloadResult(); }
        render();
      }
      scheduleRefresh();
    }
  });
  chrome.tabs.onRemoved?.addListener(removedTabId => {
    if (removedTabId !== tabId) return;
    sourceRevision++;
    sourceClosed = true; sourceAvailable = false; sourceNavigation = null;
    render(); scheduleRefresh();
  });
  window.addEventListener("focus", scheduleRefresh);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleRefresh(); });
  if (tabId === null && !workspaceId) {
    initialized = true; render();
    const message = sourceSetupMessage(new URL(location.href).searchParams.get("sourceError"));
    if (message) showMessage(message, true);
  }
  else void hydrateSourceOrigins(chrome).then(() => selectWorkspace(tabId, workspaceId)).catch(error => {
    initialized = true;
    if (error.code === "source_closed") sourceClosed = true;
    else showMessage(error.message, true);
    render();
  });
} else {
  initialized = true;
  showMessage("Откройте эту страницу через установленное расширение exporter в Chrome.", true);
  render();
}
