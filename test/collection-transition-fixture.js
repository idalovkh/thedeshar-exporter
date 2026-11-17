import assert from 'node:assert/strict';

/** Model the worker-owned transition capability around source-only fixtures. */
export function withCollectionTransitions(send, { sourceStatus, getNavigation, onCommand = () => {} } = {}) {
  let navigation, transition, sequence = 0, collectionId;
  const descriptor = () => ({ id: transition.id, attempt: transition.attempt, maxAttempts: 3, deadlineAt: transition.deadlineAt });
  return async function request(type, payload = {}) {
    if (type === 'GET_SOURCE_STATUS') {
      onCommand(type, payload);
      assert.equal(payload.collectionId, collectionId);
      assert.ok(!payload.transitionId || payload.transitionId === transition.id);
      const status = sourceStatus?.({ transition: descriptor(), navigation }) || {};
      return { sourceStatus: { state: 'same_book', browserLoading: false, canRetry: true,
        transitionId: transition.id, attempt: transition.attempt, maxAttempts: 3,
        deadlineAt: transition.deadlineAt, ...status } };
    }
    if (type === 'RETRY_DEFINITION_REQUEST') { onCommand(type, payload); return { ok: true, retried: false, reason: 'protocol_unverified' }; }
    if (type === 'RETRY_SOURCE_NAVIGATION' || type === 'REPLACE_SOURCE_TAB') {
      onCommand(type, payload);
      assert.equal(payload.collectionId, collectionId);
      assert.equal(payload.transitionId, transition.id);
      assert.ok(transition.attempt < 3);
      navigation = getNavigation?.() || navigation;
      const previousDocumentToken = navigation.documentToken;
      const repeatClick = ['OPEN_MATERIAL_ITEM', 'OPEN_CONFIRMED_LESSON'].includes(transition.original.type) && navigation.url === transition.original.payload.expectedUrl;
      const operation = repeatClick ? transition.original : { type: 'NAVIGATE_SOURCE', payload: { url: navigation.url,
        expectedUrl: navigation.url, expectedDocumentToken: navigation.documentToken,
        ...(navigation.sectionVisit ? { expectedVisitToken: navigation.sectionVisit.token } : {}), collectionId } };
      const result = await send(operation.type, { ...operation.payload, ...(payload.stalled ? { recovery: true } : {}) });
      transition.attempt++;
      return { ...result, transition: descriptor(), reloaded: !repeatClick,
        ...(!repeatClick ? { previousDocumentToken } : {}) };
    }
    const before = navigation;
    const result = await send(type, payload);
    if (type === 'BEGIN_COLLECTION') collectionId = result.collectionId;
    if (result.navigation) navigation = structuredClone(result.navigation);
    if (['OPEN_MATERIAL_ITEM', 'OPEN_CONFIRMED_LESSON', 'NAVIGATE_SOURCE'].includes(type)) {
      transition = { id: `collection-transition-${++sequence}`, attempt: 1, deadlineAt: Date.now() + 180000,
        original: { type, payload: structuredClone(payload) }, from: before };
      return { ...result, transition: descriptor() };
    }
    return result;
  };
}
