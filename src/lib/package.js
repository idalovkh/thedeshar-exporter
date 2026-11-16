import { redactSensitive, sanitizeUrl, safeFilename } from "./security.js";
import { buildCoverage } from "./coverage.js";
import { snapshotBookCover } from "./book-cover.js";
import { isTrustedSourceOrigin } from './source-origins.js';

const json = (value) => `${JSON.stringify(redactSensitive(value))}\n`;
const numbered = (index) => String(index + 1).padStart(5, "0");

export const MAX_ASSETS = 10000;

export function assertAssetCapacity(assets) {
  if (assets.length > MAX_ASSETS) {
    const error = new RangeError(`В книге найдено ${assets.length} файлов; текущий импорт поддерживает до ${MAX_ASSETS} файлов в одном архиве. Собранная копия сохранена.`);
    error.code = "asset_limit";
    throw error;
  }
}

function pageUrl(page, base) {
  return sanitizeUrl(page.url || page.sourceUrl || page.pageUrl || "", base);
}

function routeIds(url) {
  let path;
  try { path = new URL(url, "https://export.invalid/").pathname; } catch { return {}; }
  const ids = {};
  for (const [key, segment] of [["materialId", "book"], ["lessonId", "lesson"], ["sectionId", "section"]]) {
    const match = path.match(new RegExp(`(?:^|/)${segment}/([^/]+)`));
    if (match) ids[key] = match[1];
  }
  return ids;
}

function collectLinks(snapshot, base) {
  const result = [];
  const candidates = [...(Array.isArray(snapshot.links) ? snapshot.links : []), ...(Array.isArray(snapshot.materialLinks) ? snapshot.materialLinks : [])];
  for (const candidate of candidates) {
    const url = sanitizeUrl(typeof candidate === "string" ? candidate : candidate.href || candidate.url, base);
    if (!url) continue;
    let path;
    try { path = new URL(url).pathname; } catch { continue; }
    if (!/(?:^|\/)(?:materials?|book|lesson|lesson-editor|section)(?:\/|$)/i.test(path)) continue;
    result.push({ url, title: typeof candidate === "string" ? "" : candidate.title || candidate.text || candidate.label || "", route: routeIds(url) });
  }
  return result;
}

function collectionRoute(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.port || url.username || url.password ||
        !isTrustedSourceOrigin(url.origin)) return null;
    const book = url.pathname.match(/^\/cabinet\/(?:school|teacher)\/materials\/book\/(\d+)\/content\/?$/);
    const lesson = url.pathname.match(/^\/lesson-editor\/book\/(\d+)\/lesson\/(\d+)(?:\/section\/(\d+|for-homework))?\/?$/);
    if (!book && !lesson) return null;
    return { origin: url.origin, materialId: (book || lesson)[1], lessonId: lesson?.[2] || null, sectionId: lesson?.[3] || null };
  } catch { return null; }
}

function refineHierarchy({ collection, pages, materials, lessons, sections }) {
  const root = collectionRoute(collection?.rootUrl);
  if (!root || root.lessonId) return;
  const sameBook = route => route && route.origin === root.origin && route.materialId === root.materialId;
  const retained = pages.map(page => collectionRoute(page.url)).filter(sameBook);
  if (!retained.length) return;
  const titleOf = value => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 500) : "";
  const book = materials.get(root.materialId);
  if (book && sameBook(collectionRoute(book.sourceUrl)) && titleOf(collection.title)) book.title = titleOf(collection.title);
  for (const item of Array.isArray(collection.items) ? collection.items : []) {
    if (!item || !["lesson", "section", "homework"].includes(item.kind) || !titleOf(item.title)) continue;
    const route = item.url ? collectionRoute(item.url) : null;
    if (item.url && (!sameBook(route) || !route.lessonId)) continue;
    const explicitLessonId = item.lessonId == null ? null : String(item.lessonId);
    if (explicitLessonId !== null && !/^\d+$/.test(explicitLessonId)) continue;
    if (route && explicitLessonId !== null && explicitLessonId !== route.lessonId) continue;
    const lessonId = route?.lessonId || explicitLessonId;
    if (!lessonId || !retained.some(page => page.lessonId === lessonId)) continue;
    if (item.kind === "lesson") {
      const lesson = lessons.get(lessonId);
      const existing = collectionRoute(lesson?.sourceUrl);
      if (lesson && sameBook(existing) && existing.lessonId === lessonId) {
        lesson.title = titleOf(item.title);
        lesson.materialId = root.materialId;
      }
      continue;
    }
    // A section ID comes only from an actual retained route, never a navigation key.
    if (!route?.sectionId || (item.kind === "homework" ? route.sectionId !== "for-homework" : !/^\d+$/.test(route.sectionId)) ||
        !retained.some(page => page.lessonId === lessonId && page.sectionId === route.sectionId)) continue;
    const section = sections.get(`${lessonId}/${route.sectionId}`);
    const existing = collectionRoute(section?.sourceUrl);
    if (section && sameBook(existing) && existing.lessonId === lessonId && existing.sectionId === route.sectionId) {
      section.title = titleOf(item.title);
      section.lessonId = lessonId;
    }
  }
}

function packageMedia(assets, base, shareBlobs = false) {
  const entries = [];
  const paths = shareBlobs ? new Map() : null;
  const media = assets.map((asset, index) => {
    const data = asset.data instanceof Uint8Array || asset.data instanceof Blob ? asset.data : null;
    const name = safeFilename(asset.name || asset.url, `asset-${numbered(index)}.bin`);
    let file = data instanceof Blob ? paths?.get(data) ?? null : null;
    if (data && !file) {
      file = `media/${numbered(index)}-${name}`;
      entries.push({ name: file, data });
      if (data instanceof Blob) paths?.set(data, file);
    }
    return {
      id: String(asset.id ?? `asset-${numbered(index)}`),
      url: sanitizeUrl(asset.url || asset.downloadUrl || "", base),
      file,
      name,
      mimeType: asset.mimeType || "application/octet-stream",
      size: data ? (data instanceof Blob ? data.size : data.byteLength) : null,
      status: data ? "downloaded" : asset.status || "reference-only",
      error: asset.error ? String(asset.error) : null,
    };
  });
  return { media, entries };
}

export function replacePackageAssets(prepared, assets) {
  assertAssetCapacity(assets);
  const original = prepared.manifest;
  const base = original.source.origin || original.source.url || original.source.baseUrl || original.inventory.pages.find(page => page.url)?.url;
  // The downloader gives byte-identical media the same immutable Blob.
  const { media, entries: mediaEntries } = packageMedia(assets, base, true);
  const missingAssets = media.filter(asset => !asset.file).length;
  const manifest = redactSensitive({
    ...original,
    completeness: { ...original.completeness, missingAssets,
      warnings: [...original.completeness.warnings, ...(missingAssets
        ? [`В архив не включено файлов: ${missingAssets}. При импорте зависимые упражнения могут быть пропущены. Причины и исходные ссылки указаны в списке файлов.`] : [])],
    },
    counts: { ...original.counts, assets: media.length, downloadedAssets: media.filter(asset => asset.file).length },
    inventory: { ...original.inventory, assets: media },
  });
  const entries = prepared.entries.filter(entry => entry.name !== "manifest.json" && !entry.name.startsWith("media/"));
  entries.unshift({ name: "manifest.json", data: json(manifest) });
  entries.push(...mediaEntries);
  return { entries, manifest };
}

/** Neutral capture package. It deliberately does not claim conversion to editable native exercises. */
export function createExportPackage({ snapshots = [], captures = [], assets = [], source = {}, warnings = [], dropped = 0, collection = null, exportedAt = new Date().toISOString() } = {}) {
  if (![snapshots, captures, assets].every(Array.isArray)) throw new TypeError("Снимки, ответы и файлы должны быть массивами");
  assertAssetCapacity(assets);
  const base = source.origin || source.url || source.baseUrl || snapshots.find((page) => page.url)?.url;
  const entries = [];
  const pages = [];
  const responses = [];
  const links = new Map();
  const materials = new Map();
  const lessons = new Map();
  const sections = new Map();
  function addHierarchy(route, url, title) {
    if (route.materialId && !materials.has(route.materialId)) materials.set(route.materialId, { externalId: route.materialId, sourceUrl: url, title: route.lessonId ? "" : title });
    if (route.lessonId && !lessons.has(route.lessonId)) lessons.set(route.lessonId, { externalId: route.lessonId, materialId: route.materialId || null, sourceUrl: url, title });
    if (route.sectionId && !sections.has(`${route.lessonId || ""}/${route.sectionId}`)) sections.set(`${route.lessonId || ""}/${route.sectionId}`, { externalId: route.sectionId, lessonId: route.lessonId || null, sourceUrl: url, title: "" });
  }
  snapshots.forEach((snapshot, index) => {
    const file = `originals/pages/${numbered(index)}.json`;
    const url = pageUrl(snapshot, base);
    const route = routeIds(url);
    const title = snapshot.title || snapshot.lessonTitle || "";
    entries.push({ name: file, data: json(snapshot) });
    pages.push({ file, url, title, route, capturedAt: snapshot.capturedAt || snapshot.receivedAt || null, pageType: snapshot.pageType || snapshot.kind || "unknown" });
    addHierarchy(route, url, title);
    const cover = snapshotBookCover(snapshot);
    const material = materials.get(cover?.materialId);
    const existing = collectionRoute(material?.sourceUrl);
    if (cover && existing?.origin === cover.origin && existing.materialId === cover.materialId) material.coverUrl = cover.url;
    for (const link of collectLinks(snapshot, url || base)) {
      links.set(link.url, link);
      addHierarchy(link.route, link.url, link.title);
    }
  });
  refineHierarchy({ collection, pages, materials, lessons, sections });
  captures.forEach((capture, index) => {
    const file = `originals/responses/${numbered(index)}.json`;
    const url = sanitizeUrl(capture.url || capture.sourceUrl || "", base);
    entries.push({ name: file, data: json(capture) });
    responses.push({ file, kind: capture.kind || "unknown", url, pageUrl: sanitizeUrl(capture.pageUrl || ""), receivedAt: capture.receivedAt || capture.capturedAt || null });
  });
  const { media, entries: mediaEntries } = packageMedia(assets, base);
  entries.push(...mediaEntries);
  const coverage = buildCoverage({ snapshots, captures, dropped, collection });
  entries.push({ name: 'coverage.json', data: json(coverage) });
  if (collection) {
    const { diagnostics, ...archivedCollection } = collection;
    entries.push({ name: 'collection.json', data: json(archivedCollection) });
  }
  const manifest = redactSensitive({
    format: "thedeshar-material-capture",
    schemaVersion: 1,
    exportedAt,
    source,
    reports: { coverage: 'coverage.json', collection: collection ? 'collection.json' : null },
    completeness: {
      status: "partial",
      representation: "raw-capture",
      editableConversion: false,
      answerKeysVerified: false,
      sourceEnumerationComplete: false,
      missingAssets: media.filter((asset) => !asset.file).length,
      warnings: Array.isArray(warnings) ? warnings.map((warning) => String(warning)) : [],
      droppedRecords: Number.isSafeInteger(dropped) && dropped > 0 ? dropped : 0,
      limitations: [
        "Архив содержит только посещённые страницы, полученные во время сбора ответы и выбранные доступные файлы.",
        "Наличие и полнота правильных ответов не подтверждены. Исходные ответы сохранены без преобразования структуры упражнений.",
        "Снимки можно импортировать как текстовые блоки; автоматическое восстановление интерактивных упражнений не поддерживается.",
      ],
    },
    counts: { pages: pages.length, responses: responses.length, assets: media.length, downloadedAssets: media.filter((asset) => asset.file).length },
    inventory: {
      pages,
      responses,
      hierarchy: { materials: [...materials.values()], lessons: [...lessons.values()], sections: [...sections.values()] },
      links: [...links.values()],
      assets: media,
    },
  });
  entries.unshift({ name: "manifest.json", data: json(manifest) });
  return { entries, manifest };
}
