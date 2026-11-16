/* A persisted response confirms only the opening that observed it. */
(() => {
  'use strict';
  globalThis.__thedesharCreateSectionVisit = ({ getUrl, getCaptureId }) => {
    let visit;
    const target = typeof window === 'object' ? window : null;
    const barrierChannel = crypto.randomUUID();
    const navigation = target?.navigation;
    let navigationEpoch = 0;
    let navigationPage = new URL(getUrl());
    navigationPage = `${navigationPage.origin}${navigationPage.pathname}`;
    navigation?.addEventListener?.('currententrychange', () => {
      const value = new URL(getUrl()), next = `${value.origin}${value.pathname}`;
      if (next !== navigationPage) { navigationPage = next; navigationEpoch++; }
    });
    const barriers = new Map();
    const unavailable = () => Object.assign(new Error('Ожидаем завершения обработки перехода страницы книги.'), { code: 'source_loading' });
    target?.addEventListener('message', event => {
      const value = event.data;
      if (event.source !== target || value?.source !== 'thedeshar-section-visit-barrier-v1' || value.channel !== barrierChannel) return;
      const pending = barriers.get(value.id);
      if (pending && event.origin === pending.origin) pending.finish();
    });
    // MAIN-world history notifications and this marker use the same window
    // message queue. Do not expose a visit or act before earlier hops arrive.
    function flush() {
      return new Promise((resolve, reject) => {
        if (!target?.postMessage || typeof navigation?.addEventListener !== 'function') {
          reject(Object.assign(new Error('Обновите Chrome и вкладку книги для безопасной проверки переходов.'), { code: 'source_update_required' }));
          return;
        }
        const epoch = navigationEpoch;
        const id = crypto.randomUUID(), origin = new URL(getUrl()).origin;
        const finish = error => {
          clearTimeout(timer);
          barriers.delete(id);
          if (error) reject(error);
          else resolve(() => {
            if (navigationEpoch !== epoch) throw unavailable();
          });
        };
        const timer = setTimeout(() => finish(unavailable()), 10_000);
        barriers.set(id, { origin, finish });
        try { target.postMessage({ source: 'thedeshar-section-visit-barrier-v1', channel: barrierChannel, id }, origin); }
        catch { finish(unavailable()); }
      });
    }
    const page = () => { const url = new URL(getUrl()); return `${url.origin}${url.pathname}`; };
    function begin() {
      visit = { url: page(), captureId: getCaptureId(), token: crypto.randomUUID(), sequence: 0,
        revision: 0, received: false, changedAt: Date.now() };
      return visit;
    }
    function current() {
      if (!visit || visit.url !== page() || visit.captureId !== getCaptureId()) {
        const previous = visit?.url;
        begin();
        visit.previousUrl = previous;
      }
      return visit;
    }
    function navigated(from, to) {
      const value = current();
      if (value.url === to && value.previousUrl === from) value.previousUrl = undefined;
      else begin();
    }
    function observe() {
      const value = current();
      return { url: value.url, token: value.token, sequence: ++value.sequence };
    }
    function confirm(observation, status) {
      const value = current();
      if (!status || typeof status.received !== 'boolean' || observation.token !== value.token ||
        observation.url !== value.url || observation.sequence < value.revision) return;
      value.revision = observation.sequence;
      value.received = status.received;
      value.reason = status.reason === 'incomplete' ? 'incomplete' : undefined;
      value.changedAt = Date.now();
    }
    function inspect() {
      const value = current();
      return { token: value.token, revision: value.revision, received: value.received,
        ...(value.reason ? { reason: value.reason } : {}), idleMs: Math.max(0, Date.now() - value.changedAt) };
    }
    return Object.freeze({ begin, observe, confirm, inspect, navigated, flush });
  };
})();
