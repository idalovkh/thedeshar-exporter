/** Called only after the selected ZIP has been committed and verified. */
export function recordDownloadResult(state, { revision, loaded, missing, originalImages }, now = new Date().toISOString()) {
  if (!Number.isSafeInteger(revision) || revision !== (state.exportRevision || 0)) {
    throw Object.assign(new Error('Собранная книга изменилась. Обновите её состояние перед скачиванием.'), { code: 'export_changed' });
  }
  if (![loaded, missing].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Недопустимый результат скачивания.');
  if (originalImages !== undefined && (!Number.isSafeInteger(originalImages) || originalImages < 0 || originalImages > loaded))
    throw new Error('Недопустимое число изображений без сжатия.');
  return { ...state, updatedAt: now, downloadResult: { loaded, missing, handedOffAt: now, savedAt: now, ...(originalImages ? { originalImages } : {}) } };
}
