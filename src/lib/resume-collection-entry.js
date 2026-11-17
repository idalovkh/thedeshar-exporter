import { sourceBookKey } from './book-workspaces.js';
import { navigationBlockMessage } from './navigation-block-reasons.js';

/** A paused lesson may return only to its retained book's contents. */
export function resumeCollectionEntry(state, navigation) {
  const rootUrl = state?.collection?.rootUrl;
  const key = sourceBookKey(rootUrl);
  const unavailable = () => Object.assign(new Error('Откройте ту же книгу, чтобы продолжить сохранённый сбор.'), { code: 'resume_unavailable' });
  if (!key || key !== sourceBookKey(navigation?.url)) throw unavailable();
  const root = new URL(rootUrl), current = new URL(navigation.url);
  const lesson = current.pathname.match(/^\/lesson-editor\/book\/(\d+)\/lesson\/\d+(?:\/section(?:\/(?:\d+|for-homework))?)?\/?$/);
  if (!/^\/cabinet\/(?:school|teacher)\/materials\/book\/\d+\/content\/?$/.test(root.pathname) || root.search || root.hash ||
      navigation.kind !== 'lesson' || !lesson || String(navigation.materialId) !== lesson[1]) throw unavailable();
  return { rootUrl, title: state.collection.title };
}

/** Starting capture creates a new visit; retain the original route/document guard. */
export async function refreshResumeCollectionEntry(request, initial) {
  const { navigation } = await request('GET_NAVIGATION', { expectedUrl: initial.url, expectedDocumentToken: initial.documentToken });
  if (navigation?.url !== initial.url || navigation.kind !== 'lesson' || navigation.materialId !== initial.materialId || navigation.lessonId !== initial.lessonId) {
    throw Object.assign(new Error('Исходная вкладка изменилась. Продолжение сбора остановлено.'), { code: 'source_changed' });
  }
  if (navigation.blocked) throw Object.assign(new Error(navigationBlockMessage(navigation.blockedReasonCode) ||
    'Навигация в исходной вкладке недоступна. Проверьте доступ к книге.'), {
    code: 'navigation_blocked', url: navigation.url, blockedReasonCode: navigation.blockedReasonCode,
  });
  if (/\/section\/(?:\d+|for-homework)\/?$/.test(new URL(navigation.url).pathname) &&
      !/^[a-zA-Z0-9-]{16,100}$/.test(navigation.sectionVisit?.token || '')) {
    throw Object.assign(new Error('Обновите расширение и перезагрузите вкладку учебника перед сбором.'), { code: 'source_update_required' });
  }
  return navigation;
}
