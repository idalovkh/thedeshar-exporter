const positiveID = value => /^0*[1-9]\d*$/.test(value || '');

function landingRoute(value) {
  try {
    const url = new URL(value);
    const route = url.pathname.match(/^\/lesson-editor\/book\/(\d+)\/lesson\/(\d+)(?:\/section(?:\/(\d+|for-homework))?)?\/?$/);
    if (!route || !positiveID(route[1]) || !positiveID(route[2]) || route[3] && route[3] !== 'for-homework' && !positiveID(route[3])) return null;
    return { origin: url.origin, book: route[1], lesson: route[2], stage: route[3] ? 2 : /\/section\/?$/.test(url.pathname) ? 1 : 0 };
  } catch { return null; }
}

export const isLessonBootstrapUrl = value => landingRoute(value)?.stage < 2;

/** Only the selected lesson's unfinished router landing can advance to its first section. */
export function canAdvanceLessonLanding(intent, value, documentId) {
  if (intent.command?.type !== 'OPEN_MATERIAL_ITEM' || intent.target?.kind !== 'lesson' ||
    intent.phase !== 'committed' || !documentId || documentId !== intent.browserDocumentId) return false;
  const previous = landingRoute(intent.observedUrl), next = landingRoute(value);
  if (!previous || !next || previous.stage >= 2 || next.stage <= previous.stage ||
    previous.origin !== next.origin || previous.book !== next.book || previous.lesson !== next.lesson) return false;
  if (`${previous.origin}/book/${previous.book}` !== intent.bookKey) return false;
  return !intent.target.sourceId || String(intent.target.sourceId) === previous.lesson;
}
