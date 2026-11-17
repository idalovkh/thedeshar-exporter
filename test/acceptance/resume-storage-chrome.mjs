import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const output = path.resolve(process.argv[2] || '');
assert.ok(process.argv.length === 3 && output.startsWith('/private/tmp/'),
  'Usage: node test/acceptance/resume-storage-chrome.mjs /private/tmp/OUTPUT');
await mkdir(output, { mode: 0o700 });
const temporary = await mkdtemp(path.join(tmpdir(), 'thedeshar-resume-storage-'));
const exporter = fileURLToPath(new URL('../..', import.meta.url));
const extension = path.join(temporary, 'extension'), profile = path.join(temporary, 'profile');
const report = { complete: false, cases: [], chromeExits: [], limitations: [
  'Synthetic saved material only; the shipping background, default workspace store and real Chrome local/session storage run in an isolated profile.',
  'No source website is navigated; all host lookups are blocked. Browser.close tests a full clean process restart, not an operating-system crash.',
  'The real IndexedDB adoption contract additionally injects small storage mocks to exercise the supported predecessor layout.',
] };
let child, cdp, stderr = '';

function connect(process) {
  let sequence = 0, buffer = '';
  const pending = new Map();
  const close = error => { for (const task of pending.values()) { clearTimeout(task.timer); task.reject(error); } pending.clear(); };
  process.stdio[4].setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      const task = pending.get(value.id);
      if (!task) continue;
      pending.delete(value.id); clearTimeout(task.timer);
      if (value.error) task.reject(Error(task.method + ': ' + value.error.message)); else task.resolve(value.result);
    }
  });
  process.stdio[3].on('error', close); process.once('error', close);
  process.once('exit', () => close(Error('Isolated Chrome stopped')));
  return { call: (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(method + ': timed out')); }, 20000);
    pending.set(id, { method, timer, resolve, reject });
    process.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
  }) };
}
async function evaluate(session, expression) {
  const result = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session);
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function launch() {
  child = spawn(process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--user-data-dir=' + profile, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    '--no-first-run', '--disable-background-networking', '--disable-component-update', '--no-proxy-server',
    '--host-resolver-rules=MAP * ~NOTFOUND', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16384); });
  cdp = connect(child);
  report.chrome = (await cdp.call('Browser.getVersion')).product;
  const { id } = await cdp.call('Extensions.loadUnpacked', { path: extension });
  const { targetId } = await cdp.call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true });
  await cdp.call('Page.navigate', { url: `chrome-extension://${id}/resume-storage.html` }, sessionId);
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    if (await evaluate(sessionId, 'Boolean(globalThis.resumeStorageQa?.ready)')) return { id, sessionId };
    await wait(50);
  }
  throw Error('Resume storage QA module did not initialize');
}
async function closeBrowser() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const current = child, exited = once(current, 'exit');
  let graceful = false;
  try { await cdp.call('Browser.close'); graceful = true; }
  catch (error) { if (current.exitCode === null && current.signalCode === null) throw error; }
  const timedOut = await Promise.race([exited.then(() => false), wait(5000, true, { ref: false })]);
  if (timedOut) { current.kill('SIGKILL'); await exited; }
  report.chromeExits.push({ pid: current.pid, code: current.exitCode, signal: current.signalCode, graceful: graceful && !timedOut });
  assert.equal(timedOut, false, 'Chrome did not exit after Browser.close');
  assert.equal(current.exitCode, 0, 'Chrome restart must follow a complete clean shutdown');
}

try {
  await mkdir(extension);
  await cp(path.join(exporter, 'src'), path.join(extension, 'src'), { recursive: true });
  await cp(path.join(exporter, 'manifest.json'), path.join(extension, 'manifest.json'));
  await mkdir(path.join(extension, 'test'));
  for (const name of ['resume-ui-fixture.js', 'durable-store-checks.js']) await cp(path.join(exporter, 'test', name), path.join(extension, 'test', name));
  await writeFile(path.join(extension, 'resume-storage.html'), '<!doctype html><meta charset="utf-8"><script type="module" src="resume-storage-qa.js"></script>');
  await writeFile(path.join(extension, 'resume-storage-qa.js'), `
import { createWorkspaceStore } from './src/lib/store.js';
import { createBookWorkspaces } from './src/lib/book-workspaces.js';
import { collectionResumeInfo } from './src/lib/collection-resume.js';
import { savedResumeState, resumeBook } from './test/resume-ui-fixture.js';
import { runDurableStoreChecks } from './test/durable-store-checks.js';
const store = createWorkspaceStore();
const catalogue = createBookWorkspaces({storage:chrome.storage.local,sessionStorage:chrome.storage.session,listLegacy:store.listWorkspaceMetadata});
globalThis.resumeStorageQa = {ready:true,
 async seed() {
  const source = await chrome.tabs.create({url:'about:blank'}), exporter = await chrome.tabs.getCurrent();
  const entry = await catalogue.resolve({sourceTabId:source.id,url:resumeBook});
  const state = {...savedResumeState(),id:entry.storageId,exportRevision:4};
  state.collection.status='running';
  await store.updateWorkspace(entry.storageId,()=>state);
  await catalogue.update(entry.workspaceId,{state,sourceTabId:source.id,exporterTabId:exporter.id});
  await chrome.storage.session.set({['capture:'+source.id]:true,['capture-id:'+source.id]:'resume-acceptance-live-capture',
   ['collection:'+source.id]:{ownerTabId:exporter.id,storageId:entry.storageId,workspaceId:entry.workspaceId,collectionId:'resume-acceptance-live-collection'},
   ['collection-owner:'+exporter.id]:source.id});
  return {entry:await catalogue.get(entry.workspaceId),resume:collectionResumeInfo(state),sessions:await chrome.storage.session.get(null),local:await chrome.storage.local.get(null)};
 },
 async inspect(workspaceId) {
  const entry=await catalogue.get(workspaceId),state=await store.readWorkspace(entry.storageId);
  return {entry,resume:collectionResumeInfo(state),snapshots:state.snapshots,captures:state.captures,
   sessions:await chrome.storage.session.get(null),local:await chrome.storage.local.get(null)};
 },
 async rebind(workspaceId) {
  const source=await chrome.tabs.create({url:'about:blank'});
  const entry=await catalogue.resolve({sourceTabId:source.id,url:resumeBook,preferredWorkspaceId:workspaceId});
  return {entry,sourceTabId:source.id,state:await store.readWorkspace(entry.storageId),count:(await catalogue.list()).length};
 },
 async adoptionChecks() {return runDurableStoreChecks(indexedDB,'resume-adoption-'+crypto.randomUUID(),IDBKeyRange);}
};
`);
  report.sources = {};
  for (const name of ['src/lib/store.js', 'src/lib/durable-workspace-scope.js', 'src/lib/book-workspaces.js', 'src/lib/collection-resume.js', 'src/background.js']) {
    report.sources[name] = createHash('sha256').update(await readFile(path.join(extension, name))).digest('hex');
  }
  const first = await launch();
  const seeded = await evaluate(first.sessionId, 'resumeStorageQa.seed()');
  assert.equal(seeded.resume.available, true);
  assert.equal(seeded.entry.sourceTabId > 0, true);
  assert.equal(seeded.entry.exporterTabId > 0, true);
  const durableEntry = seeded.local['book-workspaces-v1'].entries[0];
  assert.equal(durableEntry.sourceTabId, undefined);
  assert.equal(durableEntry.exporterTabId, undefined);
  assert.ok(seeded.local['workspace-durable-scope']);
  report.cases.push({ name: 'shipping-default-store-seeds-durable-checkpoint-with-session-only-live-bindings', passed: true,
    workspaceId: seeded.entry.workspaceId, storageId: seeded.entry.storageId, confirmedSections: seeded.resume.confirmedSections });
  await closeBrowser();
  const second = await launch();
  assert.equal(second.id, first.id, 'The same unpacked path must retain its extension identity');
  const restored = await evaluate(second.sessionId, `resumeStorageQa.inspect(${JSON.stringify(seeded.entry.workspaceId)})`);
  assert.equal(restored.entry.workspaceId, seeded.entry.workspaceId);
  assert.equal(restored.entry.storageId, seeded.entry.storageId);
  assert.equal(restored.entry.sourceTabId, undefined);
  assert.equal(restored.entry.exporterTabId, undefined);
  assert.equal(restored.resume.available, true);
  assert.equal(restored.resume.confirmedSections, 1);
  assert.deepEqual(restored.snapshots, [{ url: 'https://progressme.ru/cabinet/school/materials/book/71/content', capturedAt: '2026-11-16T10:00:00.000Z' },
    { url: 'https://progressme.ru/lesson-editor/book/71/lesson/8/section/9', capturedAt: '2026-11-16T10:00:00.000Z' }]);
  assert.equal(restored.captures[0].receivedAt, '2026-11-16T10:00:00.000Z');
  assert.equal(restored.captures[0].data.Value.Items[0].Name, 'Saved answer');
  assert.equal(Object.keys(restored.sessions).some(key => /^(?:capture:|capture-id:|collection:|collection-owner:|book-workspace-bindings-v1$)/.test(key)), false);
  report.cases.push({ name: 'full-chrome-restart-retains-raw-data-timestamps-and-resumability-without-reviving-bindings', passed: true,
    extensionId: second.id, confirmedSections: restored.resume.confirmedSections, retainedSnapshotTimestamps: restored.snapshots.map(snapshot => snapshot.capturedAt),
    sessionKeys: Object.keys(restored.sessions) });
  const rebound = await evaluate(second.sessionId, `resumeStorageQa.rebind(${JSON.stringify(seeded.entry.workspaceId)})`);
  assert.equal(rebound.entry.workspaceId, seeded.entry.workspaceId);
  assert.equal(rebound.entry.storageId, seeded.entry.storageId);
  assert.equal(rebound.entry.sourceTabId, rebound.sourceTabId);
  assert.equal(rebound.count, 1);
  assert.deepEqual(rebound.state.snapshots, restored.snapshots);
  assert.deepEqual(rebound.state.captures, restored.captures);
  report.cases.push({ name: 'explicit-new-tab-rebind-reuses-original-workspace-and-authored-data', passed: true });
  const checks = await evaluate(second.sessionId, 'resumeStorageQa.adoptionChecks()');
  assert.equal(checks.length, 8);
  report.cases.push({ name: 'supported-v3-scope-and-catalogue-adoption-in-real-indexeddb', passed: true, checks });
  await closeBrowser();
  report.complete = true;
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  if (stderr) console.error(stderr);
  process.exitCode = 1;
} finally {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill();
    if (await Promise.race([exited.then(() => false), wait(5000, true, { ref: false })])) { child.kill('SIGKILL'); await exited; }
  }
  await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  report.cleanedUp = await stat(temporary).then(() => false, error => error.code === 'ENOENT');
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ complete: report.complete, cases: report.cases.map(item => ({name:item.name,passed:item.passed})),
  exits:report.chromeExits,cleanedUp:report.cleanedUp,report:path.join(output,'report.json'),error:report.error?.message }));
