/* Read-only navigation through the source site's known material controls. */
(() => {
  'use strict';
  if (globalThis.__thedesharNavigation) return;

  const MAX_ITEMS = 1000;
  const HOSTS = new Set(['progressme.ru', 'platform.desharschool.ru']);
  const PARTIAL_WARNING = 'Обход охватывает только загруженные элементы страницы; отсутствие других уроков и разделов не подтверждается.';
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
  let bookInventory = null;
  let observedNavigation = null;

  function routeFor(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.port || url.username || url.password ||
          !HOSTS.has(url.hostname) && url.origin !== globalThis.__thedesharExporterSourceOrigin) return null;
      const book = url.pathname.match(/^\/cabinet\/(?:school|teacher)\/materials\/book\/(\d+)\/content\/?$/);
      const lesson = url.pathname.match(/^\/lesson-editor\/book\/(\d+)\/lesson\/(\d+)(?:\/section(?:\/(\d+|for-homework))?)?\/?$/);
      if (!book && !lesson) return null;
      return { url: `${url.origin}${url.pathname}`, kind: book ? 'book' : 'lesson', materialId: (book || lesson)[1], lessonId: lesson?.[2] || null, sectionId: lesson?.[3] || null };
    } catch { return null; }
  }

  function visible(element) {
    if (!element || element.isConnected === false || element.closest('[hidden],[aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && element.getClientRects().length > 0;
  }

  function enabled(element) {
    return visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true';
  }

  function signature(value) {
    const text = String(value || '');
    const bounded = normalize(text.slice(0, 200000));
    let hash = 2166136261;
    for (let index = 0; index < bounded.length; index++) hash = Math.imul(hash ^ bounded.charCodeAt(index), 16777619) >>> 0;
    return `${text.length}:${hash.toString(16)}`;
  }

  function sourceIdentity(element, kind, route) {
    const container = kind === 'lesson' ? element.closest('.unit_li') : element;
    const attribute = kind === 'lesson' ? 'data-lesson-id' : kind === 'section' ? 'data-section-id' : '';
    const id = attribute && [element, container].map(node => node?.getAttribute(attribute)).find(value => /^\d+$/.test(value || ''));
    if (id) return id;
    // Only known source routes identify a lesson/section. Generic DOM IDs and
    // Vue component internals do not provide a trustworthy material identity.
    for (const link of [element, ...(container?.querySelectorAll('a[href]') || [])]) {
      const href = link.getAttribute('href');
      if (!href) continue;
      let absolute;
      try { absolute = new URL(href, location.href).href; } catch { continue; }
      const target = routeFor(absolute);
      if (target?.materialId !== route.materialId || target?.kind !== 'lesson') continue;
      if (new URL(target.url).origin !== new URL(route.url).origin) continue;
      if (kind === 'lesson') return target.lessonId;
      if (kind === 'section' && target.lessonId === route.lessonId && /^\d+$/.test(target.sectionId || '')) return target.sectionId;
    }
    return '';
  }

  function scan() {
    const route = routeFor(location.href);
    if (!route) return { result: { url: '', kind: 'unsupported', materialId: null, lessonId: null, title: '', items: [], ready: false, blocked: true, contentSignature: '', warnings: ['Откройте содержание книги или редактор урока на учебной платформе.'] }, entries: [] };
    const warnings = [PARTIAL_WARNING];
    const entries = [];
    let blocked = false;
    const scope = `${route.materialId}/${route.lessonId || 'book'}`;
    const titleCounts = new Map();
    const add = (element, title, kind, active = false) => {
      title = normalize(title);
      const unnamedSection = !title && kind === 'section' &&
        element.classList.contains('regular') && element.closest('.sections-list');
      if ((!title && !unnamedSection) || title.length > 500 || !enabled(element)) {
        warnings.push('Некоторые элементы навигации недоступны или не имеют однозначного названия.');
        blocked = true;
        return;
      }
      const identity = `${kind}:${title}`;
      const occurrence = (titleCounts.get(identity) || 0) + 1;
      titleCounts.set(identity, occurrence);
      const sourceId = sourceIdentity(element, kind, route);
      entries.push({ element, identity, sourceId, item: { key: sourceId ? `${scope}/${kind}/id/${sourceId}` : `${scope}/${kind}/${encodeURIComponent(title)}/${occurrence}`, title: title || 'Раздел без названия', kind, active,
        ...(sourceId ? { sourceId } : {}) } });
    };
    const limited = selector => {
      const elements = [...document.querySelectorAll(selector)].filter(visible);
      if (elements.length > MAX_ITEMS) {
        warnings.push(`Найдено больше ${MAX_ITEMS} элементов навигации. Автоматический обход этой страницы остановлен.`);
        blocked = true;
      }
      return elements.slice(0, MAX_ITEMS);
    };

    let title = '';
    let content = '';
    let readinessReason = '';
    let exerciseState;
    let bookState;
    let ready = document.readyState !== 'loading';
    if (route.kind === 'book') {
      const heading = [...document.querySelectorAll('h1')].find(element => visible(element) &&
        !element.closest('.unit_li,nav,aside,[role="navigation"]') && normalize(element.innerText));
      title = normalize(heading?.innerText).slice(0, 500);
      for (const card of limited('.unit_li')) {
        const desktop = [...card.querySelectorAll('button.open_lesson-desc')].filter(visible);
        const mobile = [...card.querySelectorAll('button.open_lesson-mobile')].filter(visible);
        const buttons = desktop.length ? desktop : mobile;
        if (buttons.length !== 1 || desktop.length && normalize(buttons[0]?.innerText) !== 'Открыть урок' || !desktop.length && !buttons[0]?.querySelector('.iconedv-Arrow-Right')) {
          warnings.push('Карточка урока не содержит единственную распознанную кнопку «Открыть урок».');
          blocked = true;
          continue;
        }
        const label = buttons[0].innerText;
        const text = String(card.innerText || '');
        const split = label ? text.indexOf(label) : -1;
        const name = card.querySelector('.info')?.querySelector('p')?.innerText;
        add(buttons[0], name || (split >= 0 ? text.slice(0, split) : ''), 'lesson');
      }
      content = entries.map(entry => entry.item.title).join('\n');
      bookState = { visibleLessons: entries.length,
        ...(bookInventory?.url === route.url ? { expectedLessons: bookInventory.expectedLessons } : {}) };
      ready = ready && entries.length > 0;
      const groups = [...document.querySelectorAll('.section_accordion_li-inner')].filter(group => visible(group) && group.closest('.section_accordion_list'));
      const closed = groups.filter(group => !group.classList.contains('open'));
      if (closed.length) {
        ready = false;
        readinessReason = `Раскрываем разделы учебника: осталось ${closed.length}.`;
      } else if (groups.length && (!bookInventory || bookInventory.url !== route.url)) {
        ready = false;
        readinessReason = 'Ожидаем данные о количестве уроков в разделах учебника.';
      } else if (bookInventory?.url === route.url && entries.length !== bookInventory.expectedLessons) {
        ready = false;
        readinessReason = `Загружаем список уроков: ${entries.length} из ${bookInventory.expectedLessons}.`;
      } else if (!entries.length) readinessReason = 'Список уроков ещё не загрузился либо учебник пуст.';

      const filters = document.querySelectorAll('input[type="search"],input[placeholder*="Поиск"],input[placeholder*="поиск"],input[placeholder*="Найти"],input[placeholder*="найти"],input[placeholder*="назван"],input[placeholder*="Search"],input[placeholder*="search"]');
      if ([...filters].some(element => visible(element) && normalize(element.value))) {
        warnings.push('В книге включён поиск. Очистите фильтр перед автоматическим обходом.');
        blocked = true;
      }
    } else {
      const main = document.querySelector('.lesson-viewer-layout_main');
      const header = document.querySelector('.lesson-viewer-header_input');
      title = normalize(header?.value || header?.innerText || header?.textContent).slice(0, 500);
      content = main?.innerText || main?.textContent || '';
      // Confirmed ProgressMe Vue3Exercises DOM: the layout/header mount before
      // exercise requests finish, and the previous exercise list can remain in
      // the DOM while its loader is visible. An explicit empty-state is valid,
      // including a homework section without exercises.
      const hasVisible = selector => [...(main?.querySelectorAll(selector) || [])].some(visible);
      const loaderVisible = hasVisible('.vue_exercises_wrapper_loader');
      const listVisible = hasVisible('.exercises-list');
      const emptyVisible = hasVisible('.lesson-viewer-plug_text');
      exerciseState = { loaderVisible, listVisible, emptyVisible };
      const rendered = listVisible || emptyVisible;
      ready = ready && visible(main) && visible(header) && rendered && !loaderVisible && Boolean(route.sectionId);
      readinessReason = !route.sectionId ? 'Ожидаем адрес открываемого раздела.' : !visible(main) ? 'Содержимое урока ещё не появилось.'
        : !visible(header) ? 'Заголовок раздела ещё не появился.' : loaderVisible ? 'Сайт загружает задания раздела.'
          : !rendered ? 'Ожидаем задания или пустое состояние раздела.' : '';
      for (const section of limited('.sections-list_item')) {
        // ProgressMe renders its synthetic IsAddSection action as an ordinary
        // regular item, with a Plus icon. It opens an editor, not a section.
        if (section.classList.contains('separator') || section.querySelector('.iconedv-Plus')) continue;
        add(section, section.innerText, 'section', route.sectionId !== 'for-homework' && section.classList.contains('current'));
      }
      for (const homework of limited('.lesson-viewer-section-right_additional')) {
        // Source icon fonts expose private-use glyphs alongside the text label.
        const label = normalize(String(homework.innerText || '').replace(/\p{Co}/gu, ' '));
        if (label === 'Для домашней работы') add(homework, label, 'homework', route.sectionId === 'for-homework');
      }
    }

    // Exercises may have their own pagination; only section-list controls affect lesson traversal.
    const navigationRoots = route.kind === 'book' ? [document] : [...document.querySelectorAll('.sections-list')];
    const pagination = navigationRoots.flatMap(root => [...root.querySelectorAll('[class*="pagination"],[class*="Pagination"],[aria-label*="pagination"],[aria-label*="Pagination"],[infinite-scroll],[class*="infinite-scroll"],[class*="infiniteScroll"]')]);
    const loadMore = navigationRoots.some(root => [...root.querySelectorAll('button')].some(element => visible(element) && /^(?:показать|загрузить)\s+ещ[её]$|^load more$/i.test(normalize(element.innerText))));
    if (pagination.some(visible) || loadMore) {
      warnings.push('Обнаружена пагинация или подгрузка элементов. Автоматический обход этой страницы остановлен.');
      blocked = true;
    }
    if (entries.length > MAX_ITEMS) {
      warnings.push(`Найдено больше ${MAX_ITEMS} элементов навигации. Автоматический обход этой страницы остановлен.`);
      blocked = true;
    }
    const keys = new Set();
    for (const entry of entries) {
      if (keys.has(entry.item.key)) { warnings.push('Несколько элементов навигации ссылаются на один исходный идентификатор. Проверьте список материала.'); blocked = true; }
      keys.add(entry.item.key);
    }

    return { result: { url: route.url, kind: route.kind, materialId: route.materialId, lessonId: route.lessonId, title, items: entries.slice(0, MAX_ITEMS).map(entry => entry.item), ready: ready && !blocked, blocked, readinessReason, ...(exerciseState ? { exerciseState } : {}), ...(bookState ? { bookState } : {}), contentSignature: signature(content), warnings: [...new Set(warnings)] }, entries, titleCounts };
  }

  function observe(scanned) {
    observedNavigation = { url: scanned.result.url,
      outline: JSON.stringify(scanned.entries.map(entry => [entry.item.key, entry.item.title, entry.item.kind])),
      controls: new Map(scanned.entries.map(entry => [entry.item.key, entry.element])) };
    return scanned.result;
  }
  function inspect() { return observe(scan()); }

  function setBookInventory(value) {
    const current = routeFor(location.href), incoming = routeFor(value?.url);
    if (!current || current.kind !== 'book' || incoming?.url !== current.url || !Array.isArray(value?.groups) || value.groups.length > MAX_ITEMS) return false;
    const ids = new Set();
    let expectedLessons = 0;
    for (const group of value.groups) {
      if (!Number.isSafeInteger(group?.Id) || group.Id <= 0 || ids.has(group.Id) || !Number.isSafeInteger(group.CountLesson) || group.CountLesson < 0) return false;
      ids.add(group.Id);
      expectedLessons += group.CountLesson;
      if (!Number.isSafeInteger(expectedLessons)) return false;
    }
    bookInventory = { url: current.url, expectedLessons };
    return true;
  }

  function prepare(request) {
    const current = routeFor(location.href), expected = routeFor(request?.expectedUrl);
    if (!current || current.kind !== 'book' || expected?.url !== current.url) return { ok: false, error: 'Содержание учебника изменилось до раскрытия разделов.' };
    const before = scan().result;
    if (before.blocked) return { ok: false, error: before.warnings.at(-1) };
    const groups = [...document.querySelectorAll('.section_accordion_li-inner')].filter(group => visible(group) && group.closest('.section_accordion_list'));
    if (groups.length > MAX_ITEMS) return { ok: false, error: 'Список разделов превышает размер поддерживаемого архива.' };
    let opened = 0;
    for (const group of groups) {
      if (group.classList.contains('open')) continue;
      const head = group.querySelector('.section_accordion_li-head');
      if (!enabled(head) || head.closest('.section_accordion_li-inner') !== group) return { ok: false, error: 'Не удалось раскрыть раздел учебника.' };
      head.click(); opened++;
    }
    return { ok: true, opened, navigation: inspect() };
  }

  function open(request) {
    try {
      const expected = routeFor(request?.expectedUrl);
      const current = routeFor(location.href);
      if (!expected || !current || expected.url !== current.url) return { ok: false, error: 'Страница изменилась. Повторно прочитайте навигацию перед переходом.' };
      if (typeof request?.key !== 'string' || request.key.length > 10000) return { ok: false, error: 'Неизвестный элемент навигации.' };
      const { result, entries } = scan();
      if (!result.ready) return { ok: false, error: 'Страница ещё не готова к обходу либо содержит неподдерживаемую навигацию.' };
      const target = entries.find(entry => entry.item.key === request.key);
      if (!target) return { ok: false, code: 'navigation_stale', error: 'Элемент навигации изменился или больше не доступен.' };
      const outline = JSON.stringify(entries.map(entry => [entry.item.key, entry.item.title, entry.item.kind]));
      if (!observedNavigation || observedNavigation.url !== current.url || observedNavigation.outline !== outline ||
        observedNavigation.controls.get(target.item.key) !== target.element) return { ok: false, code: 'navigation_stale', error: 'Список материала изменился. Повторно прочитайте навигацию перед переходом.' };
      if (!enabled(target.element)) return { ok: false, error: 'Элемент навигации больше не доступен.' };
      target.element.click();
      return { ok: true, key: target.item.key, kind: target.item.kind, title: target.item.title };
    } catch { return { ok: false, error: 'Не удалось безопасно открыть элемент навигации.' }; }
  }

  globalThis.__thedesharNavigation = Object.freeze({ inspect, open, prepare, setBookInventory });
})();
