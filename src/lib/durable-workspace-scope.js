const SESSION_SCOPE = 'workspace-session-scope';
const DURABLE_SCOPE = 'workspace-durable-scope';
const valid = value => typeof value === 'string' && /^[a-zA-Z0-9-]{16,100}$/.test(value);

/** Adopt the supported live v3 scope without copying any raw IndexedDB rows. */
export function createDurableWorkspaceScope({ localStorage, sessionStorage, randomUUID = () => crypto.randomUUID() } = {}) {
  let opening;
  return function scope() {
    if (!opening) opening = (async () => {
      if (localStorage) {
        const retained = (await localStorage.get(DURABLE_SCOPE))[DURABLE_SCOPE];
        if (valid(retained)) return retained;
      }
      if (!sessionStorage && !localStorage) throw new Error('Не удалось определить хранилище локального сбора.');
      const previous = sessionStorage && (await sessionStorage.get(SESSION_SCOPE))[SESSION_SCOPE];
      const token = valid(previous) ? previous : randomUUID();
      if (!valid(token)) throw new Error('Не удалось определить хранилище локального сбора.');
      // Publish the durable key only after its write succeeds. A retry adopts
      // the same live session instead of orphaning its already committed rows.
      if (localStorage) await localStorage.set({ [DURABLE_SCOPE]: token });
      else if (!valid(previous)) await sessionStorage.set({ [SESSION_SCOPE]: token });
      return token;
    })().catch(error => { opening = undefined; throw error; });
    return opening;
  };
}
