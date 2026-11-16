import { sanitizeUrl } from "./security.js";
import { isTrustedSourceOrigin } from './source-origins.js';

const CAPTURE_KINDS = new Set(["fetch", "xhr", "websocket"]);

function reference(value) {
  if (typeof value === "string") return value;
  return value?.url || value?.href || value?.sourceUrl || value?.pageUrl || "";
}

function routeFor(value, base) {
  const cleaned = sanitizeUrl(reference(value), base);
  if (!cleaned) return null;
  let url;
  try { url = new URL(cleaned, base); } catch { return null; }
  if (url.protocol !== "https:" || !isTrustedSourceOrigin(url.origin) ||
      !/^\/(?:cabinet\/(?:school|teacher)\/materials(?:\/|$)|lesson-editor(?:\/|$))/.test(url.pathname)) return null;
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  // Wordwall iframe markup in a relative href can resolve under the current lesson URL.
  if (/\/%3ciframe\b/i.test(url.pathname)) return null;
  url.searchParams.sort();
  const materialId = url.pathname.match(/\/book\/([^/]+)/)?.[1] || null;
  const lessonId = url.pathname.match(/\/lesson\/([^/]+)/)?.[1] || null;
  const sectionId = url.pathname.match(/\/section\/([^/]+)/)?.[1] || null;
  const hint = typeof value === "object" && value ? value.route || value : {};
  const homework = hint.kind === "homework" || hint.sectionKind === "homework" || hint.section_kind === "homework" ||
    /(?:^|\/)(?:homework|for-homework)(?:\/|$)/i.test(url.pathname) ||
    [...url.searchParams].some(([key, item]) => /^(?:type|kind|tab|section|section_type|sectionType|mode)$/i.test(key) && item.toLowerCase() === "homework");
  return {
    url: url.href,
    kind: homework ? "homework" : sectionId ? "section" : lessonId ? "lesson" : materialId ? "material" : "library",
    materialId, lessonId, sectionId,
  };
}

function collectionList(collection, name) {
  const value = collection?.[name];
  return Array.isArray(value) ? value : [];
}

/**
 * Describe the evidence retained in a raw capture, not native exercise compatibility.
 * collection accepts rootUrl and expected/visited/failed arrays of URLs or {url} records.
 * A JSON response is associated only through its explicit pageUrl, never its API URL.
 */
export function buildCoverage({ snapshots = [], captures = [], dropped = 0, collection = null } = {}) {
  if (!Array.isArray(snapshots) || !Array.isArray(captures)) throw new TypeError("Снимки и ответы должны быть массивами");
  const base = collection?.rootUrl || collection?.sourceUrl || snapshots.find((snapshot) => reference(snapshot))?.url;
  const found = new Map();
  function add(value, relativeTo = base) {
    const route = routeFor(value, relativeTo);
    if (!route) return null;
    let item = found.get(route.url);
    if (!item) {
      item = { ...route, listed: false, captured: false, visited: false, failed: false, snapshotCount: 0, jsonCount: 0, requiresSnapshot: true, warnings: [] };
      found.set(route.url, item);
    } else if (route.kind === "homework") item.kind = "homework";
    return item;
  }
  for (const snapshot of snapshots) {
    const item = add(snapshot);
    if (!item) continue;
    item.snapshotCount++;
    item.captured = true;
    item.visited = true;
    for (const name of ["links", "materialLinks"]) {
      for (const link of Array.isArray(snapshot[name]) ? snapshot[name] : []) {
        const target = add(link, item.url);
        if (target) target.listed = true;
      }
    }
  }
  if (collection?.rootUrl) {
    const root = add(collection.rootUrl);
    if (root) root.listed = true;
  }
  for (const [name, field] of [["expected", "listed"], ["visited", "visited"], ["failed", "failed"]]) {
    for (const value of collectionList(collection, name)) {
      const item = add(value);
      if (item) item[field] = true;
    }
  }
  let jsonResponses = 0;
  let associatedJsonResponses = 0;
  for (const capture of captures) {
    if (!CAPTURE_KINDS.has(capture?.kind) || capture.data == null) continue;
    jsonResponses++;
    const item = capture.pageUrl ? add(capture.pageUrl) : null;
    if (!item) continue;
    item.jsonCount++;
    associatedJsonResponses++;
  }
  const routes = [...found.values()].sort((a, b) => a.url.localeCompare(b.url));
  // ProgressMe first opens /lesson/:id/section, receives lesson metadata, then
  // redirects to a concrete section. That wrapper has no separate lesson body.
  // Retain its actual URL and JSON association without inventing a snapshot.
  const sectionsByLesson = new Map();
  for (const route of routes) {
    const url = new URL(route.url);
    if (!route.captured || url.search || !/^\/lesson-editor\/book\/\d+\/lesson\/\d+\/section\/(?:\d+|for-homework)$/.test(url.pathname)) continue;
    const key = `${url.origin}/${route.materialId}/${route.lessonId}`;
    if (!sectionsByLesson.has(key)) sectionsByLesson.set(key, []);
    sectionsByLesson.get(key).push(route.url);
  }
  for (const route of routes) {
    const url = new URL(route.url);
    if (route.captured || route.failed || url.search || !/^\/lesson-editor\/book\/\d+\/lesson\/\d+(?:\/section)?$/.test(url.pathname)) continue;
    const retained = sectionsByLesson.get(`${url.origin}/${route.materialId}/${route.lessonId}`);
    if (retained?.length) {
      route.requiresSnapshot = false;
      route.resolvedBy = [...retained];
    }
  }
  for (const route of routes) {
    if (!route.captured && route.requiresSnapshot) route.warnings.push("Снимок этой страницы отсутствует в архиве.");
    if (!route.jsonCount) route.warnings.push("Нет JSON-ответов, связанных с этой страницей; полнота упражнений и ответов не подтверждена.");
    if (route.failed) route.warnings.push("При обходе этой страницы зарегистрирована ошибка.");
  }
  const count = (predicate) => routes.filter(predicate).length;
  const navigationItems = Array.isArray(collection?.items) ? collection.items.filter((item) => item && typeof item === "object") : [];
  const counts = {
    routes: routes.length,
    listedRoutes: count((route) => route.listed),
    capturedRoutes: count((route) => route.captured),
    missingRoutes: count((route) => !route.captured && route.requiresSnapshot),
    resolvedRoutes: count((route) => !route.requiresSnapshot),
    visitedRoutes: count((route) => route.visited),
    failedRoutes: count((route) => route.failed),
    jsonResponses,
    associatedJsonResponses,
    unassociatedJsonResponses: jsonResponses - associatedJsonResponses,
    routesWithJson: count((route) => route.jsonCount > 0),
    routesWithoutJson: count((route) => route.jsonCount === 0),
    navigationItems: navigationItems.length,
    unvisitedItems: navigationItems.filter((item) => item.status !== "visited").length,
    droppedRecords: Number.isSafeInteger(dropped) && dropped > 0 ? dropped : 0,
  };
  const warnings = [
    "Проверены только обнаруженные ссылки и сохранённые страницы; полный состав материала, включая домашнюю работу, не подтверждён.",
    "JSON-ответы связаны со страницей, открытой во время сбора; это не проверка состава упражнений или правильных ответов.",
    "Архив содержит исходные данные; преобразование в редактируемые упражнения не выполнено.",
  ];
  if (!counts.capturedRoutes) warnings.push("В архиве нет снимков страниц материала.");
  if (counts.missingRoutes) warnings.push(`Нет снимков для обнаруженных страниц: ${counts.missingRoutes}.`);
  if (!counts.jsonResponses) warnings.push("JSON-ответы учебных материалов не сохранены.");
  else if (counts.unassociatedJsonResponses) warnings.push(`JSON-ответы без подтверждённой страницы: ${counts.unassociatedJsonResponses}.`);
  if (counts.routesWithoutJson) warnings.push(`Страницы без связанных JSON-ответов: ${counts.routesWithoutJson}.`);
  if (counts.unvisitedItems) warnings.push(`Элементы навигации без завершённого посещения: ${counts.unvisitedItems}. Их адреса могут быть ещё неизвестны.`);
  if (counts.failedRoutes) warnings.push(`Страницы с ошибками обхода: ${counts.failedRoutes}.`);
  if (counts.droppedRecords) warnings.push(`Из-за ограничений сбора отброшено записей: ${counts.droppedRecords}.`);
  if (collection?.status === "running") {
    warnings.push("Обход ещё не завершён; отчёт содержит только уже полученные данные.");
  } else if (["cancelled", "canceled", "stopped", "failed", "interrupted", "limit"].includes(collection?.status)) {
    warnings.push("Обход остановлен до завершения; сохранены только полученные данные.");
  }
  return {
    schemaVersion: 1,
    representation: "raw-capture",
    editableConversion: false,
    answerKeysVerified: false,
    sourceEnumerationComplete: false,
    status: counts.capturedRoutes || counts.jsonResponses ? "partial" : "empty",
    counts,
    routes,
    warnings,
  };
}
