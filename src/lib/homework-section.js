import { responseTime } from './capture-response-time.js';

const metadata = new WeakMap();
function lessonAliases(data) {
  if (!data || typeof data !== 'object') return [];
  if (metadata.has(data)) return metadata.get(data);
  const aliases = [];
  let remaining = 100000;
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 24 || --remaining < 0) return;
    if (value.Class === 'LessonWsController' && value.IsSuccess === true &&
      ['GetLessonWithId', 'GetLessonPreview'].includes(value.Method)) {
      const lesson = value.Value, id = lesson?.HomeworkSection?.Id;
      if (Number.isSafeInteger(id) && id > 0 && Number.isSafeInteger(lesson?.Id) && lesson.Id > 0 &&
        Number.isSafeInteger(lesson.Book?.Id) && lesson.Book.Id > 0) {
        aliases.push({ id: String(id), book: String(lesson.Book.Id), lesson: String(lesson.Id) });
      }
      return;
    }
    // Other RPC envelopes cannot contain lesson aliases. Avoid walking large
    // exercise bodies whenever a homework response needs its section identity.
    if (typeof value.Method === 'string' && (typeof value.Class === 'string' || typeof value.Controller === 'string')) return;
    for (const child of Object.values(value)) visit(child, depth + 1);
  };
  visit(data);
  metadata.set(data, aliases);
  return aliases;
}

/** Resolve the source's numeric homework alias from validated lesson metadata. */
export function homeworkSectionId(captures, expectedUrl) {
  const expected = new URL(expectedUrl);
  const route = expected.pathname.match(/\/book\/(\d+)\/lesson\/(\d+)/);
  if (!route) return null;
  let selected;
  for (const capture of captures) {
    let page;
    try { page = new URL(capture.pageUrl); } catch { continue; }
    if (page.origin !== expected.origin || page.pathname.match(/\/book\/(\d+)/)?.[1] !== route[1]) continue;
    const sourceLesson = page.pathname.match(/\/lesson\/(\d+)/)?.[1];
    for (const alias of lessonAliases(capture.data)) {
      if (alias.book !== route[1] || alias.lesson !== route[2] || sourceLesson && sourceLesson !== route[2]) continue;
      const receivedAt = responseTime(capture.receivedAt);
      if (!selected || receivedAt === null || selected.receivedAt === null || receivedAt >= selected.receivedAt) {
        selected = { id: alias.id, receivedAt };
      }
    }
  }
  return selected?.id || null;
}
