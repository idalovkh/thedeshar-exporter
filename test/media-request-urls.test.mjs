import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMediaRequestUrls } from '../src/lib/media-request-urls.js';

const image = '883a1997-622d-447f-8910-0a7dd7ba2040.jpg';
const imagePath = `/files/LessonExerciseImages/${image}`;
const page = 'https://platform.desharschool.ru/lesson-editor/book/857133/lesson/13598158/section';
const alias = `${page}${imagePath}`;
const canonical = `https://media-y.progressme.ru${imagePath}`;

test('the confirmed legacy image path resolves to the CDN without changing its source identifier', () => {
  const assets = [{ url: alias }];
  const original = structuredClone(assets);
  const requests = buildMediaRequestUrls(assets);
  assert.deepEqual(requests.get(alias), { url: canonical });
  assert.deepEqual(assets, original);
});

test('both source sites accept root and editor section aliases, including homework and unextended UUIDs', () => {
  for (const origin of ['https://progressme.ru', 'https://platform.desharschool.ru']) {
    for (const prefix of ['', '/lesson-editor/book/1/lesson/2/section', '/lesson-editor/book/1/lesson/2/section/3',
      '/lesson-editor/book/1/lesson/2/section/for-homework']) {
      for (const filename of [image, image.replace('.jpg', ''), image.replace('.jpg', '.webp')]) {
        const path = `/files/LessonExerciseImages/${filename}`;
        const source = `${origin}${prefix}${path}`;
        assert.deepEqual(buildMediaRequestUrls([{ url: source }]).get(source), { url: `https://media-y.progressme.ru${path}` });
      }
    }
  }
});

test('observed absolute DTO or DOM URLs take priority over the known family fallback in either input order', () => {
  const target = `https://media.edvibe.com${imagePath}`;
  for (const assets of [[{ url: alias }, { url: target }], [{ url: target }, { url: alias }]]) {
    const requests = buildMediaRequestUrls(assets);
    assert.deepEqual(requests.get(alias), { url: target });
    assert.deepEqual(requests.get(target), { url: target });
  }
});

test('audio families resolve through exact observed URLs without inferring a global CDN', () => {
  for (const family of ['LessonExerciseAudios', 'WordExerciseAudios', 'AnotherConfirmedFamily']) {
    const path = `/files/${family}/${image.replace('.jpg', '.mp3')}`;
    const source = `${page}${path}`;
    const target = `https://cdn.example.org${path}`;
    assert.deepEqual(buildMediaRequestUrls([{ url: source }, { url: target }]).get(source), { url: target });
    assert.deepEqual(buildMediaRequestUrls([{ url: source }]).get(source), { url: source });
  }
});

test('only identical paths and query strings establish an observed alias', () => {
  const audioPath = imagePath.replace('LessonExerciseImages', 'LessonExerciseAudios').replace('.jpg', '.mp3');
  const source = `${page}${audioPath}?part=1&version=2`;
  const target = `https://media.edvibe.com${audioPath}?part=1&version=2`;
  const requests = buildMediaRequestUrls([{ url: source }, { url: target }]);
  assert.deepEqual(requests.get(source), { url: target });
  for (const changed of [
    target.replace('part=1', 'part=2'), target.replace('part=1&version=2', 'version=2&part=1'),
    target.replace('LessonExerciseAudios', 'WordExerciseAudios'), target.replace('/files/', '/other/'),
    target.replace('883a1997', '983a1997'),
  ]) {
    assert.deepEqual(buildMediaRequestUrls([{ url: source }, { url: changed }]).get(source), { url: source });
  }
});

test('the legacy fallback preserves query values exactly and excludes the network fragment', () => {
  const source = `${alias}?size=200&name=a%2Fb&name=c#private-fragment`;
  const target = `${canonical}?size=200&name=a%2Fb&name=c`;
  assert.deepEqual(buildMediaRequestUrls([{ url: source }]).get(source), { url: target });
  assert.deepEqual(buildMediaRequestUrls([{ url: `${alias}?#fragment` }]).get(`${alias}?#fragment`), { url: `${canonical}?` });
});

test('an explicitly empty query does not alias an observed address with no query', () => {
  const path = imagePath.replace('LessonExerciseImages', 'WordExerciseAudios');
  const source = `${page}${path}?`;
  const target = `https://media.edvibe.com${path}`;
  assert.deepEqual(buildMediaRequestUrls([{ url: source }, { url: target }]).get(source), { url: source });
});

test('equivalent observed URLs that differ only by fragment count as one destination', () => {
  const source = `${alias}?size=200#source-fragment`;
  const target = `https://media.edvibe.com${imagePath}?size=200`;
  const requests = buildMediaRequestUrls([{ url: source }, { url: `${target}#one` }, { url: `${target}#two` }]);
  assert.deepEqual(requests.get(source), { url: target });
  assert.deepEqual(requests.get(`${target}#one`), { url: `${target}#one` }, 'Already absolute external references retain their source identifiers');
});

test('multiple distinct observed destinations produce an explicit ambiguity without fallback', () => {
  const second = `https://media.edvibe.com${imagePath}`;
  const requests = buildMediaRequestUrls([{ url: alias }, { url: canonical }, { url: second }]);
  assert.deepEqual(requests.get(alias), { reason: 'ambiguous_media_url' });
  assert.deepEqual(requests.get(canonical), { url: canonical });
  assert.deepEqual(requests.get(second), { url: second });
});

test('unavailable sources stay unavailable and unavailable destinations cannot resolve aliases', () => {
  const target = `https://media.edvibe.com${imagePath}`;
  assert.deepEqual(buildMediaRequestUrls([{ url: alias, downloadUnavailable: true }, { url: target }]).get(alias), { url: alias });
  assert.deepEqual(buildMediaRequestUrls([{ url: alias }, { url: target, downloadUnavailable: true }]).get(alias), { url: canonical });
  const path = imagePath.replace('LessonExerciseImages', 'WordExerciseAudios');
  const source = `${page}${path}`;
  assert.deepEqual(buildMediaRequestUrls([{ url: source }, { url: `https://media.edvibe.com${path}`, downloadUnavailable: true }]).get(source), { url: source });
});

test('unsafe observed addresses cannot become requests or make a source alias ambiguous', () => {
  for (const target of [
    `http://cdn.example.org${imagePath}`, `https://user:password@cdn.example.org${imagePath}`,
    `https://127.0.0.1${imagePath}`, `https://192.168.1.12${imagePath}`, `https://service.internal${imagePath}`,
    `https://cdn.example.org:8443${imagePath}`, `https://[::1]${imagePath}`,
  ]) {
    const requests = buildMediaRequestUrls([{ url: alias }, { url: target }]);
    assert.deepEqual(requests.get(alias), { url: canonical });
    assert.deepEqual(requests.get(target), { url: target });
  }
});

test('lookalike and unrelated origins, credentials, protocols and nonstandard ports are not source aliases', () => {
  for (const source of [
    `https://progressme.ru.evil.example.org${imagePath}`, `https://other.progressme.ru${imagePath}`,
    `https://platform.desharschool.ru.example.org${imagePath}`, `https://cdn.example.org${imagePath}`,
    `https://user:password@progressme.ru${imagePath}`, `https://progressme.ru:8443${imagePath}`,
    `http://progressme.ru${imagePath}`, `https://127.0.0.1${imagePath}`, `https://progressme.ru.${imagePath}`,
  ]) assert.deepEqual(buildMediaRequestUrls([{ url: source }]).get(source), { url: source });
});

test('other routes, malformed paths and ordinary relative references keep their existing resolution semantics', () => {
  for (const source of [
    `${page}/relative-audio`, `relative-audio`, `files/ordinary.png`, '/files/ordinary.png',
    `${page}/files/LessonExerciseImages/not-a-uuid.jpg`, `${alias}/`,
    `${page}/files/LessonExerciseImages/extra/${image}`, `${page}//files/LessonExerciseImages/${image}`,
    `${page.replace('/857133/', '/not-a-number/')}${imagePath}`, `${page.replace('/13598158/', '/other/')}${imagePath}`,
    `${page}/unknown${imagePath}`, `https://progressme.ru/api${imagePath}`,
    alias.replace('.jpg', '.extensiontoolong'),
  ]) assert.deepEqual(buildMediaRequestUrls([{ url: source }]).get(source), { url: source });
});

test('one observed family or UUID does not establish a media host for other files', () => {
  const audioPath = imagePath.replace('LessonExerciseImages', 'LessonExerciseAudios').replace('.jpg', '.mp3');
  const source = `${page}${audioPath}`;
  const observed = `https://media.edvibe.com${imagePath}`;
  assert.deepEqual(buildMediaRequestUrls([{ url: source }, { url: observed }]).get(source), { url: source });
});

test('URL inference never mutates captured metadata, asset records or their ordering', () => {
  const assets = [
    { url: alias, sourcePage: `${page}/1`, metadata: { captured: ['original'] } },
    { url: canonical, name: 'Image', status: 'referenced' },
    { url: 'relative-audio', downloadUnavailable: true },
  ];
  const original = structuredClone(assets);
  Object.freeze(assets);
  assets.forEach(Object.freeze);
  const requests = buildMediaRequestUrls(assets);
  assert.deepEqual(assets, original);
  assert.deepEqual([...requests.keys()], assets.map(asset => asset.url));
});
