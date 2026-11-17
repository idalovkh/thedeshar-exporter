/** Change only the source binding; the dashboard document and its running collector survive. */
export function createSourceReplacement({ send, getSourceTabId, adopt, signal }) {
  let active = null;
  async function cancel() {
    const pending = active;
    if (!pending) return;
    pending.cancelled = true;
    if (!pending.token) return;
    await send('ABORT_SOURCE_REPLACEMENT', { token: pending.token, collectionId: pending.collectionId });
    adopt(pending.previous);
  }
  signal?.addEventListener('abort', () => { void cancel().catch(() => {}); });
  async function replace(payload) {
    signal?.throwIfAborted();
    const pending = { previous: getSourceTabId(), collectionId: payload.collectionId, cancelled: false };
    active = pending;
    try {
      const prepared = await send('PREPARE_SOURCE_REPLACEMENT', payload);
      pending.token = prepared.token;
      if (pending.cancelled || signal?.aborted) { await cancel(); throw new DOMException('Сбор отменён.', 'AbortError'); }
      adopt(prepared.sourceTabId);
      const result = await send('COMMIT_SOURCE_REPLACEMENT', { ...payload, token: prepared.token });
      if (pending.cancelled || signal?.aborted) { await cancel(); throw new DOMException('Сбор отменён.', 'AbortError'); }
      return result;
    } catch (error) {
      if (pending.token) await send('ABORT_SOURCE_REPLACEMENT', { token: pending.token, collectionId: pending.collectionId }).catch(() => {});
      adopt(pending.previous);
      throw error;
    } finally { if (active === pending) active = null; }
  }
  return { replace, active: () => Boolean(active) };
}
