const sourceID = value => typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value));

/** Retain navigation evidence, never page bodies or framework-internal identities. */
export function confirmedLessonInventory(navigation) {
  try {
    const url = new URL(navigation?.url);
    const route = url.pathname.match(/^\/cabinet\/(?:school|teacher)\/materials\/book\/([1-9]\d*)\/content\/?$/);
    if (navigation.kind !== 'book' || navigation.ready !== true || !route || !sourceID(route[1]) ||
      String(navigation.materialId) !== route[1] || url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash ||
      !Array.isArray(navigation.items) || navigation.items.length > 1000) return null;
    const items = navigation.items.filter(item => item?.kind === 'lesson').map(item => ({
      key: typeof item.key === 'string' && item.key.length <= 1000 ? item.key : '', kind: 'lesson',
      ...(sourceID(String(item.sourceId)) ? { sourceId: String(item.sourceId) } : {}),
    }));
    return { url: url.href, kind: 'book', materialId: route[1], ready: true, items };
  } catch { return null; }
}

/** A name/occurrence key alone cannot grant a direct lesson navigation. */
export function confirmedLessonRoute(navigation, lesson) {
  const inventory = confirmedLessonInventory(navigation);
  if (!inventory || typeof lesson?.key !== 'string' || !lesson.key) return '';
  const matches = inventory.items.filter(item => item.key === lesson.key);
  if (matches.length !== 1 || !matches[0].sourceId) return '';
  const item = matches[0];
  if (inventory.items.filter(candidate => candidate.sourceId === item.sourceId).length !== 1 ||
    lesson.sourceId !== undefined && String(lesson.sourceId) !== item.sourceId) return '';
  return `${new URL(inventory.url).origin}/lesson-editor/book/${inventory.materialId}/lesson/${item.sourceId}`;
}
