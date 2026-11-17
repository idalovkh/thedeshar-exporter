import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { navigationBlockMessage, navigationBlockReason } from '../src/lib/navigation-block-reasons.js';

const source = await readFile(new URL('../src/capture/navigation.js', import.meta.url), 'utf8');
const bookUrl = 'https://progressme.ru/cabinet/school/materials/book/867169/content';
const lessonUrl = 'https://progressme.ru/lesson-editor/book/867169/lesson/13794943/section/67546487';

function matches(element, selector) {
  const matchesPart = (node, part) => {
    const attributes = [...part.matchAll(/\[([^\]=*]+)(\*?=)?(?:"([^"]*)")?\]/g)];
    const bare = part.replace(/\[[^\]]*\]/g, '').trim();
    const tag = bare.match(/^[a-z][a-z0-9-]*/i)?.[0];
    if (tag && tag.toUpperCase() !== node.tagName) return false;
    const classes = [...bare.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
    if (classes.some(name => !node.classList.contains(name))) return false;
    return attributes.every(([, name, operator, value]) => {
      const actual = node.getAttribute(name);
      return operator === '*=' ? actual?.includes(value) : operator === '=' ? actual === value : actual !== null;
    });
  };
  return selector.split(',').some(part => {
    const path = part.trim().match(/(?:\[[^\]]*\]|[^\s])+/g) || [];
    if (!path.length || !matchesPart(element, path.at(-1))) return false;
    let ancestor = element.parentElement;
    for (let index = path.length - 2; index >= 0; index--) {
      while (ancestor && !matchesPart(ancestor, path[index])) ancestor = ancestor.parentElement;
      if (!ancestor) return false;
      ancestor = ancestor.parentElement;
    }
    return true;
  });
}

function element(tag, { classes = '', text = '', value = '', attributes = {}, hidden = false, disabled = false, children = [] } = {}) {
  const node = {
    tagName: tag.toUpperCase(), innerText: text, textContent: text, value, disabled, isConnected: true,
    attributes: { ...attributes, class: classes }, style: { display: hidden ? 'none' : 'block', visibility: 'visible' }, clicks: 0,
    children, parentElement: null,
    classList: { contains: name => node.attributes.class.split(/\s+/).includes(name) },
    getAttribute: name => node.attributes[name] ?? null,
    getClientRects: () => hidden ? [] : [{}],
    querySelectorAll(selector) { return this.children.flatMap(child => [...(matches(child, selector) ? [child] : []), ...child.querySelectorAll(selector)]); },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    closest(selector) { return matches(this, selector) ? this : this.parentElement?.closest(selector) || null; },
    click() { this.clicks++; },
  };
  children.forEach(child => { child.parentElement = node; });
  return node;
}

function card(title, options = {}) {
  const open = element('button', { classes: 'open_lesson-desc', text: 'Открыть урок', ...options });
  const edit = element('button', { classes: 'edit_lesson', text: 'Редактировать' });
  const start = element('button', { classes: 'start_lesson', text: 'Начать урок' });
  return { open, edit, start, node: element('li', { classes: 'unit_li', text: `${title}\nОткрыть урок\nНачать урок`, children: [open, edit, start] }) };
}

function mobileCard(title, { icon = 'iconedv-Arrow-Right' } = {}) {
  const open = element('button', { classes: 'open_lesson-mobile', children: [element('i', { classes: icon })] });
  const info = element('div', { classes: 'info', children: [element('p', { text: title })] });
  const edit = element('button', { classes: 'edit_lesson', text: 'Редактировать' });
  return { open, edit, node: element('li', { classes: 'unit_li', text: `${title}\nРедактировать`, children: [info, open, edit] }) };
}

function group({ title = 'Section', cards = [], open = false, loadOnOpen = true } = {}) {
  const add = element('button', { classes: 'add_lesson', text: 'Добавить урок' });
  const remove = element('button', { classes: 'delete_section', text: 'Удалить раздел' });
  const head = element('div', { classes: 'section_accordion_li-head', text: title, children: [add, remove] });
  const body = element('ul', { classes: 'units_list' });
  const node = element('li', { classes: `section_accordion_li-inner${open ? ' open' : ''}`, children: [head, body] });
  const load = items => {
    body.children = items.map(item => item.node);
    body.children.forEach(child => { child.parentElement = body; });
  };
  head.click = () => {
    head.clicks++;
    node.attributes.class = 'section_accordion_li-inner open';
    if (loadOnOpen) load(cards);
  };
  const close = () => { node.attributes.class = 'section_accordion_li-inner'; load([]); };
  if (open) load(cards);
  return { node, head, add, remove, load, close };
}

function groupedBook(groups) {
  return environment(bookUrl, [element('ul', { classes: 'section_accordion_list', children: groups.map(item => item.node) })]);
}

const inventory = counts => ({ url: bookUrl, groups: counts.map((CountLesson, index) => ({ Id: index + 1, CountLesson })) });

function environment(url, nodes, sourceOrigin) {
  const document = element('document', { children: nodes });
  document.readyState = 'complete';
  const location = new URL(url);
  const context = vm.createContext({ document, location, URL, getComputedStyle: node => node.style,
    __thedesharExporterSourceOrigin: sourceOrigin });
  vm.runInContext(source, context);
  return { document, location, api: context.__thedesharNavigation };
}

function lesson({ url = lessonUrl, empty = false, header = true, sections = ['First section', 'Second section'] } = {}) {
  const rendered = element('div', {
    classes: empty ? 'lesson-viewer-plug_text' : 'exercises-list',
    text: empty ? 'В этом разделе еще нет упражнений.' : 'Exercise 1. Fill the gaps.',
  });
  const main = element('main', { classes: 'lesson-viewer-layout_main', text: rendered.innerText, children: [rendered] });
  const title = element('input', { classes: 'lesson-viewer-header_input', value: 'Starter lesson' });
  const items = sections.map((text, index) => element('div', { classes: `sections-list_item${index === 0 ? ' current' : ''}`, text }));
  const sectionList = element('div', { classes: 'sections-list', children: items });
  const homework = element('div', { classes: 'lesson-viewer-section-right_additional', text: 'Для домашней работы' });
  return { ...environment(url, [main, ...(header ? [title] : []), sectionList, homework]), main, title, sections: items, sectionList, homework };
}

test('book adapter reads real lesson cards and only opens the recognized lesson button', () => {
  const first = card('Lesson 1: Hello');
  const second = card('Lesson 2: Food');
  const { api } = environment(bookUrl, [first.node, second.node]);
  const state = api.inspect();
  assert.equal(state.kind, 'book');
  assert.equal(state.materialId, '867169');
  assert.equal(state.lessonId, null);
  assert.equal(state.ready, true);
  assert.equal(state.blocked, false);
  assert.equal(Object.hasOwn(state, 'exerciseState'), false);
  assert.deepEqual({ ...state.bookState }, { visibleLessons: 2 });
  assert.deepEqual(Array.from(state.items, item => item.title), ['Lesson 1: Hello', 'Lesson 2: Food']);
  assert.equal(api.open({ expectedUrl: state.url, key: state.items[1].key }).ok, true);
  assert.equal(second.open.clicks, 1);
  assert.equal(first.open.clicks + first.edit.clicks + first.start.clicks + second.edit.clicks + second.start.clicks, 0);
  assert.match(state.warnings.join(' '), /только загруженные/);
});

test('book preparation expands every known closed group and never clicks its add or delete actions', () => {
  const firstCard = card('First lesson');
  const secondCard = card('Second lesson');
  const groups = [group({ cards: [firstCard] }), group({ cards: [secondCard] })];
  const { api } = groupedBook(groups);
  assert.equal(api.setBookInventory(inventory([1, 1])), true);
  const before = api.inspect();
  assert.equal(before.items.length, 0);
  assert.equal(before.ready, false);
  assert.match(before.readinessReason, /Раскрываем разделы.*2/);
  assert.deepEqual({ ...before.bookState }, { visibleLessons: 0, expectedLessons: 2 });
  const prepared = api.prepare({ expectedUrl: bookUrl });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.opened, 2);
  assert.equal(prepared.navigation.ready, true);
  assert.deepEqual({ ...prepared.navigation.bookState }, { visibleLessons: 2, expectedLessons: 2 });
  assert.deepEqual(Array.from(prepared.navigation.items, item => item.title), ['First lesson', 'Second lesson']);
  for (const item of groups) {
    assert.equal(item.head.clicks, 1);
    assert.equal(item.add.clicks + item.remove.clicks, 0);
  }
  assert.equal(firstCard.open.clicks + firstCard.edit.clicks + firstCard.start.clicks + secondCard.open.clicks, 0);
  assert.equal(api.prepare({ expectedUrl: bookUrl }).opened, 0, 'Preparing an open group must not toggle it closed');
});

test('grouped book waits for all lessons declared by author inventory before opening any lesson', () => {
  const first = card('Lesson one');
  const second = card('Lesson two');
  const third = card('Lesson three');
  const groups = [group({ loadOnOpen: false }), group({ loadOnOpen: false })];
  const { api } = groupedBook(groups);
  assert.equal(api.setBookInventory(inventory([2, 1])), true);
  assert.equal(api.prepare({ expectedUrl: bookUrl }).ok, true);
  groups[0].load([first]);
  groups[1].load([third]);
  const partial = api.inspect();
  assert.equal(partial.items.length, 2);
  assert.equal(partial.ready, false);
  assert.equal(partial.blocked, false, 'An unfinished list remains retryable');
  assert.match(partial.readinessReason, /2 из 3/);
  assert.deepEqual({ ...partial.bookState }, { visibleLessons: 2, expectedLessons: 3 });
  assert.equal(api.open({ expectedUrl: bookUrl, key: partial.items[0].key }).ok, false);
  assert.equal(first.open.clicks, 0);
  groups[0].load([first, second]);
  const loaded = api.inspect();
  assert.equal(loaded.ready, true);
  assert.deepEqual({ ...loaded.bookState }, { visibleLessons: 3, expectedLessons: 3 });
  assert.equal(api.open({ expectedUrl: bookUrl, key: loaded.items[0].key }).ok, true);
  assert.equal(first.open.clicks, 1);
});

test('an empty group does not prevent a grouped book with loaded lessons from becoming ready', () => {
  const groups = [group({ open: true }), group({ open: true, cards: [card('Only lesson')] })];
  const { api } = groupedBook(groups);
  assert.equal(api.setBookInventory(inventory([0, 1])), true);
  assert.equal(api.inspect().ready, true);
  assert.equal(api.inspect().items.length, 1);
  assert.equal(api.prepare({ expectedUrl: bookUrl }).opened, 0);
});

test('expanded groups require matching inventory even when their lesson cards are already visible', () => {
  const { api } = groupedBook([group({ open: true, cards: [card('Visible lesson')] })]);
  const unknown = api.inspect();
  assert.equal(unknown.items.length, 1);
  assert.equal(unknown.ready, false);
  assert.equal(unknown.blocked, false);
  assert.match(unknown.readinessReason, /количестве уроков/);
  assert.deepEqual({ ...unknown.bookState }, { visibleLessons: 1 });
  assert.equal(api.prepare({ expectedUrl: bookUrl }).navigation.ready, false);
  assert.equal(api.setBookInventory({ ...inventory([1]), url: bookUrl.replace('867169', '999') }), false);
  assert.equal(api.inspect().ready, false);
  assert.deepEqual({ ...api.inspect().bookState }, { visibleLessons: 1 });
  assert.equal(api.setBookInventory(inventory([1])), true);
  assert.equal(api.inspect().ready, true);
  assert.deepEqual({ ...api.inspect().bookState }, { visibleLessons: 1, expectedLessons: 1 });
  assert.equal(api.setBookInventory(inventory([0])), true);
  assert.deepEqual({ ...api.inspect().bookState }, { visibleLessons: 1, expectedLessons: 0 });
});

test('book preparation refuses a changed URL without clicking group headers', () => {
  const item = group({ cards: [card('Lesson')] });
  const { api } = groupedBook([item]);
  for (const expectedUrl of [bookUrl.replace('867169', '2'), bookUrl.replace('progressme.ru', 'platform.desharschool.ru'),
    bookUrl.replace('https:', 'http:'), `${bookUrl}/delete`, lessonUrl, 'javascript:alert(1)']) {
    assert.equal(api.prepare({ expectedUrl }).ok, false, expectedUrl);
  }
  assert.equal(item.head.clicks + item.add.clicks + item.remove.clicks, 0);
  assert.equal(api.inspect().items.length, 0);
});

test('returning to a book reopens groups that the source collapsed after lesson navigation', () => {
  const groups = [group({ cards: [card('Alpha')] }), group({ cards: [card('Beta')] })];
  const { api, location } = groupedBook(groups);
  api.setBookInventory(inventory([1, 1]));
  assert.equal(api.prepare({ expectedUrl: bookUrl }).navigation.ready, true);
  location.href = lessonUrl;
  groups.forEach(item => item.close());
  location.href = bookUrl;
  assert.equal(api.inspect().ready, false);
  const returned = api.prepare({ expectedUrl: bookUrl });
  assert.equal(returned.opened, 2);
  assert.equal(returned.navigation.ready, true);
  assert.deepEqual(groups.map(item => item.head.clicks), [2, 2]);
  assert.equal(groups.reduce((total, item) => total + item.add.clicks + item.remove.clicks, 0), 0);
});

test('mobile lesson controls use the recognized arrow button and the card name without button text', () => {
  const item = mobileCard('Mobile lesson');
  const { api } = environment(bookUrl, [item.node]);
  const state = api.inspect();
  assert.equal(state.ready, true);
  assert.equal(state.items[0].title, 'Mobile lesson');
  assert.equal(api.open({ expectedUrl: bookUrl, key: state.items[0].key }).ok, true);
  assert.equal(item.open.clicks, 1);
  assert.equal(item.edit.clicks, 0);
  const unrelated = mobileCard('Lesson', { icon: 'iconedv-Delete' });
  assert.equal(environment(bookUrl, [unrelated.node]).api.inspect().ready, false);
  assert.equal(unrelated.open.clicks, 0);
});

test('a changed desktop label or mobile icon can use a confirmed lesson identity', () => {
  const desktop = card('Desktop lesson', { text: 'Open lesson', attributes: { 'data-lesson-id': '101' } });
  desktop.node.innerText = 'Desktop lesson\nOpen lesson';
  const mobile = mobileCard('Mobile lesson', { icon: 'updated-arrow' });
  const link = element('a', { attributes: { href: '/lesson-editor/book/867169/lesson/202/section' } });
  link.parentElement = mobile.node;
  mobile.node.children.push(link);
  const { api } = environment(bookUrl, [desktop.node, mobile.node]);
  const state = api.inspect();
  assert.equal(state.ready, true);
  assert.deepEqual(Array.from(state.items, item => [item.title, item.sourceId]), [
    ['Desktop lesson', '101'], ['Mobile lesson', '202'],
  ]);
  for (const item of state.items) assert.equal(api.open({ expectedUrl: state.url, key: item.key }).ok, true);
  assert.equal(desktop.open.clicks + mobile.open.clicks, 2);
  assert.equal(desktop.edit.clicks + mobile.edit.clicks, 0);
});

test('fallback buttons still refuse conflicting identities, secondary actions and replaced controls', () => {
  const conflicting = card('Conflicting IDs', { text: 'Open lesson', attributes: { 'data-lesson-id': '101' } });
  conflicting.node.attributes['data-lesson-id'] = '202';
  const edited = card('Edit action', { text: 'Редактировать', attributes: { 'data-lesson-id': '101' } });
  const deleted = mobileCard('Delete action', { icon: 'iconedv-Delete' });
  deleted.node.attributes['data-lesson-id'] = '101';
  const foreign = card('Different book', { text: 'Open lesson', attributes: {
    href: '/lesson-editor/book/987654/lesson/101/section',
  } });
  const conflictingLink = card('Conflicting link', { attributes: { 'data-lesson-id': '101' } });
  const link = element('a', { attributes: { href: '/lesson-editor/book/867169/lesson/202/section' } });
  link.parentElement = conflictingLink.node;
  conflictingLink.node.children.push(link);
  for (const [item, cause] of [[conflicting, 'identity'], [edited, 'label'], [deleted, 'icon'], [foreign, 'label'], [conflictingLink, 'identity']]) {
    const { api } = environment(bookUrl, [item.node]);
    const state = api.inspect();
    assert.equal(state.blocked, true);
    assert.equal(state.lessonButton.cause, cause);
    assert.equal(api.open({ expectedUrl: bookUrl, key: 'lesson' }).ok, false);
    assert.equal(item.open.clicks, 0);
  }

  const item = card('Lesson', { text: 'Open lesson', attributes: { 'data-lesson-id': '101' } });
  item.node.innerText = 'Lesson\nOpen lesson';
  const { api } = environment(bookUrl, [item.node]);
  const state = api.inspect();
  const replacement = card('Lesson', { text: 'Open lesson', attributes: { 'data-lesson-id': '101' } }).open;
  replacement.parentElement = item.node;
  item.node.children[0] = replacement;
  assert.equal(api.open({ expectedUrl: bookUrl, key: state.items[0].key }).code, 'navigation_stale');
  assert.equal(item.open.clicks + replacement.clicks, 0);
});

test('button diagnostics count visible choices owned by the first broken card', () => {
  const ready = card('Ready');
  const outer = element('li', { classes: 'unit_li', children: [card('Nested').node] });
  const multiple = card('Multiple');
  const another = mobileCard('Multiple').open;
  another.parentElement = multiple.node;
  multiple.node.children.push(another);
  const hidden = card('Hidden', { hidden: true });
  const disabled = card('Disabled', { disabled: true });
  for (const [broken, cause, desktopVisible, mobileVisible] of [
    [outer, 'missing', 0, 0], [multiple.node, 'multiple', 1, 1], [hidden.node, 'missing', 0, 0],
    [disabled.node, 'disabled', 1, 0],
  ]) {
    const { api } = environment(bookUrl, [ready.node, broken, card('Another missing', { hidden: true }).node]);
    const expected = { cardIndex: 2, desktopVisible, mobileVisible, cause };
    assert.deepEqual({ ...api.inspect().lessonButton }, expected);
    assert.deepEqual({ ...api.prepare({ expectedUrl: bookUrl }).lessonButton }, expected);
    assert.deepEqual({ ...api.open({ expectedUrl: bookUrl, key: 'lesson' }).lessonButton }, expected);
  }
});

test('unique title keys survive card ordering and reloads', () => {
  const first = environment(bookUrl, [card('Alpha').node, card('Beta').node]).api.inspect();
  const second = environment(bookUrl, [card('Beta').node, card('Alpha').node]).api.inspect();
  assert.equal(first.items[0].key, second.items[1].key);
  assert.equal(first.items[1].key, second.items[0].key);
});

test('book titles use a visible plain-text h1 and ignore hidden or navigation headings', () => {
  const hidden = element('h1', { text: 'Hidden title', hidden: true });
  const navigation = element('nav', { children: [element('h1', { text: 'Platform name' })] });
  const title = element('h1', { text: '  Starter\n Pack  ' });
  const { api } = environment(bookUrl, [hidden, navigation, title, card('Lesson').node]);
  assert.equal(api.inspect().title, 'Starter Pack');
  title.innerText = 'A'.repeat(600);
  assert.equal(api.inspect().title.length, 500);
});

test('book titles remain empty when no visible source heading is available', () => {
  const item = card('Lesson title');
  item.node.children.push(element('h1', { text: 'Lesson heading' }));
  item.node.children.at(-1).parentElement = item.node;
  const { api } = environment(bookUrl, [element('h1', { text: 'Hidden book name', attributes: { hidden: '' } }), item.node]);
  assert.equal(api.inspect().title, '');
});

test('opening re-reads the DOM and refuses stale titles and arbitrary selectors', () => {
  const item = card('Old title');
  const { api } = environment(bookUrl, [item.node]);
  const state = api.inspect();
  item.node.innerText = 'Changed title\nОткрыть урок';
  const renamed = api.open({ expectedUrl: state.url, key: state.items[0].key });
  assert.equal(renamed.ok, false);
  assert.equal(renamed.code, 'navigation_stale');
  assert.equal(api.open({ expectedUrl: state.url, key: 'button.edit_lesson', url: 'javascript:alert(1)' }).ok, false);
  assert.equal(item.open.clicks + item.edit.clicks, 0);
});

test('opening reports stale navigation after a control replacement or outline change without clicking', () => {
  const item = card('Lesson');
  const other = card('Other lesson');
  const { api, document } = environment(bookUrl, [item.node, other.node]);
  const state = api.inspect();
  const replacement = card('Lesson');
  document.children[0] = replacement.node;
  replacement.node.parentElement = document;
  const changedControl = api.open({ expectedUrl: state.url, key: state.items[0].key });
  assert.equal(changedControl.ok, false);
  assert.equal(changedControl.code, 'navigation_stale');
  assert.equal(item.open.clicks + replacement.open.clicks + other.open.clicks, 0);

  api.inspect();
  other.node.innerText = 'Renamed lesson\nОткрыть урок';
  const changedOutline = api.open({ expectedUrl: state.url, key: state.items[0].key });
  assert.equal(changedOutline.ok, false);
  assert.equal(changedOutline.code, 'navigation_stale');
  assert.equal(replacement.open.clicks + other.open.clicks, 0);
  const refreshed = api.inspect();
  assert.equal(api.open({ expectedUrl: refreshed.url, key: refreshed.items[0].key }).ok, true);
  assert.equal(replacement.open.clicks, 1);
  document.children.pop();
  const removed = api.open({ expectedUrl: refreshed.url, key: refreshed.items[1].key });
  assert.equal(removed.ok, false);
  assert.equal(removed.code, 'navigation_stale');
  assert.equal(other.open.clicks, 0);
  assert.equal(replacement.open.clicks, 1);
});

test('opening rejects wrong origin, path, credentials and unrelated routes', () => {
  const item = card('Lesson');
  const { api, location } = environment(bookUrl, [item.node]);
  const state = api.inspect();
  for (const expectedUrl of [bookUrl.replace('867169', '2'), bookUrl.replace('progressme.ru', 'platform.desharschool.ru'), bookUrl.replace('progressme.ru', 'evil.progressme.ru'), bookUrl.replace('https:', 'http:'), bookUrl.replace('https://', 'https://name:password@'), `${bookUrl}/delete`, 'javascript:alert(1)']) {
    assert.equal(api.open({ key: state.items[0].key, expectedUrl }).ok, false, expectedUrl);
  }
  location.pathname = '/cabinet/school/students';
  assert.equal(api.inspect().kind, 'unsupported');
  assert.equal(api.open({ key: state.items[0].key, expectedUrl: bookUrl }).ok, false);
  assert.equal(item.open.clicks, 0);
});

test('only the two exact supported HTTPS origins can expose navigation', () => {
  for (const origin of ['https://progressme.ru', 'https://platform.desharschool.ru']) assert.equal(environment(bookUrl.replace('https://progressme.ru', origin), [card('Lesson').node]).api.inspect().ready, true);
  for (const origin of ['https://other.progressme.ru', 'https://progressme.ru.evil.example', 'http://progressme.ru', 'https://progressme.ru:8443']) assert.equal(environment(bookUrl.replace('https://progressme.ru', origin), [card('Lesson').node]).api.inspect().kind, 'unsupported');
});

test('an explicitly connected white label exposes navigation only on its bound origin', () => {
  const origin = 'https://school-one.example';
  const url = bookUrl.replace('https://progressme.ru', origin);
  assert.equal(environment(url, [card('Lesson').node]).api.inspect().kind, 'unsupported');
  const connected = environment(url, [card('Lesson').node], origin);
  assert.equal(connected.api.inspect().kind, 'book');
  assert.equal(connected.api.inspect().ready, true);
  assert.equal(environment(url.replace('school-one', 'school-two'), [card('Lesson').node], origin).api.inspect().kind, 'unsupported');
});

test('same-title lessons open individually through the last observed stable list', () => {
  const first = card('Same lesson');
  const second = card('Same lesson');
  const { api } = environment(bookUrl, [first.node, second.node]);
  const state = api.inspect();
  assert.equal(state.items.length, 2);
  assert.notEqual(state.items[0].key, state.items[1].key);
  assert.doesNotMatch(state.warnings.join(' '), /одинаковые названия/);
  for (const item of state.items) assert.equal(api.open({ expectedUrl: state.url, key: item.key }).ok, true);
  assert.equal(first.open.clicks, 1);
  assert.equal(second.open.clicks, 1);
});

test('same-title lesson controls use explicit source IDs when available', () => {
  const first = card('Test'), second = card('Test');
  first.node.attributes['data-lesson-id'] = '101'; second.node.attributes['data-lesson-id'] = '202';
  const { api } = environment(bookUrl, [first.node, second.node]);
  const state = api.inspect();
  assert.deepEqual(Array.from(state.items, item => item.sourceId), ['101', '202']);
  assert.match(state.items[1].key, /\/id\/202$/);
  assert.equal(api.open({ expectedUrl: state.url, key: state.items[1].key }).ok, true);
  assert.equal(second.open.clicks, 1);
  assert.equal(first.open.clicks, 0);
});

test('reordering identical-title controls after inspection cannot redirect a positional click', () => {
  const first = card('Test'), second = card('Test');
  const { api, document } = environment(bookUrl, [first.node, second.node]);
  const state = api.inspect();
  document.children.reverse();
  assert.equal(api.open({ expectedUrl: state.url, key: state.items[0].key }).ok, false);
  assert.equal(first.open.clicks + second.open.clicks, 0);
  const refreshed = api.inspect();
  assert.equal(api.open({ expectedUrl: refreshed.url, key: refreshed.items[0].key }).ok, true);
  assert.equal(second.open.clicks, 1);
});

test('a changed list refuses an old click even when the selected title itself stayed unique', () => {
  const first = card('First'), second = card('Second');
  const { api, document } = environment(bookUrl, [first.node, second.node]);
  const state = api.inspect();
  document.children.reverse();
  assert.equal(api.open({ expectedUrl: state.url, key: state.items[0].key }).ok, false);
  assert.equal(first.open.clicks + second.open.clicks, 0);
});

test('sections and homework are associated with their current lesson', () => {
  const env = lesson();
  const state = env.api.inspect();
  assert.equal(state.ready, true);
  assert.equal(state.title, 'Starter lesson');
  assert.equal(state.lessonId, '13794943');
  assert.deepEqual(Array.from(state.items, item => item.kind), ['section', 'section', 'homework']);
  assert.deepEqual(Array.from(state.items, item => item.active), [true, false, false]);
  const homework = state.items[2];
  assert.equal(env.api.open({ expectedUrl: state.url, key: homework.key }).ok, true);
  assert.equal(env.homework.clicks, 1);
  env.location.pathname = '/lesson-editor/book/867169/lesson/13794943/section/for-homework';
  const homeworkState = env.api.inspect();
  assert.equal(homeworkState.items[2].key, homework.key);
  assert.deepEqual(Array.from(homeworkState.items, item => item.active), [false, false, true]);
  env.location.pathname = '/lesson-editor/book/867169/lesson/999/section/1';
  assert.equal(env.api.open({ expectedUrl: env.location.href, key: homework.key }).ok, false);
  assert.equal(env.homework.clicks, 1);
});

test('source icon glyphs do not hide homework or change its navigation identity', () => {
  for (const host of ['progressme.ru', 'platform.desharschool.ru']) {
    const env = lesson({ url: lessonUrl.replace('progressme.ru', host) });
    const original = env.api.inspect().items.find(item => item.kind === 'homework');
    const label = element('span', { text: 'Для\u00a0домашней работы' });
    const icon = element('i', { text: '\ue97d' });
    env.homework.children = [label, icon];
    for (const child of env.homework.children) child.parentElement = env.homework;
    env.homework.innerText = env.homework.textContent = '\ue9ce\nДля\u00a0домашней работы\n\ue97d';

    const state = env.api.inspect();
    const homework = state.items.filter(item => item.kind === 'homework');
    assert.equal(homework.length, 1, `${host}: homework must remain in the lesson itinerary`);
    assert.equal(homework[0].title, 'Для домашней работы');
    assert.equal(homework[0].key, original.key);
    assert.equal(env.api.open({ expectedUrl: state.url, key: homework[0].key }).ok, true);
    assert.equal(env.homework.clicks, 1);

    env.location.pathname = '/lesson-editor/book/867169/lesson/13794943/section/for-homework';
    const opened = env.api.inspect();
    assert.deepEqual(Array.from(opened.items, item => item.active), [false, false, true]);
    assert.equal(opened.items[2].key, original.key);
  }
});

test('homework discovery leaves unrelated additional controls alone', () => {
  const env = lesson({ sections: ['Дополнительно', 'Second section'] });
  const additional = element('div', { classes: 'lesson-viewer-section-right_additional', text: 'Дополнительно\n\ue9a1' });
  additional.parentElement = env.document;
  env.document.children.push(additional);
  env.homework.innerText = 'Для домашней работы\n\ue97d';

  const state = env.api.inspect();
  assert.deepEqual(Array.from(state.items, item => [item.kind, item.title]), [
    ['section', 'Дополнительно'], ['section', 'Second section'], ['homework', 'Для домашней работы'],
  ]);
  assert.equal(env.api.open({ expectedUrl: state.url, key: state.items[2].key }).ok, true);
  assert.equal(env.homework.clicks, 1);
  assert.equal(additional.clicks, 0);
});

test('a lesson redirect without its section id stays retryable until the final route arrives', () => {
  const env = lesson({ url: lessonUrl.replace(/\/\d+$/, '') });
  const pending = env.api.inspect();
  assert.equal(pending.kind, 'lesson');
  assert.equal(Object.hasOwn(pending, 'bookState'), false);
  assert.equal(pending.lessonId, '13794943');
  assert.equal(pending.ready, false);
  assert.equal(pending.blocked, false);
  assert.match(pending.readinessReason, /Ожидаем адрес/);
  env.location.href = lessonUrl;
  assert.equal(env.api.inspect().ready, true);
});

test('a real unnamed section retains its own control before and after switching to homework', () => {
  const env = lesson({ url: lessonUrl.replace(/\/\d+$/, ''), sections: ['', 'Раздел без названия'] });
  env.sections[0].attributes.class += ' regular';
  const pending = env.api.inspect();
  assert.equal(pending.ready, false);
  assert.equal(pending.blocked, false);

  env.location.href = lessonUrl;
  const opened = env.api.inspect();
  assert.equal(opened.ready, true);
  assert.equal(opened.items[0].title, 'Раздел без названия');
  assert.equal(opened.items[0].active, true);
  assert.notEqual(opened.items[0].key, opened.items[1].key);
  assert.equal(opened.items[0].key, pending.items[0].key);

  env.location.pathname = env.location.pathname.replace(/\/\d+$/, '/for-homework');
  const homework = env.api.inspect();
  assert.equal(homework.items[0].key, opened.items[0].key);
  assert.equal(homework.items[0].active, false);
  assert.equal(env.api.open({ expectedUrl: homework.url, key: homework.items[0].key }).ok, true);
  assert.equal(env.sections[0].clicks, 1);
  assert.equal(env.sections[1].clicks + env.homework.clicks, 0);

  env.sections[0].disabled = true;
  assert.equal(env.api.inspect().blocked, true);
});

test('the editable lesson Add section action is never enumerated or clicked', () => {
  const env = lesson({ sections: ['Starting point', 'Talking point'] });
  const add = element('div', { classes: 'sections-list_item regular', text: 'Добавить раздел', children: [
    element('div', { classes: 'sections-list_item_status', children: [element('i', { classes: 'iconedv-Plus' })] }),
  ] });
  env.sectionList.children.push(add); add.parentElement = env.sectionList;
  const state = env.api.inspect();
  assert.deepEqual(Array.from(state.items, item => item.title), ['Starting point', 'Talking point', 'Для домашней работы']);
  assert.equal(env.api.open({ expectedUrl: state.url, key: '867169/13794943/section/' + encodeURIComponent('Добавить раздел') + '/1' }).ok, false);
  assert.equal(add.clicks, 0);
  // The marker, not a Russian title, identifies this action.
  add.innerText = 'Add section';
  assert.equal(env.api.inspect().items.length, 3);
  const ordinary = element('div', { classes: 'sections-list_item regular', text: 'Добавить раздел' });
  env.sectionList.children.push(ordinary); ordinary.parentElement = env.sectionList;
  assert.equal(env.api.inspect().items.length, 4);
});

test('same-title sections remain separate and their observed controls can open', () => {
  const env = lesson({ sections: ['Same section', 'Same section', 'Unique section'] });
  const state = env.api.inspect();
  assert.equal(env.api.open({ expectedUrl: state.url, key: state.items[0].key }).ok, true);
  assert.equal(env.api.open({ expectedUrl: state.url, key: state.items[1].key }).ok, true);
  assert.equal(env.api.open({ expectedUrl: state.url, key: state.items[2].key }).ok, true);
  assert.equal(env.sections[2].clicks, 1);
});

test('hidden controls and hidden ancestors cannot be clicked', () => {
  const item = card('Hidden lesson');
  const { api } = environment(bookUrl, [item.node]);
  const state = api.inspect();
  item.open.attributes['aria-hidden'] = 'true';
  assert.equal(api.open({ expectedUrl: state.url, key: state.items[0].key }).ok, false);
  delete item.open.attributes['aria-hidden'];
  item.node.attributes.hidden = '';
  assert.equal(api.inspect().items.length, 0);
  assert.equal(api.open({ expectedUrl: state.url, key: state.items[0].key }).ok, false);
  assert.equal(item.open.clicks, 0);
});

test('disabled controls and malformed lesson cards stop traversal', () => {
  for (const options of [{ disabled: true }, { attributes: { 'aria-disabled': 'true' } }, { text: 'Редактировать' }]) {
    const item = card('Lesson', options);
    const { api } = environment(bookUrl, [item.node]);
    assert.equal(api.inspect().ready, false);
    assert.equal(item.open.clicks, 0);
  }
});

test('active search filters, pagination, infinite scroll and load more stop traversal', () => {
  for (const blocker of [
    element('input', { attributes: { placeholder: 'Найти урок' }, value: 'One lesson' }),
    element('input', { attributes: { type: 'search' }, value: 'One lesson' }),
    element('div', { classes: 'pagination' }),
    element('div', { attributes: { 'infinite-scroll': '' } }),
    element('button', { text: 'Показать ещё' }),
  ]) {
    const item = card('Lesson');
    const { api } = environment(bookUrl, [item.node, blocker]);
    const state = api.inspect();
    assert.equal(state.ready, false);
    assert.equal(state.blocked, true);
    assert.equal(api.open({ expectedUrl: state.url, key: state.items[0].key }).ok, false);
    const prepared = api.prepare({ expectedUrl: state.url });
    assert.equal(prepared.ok, false);
    assert.equal(prepared.code, 'navigation_blocked');
    assert.equal(prepared.blockedReasonCode, state.blockedReasonCode);
    assert.equal(item.open.clicks, 0);
  }
  const { api } = environment(bookUrl, [card('Lesson').node, element('input', { attributes: { type: 'search' }, value: '' })]);
  assert.equal(api.inspect().ready, true);
});

test('blocked navigation reports the specific check that stopped collection', () => {
  const search = element('input', { attributes: { type: 'search' }, value: 'One lesson' });
  const pagination = element('div', { classes: 'pagination' });
  const invalidItem = card('Disabled lesson', { disabled: true }).node;
  const invalidButton = mobileCard('Lesson', { icon: 'wrong_icon' }).node;
  const sameLesson = () => card('Lesson', { attributes: { 'data-lesson-id': '10' } }).node;
  const cases = [
    ['unsupported_page', 'https://progressme.ru/cabinet/school/materials', []],
    ['invalid_item', bookUrl, [invalidItem]],
    ['item_limit', bookUrl, Array.from({ length: 1001 }, (_, index) => card(`Lesson ${index}`).node)],
    ['lesson_button', bookUrl, [invalidButton]],
    ['search_active', bookUrl, [card('Lesson').node, search]],
    ['pagination', bookUrl, [card('Lesson').node, search, pagination]],
    ['duplicate_item', bookUrl, [sameLesson(), sameLesson()]],
  ];
  for (const [reason, url, nodes] of cases) {
    const state = environment(url, nodes).api.inspect();
    assert.equal(state.blocked, true, reason);
    assert.equal(state.blockedReasonCode, reason);
    assert.equal(navigationBlockReason(state.blockedReasonCode), reason);
    assert.equal(navigationBlockMessage(reason), state.warnings.at(-1));
  }
  const unblocked = environment(bookUrl, [card('Lesson').node]).api.inspect();
  assert.equal(unblocked.blocked, false);
  assert.equal(Object.hasOwn(unblocked, 'blockedReasonCode'), false);
  assert.equal(navigationBlockReason('constructor'), '');
  assert.equal(navigationBlockMessage('unknown_reason'), '');
});

test('an explicit empty lesson or homework can be ready but a bare layout cannot', () => {
  const empty = lesson({ empty: true, sections: [] });
  const emptyState = empty.api.inspect();
  assert.equal(emptyState.ready, true);
  assert.deepEqual({ ...emptyState.exerciseState }, { loaderVisible: false, listVisible: false, emptyVisible: true });
  const homework = lesson({ empty: true, url: lessonUrl.replace(/section\/\d+$/, 'section/for-homework') });
  assert.equal(homework.api.inspect().ready, true);
  assert.equal(homework.api.inspect().items.at(-1).active, true);
  empty.main.children.length = 0;
  assert.equal(empty.api.inspect().ready, false, 'the layout can mount before exercises or their empty-state');
  assert.equal(lesson({ header: false }).api.inspect().ready, false);
  empty.document.readyState = 'loading';
  assert.equal(empty.api.inspect().ready, false);
  assert.equal(environment(bookUrl, []).api.inspect().ready, false);
});

test('a visible exercise loader blocks traversal even while an old list is still present', () => {
  const env = lesson();
  const loader = element('div', { classes: 'vue_exercises_wrapper_loader' });
  env.main.children.push(loader); loader.parentElement = env.main;
  const state = env.api.inspect();
  assert.equal(state.ready, false);
  assert.equal(state.blocked, false, 'loading is retryable rather than unsupported navigation');
  assert.deepEqual({ ...state.exerciseState }, { loaderVisible: true, listVisible: true, emptyVisible: false });
  assert.equal(env.api.open({ expectedUrl: state.url, key: state.items[1].key }).ok, false);
  assert.equal(env.sections[1].clicks, 0);
  loader.attributes.hidden = '';
  const loaded = env.api.inspect();
  assert.equal(loaded.ready, true);
  assert.deepEqual({ ...loaded.exerciseState }, { loaderVisible: false, listVisible: true, emptyVisible: false });
});

test('lesson traversal ignores exercise pagination but stops for section-list pagination and load-more', () => {
  for (const control of [element('div', { classes: 'pagination' }), element('button', { text: 'Показать ещё' })]) {
    const env = lesson();
    env.main.children.push(control);
    control.parentElement = env.main;
    assert.equal(env.api.inspect().ready, true, 'Exercise pagination does not paginate the section list');
    assert.equal(env.api.inspect().blocked, false);
    env.main.children.pop();
    env.sectionList.children.push(control);
    control.parentElement = env.sectionList;
    assert.equal(env.api.inspect().ready, false);
    assert.equal(env.api.inspect().blocked, true);
  }
});

test('content signatures change when lesson content or card titles change', () => {
  const env = lesson();
  const before = env.api.inspect().contentSignature;
  assert.equal(env.api.inspect().contentSignature, before);
  env.main.innerText = 'A different exercise';
  assert.notEqual(env.api.inspect().contentSignature, before);
  const item = card('Alpha');
  const book = environment(bookUrl, [item.node]);
  const bookBefore = book.api.inspect().contentSignature;
  item.node.innerText = 'Beta\nОткрыть урок';
  assert.notEqual(book.api.inspect().contentSignature, bookBefore);
});

test('navigation is bounded and refuses a potentially incomplete inventory', () => {
  const cards = Array.from({ length: 1001 }, (_, index) => card(`Lesson ${index + 1}`));
  const { api } = environment(bookUrl, cards.map(item => item.node));
  const state = api.inspect();
  assert.equal(state.items.length, 1000);
  assert.equal(state.ready, false);
  assert.match(state.warnings.join(' '), /больше 1000/);
  assert.equal(api.open({ expectedUrl: state.url, key: state.items[0].key }).ok, false);
});
