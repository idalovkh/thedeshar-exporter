import assert from 'node:assert/strict';
import test from 'node:test';
import { archiveFilename } from '../src/lib/download-name.js';

const exportedAt = '2026-10-23T19:01:31.258Z';
const suffix = '-2026-10-23T19-01-31-258Z.zip';
const bookUrl = 'https://progressme.ru/cabinet/school/materials/book/867169/content';

test('archive names preserve the collected Russian book title rather than a generic site title', () => {
  assert.equal(archiveFilename({ collection: { title: 'Английский язык — 5 класс' },
    source: { title: 'DesharSchool' }, navigation: { kind: 'lesson', title: 'Lesson information' } }, exportedAt),
  `Английский язык — 5 класс${suffix}`);
});

test('archive title fallback uses book contents metadata, never a lesson or browser site title', () => {
  const snapshots = [{ url: bookUrl.replace('/content', '/lesson/1'), title: 'Lesson information' },
    { url: bookUrl, title: 'Сохранённый учебник' }];
  assert.equal(archiveFilename({ collection: { title: '  ' }, snapshots,
    navigation: { kind: 'book', title: 'Другой заголовок' } }, exportedAt), `Сохранённый учебник${suffix}`);
  assert.equal(archiveFilename({ navigation: { kind: 'book', title: 'Открытый учебник' } }, exportedAt), `Открытый учебник${suffix}`);
  assert.equal(archiveFilename({ snapshots: snapshots.slice(0, 1), source: { title: 'DesharSchool' },
    navigation: { kind: 'lesson', title: 'Lesson information' } }, exportedAt), `materials${suffix}`);
  assert.equal(archiveFilename({}, exportedAt), `materials${suffix}`);
});

test('archive names remove path separators, forbidden characters, controls and direction overrides', () => {
  const name = archiveFilename({ collection: { title: '..  Учебник / часть \\ 2: <тест> | "A"?*\u0000\u007f\u0085\u202e\u2066 . ' } }, exportedAt);
  assert.equal(name, `Учебник _ часть _ 2_ _тест_ _ _A_${suffix}`);
  assert.doesNotMatch(name, /[\\/<>:"|?*\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
  assert.equal(archiveFilename({ collection: { title: '  ...  ' } }, exportedAt), `materials${suffix}`);
  assert.equal(archiveFilename({ collection: { title: 'CON' } }, exportedAt), `_CON${suffix}`);
});

test('long Unicode archive names fit a portable byte limit without losing ZIP extension or timestamp', () => {
  for (const title of ['Учебник'.repeat(100), '📚'.repeat(100), 'x'.repeat(1000)]) {
    const name = archiveFilename({ collection: { title } }, exportedAt);
    assert.ok(new TextEncoder().encode(name).byteLength <= 200);
    assert.ok(name.endsWith(suffix));
    assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(name)), name);
    assert.doesNotMatch(name, /[\ud800-\udfff]/u);
  }
});
