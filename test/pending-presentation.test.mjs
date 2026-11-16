import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { getView } from '../src/ui/view.js';

const book = { sourceAvailable: true, source: { url: 'https://progressme.ru/cabinet/school/materials/book/71/content' } };

test('active collection keeps a stable title, real counts and source safety instructions', () => {
  for (const items of [[], [
    { kind: 'lesson', title: 'First lesson', status: 'visited' },
    { kind: 'lesson', title: 'Second lesson', status: 'running' },
  ]]) {
    const view = getView({ ...book, collecting: true, state: { collection: { status: 'running', items } } });
    assert.equal(view.title, 'Сбор книги');
    assert.equal(view.statusLabel, 'Книга');
    assert.equal(view.lessonsTotal, items.length);
    assert.equal(view.lessonsDone, items.length ? 1 : 0);
    assert.match(view.description, /Оставьте обе вкладки открытыми/);
    assert.doesNotMatch(view.description, /открываем|определяем|собираем|подождите|0 из 0|100%/iu);
  }
});

test('archive work names the destination without ongoing process prose', () => {
  const view = getView({ ...book, downloading: true });
  assert.equal(view.title, 'Архив книги');
  assert.equal(view.statusLabel, 'Архив');
  assert.match(view.description, /Оставьте эту вкладку открытой/);
  assert.doesNotMatch(view.description, /готовим|скачиваем|собираем|загружаем/iu);
  assert.equal(view.canCollect, false);
  assert.equal(view.canExport, false);
});

test('the first paint uses the importer ring and announces connection', async () => {
  const html = await readFile(new URL('../exporter.html', import.meta.url), 'utf8');
  assert.match(html, /id="source-name"[^>]*aria-busy="true"/);
  assert.match(html, /id="connection-progress"[^>]*aria-hidden="true"/);
  assert.match(html, /id="progress"[^>]*role="progressbar"/);
  assert.doesNotMatch(html, /class="skeleton/);
  assert.doesNotMatch(html, /Проверяем открытую вкладку|Подключаемся к книге|Сейчас проверим|Собираем материалы/);
});
