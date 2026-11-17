import assert from 'node:assert/strict';

/** A real collector cancellation/resume, with an edited already-saved source answer. */
export function resumeCollectionFixture(name) {
  if (name !== 'resume-confirmed') return null;
  const fixtureOrigin = 'https://platform.desharschool.ru';
  const fixtureBook = `${fixtureOrigin}/cabinet/school/materials/book/71/content`;
  const section = id => `${fixtureOrigin}/lesson-editor/book/71/lesson/8/section/${id}`;
  const answer = capture => JSON.parse(capture.data.Value.Items[0].JsonData).correctAnswers[0];
  return {
    fixtureOrigin, fixtureBook, fixtureSection: section(9),
    scenario: { name, resumeCollection: true, resumePhase: 'first', lessonNavigation: 'document' },
    deferJSON(pathname, scenario) { return pathname === '/lessons/qa/author/10' && scenario.resumePhase === 'first'; },
    fixtureHTML() {
      return `<!doctype html><meta charset="utf-8"><title>Resume collection fixture</title><main id="fixture"></main><script>
function render(){
 const match=location.pathname.match(/\\/section\\/(9|10)\\/?$/), section=match?Number(match[1]):null;
 document.querySelector('#fixture').innerHTML=section
  ? '<input class="lesson-viewer-header_input" value="Resume lesson"><div class="sections-list">'+[9,10].map(id=>'<div class="sections-list_item '+(section===id?'current':'')+'" data-section-id="'+id+'">Section '+id+'</div>').join('')+'</div><main class="lesson-viewer-layout_main"><div class="vue_exercises_wrapper_loader">Loading</div></main>'
  : '<h1>Resume fixture</h1><ul><li class="unit_li" data-lesson-id="8"><div class="info"><p>Resume lesson</p></div><button class="open_lesson-desc">Открыть урок</button></li></ul>';
 if(!section) document.querySelector('button').onclick=()=>location.assign(${JSON.stringify(section(9))});
 else for(const button of document.querySelectorAll('.sections-list_item')) button.onclick=()=>{
  history.pushState({},'', '/lesson-editor/book/71/lesson/8/section/'+button.dataset.sectionId);render();
 };
 setTimeout(()=>fetch(section?'/lessons/qa/author/'+section:'/books/qa/groups').then(response=>response.json()).then(data=>{
  if(section&&location.pathname.endsWith('/section/'+section)) document.querySelector('.lesson-viewer-layout_main').innerHTML='<div class="exercises-list"><div data-exercise-id="'+(100+section)+'">Source exercise '+section+'</div></div>';
 }).catch(()=>{}),150);
}
render();
</script>`;
    },
    fixtureJSON(pathname, scenario) {
      if (pathname === '/books/qa/groups') return { Class: 'CourseWsController', Method: 'GetBookCourses', IsSuccess: true,
        ProjectName: 'Books', Value: [{ Id: 1, Name: 'Group', CountLesson: 1 }] };
      const id = pathname.match(/^\/lessons\/qa\/author\/(9|10)$/)?.[1];
      if (!id) return null;
      const edited = id === '9' && scenario.resumePhase === 'resuming';
      if (edited) scenario.editedAuthorResponses = (scenario.editedAuthorResponses || 0) + 1;
      return { Class: 'GetExerciseWsController', Method: 'LoadExercises', IsSuccess: true, ProjectName: 'Exercises',
        Value: { SectionId: Number(id), Count: 1, Items: [{ Id: 100 + Number(id), Type: 3, Name: 'Authored exercise',
          JsonData: JSON.stringify({ correctAnswers: [edited ? 'edited-answer-after-stop' : id === '9' ? 'saved-original-answer' : 'new-section-answer'] }) }] } };
    },
    validateFinished(result, scenario) {
      const before = scenario.beforeResume;
      assert.ok(before, 'The interrupted collector checkpoint must be recorded');
      assert.equal(before.collection.resume.confirmed.length, 1);
      assert.equal(before.collection.resume.confirmed[0].url, section(9));
      const previous = before.snapshots.find(snapshot => snapshot.url === section(9));
      const retained = result.snapshots.find(snapshot => snapshot.url === section(9));
      assert.ok(previous && retained);
      assert.equal(retained.capturedAt, previous.capturedAt, 'The saved section must not be recaptured');
      assert.equal(result.snapshots.find(snapshot => snapshot.url === fixtureBook).capturedAt,
        before.snapshots.find(snapshot => snapshot.url === fixtureBook).capturedAt, 'Resume must not clear and rebuild the dataset');
      const savedCaptures = result.captures.filter(capture => capture.pageUrl === section(9) && capture.data?.Value?.SectionId === 9);
      assert.equal(savedCaptures.length, 1);
      assert.equal(answer(savedCaptures[0]), 'saved-original-answer');
      assert.ok(scenario.editedAuthorResponses > 0, 'The source must actually return its edited answer during access revalidation');
      assert.ok(!JSON.stringify(result.captures).includes('edited-answer-after-stop'), 'Fresh readiness data must not replace saved authored definitions');
      assert.equal(answer(result.captures.find(capture => capture.data?.Value?.SectionId === 10)), 'new-section-answer');
      assert.equal(result.collection.resume.confirmed.length, 2);
      assert.equal(result.collection.items.filter(item => item.kind === 'section').length, 2);
      assert.ok(result.collection.items.every(item => item.status === 'visited'));
      assert.ok(Date.parse(result.snapshots.find(snapshot => snapshot.url === section(10)).capturedAt) > Date.parse(previous.capturedAt));
    },
  };
}
