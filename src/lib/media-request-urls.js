import { isSafeMediaUrl } from './security.js';
import { isBuiltinSourceOrigin, isTrustedSourceOrigin } from './source-origins.js';

const UUID_FILE = '[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}(?:\\.[a-zA-Z0-9]{1,10})?';
const STORED_FILE = new RegExp(`^/files/([^/]+)/(${UUID_FILE})$`);
const SECTION_FILE = new RegExp(`^/lesson-editor/book/\\d+/lesson/\\d+/section/(?:(?:\\d+|for-homework)/)?files/([^/]+)/(${UUID_FILE})$`);

function mediaUrl(value) {
  if (!isSafeMediaUrl(value)) return null;
  try { return new URL(value); } catch { return null; }
}

function fileReference(url, sourceAlias = false) {
  const match = STORED_FILE.exec(url.pathname) || (sourceAlias && SECTION_FILE.exec(url.pathname));
  if (!match) return null;
  const path = `/files/${match[1]}/${match[2]}`;
  // Query strings can select different content, so only exact queries are aliases.
  const requestUrl = url.href.split('#', 1)[0];
  const queryIndex = requestUrl.indexOf('?');
  const query = queryIndex < 0 ? '' : requestUrl.slice(queryIndex);
  return { family: match[1], key: `${path}${query}` };
}

/** Resolve requests while keeping original URLs as the archive/import identifiers. */
export function buildMediaRequestUrls(assets = []) {
  const observed = new Map();
  const requests = new Map();
  for (const asset of assets) {
    if (typeof asset?.url !== 'string') continue;
    requests.set(asset.url, { url: asset.url });
    if (asset.downloadUnavailable) continue;
    const url = mediaUrl(asset.url);
    if (!url || isTrustedSourceOrigin(url.origin)) continue;
    const file = fileReference(url);
    if (!file) continue;
    url.hash = '';
    if (!observed.has(file.key)) observed.set(file.key, new Set());
    observed.get(file.key).add(url.href);
  }

  for (const asset of assets) {
    if (typeof asset?.url !== 'string' || asset.downloadUnavailable) continue;
    const url = mediaUrl(asset.url);
    if (!url || !isTrustedSourceOrigin(url.origin)) continue;
    const file = fileReference(url, true);
    if (!file) continue;
    const targets = observed.get(file.key);
    if (targets?.size > 1) {
      requests.set(asset.url, { reason: 'ambiguous_media_url' });
    } else if (targets?.size === 1) {
      requests.set(asset.url, { url: targets.values().next().value });
    } else if (file.family === 'LessonExerciseImages' && isBuiltinSourceOrigin(url.origin)) {
      // This legacy family is confirmed on this CDN; other families need an observed URL.
      // Remove once capture guarantees explicit URLs for this family and retained
      // alias-only collections no longer need support.
      requests.set(asset.url, { url: `https://media-y.progressme.ru${file.key}` });
    }
  }
  return requests;
}
