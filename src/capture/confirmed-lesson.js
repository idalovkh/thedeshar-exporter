/* Called only by the isolated bridge after its document and visit guards. */
(() => {
  'use strict';
  if (globalThis.__thedesharOpenConfirmedLesson) return;
  const contents = /^\/cabinet\/(?:school|teacher)\/materials\/book\/([1-9]\d*)\/content\/?$/;
  const lesson = /^\/lesson-editor\/book\/([1-9]\d*)\/lesson\/[1-9]\d*(?:\/section(?:\/(?:[1-9]\d*|for-homework))?)?\/?$/;
  const destination = /^\/lesson-editor\/book\/([1-9]\d*)\/lesson\/[1-9]\d*\/?$/;
  const denied = () => ({ ok: false, code: 'source_changed', error: 'Не удалось подтвердить переход к выбранному уроку. Повторите сбор из содержания книги.' });
  globalThis.__thedesharOpenConfirmedLesson = ({ expectedUrl, url } = {}, beforeNavigate) => {
    try {
      const current = new URL(location.href), expected = new URL(expectedUrl), target = new URL(url);
      const currentBook = (current.pathname.match(contents) || current.pathname.match(lesson))?.[1];
      if (current.protocol !== 'https:' || current.port || current.username || current.password ||
        !['progressme.ru', 'platform.desharschool.ru'].includes(current.hostname) && current.origin !== globalThis.__thedesharExporterSourceOrigin ||
        !currentBook || expected.origin !== current.origin || expected.pathname !== current.pathname || expected.username || expected.password ||
        target.origin !== current.origin || target.username || target.password || target.search || target.hash ||
        target.pathname.match(destination)?.[1] !== currentBook) return denied();
      beforeNavigate?.();
      location.assign(target.href);
      return { ok: true };
    } catch { return denied(); }
  };
})();
