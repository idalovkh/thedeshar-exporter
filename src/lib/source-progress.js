/** Monotone readiness milestones: polling, pending traffic and spinners are not progress. */
export function observeSourceProgress(previous, navigation, now) {
  const seen = new Set(previous?.seen || []);
  let at = previous?.at ?? now;
  let sequence = previous?.sequence || 0, bookLessons = previous?.bookLessons || 0;
  if (!navigation?.url || !navigation.documentToken) return { at, seen: [...seen], sequence, bookLessons };
  const scope = `${navigation.documentToken}:${navigation.url}`;
  const milestones = [`${scope}:route`];
  if (navigation.ready || navigation.exerciseState?.listVisible || navigation.exerciseState?.emptyVisible) milestones.push(`${scope}:content`);
  if (navigation.sectionVisit?.received) milestones.push(`${scope}:author`);
  if (navigation.kind === 'book' && navigation.bookState?.visibleLessons > 0) milestones.push(`${scope}:lessons`);
  for (const milestone of milestones) if (!seen.has(milestone)) { seen.add(milestone); at = now; sequence++; }
  const count = navigation.kind === 'book' && navigation.bookState?.visibleLessons;
  if (Number.isSafeInteger(count) && count > bookLessons && count <= 1000) { bookLessons = count; at = now; sequence++; }
  return { at, seen: [...seen].slice(-64), sequence, bookLessons };
}
