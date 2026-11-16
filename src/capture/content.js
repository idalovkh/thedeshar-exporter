/* Isolated-world bridge and best-effort snapshot of the currently open material page. */
(() => {
  'use strict';
  const INSTALL_KEY = '__thedesharExporterContentV1';
  if (globalThis[INSTALL_KEY]) return;
  globalThis[INSTALL_KEY] = true;
  const SOURCE = 'thedeshar-exporter-v1';
  const channel = crypto.randomUUID();
  const documentToken = crypto.randomUUID();
  const MAX_BYTES = 8 * 1024 * 1024;
  const SECRET_KEY = /(?:password|passwd|passphrase|authorization|cookie|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token|jwt[_-]?token|client[_-]?secret|api[_-]?key|private[_-]?key|^token$|^jwt$|^secret$|^session$|^session_?id$|^credentials?$|^csrf(?:_?token)?$|^xsrf(?:_?token)?$|^email$|^phone(?:_number)?$|^students?$|^users?$|^payments?$)/i;
  const SECRET_QUERY = /^(?:.*token|auth(?:orization)?|api[_-]?key|key|password|passwd|secret|session(?:id)?|sid|jwt|signature|sig|credential|policy|key[_-]?pair[_-]?id|code|csrf(?:[_-]?token)?|xsrf(?:[_-]?token)?|x[_-]amz[_-].*|x[_-]goog[_-].*)$/i;
  // Revalidate the same confirmed definition DTO as hook.js and security.js;
  // page messages are untrusted even when they claim a read-only RPC method.
  const definitionFields = new Set(('Id Type Name Number ExerciseNumber IsAutoCheck IsLessonPage IsShowExerciseNumber JsonData Images ImageInputCorrectWord PasteWordByDrag InputCorrectFormWord SelectCorrectFormWord Essay ImageSelectCorrectWord Note Audios Button Text BuildWordFromLetters PracticeId PersonalMaterialId HomeworkLessonId PracticeNumber SectionId LessonSectionId Videos VideosUrl AudioRecording Questions QuestionAnswers MappingWords Words AddWordsToVocabulary Topic MappingImageByDrag GroupWordsByColumns Test QuestionWithCodingTexts SentencesInCorrectOrder Descriptions NumberToHeader MainNumberToHeader MiroBoard GooglePDF Wordwall Learningapps Genially Baamboozle Quizlet ChoiseExtraWords TrueOrFalse IsHidePupil ImagesJson AutoCheck TimerMinutes UsedNewConstructor Statistics').split(' '));
  const definitionTypes = new Set([2, 3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 41, 42, 43, 99]);
  const PAGE_CHROME = 'nav,aside,header,[role="navigation"],.sections-list,.lesson-viewer-header,.lesson-viewer-section-right_additional,.exercise-constructor,.recognition-text-helper-wrapper';
  const EXERCISE_ELEMENTS = '[data-exercise-id],[data-block-id],[class*="exercise-item"],[class*="exercise-wrapper"],[class*="exercise-container"],[class*="exercise-card"]';
  let enabled = false;
  let captureId = null;
  const validCaptureId = value => typeof value === 'string' && /^[a-zA-Z0-9-]{16,100}$/.test(value);
  let stateRevision = 0;
  let captureState = 'pending';
  const pageCommands = new Set(['MATERIAL_NAVIGATION', 'PREPARE_BOOK', 'PAGE_SNAPSHOT', 'OPEN_MATERIAL_ITEM', 'NAVIGATE_SOURCE']);
  const sectionVisit = globalThis.__thedesharCreateSectionVisit({ getUrl: () => location.href, getCaptureId: () => captureId });
  // Reported by the MAIN observer for the active capture revision only. The
  // collector treats it as a timing hint; snapshots never include it.
  let network = null;
  const ISSUE_CODES = new Set(['response_too_large', 'response_too_complex', 'bootstrap_overflow', 'bootstrap_navigation_changed']);

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

  // Retain only authored scoring rules; learner scores/history never cross worlds.
  function authoredStatistics(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const result = {};
    const unsupported = '[unsupported scoring definition]';
    const scalar = item => item === null || typeof item === 'number' && Number.isFinite(item) ||
      typeof item === 'string' && /^-?\d+(?:\.\d+)?$/.test(item) ? item : unsupported;
    if (Object.hasOwn(value, 'ScoringType')) result.ScoringType = scalar(value.ScoringType);
    if (Object.hasOwn(value, 'ConfigurationJson')) {
      let configuration = value.ConfigurationJson;
      if (configuration === null || typeof configuration === 'string' && !configuration.trim()) {
        result.ConfigurationJson = configuration;
        return result;
      }
      const serialized = typeof configuration === 'string';
      if (serialized) {
        if (configuration.length > 1024 * 1024 || new TextEncoder().encode(configuration).byteLength > 1024 * 1024) configuration = undefined;
        else {
          try { configuration = JSON.parse(configuration); } catch { configuration = undefined; }
        }
      }
      if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
        result.ConfigurationJson = unsupported;
      } else {
        const config = {};
        for (const field of ['TotalPoints', 'TotalCountAnswers', 'MaxPoints']) {
          if (Object.hasOwn(configuration, field)) config[field] = scalar(configuration[field]);
        }
        for (const [field, fields] of [['TestAnswers', ['AnswerId', 'Points']], ['Points', ['CountAnswersFalse', 'Point']]]) {
          if (!Object.hasOwn(configuration, field)) continue;
          config[field] = Array.isArray(configuration[field]) && configuration[field].length <= 4000 ? configuration[field].map(item => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return unsupported;
            return Object.fromEntries(fields.filter(name => Object.hasOwn(item, name)).map(name => [name, scalar(item[name])]));
          }) : unsupported;
        }
        result.ConfigurationJson = serialized ? JSON.stringify(config) : config;
      }
    }
    return Object.keys(result).length ? result : undefined;
  }

  function parsedDefinitionJson(key, value) {
    if (!['JsonData', 'ImagesJson'].includes(key) || typeof value !== 'string' ||
      value.length > MAX_BYTES || new TextEncoder().encode(value).byteLength > MAX_BYTES) return undefined;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : undefined;
    } catch { return undefined; }
  }

  function isMaterialPage() {
    return /\/(?:cabinet\/(?:school|teacher)\/materials(?:\/|$)|lesson-editor(?:\/|$))/.test(location.pathname);
  }

  function safeUrl(value) {
    try {
      const url = new URL(value, location.href);
      if (!/^(?:https?|wss?):$/.test(url.protocol)) return null;
      url.username = '';
      url.password = '';
      url.hash = '';
      for (const key of [...url.searchParams.keys()]) if (SECRET_QUERY.test(key)) url.searchParams.delete(key);
      return url.href;
    } catch { return null; }
  }

  function safeReference(value) {
    const encoded = /&(?:amp|#0*38|#x0*26);/i.test(value);
    const decoded = value.replace(/&(?:amp|#0*38|#x0*26);/gi, '&');
    const sanitized = safeUrl(decoded);
    return encoded && sanitized ? sanitized.replace(/&/g, '&amp;') : sanitized;
  }

  function captureFailure(code) { return Object.assign(new Error(code), { captureCode: code }); }

  function sanitize(value, depth = 0, seen = new WeakSet(), budget = { count: 0 }) {
    if (++budget.count > 100000 || depth > 24) throw captureFailure('response_too_complex');
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      if (/\bBearer\s+[A-Za-z0-9._~+\/-]+/i.test(value) || /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(value)) return '[redacted]';
      if (/^(?:https?|wss?):\/\//i.test(value)) return safeReference(value);
      if (/^\/(?!\/)[^\s<>]*[?#]/.test(value)) return safeReference(value);
      const stripped = value.replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, match => safeReference(match) || '[unsupported URL]');
      return stripped;
    }
    if (!value || typeof value !== 'object') return undefined;
    const definitions = exerciseDefinitions(value) || bookCourses(value);
    if (rpcEnvelope(value) && !definitions && !lessonMetadata(value)) return undefined;
    value = definitions || value;
    if (seen.has(value)) throw captureFailure('response_too_complex');
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > 4000) throw captureFailure('response_too_complex');
      const result = value.map(item => sanitize(item, depth + 1, seen, budget));
      seen.delete(value);
      return result;
    }
    const result = Object.create(null);
    const entries = Object.entries(value);
    if (entries.length > 4000) throw captureFailure('response_too_complex');
    for (const [key, item] of entries) {
      if (SECRET_KEY.test(key)) continue;
      if (key === 'Statistics') {
        const statistics = authoredStatistics(item);
        if (statistics !== undefined) result[key] = sanitize(statistics, depth + 1, seen, budget);
        continue;
      }
      const parsed = parsedDefinitionJson(key, item);
      result[key] = parsed === undefined ? sanitize(item, depth + 1, seen, budget)
        : JSON.stringify(sanitize(parsed, depth + 1, seen, budget) ?? null);
    }
    seen.delete(value);
    return result;
  }

  function setEnabled(value) {
    enabled = value === true && validCaptureId(captureId) && isMaterialPage();
    network = null;
    sectionVisit.begin();
    window.postMessage({ source: SOURCE, direction: 'command', type: 'CAPTURE_STATE', channel, revision: stateRevision, enabled }, location.origin);
  }

  function materialPayload(value, depth = 0, budget = { count: 0 }) {
    if (++budget.count > 4000 || depth > 7) throw captureFailure('response_too_complex');
    if (!value || typeof value !== 'object') return false;
    if (rpcEnvelope(value)) {
      return Boolean(exerciseDefinitions(value) || bookCourses(value) || lessonMetadata(value));
    }
    if (Array.isArray(value)) return value.some(item => materialPayload(item, depth + 1, budget));
    return Object.entries(value).some(([key, item]) => /^(?:materials?|books?|lessons?|sections?|exercises?|units?|blocks?|exercise_type|exerciseType|answer_key|answerKey|correct_answers|correctAnswers|wordlist|word_list|vocabulary_words)$/i.test(key) || materialPayload(item, depth + 1, budget));
  }

  function applyBookInventory(value, depth = 0, budget = { count: 0 }) {
    if (++budget.count > 4000 || depth > 7 || !value || typeof value !== 'object') return;
    const inventory = bookCourses(value);
    if (inventory) {
      // Bind the response to this source tab, never a page-supplied URL.
      if (/^\/cabinet\/(?:school|teacher)\/materials\/book\/\d+\/content\/?$/.test(location.pathname)) {
        globalThis.__thedesharNavigation?.setBookInventory({ url: `${location.origin}${location.pathname}`, groups: inventory.Value });
      }
      return;
    }
    if (rpcEnvelope(value)) return;
    for (const child of Object.values(value)) applyBookInventory(child, depth + 1, budget);
  }

  function send(message) {
    try { return Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => null); }
    catch { return Promise.resolve(null); }
  }

  window.addEventListener('message', event => {
    if (!enabled || !isMaterialPage() || event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.source !== SOURCE || message.channel !== channel || message.revision !== stateRevision) return;
    if (message.direction === 'navigation') {
      sectionVisit.navigated(message.from, message.to);
      return;
    }
    if (message.direction === 'activity') {
      if (Number.isSafeInteger(message.pending) && message.pending >= 0 && message.pending <= 100000) network = { pending: message.pending, changedAt: Date.now() };
      return;
    }
    if (network) network.changedAt = Date.now();
    if (message.direction === 'issue') {
      if (ISSUE_CODES.has(message.code)) void send({ type: 'CAPTURE_ISSUE', captureId, code: message.code });
      return;
    }
    if (message.direction !== 'event') return;
    const sourceEvent = message.event;
    if (!sourceEvent || !['fetch', 'xhr', 'websocket'].includes(sourceEvent.kind)) return;
    try {
      const url = safeUrl(sourceEvent.url);
      if (!url) return;
      const endpoint = new URL(url);
      if (/(?:^|\/)(?:auth|login|logout|oauth|signin|signup|account|profile|users?|students?|employees?|members?|payments?|billing|finance|notifications?|analytics|telemetry|messages?|chats?)(?:\/|$)/i.test(endpoint.pathname) ||
        !(endpoint.origin === location.origin || /(?:^|\.)(?:progressme\.ru|docstorio\.com)$/.test(endpoint.hostname))) return;
      const captureEvent = { kind: sourceEvent.kind, url, receivedAt: new Date().toISOString(), data: sanitize(sourceEvent.data) };
      if (!materialPayload(captureEvent.data)) return;
      const serialized = JSON.stringify(captureEvent);
      if (serialized.length > MAX_BYTES || new TextEncoder().encode(serialized).byteLength > MAX_BYTES) {
        void send({ type: 'CAPTURE_ISSUE', captureId, code: 'response_too_large' });
        return;
      }
      applyBookInventory(captureEvent.data);
      const observation = sectionVisit.observe();
      void send({ type: 'CAPTURE_EVENT', captureId, observedUrl: observation.url, event: captureEvent }).then(response => {
        if (enabled && response?.ok) sectionVisit.confirm(observation, response.exerciseCapture);
      });
    } catch (error) {
      if (ISSUE_CODES.has(error?.captureCode)) void send({ type: 'CAPTURE_ISSUE', captureId, code: error.captureCode });
      // Page messages are untrusted, even on an authorized source page.
    }
  });

  function withNavigationState(response) {
    if (!response?.navigation) return response;
    const navigation = { ...response.navigation, documentToken, sectionVisit: sectionVisit.inspect() };
    if (enabled && network) navigation.network = { pending: network.pending, idleMs: Math.max(0, Date.now() - network.changedAt) };
    return { ...response, navigation };
  }

  function visible(element) {
    if (element.closest(`${PAGE_CHROME},[hidden],[aria-hidden="true"]`)) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  }

  function routeInfo() {
    const path = location.pathname;
    return {
      materialId: path.match(/\/book\/([^/]+)/)?.[1] || null,
      lessonId: path.match(/\/lesson\/([^/]+)/)?.[1] || null,
      sectionId: path.match(/\/section\/([^/]+)/)?.[1] || null,
      kind: path.includes('/lesson-editor/') ? 'lesson' : /\/book\//.test(path) ? 'material' : 'library',
    };
  }

  function sanitizedHtml(element) {
    const clone = element.cloneNode(true);
    for (const node of clone.querySelectorAll(`script,style,link,meta,noscript,template,form,input,textarea,select,svg,canvas,object,embed,${PAGE_CHROME}`)) node.remove();
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
    const comments = [];
    while (walker.nextNode()) comments.push(walker.currentNode);
    for (const comment of comments) comment.remove();
    for (const node of [clone, ...clone.querySelectorAll('*')]) {
      for (const attribute of [...node.attributes]) {
        const name = attribute.name.toLowerCase();
        if (['src', 'href', 'poster'].includes(name)) {
          const value = safeUrl(attribute.value);
          if (value && /^https?:/.test(value)) node.setAttribute(name, value);
          else node.removeAttribute(name);
        } else if (!['alt', 'title', 'colspan', 'rowspan', 'width', 'height', 'lang', 'dir'].includes(name)) node.removeAttribute(name);
      }
    }
    return clone.innerHTML;
  }

  function bookCover(route, navigation, warnings) {
    if (route.lessonId || !/^\/cabinet\/(?:school|teacher)\/materials\/book\/\d+\/content\/?$/.test(location.pathname)) return null;
    const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
    const excluded = 'nav,aside,[role="navigation"],.unit_li,.sections-list,.lesson-viewer-header,.exercise-constructor,form,button,[hidden],[aria-hidden="true"]';
    const shown = element => {
      if (element.closest(excluded)) return false;
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    };
    const headings = [...document.querySelectorAll('h1')].filter(element => shown(element) && normalize(element.innerText) &&
      (!navigation?.title || normalize(element.innerText) === normalize(navigation.title)));
    if (headings.length !== 1) return null;
    const heading = headings[0];
    // Source themes render the cover as either an img or a CSS background.
    // Stay in the small title/header branch; never search the page or lesson cards.
    let scope = heading.parentElement;
    for (let depth = 0; scope && depth < 4; depth++, scope = scope.parentElement) {
      if (scope.matches('body,html,main') || scope.querySelector(`.unit_li,.units_list,.section_accordion_list,${EXERCISE_ELEMENTS}`)) break;
      const nodes = [...scope.querySelectorAll('*')];
      if (nodes.length > 80 || scope.querySelectorAll('h1').length !== 1) break;
      const candidates = new Map();
      for (const node of nodes) {
        if (node.contains(heading) || !shown(node)) continue;
        let raw = node.tagName === 'IMG' ? node.currentSrc || node.src : '';
        if (!raw) {
          const background = getComputedStyle(node).backgroundImage || '';
          const match = /^url\(\s*(?:"([^"]+)"|'([^']+)'|([^'"\)]+))\s*\)$/i.exec(background.trim());
          raw = match?.[1] || match?.[2] || match?.[3]?.trim();
        }
        if (!raw) continue;
        const url = safeUrl(raw);
        if (url && /^https?:/.test(url)) candidates.set(url, raw);
      }
      if (candidates.size === 1) return candidates.values().next().value;
      if (candidates.size > 1) {
        warnings.push('В шапке книги найдено несколько изображений; обложка не определена однозначно.');
        return null;
      }
    }
    return null;
  }

  function snapshot() {
    if (!isMaterialPage()) return { ok: false, error: 'Откройте библиотеку материалов или редактор урока на учебной платформе.' };
    const route = routeInfo();
    const warnings = ['Снимок содержит только открытые и загруженные элементы. Правильные ответы из внешнего вида упражнений не определяются.'];
    const navigation = globalThis.__thedesharNavigation?.inspect();
    const selectors = route.kind === 'lesson'
      ? ['.lesson-viewer-layout_main', '[data-testid="lesson-content"]', '.lesson-content', '.lesson-editor-content']
      : ['.materials-content', '.book-content', '[data-testid="book-content"]'];
    // Query separately: a combined selector returns the first node in document order,
    // which used to let the global <main> or document.body include chat and site chrome.
    const preferred = selectors.map(selector => document.querySelector(selector)).find(element => element && visible(element));
    const observed = preferred ? [preferred] : route.kind === 'lesson'
      ? [...document.querySelectorAll(EXERCISE_ELEMENTS)].filter(visible) : [];
    const roots = observed.filter(element => !observed.some(parent => parent !== element && parent.contains(element)));
    if (route.kind === 'lesson' && !roots.length) return { ok: false, error: 'Не найдено учебное содержимое урока. Дождитесь его загрузки и повторите сбор; интерфейс страницы не сохранён вместо упражнений.' };
    const withinRoots = selector => [...new Set(roots.flatMap(root => [
      ...(root.matches(selector) ? [root] : []), ...root.querySelectorAll(selector),
    ]))].filter(visible);
    const headings = withinRoots('h1,h2,h3,h4,[role="heading"]').slice(0, 100).map(element => ({ level: Number(element.tagName.slice(1)) || Number(element.getAttribute('aria-level')) || 0, text: element.innerText.trim().slice(0, 500) })).filter(item => item.text);
    const links = withinRoots('a[href]').map(element => ({ url: safeUrl(element.href), title: element.innerText.trim().slice(0, 300) }))
      .filter(item => item.url && /\/(?:materials(?:\/|$)|lesson-editor(?:\/|$))/.test(new URL(item.url).pathname)).slice(0, 300);

    const candidates = withinRoots(`${EXERCISE_ELEMENTS},.content-wrapper`);
    const topLevel = candidates.filter(element => !candidates.some(parent => parent !== element && parent.contains(element)));
    const fragments = topLevel.length ? topLevel : withinRoots('article,[contenteditable="true"],p,table,figure').filter(element => !element.closest('button,form'));
    let htmlSize = 0;
    const blocks = [];
    if (fragments.length > 300) throw captureFailure('response_too_complex');
    for (const element of fragments) {
      if (fragments.some(parent => parent !== element && parent.contains(element))) continue;
      const html = sanitizedHtml(element);
      if ((htmlSize += new TextEncoder().encode(html).byteLength) > MAX_BYTES) throw captureFailure('response_too_large');
      const text = (element.innerText || element.textContent || '').trim();
      if (!text && !element.querySelector('img,audio,video,iframe')) continue;
      blocks.push({ type: 'dom', sourceId: element.getAttribute('data-exercise-id') || element.getAttribute('data-block-id') || null,
        sourceType: element.getAttribute('data-exercise-type') || element.getAttribute('data-type') || null, position: blocks.length, html, text });
    }

    const assets = [];
    const seenAssets = new Set();
    function addAsset(raw, kind, name) {
      if (!raw) return;
      const url = safeUrl(raw);
      if (!url || !/^https?:/.test(url)) {
        if (/^(?:blob|data):/.test(raw)) warnings.push('Локальное blob/data-медиа не включено в список скачивания.');
        return;
      }
      if (seenAssets.has(url)) return;
      if (assets.length >= 300) throw captureFailure('response_too_complex');
      seenAssets.add(url);
      let sensitive = false;
      try {
        const original = new URL(raw, location.href);
        sensitive = [...original.searchParams.keys()].some(key => SECRET_QUERY.test(key));
      } catch { /* Invalid URL was already excluded. */ }
      const item = { url, kind, name: String(name || '').slice(0, 200) };
      if (sensitive) { item.downloadUnavailable = true; item.reason = 'Адрес содержит данные доступа; они не сохраняются. Потребуется отдельное скачивание файла.'; }
      assets.push(item);
    }
    const cover = bookCover(route, navigation, warnings);
    if (cover) addAsset(cover, 'image', 'Обложка книги');
    // The editor mounts helpers beside the exercise list inside the lesson main.
    // Its media are not lesson attachments, even if the helper is currently visible.
    const lists = withinRoots('.exercises-list');
    const mediaRoots = lists.length ? lists : topLevel.length ? topLevel : roots;
    const mediaSelector = 'img,audio,video,source,iframe,object,a[href]';
    const mediaElements = [...new Set(mediaRoots.flatMap(root => [
      ...(root.matches(mediaSelector) ? [root] : []), ...root.querySelectorAll(mediaSelector),
    ]))]
      .filter(element => !element.closest(`${PAGE_CHROME},form`) &&
        (visible(element) || ['AUDIO', 'VIDEO', 'SOURCE'].includes(element.tagName)));
    for (const element of mediaElements) {
      const tag = element.tagName.toLowerCase();
      if (tag === 'img') addAsset(element.currentSrc || element.src, 'image', element.alt);
      else if (tag === 'audio' || tag === 'video') {
        addAsset(element.currentSrc || element.src, tag, element.getAttribute('title'));
        for (const source of element.querySelectorAll('source[src]')) addAsset(source.src, tag, element.getAttribute('title'));
        if (tag === 'video') addAsset(element.poster, 'image', 'Обложка видео');
      } else if (tag === 'source') addAsset(element.src, element.parentElement?.tagName === 'AUDIO' ? 'audio' : 'video', '');
      else if (tag === 'iframe') addAsset(element.src, /\.pdf(?:$|[?#])/i.test(element.src) ? 'pdf' : 'embed', element.title);
      else if (tag === 'object') addAsset(element.data, /pdf/i.test(element.type) ? 'pdf' : 'file', '');
      else if (/\.(?:pdf|mp3|wav|ogg|mp4|webm|png|jpe?g|gif|webp)(?:$|[?#])/i.test(element.href)) {
        const kind = /\.pdf(?:$|[?#])/i.test(element.href) ? 'pdf' : /\.(?:mp3|wav|ogg)(?:$|[?#])/i.test(element.href) ? 'audio' : /\.(?:mp4|webm)(?:$|[?#])/i.test(element.href) ? 'video' : 'image';
        addAsset(element.href, kind, element.innerText);
      }
    }
    if (!preferred && roots.length) warnings.push('Контейнер урока не распознан; сохранены только явно обозначенные учебные блоки. Полнота страницы не подтверждена.');
    if (!roots.length) warnings.push(`В содержании книги сохранены название, список уроков${cover ? ' и обложка' : ''}. Учебные блоки и остальные файлы собираются внутри уроков.`);
    if (route.kind === 'lesson' && !blocks.length) warnings.push('Учебные блоки не распознаны в DOM. Для точной структуры включите сбор данных и перезагрузите урок.');
    const sectionHeader = document.querySelector('.lesson-viewer-header_input');
    const result = { schemaVersion: 1, url: safeUrl(location.href), capturedAt: new Date().toISOString(),
      title: (route.kind !== 'lesson' ? navigation?.title : '') || (sectionHeader?.value || sectionHeader?.innerText || '').trim() || headings[0]?.text || document.title,
      route, headings, links, blocks, assets, ...(cover ? { coverUrl: safeUrl(cover) } : {}), navigation, warnings: [...new Set(warnings)] };
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_BYTES) throw captureFailure('response_too_large');
    return { ok: true, snapshot: result };
  }

  function handleSourceMessage(message, respond) {
    if (pageCommands.has(message?.type) &&
      (message.expectedDocumentToken !== undefined || message.type === 'NAVIGATE_SOURCE') && message.expectedDocumentToken !== documentToken) {
      respond({ ok: false, code: 'source_changed', error: 'Исходная вкладка перезагрузилась. Повторно прочитайте навигацию перед продолжением.' });
      return false;
    }
    if (pageCommands.has(message?.type) && captureState !== 'ready') {
      respond({ ok: false, code: captureState === 'pending' ? 'source_loading' : 'source_unavailable',
        error: captureState === 'pending' ? 'Подключаем страницу книги. Ожидаем подтверждения состояния сбора.'
          : 'Не удалось подтвердить состояние сбора. Обновите вкладку книги и снова нажмите значок exporter.' });
      return false;
    }
    if (message?.expectedVisitToken !== undefined && message.expectedVisitToken !== sectionVisit.inspect().token) {
      respond({ ok: false, code: 'source_changed', error: 'Раздел был открыт заново. Повторно прочитайте навигацию.' });
      return false;
    }
    if (message?.requireExerciseCapture && (!enabled || !sectionVisit.inspect().received || !globalThis.__thedesharNavigation?.inspect().ready)) {
      respond({ ok: false, code: 'navigation_stale', error: 'Задания текущего раздела ещё не готовы к сохранению.' });
      return false;
    }
    if (message?.type === 'CAPTURE_START') {
      if (!validCaptureId(message.captureId)) { respond({ ok: false, code: 'source_update_required', error: 'Обновите расширение и повторите сбор учебника.' }); return false; }
      stateRevision++; captureId = message.captureId; setEnabled(true);
      captureState = 'ready';
      respond({ ok: enabled, enabled, captureId, ...(!enabled ? { error: 'Откройте страницу учебных материалов.' } : {}) });
    }
    else if (message?.type === 'CAPTURE_STOP') {
      if ((message.captureId ?? null) !== captureId) { respond({ ok: true, enabled, captureId, ignored: true }); return false; }
      stateRevision++; setEnabled(false); captureId = null;
      captureState = 'ready';
      respond({ ok: true, enabled: false });
    }
    else if (message?.type === 'PAGE_SNAPSHOT') {
      try { respond(snapshot()); } catch (error) {
        if (ISSUE_CODES.has(error?.captureCode)) void send({ type: 'CAPTURE_ISSUE', captureId, code: error.captureCode });
        respond({ ok: false, error: error?.captureCode === 'response_too_large'
          ? 'Снимок секции превышает допустимый размер. Данные не обрезаны; соберите меньшую секцию.'
          : error?.captureCode === 'response_too_complex'
            ? 'Структура секции превышает допустимую сложность. Данные не обрезаны.'
            : 'Не удалось прочитать содержимое страницы.' });
      }
    }
    else if (message?.type === 'MATERIAL_NAVIGATION') {
      try { respond(withNavigationState({ ok: true, navigation: globalThis.__thedesharNavigation?.inspect() })); }
      catch { respond({ ok: false, error: 'Не удалось прочитать список уроков и разделов.' }); }
    }
    else if (message?.type === 'PREPARE_BOOK') {
      // The background validates collection ownership and capture state. Its
      // reload command can arrive before CAPTURE_READY restores this flag.
      try { respond(withNavigationState(globalThis.__thedesharNavigation?.prepare({ expectedUrl: message.expectedUrl })) || { ok: false, error: 'Обновите расширение и вкладку источника.' }); }
      catch { respond({ ok: false, error: 'Не удалось раскрыть разделы учебника.' }); }
    }
    else if (message?.type === 'OPEN_MATERIAL_ITEM') {
      if (!enabled) respond({ ok: false, error: 'Сбор выключен.' });
      else {
        try { sectionVisit.begin(); respond(globalThis.__thedesharNavigation?.open({ key: message.key, expectedUrl: message.expectedUrl }) || { ok: false, error: 'Обновите расширение и вкладку источника.' }); }
        catch { respond({ ok: false, error: 'Не удалось открыть раздел.' }); }
      }
    }
    else if (message?.type === 'NAVIGATE_SOURCE') {
      try {
        const current = new URL(location.href), expected = new URL(message.expectedUrl), target = new URL(message.url);
        const bookPath = /^\/cabinet\/(?:school|teacher)\/materials\/book\/(\d+)\/content\/?$/;
        const lessonPath = /^\/lesson-editor\/book\/(\d+)\/lesson\/\d+(?:\/section(?:\/(?:\d+|for-homework))?)?\/?$/;
        const currentBook = (current.pathname.match(bookPath) || current.pathname.match(lessonPath))?.[1];
        const targetBook = target.pathname.match(bookPath)?.[1];
        const allowedTarget = message.reload === true
          ? target.pathname === current.pathname
          : targetBook === currentBook;
        if (current.protocol !== 'https:' || current.port ||
          !['progressme.ru', 'platform.desharschool.ru'].includes(current.hostname) && current.origin !== globalThis.__thedesharExporterSourceOrigin ||
          !currentBook || expected.username || expected.password || expected.origin !== current.origin || expected.pathname !== current.pathname ||
          target.username || target.password || target.origin !== current.origin || target.search || target.hash ||
          typeof message.reload !== 'boolean' || !allowedTarget) {
          respond({ ok: false, code: 'source_changed', error: 'Исходная вкладка изменилась. Переход внутри выбранной книги остановлен.' });
          return false;
        }
        // The identity check and navigation share one task in this document.
        // A same-URL replacement cannot receive a reload for its predecessor.
        if (message.reload) location.reload();
        else location.assign(target.href);
        respond({ ok: true });
      } catch {
        respond({ ok: false, code: 'source_changed', error: 'Не удалось перейти внутри выбранной книги. Повторите сбор из содержания.' });
      }
    }
    return false;
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    const wrongDocument = pageCommands.has(message?.type) &&
      (message.expectedDocumentToken !== undefined || message.type === 'NAVIGATE_SOURCE') && message.expectedDocumentToken !== documentToken;
    // Startup and explicit capture commands keep their synchronous handshake.
    if (!pageCommands.has(message?.type) || captureState !== 'ready' || wrongDocument) return handleSourceMessage(message, respond);
    const revision = stateRevision;
    void sectionVisit.flush().then(checkNavigation => {
      if (stateRevision !== revision) {
        respond({ ok: false, code: 'source_changed', error: 'Состояние сбора изменилось. Команда страницы отменена.' });
        return;
      }
      try { checkNavigation(); }
      catch {
        respond({ ok: false, code: 'source_loading', error: 'Страница книги изменилась во время проверки. Ожидаем завершения перехода.' });
        return;
      }
      // All document, route and visit checks run after queued history events.
      // In particular CAPTURE_STOP cannot leave a queued mutation authorized.
      handleSourceMessage(message, respond);
    }, error => {
      respond({ ok: false, code: error?.code === 'source_update_required' ? 'source_update_required' : 'source_loading',
        error: error?.code === 'source_update_required' ? 'Обновите Chrome и вкладку книги для безопасной проверки переходов.'
          : 'Ожидаем завершения обработки перехода страницы книги.' });
    }).catch(() => { /* A navigation may have closed the runtime response port. */ });
    return true;
  });

  // The background owns tab activation; no credentials or page localStorage are read.
  const restoringRevision = stateRevision;
  void send({ type: 'CAPTURE_READY' }).then(response => {
    if (stateRevision !== restoringRevision) return;
    const restoredEnabled = typeof response?.enabled === 'boolean' ? response.enabled
      : typeof response?.captureEnabled === 'boolean' ? response.captureEnabled : undefined;
    if (!response || typeof response !== 'object' || Array.isArray(response) || response.ok === false ||
      restoredEnabled === undefined || restoredEnabled && !validCaptureId(response.captureId)) {
      captureState = 'unavailable';
      return;
    }
    captureId = validCaptureId(response.captureId) ? response.captureId : null;
    setEnabled(restoredEnabled);
    captureState = 'ready';
  });
})();
