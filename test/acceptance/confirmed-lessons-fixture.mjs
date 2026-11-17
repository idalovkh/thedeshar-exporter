import assert from 'node:assert/strict';

/** Two source lessons exercise the shipping collector and direct-navigation authority. */
export function confirmedLessonsFixture(name) {
  if (!['confirmed-lessons', 'confirmed-lessons-fallback'].includes(name)) return null;
  const confirmed = name === 'confirmed-lessons';
  const fixtureOrigin = 'https://platform.desharschool.ru';
  const fixtureBook = `${fixtureOrigin}/cabinet/school/materials/book/71/content`;
  const route = lesson => `${fixtureOrigin}/lesson-editor/book/71/lesson/${lesson}`;
  const section = lesson => `${route(lesson)}/section/${lesson === 8 ? 9 : 11}`;
  return {
    fixtureOrigin, fixtureBook, fixtureSection: section(8),
    scenario: { name, lessonNavigation: 'document' },
    fixtureHTML() {
      return `<!doctype html><meta charset="utf-8"><title>Confirmed lesson fixture</title><main id="fixture"></main><script>
const confirmed = ${JSON.stringify(confirmed)};
const match = location.pathname.match(/\\/lesson\\/(8|10)(?:\\/|$)/);
const lesson = match ? Number(match[1]) : null;
const sectionId = lesson === 8 ? 9 : 11;
if (lesson && !location.pathname.includes('/section/')) history.replaceState({}, '', '/lesson-editor/book/71/lesson/' + lesson + '/section/' + sectionId);
document.querySelector('#fixture').innerHTML = lesson
 ? '<input class="lesson-viewer-header_input" value="Lesson ' + lesson + '"><div class="sections-list"><div class="sections-list_item current" data-section-id="' + sectionId + '">Empty section</div></div><main class="lesson-viewer-layout_main"><p class="lesson-viewer-plug_text">No exercises</p></main>'
 : '<h1>Confirmed lesson fixture</h1><ul>' + [8,10].map(id => '<li class="unit_li"' + (confirmed ? ' data-lesson-id="' + id + '"' : '') + '><div class="info"><p>Lesson ' + id + '</p></div><button class="open_lesson-desc" data-target="' + id + '">Открыть урок</button></li>').join('') + '</ul>';
for (const button of document.querySelectorAll('button[data-target]')) button.onclick = () => {
 const id = Number(button.dataset.target);
 location.assign('/lesson-editor/book/71/lesson/' + id + '/section/' + (id === 8 ? 9 : 11));
};
setTimeout(() => fetch(lesson ? '/lessons/qa/author/' + lesson : '/books/qa/groups').catch(() => {}),150);
</script>`;
    },
    fixtureJSON(pathname) {
      if (pathname === '/books/qa/groups') return { Class: 'CourseWsController', Method: 'GetBookCourses', IsSuccess: true,
        ProjectName: 'Books', Value: [{ Id: 1, Name: 'Group', CountLesson: 2 }] };
      const id = pathname.match(/^\/lessons\/qa\/author\/(8|10)$/)?.[1];
      return id ? { Class: 'GetExerciseWsController', Method: 'LoadExercises', IsSuccess: true, ProjectName: 'Exercises',
        Value: { SectionId: id === '8' ? 9 : 11, Items: [], Count: 0 } } : null;
    },
    validateFinished(result, scenario) {
      const lessons = result.collection.items.filter(item => item.kind === 'lesson');
      assert.equal(lessons.length, 2);
      assert.deepEqual(lessons.map(item => item.lessonId), ['8', '10']);
      assert.ok(result.collection.items.every(item => item.status === 'visited'));
      assert.ok([fixtureBook, section(8), section(10)].every(url => result.snapshots.some(snapshot => snapshot.url === url)));
      const contentsLoads = scenario.documentRequests.filter(request => request.url === fixtureBook).length;
      assert.equal(contentsLoads, confirmed ? 3 : 4,
        'Includes the user opening plus initial/final collection contents; fallback adds an intermediate contents');
      assert.equal(scenario.documentRequests.some(request => request.url === route(10)), confirmed,
        'Only source-confirmed IDs authorize the direct bare lesson route');
      scenario.confirmedNavigation = { confirmed, contentsLoads, collectorContentsLoads: contentsLoads - 1, lessons: lessons.length };
    },
  };
}
