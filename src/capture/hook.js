/* Runs in the page's MAIN world. Observes responses; never sends or replays requests. */
(() => {
  'use strict';
  const INSTALL_KEY = '__thedesharExporterObserverV1';
  if (window[INSTALL_KEY]) return;
  Object.defineProperty(window, INSTALL_KEY, { value: true });

  const CHANNEL_SOURCE = 'thedeshar-exporter-v1';
  const MAX_BYTES = 8 * 1024 * 1024;
  const secretKey = /(?:password|passwd|passphrase|authorization|cookie|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token|jwt[_-]?token|client[_-]?secret|api[_-]?key|private[_-]?key|^token$|^jwt$|^secret$|^session$|^session_?id$|^credentials?$|^csrf(?:_?token)?$|^xsrf(?:_?token)?$|^email$|^phone(?:_number)?$|^students?$|^users?$|^payments?$)/i;
  const deniedPath = /(?:^|\/)(?:auth|login|logout|oauth|signin|signup|account|profile|users?|students?|employees?|members?|payments?|billing|finance|notifications?|analytics|telemetry|messages?|chats?)(?:\/|$)/i;
  const secretQuery = /^(?:.*token|auth(?:orization)?|api[_-]?key|key|password|passwd|secret|session(?:id)?|sid|jwt|signature|sig|credential|policy|key[_-]?pair[_-]?id|code|csrf(?:[_-]?token)?|xsrf(?:[_-]?token)?|x[_-]amz[_-].*|x[_-]goog[_-].*)$/i;
  const materialKey = /^(?:materials?|books?|lessons?|sections?|exercises?|units?|blocks?|exercise_type|exerciseType|answer_key|answerKey|correct_answers|correctAnswers|wordlist|word_list|vocabulary_words)$/i;
  // Confirmed by ProgressMe lesson_shell GetExerciseWsController and the
  // exercises_shell ExerciseModel. Keep this definition projection in sync with
  // lib/security.js, which cleans the response during archive preparation.
  const definitionFields = new Set(('Id Type Name Number ExerciseNumber IsAutoCheck IsLessonPage IsShowExerciseNumber JsonData Images ImageInputCorrectWord PasteWordByDrag InputCorrectFormWord SelectCorrectFormWord Essay ImageSelectCorrectWord Note Audios Button Text BuildWordFromLetters PracticeId PersonalMaterialId HomeworkLessonId PracticeNumber SectionId LessonSectionId Videos VideosUrl AudioRecording Questions QuestionAnswers MappingWords Words AddWordsToVocabulary Topic MappingImageByDrag GroupWordsByColumns Test QuestionWithCodingTexts SentencesInCorrectOrder Descriptions NumberToHeader MainNumberToHeader MiroBoard GooglePDF Wordwall Learningapps Genially Baamboozle Quizlet ChoiseExtraWords TrueOrFalse IsHidePupil ImagesJson AutoCheck TimerMinutes UsedNewConstructor Statistics').split(' '));
  const definitionTypes = new Set([2, 3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 41, 42, 43, 99]);
  let enabled = false;
  let channel = null;
  let channelRevision = -1;
  let stateKnown = false;
  let captureEpoch = 0;
  const routeUrl = () => `${location.origin}${location.pathname}`;
  let previousRoute = routeUrl();
  let routeFrom = null;
  let routeRevision = 0;
  const responseScope = () => ({ page: location.href, epoch: captureEpoch, revision: routeRevision });
  // The collector waits for in-flight HTTP/RPC responses before saving a page.
  let pendingRequests = 0;
  const socketRequests = new WeakMap();
  const pendingSocketRequests = new Set();
  const MAX_PENDING_RPC = 256;
  const MAX_RPC_REQUEST_BYTES = 64 * 1024;
  // Temporary source data covers only the opt-in restoration handshake. It
  // never persists or crosses worlds before the background confirms capture.
  const bootstrap = [];
  const bootstrapIssues = new Set();
  let bootstrapBytes = 0;
  const MAX_BOOTSTRAP_EVENTS = 32;
  const MAX_BOOTSTRAP_BYTES = 16 * 1024 * 1024;
  const ISSUE_CODES = new Set(['response_too_large', 'response_too_complex', 'bootstrap_overflow', 'bootstrap_navigation_changed']);

  function observing() { return !stateKnown || enabled; }

  function postIssue(code, page = location.href, epoch = captureEpoch) {
    if (epoch !== captureEpoch || !observing()) return;
    if (page !== location.href) code = 'bootstrap_navigation_changed';
    if (!ISSUE_CODES.has(code)) return;
    if (!stateKnown) { bootstrapIssues.add(code); return; }
    if (enabled && channel && materialPage()) {
      window.postMessage({ source: CHANNEL_SOURCE, direction: 'issue', channel, revision: channelRevision, code }, location.origin);
    }
  }

  function postActivity() {
    if (stateKnown && enabled && channel && materialPage()) {
      window.postMessage({ source: CHANNEL_SOURCE, direction: 'activity', channel, revision: channelRevision, pending: pendingRequests }, location.origin);
    }
  }

  function trackRequest(url) {
    if (!observing() || !allowedEndpoint(url)) return () => {};
    const epoch = captureEpoch;
    pendingRequests++;
    postActivity();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      if (epoch !== captureEpoch) return;
      pendingRequests--;
      postActivity();
    };
  }

  function authoredRpc(value) {
    const controller = value?.Class || value?.Controller, method = value?.Method;
    const supported = controller === 'GetExerciseWsController' && ['LoadExercises', 'LoadExercisesInMaterial'].includes(method) ||
      ['CourseWsController', 'SharingMaterialWsController'].includes(controller) && method === 'GetBookCourses' ||
      controller === 'LessonWsController' && ['GetLessonWithId', 'GetLessonPreview'].includes(method);
    if (!supported || value.ProjectName !== undefined && value.ProjectName !== (controller === 'GetExerciseWsController' ? 'Exercises' : 'Books')) return null;
    const rawId = value.RequestId ?? value.Id;
    const id = Number.isSafeInteger(rawId) && rawId >= 0 ? `n:${rawId}`
      : typeof rawId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(rawId) ? `s:${rawId}` : null;
    return { controller, method, id };
  }

  function visitRpc(value, callback, depth = 0, budget = { count: 0 }) {
    if (!value || typeof value !== 'object' || ++budget.count > 64 || depth > 4) return;
    const rpc = authoredRpc(value);
    if (rpc) { callback(rpc, value); return; }
    if (rpcEnvelope(value)) return;
    for (const key of Object.keys(value).slice(0, 32)) visitRpc(value[key], callback, depth + 1, budget);
  }

  function releaseSocketRequest(entry) {
    entry.pending.delete(entry);
    pendingSocketRequests.delete(entry);
    entry.finished();
  }

  function trackSocketRequest(socket, raw, epoch = captureEpoch) {
    const state = socketRequests.get(socket), added = [];
    if (!state || epoch !== captureEpoch || !observing() || !materialPage() || !allowedEndpoint(state.url)) return () => {};
    try {
      if (typeof raw !== 'string' || raw.length > MAX_RPC_REQUEST_BYTES || new TextEncoder().encode(raw).byteLength > MAX_RPC_REQUEST_BYTES) return () => {};
      const parsed = JSON.parse(raw.replace(/^\x1e|\x1e$/g, ''));
      visitRpc(parsed, rpc => {
        if (pendingSocketRequests.size >= MAX_PENDING_RPC) { postIssue('response_too_complex'); return; }
        const entry = { ...rpc, epoch, pending: state.pending, finished: trackRequest(state.url) };
        state.pending.add(entry); pendingSocketRequests.add(entry); added.push(entry);
      });
    } catch { /* Unsupported frames do not affect the application's socket. */ }
    return () => { for (const entry of added) releaseSocketRequest(entry); };
  }

  function finishSocketRequests(state, parsed) {
    visitRpc(parsed, (rpc, envelope) => {
      if (typeof envelope.IsSuccess !== 'boolean') return;
      // Keep retired descriptors until their replies arrive. A response from a
      // previous capture must not clear a new request with the same RPC method.
      const entry = [...state.pending].find(candidate => candidate.controller === rpc.controller &&
        candidate.method === rpc.method && candidate.id === rpc.id);
      if (entry) releaseSocketRequest(entry);
    });
  }

  function publish(event) {
    window.postMessage({ source: CHANNEL_SOURCE, direction: 'event', channel, revision: channelRevision,
      observedPage: routeUrl(), event }, location.origin);
  }

  function accept(event) {
    if (stateKnown) { if (enabled && channel) publish(event); return; }
    if (bootstrapIssues.has('bootstrap_overflow')) return;
    const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
    if (bootstrap.length >= MAX_BOOTSTRAP_EVENTS || bootstrapBytes + bytes > MAX_BOOTSTRAP_BYTES) {
      bootstrap.length = 0;
      bootstrapBytes = 0;
      bootstrapIssues.add('bootstrap_overflow');
      return;
    }
    bootstrap.push({ event, page: location.href, revision: routeRevision });
    bootstrapBytes += bytes;
  }

  function restore(value, revisionChanged) {
    const nextEnabled = value === true && materialPage();
    if (!nextEnabled || stateKnown && revisionChanged) { captureEpoch++; pendingRequests = 0; }
    enabled = nextEnabled;
    if (stateKnown) return;
    stateKnown = true;
    if (enabled) {
      if (bootstrap.some(item => item.page !== location.href || item.revision !== routeRevision)) {
        bootstrapIssues.add('bootstrap_navigation_changed');
      } else if (!bootstrapIssues.size) {
        for (const { event } of bootstrap) publish(event);
      }
      for (const code of bootstrapIssues) postIssue(code);
    }
    bootstrap.length = 0;
    bootstrapBytes = 0;
    bootstrapIssues.clear();
  }

  function rpcEnvelope(value) {
    return value && typeof value === 'object' && typeof value.Method === 'string' &&
      (typeof value.Class === 'string' || typeof value.Controller === 'string');
  }

  function exerciseDefinitions(value) {
    if (value?.Class !== 'GetExerciseWsController' ||
      !['LoadExercisesInMaterial', 'LoadExercises'].includes(value.Method) || value.IsSuccess !== true ||
      (value.ProjectName !== undefined && value.ProjectName !== 'Exercises') ||
      !value.Value || !Array.isArray(value.Value.Items)) return null;
    if (value.Value.Items.length > 4000) throw captureFailure('response_too_complex');
    if (!value.Value.Items.every(item => item && typeof item === 'object' && !Array.isArray(item) &&
      Number.isSafeInteger(item.Id) && item.Id > 0 && definitionTypes.has(item.Type))) return null;
    const data = { Items: value.Value.Items.map(item => Object.fromEntries(Object.entries(item).filter(([key]) => definitionFields.has(key)))) };
    for (const key of ['SectionId', 'Count']) if (Number.isSafeInteger(value.Value[key]) && value.Value[key] >= 0) data[key] = value.Value[key];
    return { Class: value.Class, Method: value.Method, IsSuccess: true, ProjectName: 'Exercises', Value: data };
  }

  // Book groups contain only author navigation metadata. Their counts let the
  // adapter wait for every lazily mounted group, including empty groups.
  function bookCourses(value) {
    if (!['CourseWsController', 'SharingMaterialWsController'].includes(value?.Class) ||
      value.Method !== 'GetBookCourses' || value.IsSuccess !== true ||
      (value.ProjectName !== undefined && value.ProjectName !== 'Books') ||
      !Array.isArray(value.Value)) return null;
    if (value.Value.length > 1000) throw captureFailure('response_too_complex');
    const ids = new Set();
    if (!value.Value.every(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) ||
        !Number.isSafeInteger(item.Id) || item.Id <= 0 || ids.has(item.Id) ||
        typeof item.Name !== 'string' || item.Name.length > 500 ||
        !Number.isSafeInteger(item.CountLesson) || item.CountLesson < 0 || item.CountLesson > 10000 ||
        (item.BookId !== undefined && (!Number.isSafeInteger(item.BookId) || item.BookId <= 0))) return false;
      ids.add(item.Id);
      return true;
    })) return null;
    return { Class: value.Class, Method: value.Method, IsSuccess: true, ProjectName: 'Books',
      Value: value.Value.map(item => ({ Id: item.Id, Name: item.Name, CountLesson: item.CountLesson,
        ...(item.BookId !== undefined ? { BookId: item.BookId } : {}),
        ...(Object.hasOwn(item, 'ImageUrl') && (item.ImageUrl === null || typeof item.ImageUrl === 'string') ? { ImageUrl: item.ImageUrl } : {}) })) };
  }

  function lessonMetadata(value) {
    return value?.Class === 'LessonWsController' && ['GetLessonWithId', 'GetLessonPreview'].includes(value.Method) &&
      value.IsSuccess === true && value.Value && typeof value.Value === 'object' &&
      (Array.isArray(value.Value.Sections) || Array.isArray(value.Value.sections) ||
        Boolean(value.Value.Book && typeof value.Value.Book === 'object'));
  }

  function materialPage() {
    return /\/(?:cabinet\/(?:school|teacher)\/materials(?:\/|$)|lesson-editor(?:\/|$))/.test(location.pathname);
  }

  function safeUrl(value) {
    try {
      const url = new URL(value, location.href);
      if (!/^https?:$/.test(url.protocol) && !/^wss?:$/.test(url.protocol)) return null;
      url.username = '';
      url.password = '';
      url.hash = '';
      for (const key of [...url.searchParams.keys()]) if (secretQuery.test(key)) url.searchParams.delete(key);
      return url.href;
    } catch { return null; }
  }

  function captureFailure(code) { return Object.assign(new Error(code), { captureCode: code }); }

  function allowedEndpoint(value) {
    try {
      const url = new URL(value, location.href);
      return /^(?:https?|wss?):$/.test(url.protocol) && !deniedPath.test(url.pathname);
    } catch { return false; }
  }

  function captureData(value, depth = 0, budget = { count: 0 }, seen = new WeakSet()) {
    if (++budget.count > 100000 || depth > 24) throw captureFailure('response_too_complex');
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    // Keep authored strings and serialized JSON intact until archive preparation.
    if (typeof value === 'string') return value;
    if (typeof value !== 'object') return undefined;
    const definitions = exerciseDefinitions(value) || bookCourses(value);
    if (rpcEnvelope(value) && !definitions && !lessonMetadata(value)) return undefined;
    value = definitions || value;
    if (seen.has(value)) throw captureFailure('response_too_complex');
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > 4000) throw captureFailure('response_too_complex');
      const result = value.map(item => captureData(item, depth + 1, budget, seen));
      seen.delete(value);
      return result;
    }
    const result = Object.create(null);
    const entries = Object.entries(value);
    if (entries.length > 4000) throw captureFailure('response_too_complex');
    for (const [key, item] of entries) result[key] = captureData(item, depth + 1, budget, seen);
    seen.delete(value);
    return result;
  }

  function isMaterialData(value, depth = 0, budget = { count: 0 }) {
    if (++budget.count > 4000 || depth > 7) throw captureFailure('response_too_complex');
    if (!value || typeof value !== 'object') return false;
    if (rpcEnvelope(value)) {
      return Boolean(exerciseDefinitions(value) || bookCourses(value) || lessonMetadata(value));
    }
    if (Array.isArray(value)) return value.some(item => isMaterialData(item, depth + 1, budget));
    return Object.entries(value).some(([key, item]) =>
      materialKey.test(key) || !secretKey.test(key) && isMaterialData(item, depth + 1, budget));
  }

  const lessonSectionRoute = /^\/lesson-editor\/book\/([1-9]\d*)\/lesson\/([1-9]\d*)\/section(?:\/([1-9]\d*))?\/?$/;
  function sectionLanding(page, revision) {
    if (routeRevision !== revision + 1 || previousRoute !== routeUrl()) return null;
    const from = new URL(page), to = new URL(location.href);
    if (from.origin !== to.origin || routeFrom !== `${from.origin}${from.pathname}`) return null;
    const started = from.pathname.match(lessonSectionRoute), landed = to.pathname.match(lessonSectionRoute);
    if (!started || started[3] || !landed?.[3] || started[1] !== landed[1] || started[2] !== landed[2]) return null;
    return { book: landed[1], lesson: landed[2], section: landed[3] };
  }

  function matchesId(value, id) {
    return (typeof value === 'string' || Number.isSafeInteger(value)) && String(value) === id;
  }

  function confirmsSectionLanding(data, target) {
    if (Array.isArray(data)) return data.length > 0 && data.every(entry => confirmsSectionLanding(entry, target));
    if (lessonMetadata(data)) return matchesId(data.Value.Id, target.lesson) && matchesId(data.Value.Book?.Id, target.book);
    if (!exerciseDefinitions(data)) return false;
    const { SectionId, Items } = data.Value;
    if (SectionId !== undefined && !matchesId(SectionId, target.section)) return false;
    return (SectionId !== undefined || Items.length > 0) && Items.every(item => {
      const ids = [item.SectionId, item.LessonSectionId].filter(id => id !== undefined);
      return (SectionId !== undefined || ids.length > 0) && ids.every(id => matchesId(id, target.section));
    });
  }

  function deliver(kind, url, raw, { page, epoch, revision }, observeRpc) {
    if (epoch !== captureEpoch) return;
    if (!observing() || !materialPage() || !allowedEndpoint(url)) return;
    let parsed = raw;
    try {
      if (typeof raw === 'string') {
        if (raw.length > MAX_BYTES || new TextEncoder().encode(raw).byteLength > MAX_BYTES) {
          postIssue('response_too_large', page, epoch);
          return;
        }
        if (!/^[\s\x1e]*[\[{]/.test(raw)) return;
        parsed = JSON.parse(raw.replace(/^\x1e|\x1e$/g, ''));
      }
      if (!isMaterialData(parsed)) return;
      const data = captureData(parsed);
      if (!isMaterialData(data)) return;
      if (page !== location.href || routeRevision !== revision) {
        const landing = sectionLanding(page, revision);
        if (!landing || !confirmsSectionLanding(parsed, landing)) {
          postIssue('bootstrap_navigation_changed', page, epoch);
          return;
        }
      }
      const text = JSON.stringify(data);
      if (text.length > MAX_BYTES || new TextEncoder().encode(text).byteLength > MAX_BYTES) {
        postIssue('response_too_large', page, epoch);
        return;
      }
      const sanitizedUrl = safeUrl(url);
      if (!sanitizedUrl) return;
      accept({ kind, url: sanitizedUrl, receivedAt: new Date().toISOString(), data });
    } catch (error) {
      if (ISSUE_CODES.has(error?.captureCode)) postIssue(error.captureCode, page, epoch);
      // Unsupported/binary/non-JSON messages are not material exports.
    } finally {
      observeRpc?.(parsed);
    }
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.source !== CHANNEL_SOURCE || message.direction !== 'command' ||
      message.type !== 'CAPTURE_STATE' || typeof message.channel !== 'string' || message.channel.length > 100 ||
      !Number.isSafeInteger(message.revision) || message.revision < 0) return;
    if (channel && channel !== message.channel || message.revision < channelRevision) return;
    const revisionChanged = channelRevision !== message.revision;
    channel = message.channel;
    channelRevision = message.revision;
    restore(message.enabled, revisionChanged);
    postActivity();
  });

  // A same-document round trip can otherwise leave the old opening's proof
  // alive when it happens entirely between two navigation polls.
  function navigationChanged() {
    const next = routeUrl(), from = previousRoute;
    if (from === next) return;
    routeRevision++;
    routeFrom = from;
    previousRoute = next;
    if (stateKnown && enabled && channel && materialPage()) {
      window.postMessage({ source: CHANNEL_SOURCE, direction: 'navigation', channel, revision: channelRevision, from, to: next }, location.origin);
    }
  }
  for (const method of ['pushState', 'replaceState']) {
    const original = window.history?.[method];
    if (typeof original !== 'function') continue;
    window.history[method] = function (...args) {
      const result = Reflect.apply(original, this, args);
      navigationChanged();
      return result;
    };
  }
  window.addEventListener('popstate', navigationChanged);

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (...args) {
      const requestUrl = typeof args[0] === 'string' || args[0] instanceof URL ? String(args[0]) : args[0]?.url;
      const scope = responseScope();
      const requestObserved = observing();
      const finished = trackRequest(requestUrl);
      let promise;
      try { promise = Reflect.apply(originalFetch, this, args); }
      catch (error) { finished(); throw error; }
      promise.then(response => {
        if (!requestObserved || scope.epoch !== captureEpoch || !observing() || !materialPage() || !allowedEndpoint(response.url || requestUrl)) return;
        const type = response.headers?.get('content-type') || '';
        const length = Number(response.headers?.get('content-length') || 0);
        if (!/json/i.test(type) && !/\/(?:materials?|books?|lessons?|exercises?|sections?)(?:\/|\?|$)/i.test(requestUrl || '')) return;
        if (length > MAX_BYTES) { postIssue('response_too_large', scope.page, scope.epoch); return; }
        // Bound the clone so responses can be classified across a route change.
        const clone = response.clone();
        if (!clone.body?.getReader) return;
        const reader = clone.body.getReader();
        return (async () => {
          const decoder = new TextDecoder();
          let bytes = 0;
          let text = '';
          try {
            while (true) {
              const part = await reader.read();
              if (scope.epoch !== captureEpoch || !observing()) { void reader.cancel().catch(() => {}); return; }
              if (part.done) break;
              bytes += part.value.byteLength;
              if (bytes > MAX_BYTES) { postIssue('response_too_large', scope.page, scope.epoch); void reader.cancel().catch(() => {}); return; }
              text += decoder.decode(part.value, { stream: true });
            }
            text += decoder.decode();
            deliver('fetch', response.url || requestUrl, text, scope);
          } catch { /* Response stream can be aborted by the application. */ }
        })();
      }).catch(() => {}).finally(finished);
      return promise;
    };
  }

  if (typeof window.XMLHttpRequest === 'function') {
    const xhrUrls = new WeakMap();
    const originalOpen = window.XMLHttpRequest.prototype.open;
    const originalSend = window.XMLHttpRequest.prototype.send;
    window.XMLHttpRequest.prototype.open = function (...args) {
      xhrUrls.set(this, String(args[1]));
      return Reflect.apply(originalOpen, this, args);
    };
    window.XMLHttpRequest.prototype.send = function (...args) {
      const scope = responseScope();
      const requestObserved = observing();
      const finished = trackRequest(xhrUrls.get(this));
      this.addEventListener('loadend', () => {
        finished();
        const url = this.responseURL || xhrUrls.get(this);
        if (!requestObserved || scope.epoch !== captureEpoch || !observing() || !materialPage() || !allowedEndpoint(url)) return;
        try {
          if (this.responseType === 'json') deliver('xhr', url, this.response, scope);
          else if (this.responseType === '' || this.responseType === 'text') deliver('xhr', url, this.responseText, scope);
        } catch { /* Reading unsupported response types can throw. */ }
      }, { once: true });
      try { return Reflect.apply(originalSend, this, args); }
      catch (error) { finished(); throw error; }
    };
  }

  if (typeof window.WebSocket === 'function') {
    const OriginalSocket = window.WebSocket;
    const originalSend = OriginalSocket.prototype.send;
    OriginalSocket.prototype.send = function (...args) {
      const value = args[0], epoch = captureEpoch;
      if (typeof Blob !== 'undefined' && value instanceof Blob) {
        const result = Reflect.apply(originalSend, this, args);
        if (value.size <= MAX_RPC_REQUEST_BYTES) void value.text().then(text => trackSocketRequest(this, text, epoch)).catch(() => {});
        return result;
      }
      let raw = value;
      if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        raw = value.byteLength <= MAX_RPC_REQUEST_BYTES ? new TextDecoder().decode(value) : null;
      }
      const failed = trackSocketRequest(this, raw, epoch);
      try { return Reflect.apply(originalSend, this, args); }
      catch (error) { failed(); throw error; }
    };
    window.WebSocket = new Proxy(OriginalSocket, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget);
        const url = String(args[0]);
        const state = { url, pending: new Set() };
        socketRequests.set(socket, state);
        const close = () => { for (const entry of state.pending) releaseSocketRequest(entry); };
        socket.addEventListener('close', close);
        socket.addEventListener('error', close);
        socket.addEventListener('message', event => {
          if (!observing() || !materialPage() || !allowedEndpoint(url)) return;
          const scope = responseScope();
          const finish = parsed => finishSocketRequests(state, parsed);
          if (typeof event.data === 'string') deliver('websocket', url, event.data, scope, finish);
          else if (event.data instanceof ArrayBuffer) {
            if (event.data.byteLength > MAX_BYTES) postIssue('response_too_large', scope.page, scope.epoch);
            else deliver('websocket', url, new TextDecoder().decode(event.data), scope, finish);
          } else if (typeof Blob !== 'undefined' && event.data instanceof Blob) {
            if (event.data.size > MAX_BYTES) postIssue('response_too_large', scope.page, scope.epoch);
            else void event.data.text().then(text => deliver('websocket', url, text, scope, finish)).catch(() => {});
          }
        });
        return socket;
      },
    });
  }
})();
