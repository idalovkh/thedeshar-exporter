const encoder = new TextEncoder();
const MAX_FILENAME_BYTES = 200;

function titlePart(value) {
  if (typeof value !== 'string') return '';
  let title = value.normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/[\\/<>:"|?*]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '');
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(title)) title = `_${title}`;
  return title;
}

function bookSnapshot(snapshot) {
  try { return /^\/cabinet\/(?:school|teacher)\/materials\/book\/\d+\/content\/?$/.test(new URL(snapshot.url).pathname); }
  catch { return false; }
}

/** Keep the book's Unicode title while producing a portable download basename. */
export function archiveFilename({ collection, snapshots = [], navigation } = {}, exportedAt = new Date()) {
  const candidates = [collection?.title, ...snapshots.filter(bookSnapshot).map(snapshot => snapshot.title),
    navigation?.kind === 'book' ? navigation.title : ''];
  const title = candidates.map(titlePart).find(Boolean) || 'materials';
  const suffix = `-${new Date(exportedAt).toISOString().replace(/[:.]/g, '-')}.zip`;
  const budget = MAX_FILENAME_BYTES - encoder.encode(suffix).byteLength;
  let prefix = '', bytes = 0;
  // Bound UTF-8 bytes without splitting a surrogate pair or non-ASCII letter.
  for (const character of title) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > budget) break;
    prefix += character; bytes += size;
  }
  return `${prefix.replace(/[. ]+$/g, '')}${suffix}`;
}
