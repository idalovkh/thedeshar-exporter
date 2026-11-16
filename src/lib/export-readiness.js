import { buildCoverage } from "./coverage.js";
import { exportFileProblems } from "./export-file-problems.js";

const incomplete = reason => ({ allowed: false, reason });

/** A finished crawl must retain every discovered page before a ZIP is offered.
 * Summary captures keep data=true, so this also works without hydrating bodies.
 * Raw-capture coverage.status does not describe crawl completion.
 */
export function exportReadiness(state = {}) {
  const collection = state.collection;
  if (state.enabled || state.collectionLocked || collection?.status === "running")
    return incomplete("Дождитесь завершения сбора всей книги. Частичный архив скачать нельзя.");
  if (collection?.status !== "finished")
    return incomplete("Сначала завершите сбор всей книги. Частичный архив скачать нельзя.");
  const snapshots = Array.isArray(state.snapshots) ? state.snapshots : [];
  const captures = Array.isArray(state.captures) ? state.captures : [];
  const items = Array.isArray(collection.items) ? collection.items : [];
  if (!snapshots.length || !items.some(item => item?.kind === "lesson") ||
      items.some(item => !item || item.status !== "visited") ||
      (Array.isArray(collection.failed) && collection.failed.length) || Number(state.dropped) > 0)
    return incomplete("Книга собрана не полностью. Повторите сбор из содержания книги.");
  const expected = collection.expected;
  const coverage = buildCoverage({ snapshots, captures, dropped: state.dropped,
    collection: { ...collection, expected: [...(Array.isArray(expected) ? expected : []), ...items.filter(item => item.url)] } });
  let root;
  try { root = new URL(collection.rootUrl); } catch { return incomplete("Откройте содержание книги и повторите сбор."); }
  const book = root.pathname.match(/\/materials\/book\/(\d+)\/content\/?$/)?.[1];
  const routes = coverage.routes.filter(route => new URL(route.url).origin === root.origin && route.materialId === book);
  if (!book || !routes.some(route => route.captured) || routes.some(route => (!route.captured && route.requiresSnapshot) || route.failed) ||
      coverage.counts.unvisitedItems || coverage.counts.droppedRecords)
    return incomplete("Не все уроки и разделы сохранены. Соберите книгу заново перед скачиванием.");
  return { allowed: true, reason: "" };
}

export function assertExportReady(state) {
  const readiness = exportReadiness(state);
  if (!readiness.allowed) throw Object.assign(new Error(readiness.reason), { code: "incomplete_export" });
}

/** Every discovered file must be retained; external embeds are not candidates. */
export function assertExportFilesReady(files, expected = files) {
  const missing = exportFileProblems(files, expected);
  if (missing.length) throw Object.assign(new Error(`Не удалось скачать все файлы книги: отсутствуют ${missing.length}. Архив не создан. Повторите скачивание.`), { code: "incomplete_export" });
}
