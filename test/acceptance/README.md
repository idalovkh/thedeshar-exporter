# Проверка сжатия на реальном архиве в Chrome

Требуются Node.js 20+, Python 3.8+ и установленный Chrome с поддержкой
`Extensions.loadUnpacked` в Chrome DevTools Protocol. Стенд устанавливает
обе сборки во временный профиль Chrome. Сетевые обращения к исходной платформе
не нужны: браузер получает из приложенного архива оригинальные записи сбора и
потоки медиа через локальный сервер. Код интерфейса, упаковщик, загрузчик медиа,
манифест, политика CSP и кодировщик взяты из сравниваемых сборок. Адаптер
подменяет ответы учебной платформы, сообщения о захвате и выдачу разрешений.

Из каталога экспортёра:

```sh
CHROME_HEADFUL=1 node test/acceptance/paired-chrome.mjs \
  '/path/to/original-book.zip' dist/exporter-0.3.25.zip \
  dist/exporter-0.3.26.zip /private/tmp/exporter-webp-acceptance
```

На Windows задайте `$env:CHROME_HEADFUL='1'` в PowerShell и используйте
абсолютный путь к новому каталогу вне рабочего дерева для результата.
Запуск этого стенда на Windows в текущей проверке не подтверждён. Если Chrome
или Python установлены в нестандартном месте, задайте `CHROME_PATH` и
`PYTHON_PATH`. На macOS можно запустить команду через `caffeinate -i`.

В каждом из трёх прогонов пары используется свежий профиль; порядок сборок
чередуется. По умолчанию сервер не ограничивает скорость потоков. Чтобы
использовать одинаковый сетевой предел для обеих сборок, задайте
`REPLAY_MIB_PER_SECOND` (суммарная скорость локального сервера). Передача `-`
вместо ZIP новой сборки выполняет один диагностический прогон указанной первой
сборки. `REPLAY_REPEATS=3` повторяет диагностический прогон трижды. Оригинал книги не меняется.

В `report.json` указаны время от нажатия кнопки до готового Blob ZIP, размер,
версия Chrome, SHA-256 и выборочный пик суммарного RSS процессов Chrome
(выборка раз в 750 мс; разделяемые страницы могут учитываться несколько раз).
Сохранение готового Blob в файл проверяется отдельно и не входит в замер
готовности. Первые успешно полученные `baseline.zip` и `candidate.zip` остаются
в каталоге результата для проверки в одноразовых БД и S3. Не публикуйте их:
они содержат книгу. Временные профили и копии входных данных удаляются.

Стенд не проверяет реальный сбор, разрешения сайта или скорость внешнего CDN.
Воспроизведение в macOS не считается проверкой Windows. При сбое сравнения
сохраните текст ошибки и диагностические файлы; не засчитывайте успешный
прогон одной сборки как полную пару. Тестовый флаг
`CHROME_BLOB_FILE_TRANSPORT_BYTES` применяется только для диагностики
Blob storage; такие результаты не проходят приёмку обычного Chrome.

Для независимой проверки пикселей нужен Pillow 11 с WebP. Сравнение использует
RGBA, включая цвета полностью прозрачных пикселей, и SHA-256 остальных медиа:

```sh
python3 test/acceptance/verify-book-archive.py /absolute/original.zip /absolute/candidate.zip
```

Проверка результата импорта в одноразовых PostgreSQL и S3:

```sh
python3 test/acceptance/verify-import.py /absolute/baseline.zip /absolute/candidate.zip /private/tmp/unique-output
```

`--preflight-only` сверяет входные архивы без запуска импортов. Если прежняя
сборка не создала ZIP в Chrome и используется приложенный архив, зафиксируйте
это через `--baseline-origin original-user-archive`.

## Full HD

Для сравнения 0.3.26 и 0.3.27 задайте `REPLAY_FULL_HD=1` и `CHROME_HEADFUL=1`.
Стенд записывает изменение веса ZIP и проверяет прибавку к медиане времени до
60 секунд. Размеры растровых файлов проверяются отдельно.

```sh
node test/acceptance/fullhd-chrome.mjs dist/exporter-0.3.27.zip
python3 test/acceptance/verify-book-archive.py /absolute/baseline.zip /absolute/candidate.zip --full-hd
python3 test/acceptance/verify-import.py /absolute/baseline.zip /absolute/candidate.zip /private/tmp/unique-output --full-hd
```

Для проверки анимаций нужен Pillow 11 с поддержкой AVIF и WebP. Chrome
проверяет кадры, длительность, повторы, прозрачность и ориентацию.

## Проверка переиспользования загрузок

Для сравнения 0.3.28 и 0.3.29 задайте `REPLAY_REUSE=1` и `CHROME_HEADFUL=1`.
Стенд проверяет стабильность результатов в каждой из трёх пар, сокращение
числа запросов и переданных байтов и совпадение размера готового ZIP. Для
сохранённых архивов первой пары он сверяет манифест, порядок и содержимое
записей ZIP. Изменение времени создания архива допускается.

```sh
python3 test/acceptance/verify-book-archive.py /absolute/baseline.zip /absolute/candidate.zip --same-media
```

## Обязательный WebP

Для сравнения 0.3.29 и 0.3.30 задайте `REPLAY_STRICT_WEBP=1` и `CHROME_HEADFUL=1`.
Стенд проверяет одинаковые входные загрузки, отсутствие ошибок и прибавку к
медиане времени до 60 секунд. Вес ZIP и пиковая память записываются в отчёт.

```sh
REPLAY_STRICT_WEBP=1 node test/acceptance/fullhd-chrome.mjs dist/exporter-0.3.30.zip
python3 test/acceptance/verify-book-archive.py /absolute/baseline.zip /absolute/candidate.zip --strict-webp --source /absolute/original-book.zip
python3 test/acceptance/verify-import.py /absolute/baseline.zip /absolute/candidate.zip /private/tmp/unique-output --strict-webp --source /absolute/original-book.zip
```

Верификатор проверяет сигнатуры изображений, размеры, кадры, манифест и
дедупликацию. Браузерные фикстуры дополнительно сверяют пиксели и анимацию.

## Общие файлы в ZIP

Для сравнения 0.3.27 и 0.3.28 задайте `REPLAY_DEDUP=1` и `CHROME_HEADFUL=1`.
Передайте исходную книгу стенду `paired-chrome.mjs`. Он запишет размер ZIP,
время подготовки и пиковый RSS процессов Chrome для каждой пары.

```sh
python3 test/acceptance/verify-book-archive.py /absolute/baseline.zip /absolute/candidate.zip --dedup
python3 test/acceptance/verify-import.py /absolute/baseline.zip /absolute/candidate.zip /private/tmp/unique-output --dedup
```

Проверка сверяет содержимое и метаданные каждой ссылки, порядок манифеста и
уникальность записей ZIP. После импорта сравниваются структура книги и объекты
в тестовых PostgreSQL и MinIO.

## Начальная перезагрузка и восстановление навигации

`collection-navigation-chrome.mjs` устанавливает исходное расширение с настоящими
`background.js`, интерфейсом и коллектором в отдельный временный профиль Chrome.
Ответы поддерживаемого сайта полностью подменяются фикстурой одной книги,
одного урока и раздела с подтверждённым пустым списком заданий.

Запускайте сценарии отдельно; каждый получает свежий профиль:

```sh
node test/acceptance/collection-navigation-chrome.mjs /private/tmp/exporter-navigation-race . race
node test/acceptance/collection-navigation-chrome.mjs /private/tmp/exporter-navigation-slow . slow
node test/acceptance/collection-navigation-chrome.mjs /private/tmp/exporter-navigation-network . network
node test/acceptance/collection-navigation-chrome.mjs /private/tmp/exporter-navigation-manual . manual
```

Для сравнения с прежней сборкой замените `.` на распакованный установочный ZIP.
В сценарии `race` CDP приостанавливает настоящий обработчик перед собственной
навигацией и вызывает `history.replaceState` старого документа. Само событие
history и последующая перезагрузка создаются Chrome; события менеджера не
подменяются. Сценарий `slow` держит ответ начальной перезагрузки 65 секунд и
проверяет, что после 60 секунд активная загрузка остаётся на первой попытке.
Сценарий `network` прерывает загрузку документа и проверяет автоматическое
восстановление. Сценарий `manual` перезагружает уже подтверждённую страницу,
проверяет остановку, запрет ZIP и скачивание отчёта с реальными document ID.

Результат содержит версию Chrome, SHA-256 проверенных исходников и диагностические
JSON. Проверка не включает выдачу разрешений и запись ZIP с медиа. Для отдельного
браузерного профиля исходники копируются во временный каталог, пользовательские
профили и сохранённые книги не изменяются.

## Двухэтапное открытие урока

Фикстура `lesson-entry-fixture.mjs` повторяет последовательность из отчёта:
`/lesson/18601240/section` → через 305 мс `/section/91646226` в том же документе.
Стенд обходит одну книгу с двумя уроками по три раздела,
возвращается в содержание и сохраняет все шесть подтверждённых разделов.
Фоновое замедление таймеров Chrome отключено только в изолированном стенде,
чтобы браузер не растягивал заданный промежуток до секунды.

```sh
node test/acceptance/collection-navigation-chrome.mjs /private/tmp/exporter-lesson-after . lesson-after
node test/acceptance/collection-navigation-chrome.mjs /private/tmp/exporter-lesson-before . lesson-before
node test/acceptance/collection-navigation-chrome.mjs /private/tmp/exporter-lesson-manual . lesson-manual
```

`lesson-after` получает первый исходный ответ после появления конкретного адреса
и должен завершиться без повторов. `lesson-before` получает ответ только на
промежуточном адресе: его недостаточно для сохранения раздела. После штатного
ожидания допустима одна повторная загрузка каждого первого раздела; новая
страница сама запрашивает свежий ответ. Стенд проверяет подтверждение авторских
данных именно на адресе каждой сохранённой секции и общий счётчик попыток.
`lesson-manual` после выбора первого раздела переключает источник на другой
раздел и проверяет остановку, запрет ZIP и скачиваемый диагностический отчёт.

Отдельная проверка нативного Navigation API:

```sh
node test/acceptance/collection-navigation-chrome.mjs /private/tmp/exporter-native-navigation . api-probe
```

Она устанавливает обработчик `currententrychange` в изолированном мире расширения,
вызывает `history.pushState` и `replaceState` из MAIN и проверяет, что доверенное
браузерное событие уже обработано до возврата history-вызова. Отчёт содержит
порядок событий, исходные и текущие адреса, включая переход обратно к книге.

## Привязка окна экспортёра

`exporter-binding-chrome.mjs` проверяет исходные background и UI в отдельном
профиле Chrome без разрешения `tabs`, с синтетической книгой вместо запросов
к платформе. Запускайте его в Chrome 148 и актуальном Chrome:

```sh
node test/acceptance/exporter-binding-chrome.mjs /private/tmp/exporter-binding-current
CHROME_PATH='/absolute/path/to/chrome-148' node test/acceptance/exporter-binding-chrome.mjs /private/tmp/exporter-binding-148
```

Для сравнения с прежней версией передайте дополнительным аргументом каталог
распакованного установочного ZIP. Каждый запуск требует нового выходного каталога.
Стенд проверяет переход со старого адреса окна, начало сбора при скрытом `tab.url`,
фокусировку владельца через инициализацию второго окна, отмену ожидающей проверки,
отказ старому документу, новый сбор, восстановление после перезапуска worker
и скачиваемый JSON после нарушения привязки. Для управления гонками один вызов
`runtime.getContexts` задерживается на границе браузерного API; исходники
расширения не подменяются. Нативное нажатие значка на панели и медиа-ZIP
в эту проверку не входят. Отчёт содержит версию браузера и SHA-256 проверенных
исходников. Профили пользователя и его материалы не используются.
