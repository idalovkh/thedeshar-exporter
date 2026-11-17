import assert from 'node:assert/strict';
import test from 'node:test';
import { downloadDiskMedia } from '../src/ui/download-disk-media.js';
import { createExportSpool } from '../src/lib/export-spool.js';
import { exportFileProblems } from '../src/lib/export-file-problems.js';
import { createExportPackage, replacePackageAssets } from '../src/lib/package.js';
import { memoryOPFS, testResources } from './disk-spool-fixture.mjs';

for (const missing of [3, 20, 21]) test(`all media finish and ZIP remains valid with ${missing} unavailable files`, async () => {
  const memory = memoryOPFS(), spool = await createExportSpool({ jobId: `missing-${missing}`, storage: memory.storage, locks: null });
  const candidates = Array.from({ length: 21 }, (_, i) => ({ id: `asset-${i}`, url: `https://cdn.example.org/${i}.mp3`, name: `${i}.mp3` }));
  let calls = 0;
  try {
    const files = await downloadDiskMedia(candidates, { spool, resources: testResources(), fetchFile: async url => {
      calls++;
      return Number(new URL(url).pathname.slice(1).split('.')[0]) < missing ? new Response('Denied', { status: 403 })
        : new Response('ID3audio', { headers: { 'content-type': 'audio/mpeg' } });
    } });
    assert.equal(calls, candidates.length);
    assert.equal(exportFileProblems(files, candidates).length, missing);
    const result = replacePackageAssets(createExportPackage({ assets: candidates }), files);
    assert.equal(result.manifest.completeness.missingAssets, missing);
    assert.equal(result.manifest.counts.downloadedAssets, 21 - missing);
    assert.equal(result.entries.filter(entry => entry.name.startsWith('media/')).length, missing === 21 ? 0 : 1, 'identical available bytes share one ZIP entry');
    assert.ok(result.manifest.completeness.warnings.length);
  } finally { await spool.dispose(); }
});
