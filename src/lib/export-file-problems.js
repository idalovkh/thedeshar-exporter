const incomplete = message => Object.assign(new Error(message), { code: 'incomplete_export' });
const TERMINAL_PROBLEMS = new Set(['failed', 'skipped', 'unavailable']);

/** Consent covers known file failures, never missing results or unverified bytes. */
export function exportFileProblems(files, expected = files) {
  const expectedUrls = new Set(expected.map(asset => asset.url));
  const fileUrls = new Set(files.map(file => file.url));
  if (files.length !== expected.length || expectedUrls.size !== expected.length || fileUrls.size !== files.length ||
      files.some(file => !expectedUrls.has(file.url)))
    throw incomplete('Не все файлы книги обработаны. Архив не создан. Повторите скачивание.');
  const problems = [];
  for (const file of files) {
    if (file.status === 'downloaded') {
      if (!(file.data instanceof Blob && file.data.size > 0 || file.data instanceof Uint8Array && file.data.byteLength > 0))
        throw incomplete('Не все файлы книги сохранены корректно. Архив не создан. Повторите скачивание.');
    } else if (TERMINAL_PROBLEMS.has(file.status) && file.data == null) {
      problems.push(file);
    } else {
      throw incomplete('Не все файлы книги обработаны корректно. Архив не создан. Повторите скачивание.');
    }
  }
  if (problems.length > 2)
    throw incomplete(`Не удалось получить ${problems.length} файлов книги. Архив не создан: допускается не более двух пропущенных файлов. Скачайте отчёт о проблеме и пришлите нам — поможем разобраться.`);
  return problems;
}
