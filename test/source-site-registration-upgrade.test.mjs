import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareSourceSite } from '../src/lib/source-site-registration.js';

test('an already connected white label updates its persisted scripts before another document loads', async () => {
  const calls = [];
  const origin = 'https://registered-school.example';
  const url = `${origin}/cabinet/school/materials/book/71/content`;
  const chrome = {
    storage: { local: { async set() {} } },
    permissions: { async contains() { return true; }, async request() { return true; }, async remove() {} },
    scripting: {
      async executeScript(value) { return [{ frameId: 0, result: value.func ? { compatible: true, url } : undefined }]; },
      async getRegisteredContentScripts({ ids }) {
        return ids.map(id => ({ id, matches: [`${origin}/*`], world: id.includes('-main-') ? 'MAIN' : 'ISOLATED',
          runAt: 'document_start', allFrames: false, persistAcrossSessions: true,
          js: id.includes('-main-') ? ['src/capture/hook.js'] : ['src/capture/source-binding.js', 'src/capture/navigation.js', 'src/capture/section-visit.js', 'src/capture/content.js'] }));
      },
      async updateContentScripts(scripts) { calls.push(...scripts); },
      async registerContentScripts() { assert.fail('existing registrations must be updated, not duplicated'); },
    },
  };
  await prepareSourceSite(chrome, { id: 7, url });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].world, 'ISOLATED');
  assert.deepEqual(calls[0].matches, [`${origin}/*`]);
  assert.deepEqual(calls[0].js, ['src/capture/source-binding.js', 'src/capture/navigation.js', 'src/capture/section-visit.js',
    'src/capture/confirmed-lesson.js', 'src/capture/content.js']);
});
