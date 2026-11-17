const incomplete = message => Object.assign(new Error(message), { code: 'incomplete_export' });
const TERMINAL_PROBLEMS = new Set(['failed', 'skipped', 'unavailable']);

/** Only terminal file failures can be omitted; missing results and unverified bytes remain fatal. */
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
  return problems;
}
