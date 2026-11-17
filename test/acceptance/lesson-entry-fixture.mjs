import assert from 'node:assert/strict';
import { crossingResponseScript, validateCrossingReads } from './lesson-entry-crossing-fixture.mjs';

const fixtureOrigin = 'https://platform.desharschool.ru';
const bookId = '1153358';
const lessons = [
  { id: '18601240', title: '1. am / is / are', sections: ['91646226', '91646227', '91646228'] },
  { id: '18601241', title: '2. I am doing', sections: ['91646236', '91646237', '91646238'] },
];
const fixtureBook = `${fixtureOrigin}/cabinet/school/materials/book/${bookId}/content`;
const sectionUrl = (lesson, section = '') => `${fixtureOrigin}/lesson-editor/book/${bookId}/lesson/${lesson}/section${section ? `/${section}` : ''}`;

// Replays the two history changes from the user's report, with two complete
// lessons so the tour must also return to contents and open the next lesson.
export function lessonEntryFixture(caseName) {
  if (!['lesson-before', 'lesson-after', 'lesson-crossing', 'lesson-crossing-mismatch', 'lesson-manual'].includes(caseName)) return null;
  const timing = caseName.startsWith('lesson-crossing') ? 'crossing' : caseName === 'lesson-before' ? 'before' : 'after';
  const manualSection = caseName === 'lesson-manual';
  const mismatch = caseName === 'lesson-crossing-mismatch';
  return {
    fixtureOrigin, fixtureBook, fixtureSection: sectionUrl(lessons[0].id, lessons[0].sections[0]),
    scenario: { name: `two-stage-lesson-entry-${manualSection ? 'manual-section-refusal' : `author-${timing}${mismatch ? '-mismatch' : ''}`}`,
      lessonEntry: true, manualSection, lessonNavigation: 'staged' },
    finishTimeoutMs: timing === 'before' ? 170_000 : 25_000,
    fixtureHTML() {
      return String.raw`<!doctype html><meta charset="utf-8"><title>Two-stage lesson entry</title><main id="fixture"></main><script>
const lessons = ${JSON.stringify(lessons)}, bookId = ${JSON.stringify(bookId)};
const timing = ${JSON.stringify(timing)}, manual = ${JSON.stringify(manualSection)};
const mismatch = ${JSON.stringify(mismatch)};
const route = (lesson, section='') => '/lesson-editor/book/'+bookId+'/lesson/'+lesson+'/section'+(section?'/'+section:'');
${timing === 'crossing' ? crossingResponseScript : ''}
function log(action, lesson, section='') {
 const events=JSON.parse(sessionStorage.getItem('lesson-entry-events') || '[]');
 events.push({action,lesson,section,url:location.href});
 sessionStorage.setItem('lesson-entry-events',JSON.stringify(events));
}
function author(lesson, section) {
 log('author-request',lesson,section);
 return fetch('/lessons/qa/author/'+lesson+'/'+section).then(response=>response.json()).then(()=>log('author-response',lesson,section));
}
function renderLesson(lesson, section='') {
 const source=lessons.find(value=>value.id===lesson);
 document.querySelector('#fixture').innerHTML='<input class="lesson-viewer-header_input" value="'+source.title+'"><div class="sections-list">'+source.sections.map((id,index)=>'<div class="sections-list_item '+(id===section?'current':'')+'" data-section-id="'+id+'">Section '+(index+1)+'</div>').join('')+'</div><main class="lesson-viewer-layout_main">'+(section?'<p class="lesson-viewer-plug_text">No exercises</p>':'<div class="vue_exercises_wrapper_loader">Loading first section</div>')+'</main>';
 for (const element of document.querySelectorAll('.sections-list_item')) element.onclick=()=>openSection(lesson,element.dataset.sectionId);
}
function openSection(lesson,section) {
 history.pushState({},'',route(lesson,section)); log('section-click',lesson,section);
 renderLesson(lesson,section); setTimeout(()=>author(lesson,section),80);
}
function openLesson(lesson) {
 const first=lessons.find(value=>value.id===lesson).sections[0];
 history.replaceState({},'',location.href);
 history.pushState({},'',route(lesson)); log('lesson-bootstrap',lesson);
 renderLesson(lesson);
 if(timing==='before') setTimeout(()=>author(lesson,first),60);
 const land = ()=>{
  history.replaceState({},'',route(lesson,first)); log('lesson-concrete',lesson,first);
  renderLesson(lesson,first);
  if(timing==='after'||mismatch) setTimeout(()=>author(lesson,first),manual?1500:80);
 };
 if(timing==='crossing') crossingResponses(lesson,first,land);
 else setTimeout(land,305);
}
globalThis.__lessonEntryManual=()=>openSection(lessons[0].id,lessons[0].sections[1]);
const match=location.pathname.match(/\/lesson\/(\d+)(?:\/section(?:\/(\d+))?)?\/?$/);
if(match) {
 const source=lessons.find(value=>value.id===match[1]);
 if(match[2]) {renderLesson(source.id,match[2]);setTimeout(()=>author(source.id,match[2]),80);}
 else openLesson(source.id);
} else {
 document.querySelector('#fixture').innerHTML='<h1>Murphy - Essential Grammar in Use</h1><ul>'+lessons.map(lesson=>'<li class="unit_li" data-lesson-id="'+lesson.id+'"><div class="info"><p>'+lesson.title+'</p></div><button class="open_lesson-desc">Открыть урок</button></li>').join('')+'</ul>';
 for(const card of document.querySelectorAll('.unit_li')) card.querySelector('button').onclick=()=>openLesson(card.dataset.lessonId);
 setTimeout(()=>fetch('/books/qa/groups'),150);
}
</script>`;
    },
    fixtureJSON(pathname) {
      if (pathname === '/books/qa/groups') return { Class: 'CourseWsController', Method: 'GetBookCourses', IsSuccess: true,
        ProjectName: 'Books', Value: [{ Id: 1, Name: 'Section 1', CountLesson: lessons.length }] };
      if (timing === 'crossing' && /^\/lessons\/qa\/crossing\/service\/\d+\/\d+$/.test(pathname)) return { status: 'ok' };
      const match = pathname.match(/^\/lessons\/qa\/(crossing\/)?author\/(\d+)\/(\d+)$/);
      const lesson = match && lessons.find(lesson => lesson.id === match[2] && lesson.sections.includes(match[3]));
      if (lesson) return {
        Class: 'GetExerciseWsController', Method: 'LoadExercises', IsSuccess: true, ProjectName: 'Exercises',
        Value: { SectionId: Number(mismatch && match[1] ? lesson.sections[1] : match[3]), Items: [], Count: 0 },
      };
      return null;
    },
    manualTarget: sectionUrl(lessons[0].id, lessons[0].sections[1]),
    validateStopped: mismatch ? (result, scenario) => {
      const firstLesson = lessons[0], first = sectionUrl(firstLesson.id, firstLesson.sections[0]);
      validateCrossingReads(scenario.sourceEvents.filter(value => value.lesson === firstLesson.id), sectionUrl(firstLesson.id), first);
      assert.equal(result.collection.diagnostics.failure.stage, 'save_page');
      assert.equal(result.dropped, 1, 'Only the mismatched material response counts as lost');
      assert.ok(result.captures.every(value => !value.url.includes('/crossing/')), 'Neither crossing response may be attached to the section');
      assert.ok(result.captures.some(value => value.pageUrl === first && value.data?.Value?.SectionId === Number(firstLesson.sections[0])),
        'A fresh matching response must reach the correct section before the loss stops collection');
    } : null,
    validateFinished(result, scenario) {
      assert.equal(result.collection.items.filter(value => value.kind === 'lesson').length, lessons.length);
      assert.ok(result.collection.items.every(value => value.status === 'visited'));
      assert.ok(result.snapshots.some(value => value.url === fixtureBook));
      const retries = result.collection.diagnostics.events.filter(value => value.status === 'retrying');
      assert.equal(retries.length, timing === 'before' ? lessons.length : 0,
        'Only an early reply without current-page confirmation may require a fresh source reload');
      assert.ok(retries.every(value => value.attempt === 2), 'Fresh author recovery must stay within the shared attempt budget');
      for (const lesson of lessons) {
        const bootstrap = sectionUrl(lesson.id), first = sectionUrl(lesson.id, lesson.sections[0]);
        const events = scenario.browserEvents.filter(value => value.name === 'onHistoryStateUpdated');
        const baseEvent = events.find(value => value.url === bootstrap);
        const firstEvent = events.find(value => value.url === first);
        assert.ok(baseEvent && firstEvent, 'The exact two-stage lesson route was not exercised');
        assert.equal(baseEvent.documentId, firstEvent.documentId, 'Bootstrap and first section must share a browser document');
        assert.ok(firstEvent.timeStamp - baseEvent.timeStamp >= 300, 'The reported 305 ms route delay was not replayed');
        const sourceEvents = scenario.sourceEvents.filter(value => value.lesson === lesson.id);
        const concreteIndex = sourceEvents.findIndex(value => value.action === 'lesson-concrete');
        assert.ok(concreteIndex >= 0);
        if (timing === 'crossing') {
          validateCrossingReads(sourceEvents, bootstrap, first);
          const replies = result.captures.filter(value => value.url.endsWith(`/crossing/author/${lesson.id}/${lesson.sections[0]}`));
          assert.equal(replies.length, 1, 'The delayed author response must be retained exactly once');
          assert.equal(replies[0].pageUrl, first);
        } else {
          const responseIndex = sourceEvents.findIndex(value => value.action === 'author-response' && value.section === lesson.sections[0]);
          assert.ok(responseIndex >= 0);
          assert.equal(responseIndex < concreteIndex, timing === 'before', 'First author response timing did not match the selected scenario');
        }
        for (const section of lesson.sections) {
          assert.ok(result.snapshots.some(value => value.url === sectionUrl(lesson.id, section)), `Section ${section} was not saved`);
          assert.ok(result.captures.some(value => value.pageUrl === sectionUrl(lesson.id, section) && value.data?.Value?.Count === 0 && value.data?.Value?.SectionId === Number(section)), `Section ${section} lacks an author response confirmed on its actual page`);
        }
        assert.ok(!result.snapshots.some(value => value.url === bootstrap), 'An intermediate lesson route was saved as a ready section');
      }
      if (timing === 'crossing') {
        assert.equal(result.dropped, 0, 'The service response must not count as a lost capture');
        assert.ok(result.captures.every(value => !value.url.includes('/crossing/service/')), 'The service response must not enter the archive');
      }
    },
  };
}
