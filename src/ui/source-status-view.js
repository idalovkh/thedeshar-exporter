import { navigationStopMessage } from '../lib/source-navigation-errors.js';

const FAILURE_MESSAGES = Object.freeze({
  source_network_error: 'Не удалось загрузить страницу из-за ошибки соединения.',
  source_security_error: 'Браузер или платформа ограничили доступ к странице.',
  source_interrupted: 'Загрузка страницы была прервана.',
  source_left_page: 'В исходной вкладке открылась другая страница. Проверьте доступ к книге.',
  source_changed: 'Исходная страница изменилась во время сбора.',
  source_closed: 'Вкладка с книгой была закрыта.',
  source_unavailable: 'Страница книги недоступна.',
  source_disconnected: 'Не удалось получить ответ от страницы книги.',
  source_timeout: 'Страница книги не ответила вовремя.',
  source_update_required: 'Начните новый сбор книги после обновления расширения и вкладки источника.',
  exporter_binding_mismatch: 'Окно экспортёра потеряло привязку к книге. Откройте книгу и снова нажмите значок exporter.',
  transition_timeout: 'Не удалось дождаться загрузки страницы за 3 минуты.',
  retry_exhausted: 'Не удалось загрузить страницу после трёх попыток.',
  author_data_missing: 'Не удалось получить исходные задания раздела.',
  author_data_incomplete: 'Платформа передала неполный список заданий раздела.',
  section_loading_timeout: 'Платформа не завершила загрузку заданий раздела.',
  section_render_timeout: 'Платформа не показала задания раздела.',
  document_load_timeout: 'Не удалось дождаться загрузки страницы.',
  navigation_timeout: 'Не удалось дождаться открытия нужной страницы.',
});

export function sourceConnectionView({ sourceStatus, sourceKey, expectedKey, closed, disconnected } = {}) {
  const state = closed ? 'closed' : sourceStatus?.state;
  if (state === 'closed') return { title: 'Связь с книгой потеряна', label: 'Нет связи', mode: 'error',
    description: 'Вкладка с книгой была закрыта. Откройте книгу повторно и нажмите значок exporter.' };
  if (state === 'loading') return { title: 'Книга загружается', label: 'Загрузка', mode: 'collecting',
    description: 'Дождитесь загрузки страницы книги. При медленном соединении это может занять больше времени.' };
  if (sourceKey && expectedKey && sourceKey !== expectedKey) return { title: 'Откройте выбранную книгу', label: 'Другая книга', mode: 'warning',
    description: 'В исходной вкладке открыта другая книга. Для продолжения верните содержание выбранной книги.' };
  if (state === 'network_error') return { title: 'Не удалось загрузить страницу книги', label: 'Ошибка загрузки', mode: 'error',
    description: 'Проверьте соединение и доступность книги, затем повторите сбор. Подробности сохранены в отчёте о проблеме.' };
  if (state === 'security_error') return { title: 'Нет доступа к странице книги', label: 'Доступ ограничен', mode: 'error',
    description: 'Проверьте вход на учебную платформу и сообщение браузера во вкладке книги, затем повторите сбор.' };
  if (state === 'unavailable' && sourceStatus?.navigation?.cause === 'legacy_transition') return {
    title: 'Начните сбор книги заново', label: 'Сбор не завершён', mode: 'warning',
    description: navigationStopMessage(sourceStatus.navigation) };
  if (state === 'source_changed' || state === 'interrupted') return { title: 'Сбор книги остановлен', label: 'Сбор не завершён', mode: 'warning',
    description: navigationStopMessage(sourceStatus?.navigation) || 'Исходная страница изменилась или её загрузка была прервана. Верните содержание выбранной книги и повторите сбор.' };
  if (disconnected) return { title: 'Связь с книгой потеряна', label: 'Нет связи', mode: 'error',
    description: 'Книга не отвечает. Обновите вкладку с книгой и снова нажмите значок exporter.' };
  if (state === 'unavailable' || expectedKey && !sourceKey) return { title: 'Страница книги недоступна', label: 'Нет связи', mode: 'error',
    description: 'Проверьте загрузку и доступ к выбранной книге в исходной вкладке, затем повторите сбор.' };
  return null;
}

export function collectionLoadingDetail(event) {
  if (!event) return '';
  if (['started', 'waiting', 'retrying'].includes(event.status) &&
    Number.isInteger(event.attempt) && event.attempt >= 2 && event.attempt <= 3) {
    return `Повторная загрузка раздела. Попытка ${event.attempt} из 3.`;
  }
  if (event.status === 'waiting' && event.elapsedMs >= 60000) return 'Страница загружается дольше обычного.';
  return '';
}

export function sourceSetupMessage(code) {
  const messages = {
    source_unsupported: 'На этом сайте не удалось распознать поддерживаемую учебную платформу. Откройте содержание книги и нажмите значок exporter.',
    permission_denied: 'Для подключения книги разрешите exporter доступ к сайту учебной платформы, затем снова нажмите его значок.',
    source_unavailable: 'Не удалось подключиться к странице книги. Дождитесь её загрузки и снова нажмите значок exporter.',
  };
  return Object.hasOwn(messages, code) ? messages[code] : '';
}

function contextTitle(value) {
  return typeof value === 'string' ? value.replace(/(?:https?|wss?):\/\/\S+/gi, '').replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ').trim().slice(0, 500) : '';
}

export function collectionFailureNotice(report) {
  const failure = report?.diagnostics?.failure;
  const lesson = contextTitle(failure?.lessonTitle), section = contextTitle(failure?.sectionTitle);
  const context = [lesson && `Урок «${lesson}»`, section && `раздел «${section}»`].filter(Boolean).join(', ');
  const navigationReason = ['source_left_page', 'source_changed', 'source_unavailable', 'source_update_required', 'document_load_timeout', 'navigation_timeout'].includes(failure?.reason)
    ? navigationStopMessage(failure.navigation) : '';
  const reason = navigationReason || (Object.hasOwn(FAILURE_MESSAGES, failure?.reason) ? FAILURE_MESSAGES[failure.reason] : 'Не удалось завершить сбор всей книги.');
  return `${context ? `${context}: ` : ''}${reason} Проверьте страницу книги и повторите сбор. Если ошибка повторяется, скачайте отчёт о проблеме и пришлите нам.`;
}
