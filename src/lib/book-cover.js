import { isSafeMediaUrl, sanitizeUrl } from './security.js';
import { isTrustedSourceOrigin } from './source-origins.js';

/** A cover belongs only to the retained contents page of its source book. */
export function snapshotBookCover(snapshot) {
  if (typeof snapshot?.coverUrl !== 'string' || !snapshot.coverUrl.trim()) return null;
  let page;
  try { page = new URL(snapshot.url); } catch { return null; }
  if (page.protocol !== 'https:' || page.port || page.username || page.password ||
      !isTrustedSourceOrigin(page.origin)) return null;
  const materialId = page.pathname.match(/^\/cabinet\/(?:school|teacher)\/materials\/book\/(\d+)\/content\/?$/)?.[1];
  if (!materialId || snapshot.route?.lessonId ||
      snapshot.route?.materialId != null && String(snapshot.route.materialId) !== materialId) return null;
  const url = sanitizeUrl(snapshot.coverUrl, page.href);
  if (!url || !isSafeMediaUrl(url)) return null;
  return { url, materialId, origin: page.origin };
}
