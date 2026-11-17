import { sourceBookKey } from './book-workspaces.js';

const VERSION = 1;
const MAX_SECTIONS = 1000;
const canonical = value => {
  if (!sourceBookKey(value)) return '';
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
};
const outline = items => items.map(item => ({ key: item.key, title: item.title, kind: item.kind,
  ...(item.sourceId ? { sourceId: String(item.sourceId) } : {}) }));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const structureChanged = () => Object.assign(new Error('Структура сохранённого учебника изменилась. Начните новый сбор; прежние материалы сохранены.'), { code: 'resume_structure_changed' });

function confirmedPages(state) {
  const collection = state?.collection, resume = collection?.resume;
  if (resume?.version !== VERSION || !sourceBookKey(resume.rootUrl) ||
      sourceBookKey(resume.rootUrl) !== sourceBookKey(collection.rootUrl) || !Array.isArray(resume.book) ||
      !Array.isArray(resume.lessons) || !Array.isArray(resume.confirmed) || !Array.isArray(state.snapshots) ||
      [resume.book, resume.lessons, resume.confirmed, state.snapshots].some(items => items.length > MAX_SECTIONS)) return [];
  const snapshots = new Map(state.snapshots.map(snapshot => [canonical(snapshot?.url), snapshot?.capturedAt]));
  const seen = new Set();
  return resume.confirmed.filter(page => {
    const url = canonical(page?.url);
    const route = url.match(/\/lesson\/(\d+)\/section\/(\d+|for-homework)\/?$/);
    const lesson = resume.lessons.find(item => item?.lessonId === page?.lessonId);
    const listed = lesson && resume.book.find(item => item?.key === lesson.key && item.kind === 'lesson');
    const section = Array.isArray(lesson?.sections) && lesson.sections.find(item => item?.key === page?.key);
    if (!route || !listed || (listed.sourceId && String(listed.sourceId) !== page.lessonId) ||
        sourceBookKey(url) !== sourceBookKey(resume.rootUrl) || route[1] !== page.lessonId || !section ||
        (section.sourceId && String(section.sourceId) !== route[2]) ||
        typeof page.capturedAt !== 'string' || !Number.isFinite(Date.parse(page.capturedAt)) ||
        snapshots.get(url) !== page.capturedAt || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

/** A persisted checkpoint is useful only while its exact saved snapshot exists. */
export function collectionResumeInfo(state) {
  const confirmed = confirmedPages(state);
  return { available: confirmed.length > 0, confirmedSections: confirmed.length,
    startedAt: state?.collection?.startedAt || null };
}

export function confirmedResumePage(state, url) {
  return confirmedPages(state).find(page => canonical(page.url) === canonical(url)) || null;
}

/** Keep old authored captures/timestamps; revalidate inventories before reusing them. */
export function createCollectionResume(state, rootUrl) {
  if (state && (!collectionResumeInfo(state).available || sourceBookKey(state.collection.rootUrl) !== sourceBookKey(rootUrl))) {
    throw Object.assign(new Error('Нет подтверждённого сохранённого сбора этого учебника для продолжения.'), { code: 'resume_unavailable' });
  }
  const retained = state?.collection?.resume;
  const checkpoint = retained ? structuredClone(retained) : { version: VERSION, rootUrl, book: [], lessons: [], confirmed: [] };
  checkpoint.confirmed = state ? confirmedPages(state).map(page => ({ ...page })) : [];
  function book(items) {
    const current = outline(items);
    if (retained && !same(checkpoint.book, current)) throw structureChanged();
    checkpoint.book = current;
  }
  function lesson(item, lessonId, sections) {
    const current = { lessonId, key: item.key, sections: outline(sections) };
    const index = checkpoint.lessons.findIndex(previous => previous.key === item.key);
    if (index >= 0) {
      if (retained && !same(checkpoint.lessons[index], current)) throw structureChanged();
      checkpoint.lessons[index] = current;
    } else checkpoint.lessons.push(current);
  }
  function confirmed(url, key) {
    return checkpoint.confirmed.some(page => canonical(page.url) === canonical(url) && page.key === key);
  }
  function saved(lessonId, key) {
    return checkpoint.confirmed.find(page => page.lessonId === lessonId && page.key === key);
  }
  function confirm(url, lessonId, key, capturedAt) {
    if (typeof capturedAt !== 'string' || !Number.isFinite(Date.parse(capturedAt))) return;
    const page = { url, lessonId, key, capturedAt };
    const index = checkpoint.confirmed.findIndex(previous => canonical(previous.url) === canonical(url));
    if (index >= 0) checkpoint.confirmed[index] = page;
    else if (checkpoint.confirmed.length < MAX_SECTIONS) checkpoint.confirmed.push(page);
  }
  return { checkpoint, book, lesson, confirmed, saved, confirm };
}
