import assert from 'node:assert/strict';

export function validateCrossingReads(sourceEvents, bootstrap, first) {
  const concreteIndex = sourceEvents.findIndex(value => value.action === 'lesson-concrete');
  for (const kind of ['author', 'service']) {
    const startIndex = sourceEvents.findIndex(value => value.action === `${kind}-first-chunk`);
    const endIndex = sourceEvents.findIndex(value => value.action === `${kind}-last-chunk`);
    assert.ok(startIndex >= 0 && startIndex < concreteIndex && concreteIndex < endIndex,
      `${kind} body must be read on both sides of the landing`);
    assert.equal(sourceEvents[startIndex].url, bootstrap);
    assert.equal(sourceEvents[endIndex].url, first);
  }
}

export const crossingResponseScript = String.raw`
const crossingReads = new Map();
function crossingResponses(lesson, section, land) {
 const crossing = { remaining:2 };
 const started = new Promise(resolve=>{crossing.started=resolve;});
 crossing.landed = new Promise(resolve=>{crossing.finish=resolve;});
 crossingReads.set(lesson, crossing);
 for(const kind of ['author','service']){
  fetch('/lessons/qa/crossing/'+kind+'/'+lesson+'/'+section).then(response=>response.json());
 }
 Promise.all([started,new Promise(resolve=>setTimeout(resolve,305))]).then(()=>{
  land();
  crossing.finish();
 });
}
const originalClone = Response.prototype.clone;
Response.prototype.clone = function() {
 const clone = originalClone.call(this);
 const match = this.url && new URL(this.url).pathname.match(/^\/lessons\/qa\/crossing\/(author|service)\/(\d+)\/(\d+)$/);
 if(!match) return clone;
 const [,kind,lesson,section] = match, crossing = crossingReads.get(lesson);
 const body = clone.text().then(value=>new TextEncoder().encode(value));
 let readingSecondPart = false;
 // A zero high-water mark makes the first pull evidence of an actual read
 // by the shipping observer, even while the page gets its original response.
 return new Response(new ReadableStream({
  async pull(controller){
   const bytes = await body;
   const boundary = Math.ceil(bytes.length/2);
   if(!readingSecondPart){
    readingSecondPart = true;
    log(kind+'-first-chunk',lesson,section);
    controller.enqueue(bytes.subarray(0,boundary));
    if(--crossing.remaining===0) crossing.started();
    return;
   }
   await crossing.landed;
   log(kind+'-last-chunk',lesson,section);
   controller.enqueue(bytes.subarray(boundary));
   controller.close();
  }
 },{highWaterMark:0}));
};
`;
