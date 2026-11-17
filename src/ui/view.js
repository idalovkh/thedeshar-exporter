import { exportReadiness } from "../lib/export-readiness.js";
import { collectionResumeInfo } from "../lib/collection-resume.js";
import { sourceBookKey } from "../lib/book-workspaces.js";
import { navigationBlockMessage } from "../lib/navigation-block-reasons.js";

function isBookContents(source) {
  try {
    return /\/materials\/book\/[^/]+\/content\/?$/.test(new URL(source?.url).pathname);
  } catch {
    return false;
  }
}

/** Present collection state without claiming that every exercise was exported. */
export function getView({ state = {}, sourceAvailable = false, source = null, sourceNavigation = null, collecting = false, downloading = false, busy = false } = {}) {
  const hasData = Boolean(state.snapshots?.length || state.captures?.length);
  const report = state.collection;
  const readiness = exportReadiness(state);
  const lessons = Array.isArray(report?.items) ? report.items.filter((item) => item?.kind === "lesson") : [];
  const bookContents = isBookContents(source);
  const navigationBlocked = sourceAvailable && sourceNavigation?.blocked === true;
  const lessonsDone = lessons.filter((item) => item.status === "visited").length;
  const currentLesson = lessons.find((item) => item.status === "running")?.title || "";
  const resume = collectionResumeInfo(state);
  const structureChanged = report?.diagnostics?.failure?.reason === "resume_structure_changed";
  const sourceKey = sourceBookKey(source?.url);
  const sameBook = Boolean(sourceKey && sourceKey === sourceBookKey(report?.rootUrl));
  const lessonPage = Boolean(sourceKey && /^\/lesson-editor\/book\/\d+\/lesson\/\d+(?:\/section(?:\/(?:\d+|for-homework))?)?\/?$/.test(new URL(source.url).pathname));
  const canResume = resume.available && !structureChanged && report?.status !== "finished" && !state.dropped && !state.enabled && !state.collectionLocked &&
    sourceAvailable && !navigationBlocked && sameBook && (bookContents || lessonPage) && !busy && !collecting && !downloading;
  const common = {
    canCollect: sourceAvailable && !navigationBlocked && (bookContents || canResume) && !busy && !collecting && !downloading,
    canExport: readiness.allowed && !state.enabled && !busy && !collecting && !downloading,
    hasData,
    canResume: Boolean(canResume),
    collectLabel: canResume ? "Продолжить сбор" : hasData ? "Собрать заново" : "Собрать книгу",
    confirmedSections: resume.confirmedSections,
    startedAt: resume.startedAt,
    lessonsDone,
    lessonsTotal: lessons.length,
    currentLesson,
  };
  const view = (mode, title, description, statusLabel) => ({ ...common, mode, title, description, statusLabel });

  if (downloading) {
    return view("downloading", "Архив книги", "Оставьте эту вкладку открытой до сохранения архива.", "Архив");
  }
  if (collecting) {
    const progress = lessons.length
      ? `Собрано уроков: ${lessonsDone} из ${lessons.length}.${currentLesson ? ` Сейчас: ${currentLesson}.` : ""}`
      : "";
    return view("collecting", "Сбор книги", `${progress ? `${progress} ` : ""}Оставьте обе вкладки открытыми и не переключайте страницы книги.`, "Книга");
  }
  if (navigationBlocked && !common.canExport) {
    const reason = navigationBlockMessage(sourceNavigation.blockedReasonCode);
    return view("warning", "Сбор книги заблокирован",
      reason || "Проверьте список уроков и разделов в исходной вкладке.", "Обход заблокирован");
  }
  if (structureChanged) {
    return view("partial", "Структура книги изменилась", "Сохранённые материалы оставлены. Выберите «Собрать заново», чтобы получить текущую структуру и задания книги.", "Нужен новый сбор");
  }
  if (resume.available && report?.status !== "finished" && !state.dropped) {
    return view("partial", "Сбор можно продолжить", canResume
      ? bookContents
        ? "Подтверждённые разделы сохранены. Нажмите «Продолжить сбор»: проверим доступ и структуру книги, затем соберём оставшиеся разделы."
        : "Подтверждённые разделы сохранены. Нажмите «Продолжить сбор»: вернёмся к содержанию книги, проверим доступ и структуру, затем соберём оставшиеся разделы."
      : "Подтверждённые разделы сохранены. Откройте содержание этой книги и нажмите значок exporter, чтобы продолжить сбор.", "Сбор не завершён");
  }
  if (report?.status === "running") {
    return view("partial", "Сбор пока не завершён", hasData
      ? "Уже собранные материалы сохранены. Если сбор идёт в другой вкладке расширения, дождитесь его завершения. Иначе повторите сбор из содержания книги."
      : "Если сбор идёт в другой вкладке расширения, дождитесь его завершения. Иначе откройте содержание книги и запустите сбор ещё раз.", "Сбор не завершён");
  }
  if (report?.status === "finished" && readiness.allowed && !state.enabled) {
    return view("finished", "Сбор завершён", sourceAvailable
      ? "Скачайте архив с собранными уроками и файлами."
      : "Скачайте архив с собранными уроками и файлами. Для нового сбора откройте содержание книги.", "Сбор завершён");
  }
  if (!sourceAvailable) {
    return hasData
      ? view("partial", "Сохранена часть материалов", "Собранные данные сохранены. Для подготовки архива откройте содержание книги и повторите сбор до завершения.", "Сбор не завершён")
      : view("unavailable", "Откройте книгу на платформе", "Откройте содержание книги на учебной платформе, затем нажмите значок расширения в этой вкладке.", "Нет открытой книги");
  }
  if (state.enabled) {
    return view("manual", "Сбор книги", "Для подготовки архива откройте содержание книги, нажмите «Собрать книгу» и дождитесь завершения сбора.", "Книга");
  }
  if (report?.status === "finished") {
    return view("partial", "Сбор требует повторения", hasData
      ? "В сохранённых данных есть пропуски. Откройте содержание книги и повторите сбор до завершения. Уже собранные материалы сохранены."
      : "Сохранённые данные книги не найдены. Откройте содержание книги и повторите сбор до завершения.", "Сбор не завершён");
  }
  if (["cancelled", "canceled", "stopped", "failed", "interrupted", "limit"].includes(report?.status)) {
    return view("partial", "Сбор остановлен", hasData
      ? "Уже собранные материалы сохранены. Откройте содержание книги и повторите сбор до завершения."
      : "Материалы ещё не сохранены. Проверьте сообщение ниже и повторите сбор из содержания книги.", "Сбор не завершён");
  }
  if (hasData) {
    return view("partial", "Сохранена часть материалов", "Отдельные страницы сохранены. Для архива нужен завершённый сбор: откройте содержание книги и нажмите «Собрать книгу».", "Сбор не завершён");
  }
  if (bookContents) {
    return view("ready", "Книга готова к сбору", "Нажмите «Собрать книгу». Расширение соберёт доступные уроки, затем вы сможете скачать архив.", "Можно начинать");
  }
  return view("lesson", "Откройте содержание книги", "Перейдите к списку уроков в книге, затем вернитесь сюда и нажмите «Собрать книгу».", "Открыта страница материалов");
}
