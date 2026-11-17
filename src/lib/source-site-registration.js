import { forgetSourceOrigin, isBuiltinSourceOrigin, rememberSourceOrigin, sourceOrigin } from './source-origins.js';

const ISOLATED_FILES = ['src/capture/source-binding.js', 'src/capture/navigation.js', 'src/capture/section-visit.js', 'src/capture/confirmed-lesson.js', 'src/capture/content.js'];
const materialRoute = value => {
  try {
    const url = new URL(value);
    return /^\/cabinet\/(?:school|teacher)\/materials\/book\/\d+\/content\/?$/.test(url.pathname) ||
      /^\/lesson-editor\/book\/\d+\/lesson\/\d+(?:\/section(?:\/(?:\d+|for-homework))?)?\/?$/.test(url.pathname);
  } catch { return false; }
};
const unsupported = () => Object.assign(new Error('На этом сайте не удалось распознать поддерживаемую учебную платформу. Откройте содержание книги и попробуйте снова.'), { code: 'source_unsupported' });

function probeSourceApplication() {
  const navigation = globalThis.__thedesharNavigation?.inspect();
  const book = document.querySelector('.unit_li button.open_lesson-desc, .unit_li button.open_lesson-mobile, .section_accordion_list');
  const lesson = document.querySelector('.lesson-viewer-layout_main') && document.querySelector('.sections-list');
  return { compatible: Boolean(navigation && ['book', 'lesson'].includes(navigation.kind) &&
    (navigation.kind === 'book' ? book : lesson)), url: location.href };
}

/** Called directly from the extension click so requesting this one site keeps its user gesture. */
export function prepareSourceSite(chrome, tab) {
  const origin = sourceOrigin(tab?.url);
  if (!origin || !Number.isInteger(tab?.id) || !materialRoute(tab.url)) return Promise.reject(unsupported());
  if (isBuiltinSourceOrigin(origin)) return Promise.resolve({ origin, connected: true });
  if (!chrome?.scripting || !chrome?.permissions?.request || !chrome?.storage?.local) return Promise.reject(unsupported());
  const pattern = `${origin}/*`;
  // Start both calls synchronously. Do not await before permissions.request.
  const previous = Promise.resolve(chrome.permissions.contains({ origins: [pattern] }));
  const requested = Promise.resolve(chrome.permissions.request({ origins: [pattern] }));
  return (async () => {
    const hadAccess = await previous;
    if (!await requested) throw Object.assign(new Error('Для подключения книги разрешите доступ к сайту учебной платформы.'), { code: 'permission_denied' });
    let registrationIds = [];
    let remembered = false;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED',
        files: ['src/capture/source-binding.js', 'src/capture/navigation.js'] });
      const inspected = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: probeSourceApplication });
      const main = inspected.find(result => result.frameId === 0)?.result;
      if (!main?.compatible || sourceOrigin(main.url) !== origin || !materialRoute(main.url)) throw unsupported();
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(origin));
      const id = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('').slice(0, 24);
      const scripts = [
        { id: `source-main-${id}`, matches: [pattern], js: ['src/capture/hook.js'], world: 'MAIN', runAt: 'document_start', allFrames: false, persistAcrossSessions: true },
        { id: `source-isolated-${id}`, matches: [pattern], js: ISOLATED_FILES, world: 'ISOLATED', runAt: 'document_start', allFrames: false, persistAcrossSessions: true },
      ];
      const existing = await chrome.scripting.getRegisteredContentScripts({ ids: scripts.map(script => script.id) });
      const missing = scripts.filter(script => !existing.some(item => item.id === script.id));
      const outdated = scripts.filter(script => {
        const previous = existing.find(item => item.id === script.id);
        return previous && ['js', 'matches', 'world', 'runAt', 'allFrames', 'persistAcrossSessions'].some(key =>
          JSON.stringify(previous[key]) !== JSON.stringify(script[key]));
      });
      if (outdated.length) await chrome.scripting.updateContentScripts(outdated);
      if (missing.length) {
        await chrome.scripting.registerContentScripts(missing);
        registrationIds = missing.map(script => script.id);
      }
      await rememberSourceOrigin(chrome, origin);
      remembered = true;
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', files: ['src/capture/hook.js'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', files: ISOLATED_FILES });
      return { origin, connected: true };
    } catch (error) {
      if (remembered && !hadAccess) await forgetSourceOrigin(chrome, origin).catch(() => {});
      if (registrationIds.length) await chrome.scripting.unregisterContentScripts?.({ ids: registrationIds }).catch(() => {});
      if (!hadAccess) await chrome.permissions.remove({ origins: [pattern] }).catch(() => {});
      throw error;
    }
  })();
}
