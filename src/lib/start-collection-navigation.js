const TRANSIENT = new Set(['source_timeout', 'source_disconnected', 'source_loading', 'source_network_error']);

/** A source can refuse a guarded command before the worker grants a transition. */
export async function startCollectionNavigation({ transition, request, type, payload, pollMs }) {
  let send = true;
  for (;;) {
    if (send) {
      try {
        const response = await transition.run(() => request(type, {
          ...payload, sourceTimeoutMs: Math.min(10_000, transition.remaining()),
        }));
        transition.accept(response.transition);
        return response;
      } catch (error) {
        if (!TRANSIENT.has(error.code)) throw error;
      }
    }
    const status = await transition.status();
    if (status.transitionId) {
      transition.accept({ id: status.transitionId, deadlineAt: status.deadlineAt,
        attempt: status.attempt, maxAttempts: status.maxAttempts });
      return { transition: status };
    }
    // No grant means there is nothing to resume or reload yet. Wait until the
    // source is available, then resend the original document/visit-guarded command.
    // Keep the same local transition so this handshake cannot renew its deadline.
    await transition.pause(pollMs);
    send = status.state === 'same_book';
  }
}
