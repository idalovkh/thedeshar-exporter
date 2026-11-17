import assert from 'node:assert/strict';
import { resumeCollectionFixture } from './resume-collection-fixture.mjs';

/** Continue from the incomplete lesson where the real stop button left the source. */
export function resumeLessonFixture(name) {
  if (name !== 'resume-from-lesson') return null;
  const fixture = resumeCollectionFixture('resume-confirmed');
  return {
    ...fixture,
    scenario: { ...fixture.scenario, name, resumeFromLesson: true },
    validateFinished(result, scenario) {
      fixture.validateFinished(result, scenario);
      assert.match(scenario.resumeSourceBeforeClick, /\/lesson\/8\/section\/10$/);
      assert.equal(scenario.resumeSourceBeforeClick, scenario.stoppedSourceUrl,
        'The source must stay on its interrupted lesson until Continue is clicked');
      assert.deepEqual(scenario.continueBeforeClick, { hidden: false, disabled: false, label: 'Продолжить сбор' });
      assert.equal(scenario.documentRequests[scenario.resumeDocumentRequestIndex]?.url, fixture.fixtureBook,
        'The collector must return to its saved contents URL after Continue is clicked');
    },
  };
}
