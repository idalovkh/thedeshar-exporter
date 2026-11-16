/** Stop the current tour without discarding its committed material or earlier result. */
export function cancelledCollection(state, now = new Date().toISOString()) {
  if (state.collection?.status !== 'running') return state;
  return { ...state, updatedAt: now, collection: { ...state.collection, status: 'cancelled', finishedAt: now,
    items: (state.collection.items || []).map(item => item.status === 'running' ? { ...item, status: 'cancelled' } : item) } };
}
