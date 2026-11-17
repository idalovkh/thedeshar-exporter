const messages = Object.freeze({
  unsupported_page: 'Откройте содержание книги или редактор урока на учебной платформе.',
  invalid_item: 'Некоторые элементы навигации недоступны или не имеют однозначного названия.',
  item_limit: 'Найдено больше 1000 элементов навигации. Автоматический обход этой страницы остановлен.',
  lesson_button: 'Карточка урока не содержит единственную распознанную кнопку «Открыть урок».',
  search_active: 'В книге включён поиск. Очистите фильтр перед автоматическим обходом.',
  pagination: 'Обнаружена пагинация или подгрузка элементов. Автоматический обход этой страницы остановлен.',
  duplicate_item: 'Несколько элементов навигации ссылаются на один исходный идентификатор. Проверьте список материала.',
});

export function navigationBlockReason(value) {
  return typeof value === 'string' && Object.hasOwn(messages, value) ? value : '';
}

export function navigationBlockMessage(value) {
  return messages[navigationBlockReason(value)] ?? '';
}
