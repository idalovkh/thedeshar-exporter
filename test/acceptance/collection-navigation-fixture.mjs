export const fixtureOrigin = 'https://platform.desharschool.ru';
export const fixtureBook = `${fixtureOrigin}/cabinet/school/materials/book/71/content`;
export const fixtureSection = `${fixtureOrigin}/lesson-editor/book/71/lesson/8/section/9`;

// Source-authored requests are intercepted by the runner. They pass through the
// shipping MAIN observer, bridge, background storage and author-data gate.
export function fixtureHTML({ lessonNavigation = 'spa' } = {}) {
  return `<!doctype html><meta charset="utf-8"><title>Navigation fixture</title>
<main id="fixture"></main><script>
const section = ${JSON.stringify(fixtureSection)};
const mode = ${JSON.stringify(lessonNavigation)};
function render() {
 const lesson = location.pathname.startsWith('/lesson-editor/');
 document.querySelector('#fixture').innerHTML = lesson
  ? '<input class="lesson-viewer-header_input" value="Fixture lesson"><div class="sections-list"><div class="sections-list_item current" data-section-id="9">Empty section</div></div><main class="lesson-viewer-layout_main"><p class="lesson-viewer-plug_text">No exercises</p></main>'
  : '<h1>Navigation fixture</h1><ul><li class="unit_li" data-lesson-id="8"><div class="info"><p>Fixture lesson</p></div><button class="open_lesson-desc">Открыть урок</button></li></ul>';
 if (!lesson) document.querySelector('button').onclick = () => {
  if (mode === 'spa') { history.pushState({}, '', section); render(); }
  else location.assign(section);
 };
 setTimeout(() => fetch(lesson ? '/lessons/qa/author' : '/books/qa/groups').catch(() => {}), 150);
}
render();
</script>`;
}

export function fixtureJSON(pathname) {
  if (pathname === '/books/qa/groups') return {
    Class: 'CourseWsController', Method: 'GetBookCourses', IsSuccess: true, ProjectName: 'Books',
    Value: [{ Id: 1, Name: 'Section 1', CountLesson: 1 }],
  };
  if (pathname === '/lessons/qa/author') return {
    Class: 'GetExerciseWsController', Method: 'LoadExercises', IsSuccess: true, ProjectName: 'Exercises',
    Value: { SectionId: 9, Items: [], Count: 0 },
  };
  return null;
}
