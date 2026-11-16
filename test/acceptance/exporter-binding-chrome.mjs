import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { fixtureBook, fixtureOrigin, fixtureHTML, fixtureJSON } from './collection-navigation-fixture.mjs';

const output = path.resolve(process.argv[2] || '');
const source = path.resolve(process.argv[3] || fileURLToPath(new URL('../..', import.meta.url)));
assert.ok(output.startsWith('/private/tmp/') && process.argv.length >= 3 && process.argv.length <= 4,
  'Usage: node test/acceptance/exporter-binding-chrome.mjs /private/tmp/OUTPUT [SOURCE_DIRECTORY]');
await mkdir(output, { mode: 0o700 });
const temporary = await mkdtemp(path.join(tmpdir(), 'thedeshar-exporter-binding-'));
const report = { complete: false, source, cases: [], limitations: [
  'The shipping background and dashboard run unchanged in a fresh Chrome profile; source HTTP is a synthetic fixture.',
  'Cancellation and document replacement hold one real runtime.getContexts API call in the worker before it resolves.',
  'Owner-window focus is exercised through shipping RESOLVE_WORKSPACE startup; the native toolbar button is not clicked.',
  'No user profile, production book, media download, permission prompt or imported archive is used.',
] };
let child, cdp, sourceSession, dashboardSession, workerSession, workerTarget, extensionId, sourceTabId, dashboardTabId;
let stderr = '', dashboardURL = '', workspaceId = '';
const documentRequests = [], workerVersions = new Map();

function connect(process) {
  let sequence = 0, buffer = '';
  const pending = new Map(), events = new Map();
  const close = error => { for (const task of pending.values()) { clearTimeout(task.timer); task.reject(error); } pending.clear(); };
  process.stdio[4].setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (!value.id) { events.get(value.method)?.(value.params, value.sessionId); continue; }
      const task = pending.get(value.id);
      if (!task) continue;
      pending.delete(value.id); clearTimeout(task.timer);
      if (value.error) task.reject(Error(`${task.method}: ${value.error.message}`)); else task.resolve(value.result);
    }
  });
  process.stdio[3].on('error', close);
  process.once('error', close); process.once('exit', () => close(Error('Isolated Chrome stopped')));
  return { on: (name, handler) => events.set(name, handler),
    call: (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(`${method}: timed out`)); }, 20000);
      pending.set(id, { method, timer, resolve, reject });
      process.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    }) };
}
async function evaluate(session, expression, userGesture = false) {
  const result = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture }, session);
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function until(action, message, ms = 15000) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    try { const value = await action(); if (value) return value; }
    catch (error) { if (!/Execution context was destroyed|Cannot find context/.test(error.message)) throw error; }
    await wait(50);
  }
  throw Error(message);
}
const worker = expression => evaluate(workerSession, expression);
const dashboard = (expression, userGesture) => evaluate(dashboardSession, expression, userGesture);
const command = payload => dashboard(`chrome.runtime.sendMessage(${JSON.stringify({ tabId: sourceTabId, workspaceId, ...payload })})`);
const readState = () => command({ type: 'GET_STATE', summary: true });
const readSessions = () => worker('chrome.storage.session.get(null)');
async function attachWorker() {
  const target = await until(async () => (await cdp.call('Target.getTargets')).targetInfos.find(value =>
    value.type === 'service_worker' && value.url === `chrome-extension://${extensionId}/src/background.js`), 'Shipping worker did not start');
  workerTarget = target.targetId;
  ({ sessionId: workerSession } = await cdp.call('Target.attachToTarget', { targetId: workerTarget, flatten: true }));
  await until(() => worker('Boolean(globalThis.chrome?.runtime?.getContexts)'), 'Runtime context lookup is unavailable');
}
async function ready() {
  const status = await until(() => dashboard(`(() => {
    const button=document.querySelector('#collect-book'), message=document.querySelector('#message');
    if (button && !button.hidden && !button.disabled) return {ready:true,url:location.href};
    if (message && !message.hidden && message.classList.contains('error') && message.textContent)
      return {ready:false,url:location.href,error:message.textContent};
    return null;
  })()`), 'Shipping dashboard did not become usable');
  report.lastDashboard = status;
  assert.equal(status.ready, true, `Shipping dashboard startup failed: ${status.error || JSON.stringify(status)}`);
  return status;
}
async function holdNextOwnerLookup() {
  await worker(`(() => {
    const original=globalThis.__bindingOriginalGetContexts || chrome.runtime.getContexts.bind(chrome.runtime);
    globalThis.__bindingOriginalGetContexts=original;
    globalThis.__bindingHold={armed:true,waiting:false,released:false};
    chrome.runtime.getContexts=async filter=>{
      const hold=globalThis.__bindingHold;
      if(hold.armed && filter.tabIds?.includes(${dashboardTabId})) {
        hold.armed=false;hold.waiting=true;
        await new Promise(resolve=>{hold.release=()=>{hold.released=true;resolve();};});
      }
      return original(filter);
    };
    return true;
  })()`);
}
async function releaseOwnerLookup() { await worker('globalThis.__bindingHold.release(); true'); }
async function assertNoLateStart(beforeRequests) {
  await wait(300);
  const state = await readState();
  assert.equal(state.ok, true, state.error);
  assert.notEqual(state.state.collection?.status, 'running');
  const stored = await readSessions();
  assert.equal(stored[`collection:${sourceTabId}`], undefined, 'A late preflight recreated the collection lease');
  assert.equal(stored[`capture-id:${sourceTabId}`], undefined, 'A late preflight restarted source capture');
  assert.equal(documentRequests.length, beforeRequests, 'A cancelled preflight navigated the source');
  return state.state;
}

try {
  const extension = path.join(temporary, 'extension');
  await mkdir(extension);
  for (const name of ['src', 'manifest.json', 'exporter.html']) await cp(path.join(source, name), path.join(extension, name), { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
  assert.equal(manifest.background.service_worker, 'src/background.js');
  assert.equal(manifest.permissions.includes('tabs'), false, 'This acceptance case must retain the shipping permission set');
  report.extensionVersion = manifest.version;
  report.permissions = manifest.permissions;
  report.sources = {};
  async function hashSources(relative) {
    for (const entry of await readdir(path.join(extension, relative), { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await hashSources(name);
      else report.sources[name] = createHash('sha256').update(await readFile(path.join(extension, name))).digest('hex');
    }
  }
  await hashSources('src');
  for (const name of ['manifest.json', 'exporter.html']) report.sources[name] = createHash('sha256').update(await readFile(path.join(extension, name))).digest('hex');
  child = spawn(process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', `--user-data-dir=${path.join(temporary, 'profile')}`, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    '--no-first-run', '--disable-background-networking', '--disable-component-update', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16384); });
  cdp = connect(child);
  report.chrome = (await cdp.call('Browser.getVersion')).product;
  await cdp.call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: output });
  ({ id: extensionId } = await cdp.call('Extensions.loadUnpacked', { path: extension }));
  await attachWorker();
  const { targetId: sourceTarget } = await cdp.call('Target.createTarget', { url: 'about:blank' });
  ({ sessionId: sourceSession } = await cdp.call('Target.attachToTarget', { targetId: sourceTarget, flatten: true }));
  cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
    for (const version of versions) workerVersions.set(version.versionId, version);
  });
  await cdp.call('ServiceWorker.enable', {}, sourceSession);
  cdp.on('Fetch.requestPaused', (request, session) => {
    void (async () => {
      if (session !== sourceSession) return;
      const url = new URL(request.request.url);
      if (url.origin !== fixtureOrigin) {
        await cdp.call('Fetch.failRequest', { requestId: request.requestId, errorReason: 'BlockedByClient' }, session); return;
      }
      const data = fixtureJSON(url.pathname);
      if (!data && request.resourceType !== 'Document') {
        await cdp.call('Fetch.fulfillRequest', { requestId: request.requestId, responseCode: 204 }, session); return;
      }
      if (request.resourceType === 'Document') documentRequests.push(request.request.url);
      await cdp.call('Fetch.fulfillRequest', { requestId: request.requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: data ? 'application/json' : 'text/html; charset=utf-8' }],
        body: Buffer.from(data ? JSON.stringify(data) : fixtureHTML()).toString('base64') }, session);
    })().catch(error => { report.interceptionError = error.message; });
  });
  await cdp.call('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sourceSession);
  await cdp.call('Page.navigate', { url: fixtureBook }, sourceSession);
  await until(() => evaluate(sourceSession, 'document.readyState === "complete" && Boolean(document.querySelector(".unit_li"))'), 'Source fixture did not load');
  sourceTabId = await worker(`(async () => (await chrome.tabs.query({})).find(tab=>tab.url===${JSON.stringify(fixtureBook)}).id)()`);
  const { targetId: dashboardTarget } = await cdp.call('Target.createTarget', { url: `chrome-extension://${extensionId}/exporter.html?tab=${sourceTabId}` });
  ({ sessionId: dashboardSession } = await cdp.call('Target.attachToTarget', { targetId: dashboardTarget, flatten: true }));
  await until(() => dashboard('Boolean(globalThis.chrome?.runtime)'), 'Dashboard did not load');
  await wait(100);
  report.ownerObservation = await worker(`(async () => {
    const contexts=await chrome.runtime.getContexts({contextTypes:['TAB'],frameIds:[0]});
    const context=contexts.find(value=>value.documentUrl?.includes('/exporter.html'));
    return {contexts,tab:context?await chrome.tabs.get(context.tabId):null};
  })()`);
  const initial = await ready();
  dashboardURL = initial.url;
  workspaceId = new URL(dashboardURL).searchParams.get('workspace');
  assert.ok(workspaceId, 'Legacy startup did not canonicalize its workspace');
  dashboardTabId = await dashboard('(async () => (await chrome.tabs.getCurrent()).id)()');
  const initialState = await readState();
  assert.equal(initialState.ok, true, initialState.error);
  report.cases.push({ name: 'legacy-startup-and-state-without-tabs-permission', passed: true,
    tabUrlPresent: typeof report.ownerObservation.tab?.url === 'string', canonicalURL: dashboardURL });

  const begun = await command({ type: 'BEGIN_COLLECTION', requestId: 'acceptance-focus-owner' });
  assert.equal(begun.ok, true, begun.error);
  const { targetId: duplicateTarget } = await cdp.call('Target.createTarget', { url: dashboardURL });
  await until(async () => (await worker(`chrome.tabs.get(${dashboardTabId})`)).active, 'Reopening did not focus the active owner window');
  assert.equal((await readSessions())[`collection:${sourceTabId}`]?.ownerTabId, dashboardTabId);
  await cdp.call('Target.closeTarget', { targetId: duplicateTarget });
  assert.equal((await command({ type: 'END_COLLECTION', collectionId: begun.collectionId })).ok, true);
  report.cases.push({ name: 'active-owner-focus-without-lease-takeover', passed: true });
  await ready(); await wait(150);

  await holdNextOwnerLookup();
  const beforeCancellation = documentRequests.length;
  await dashboard('document.querySelector("#collect-book").click(); true', true);
  await until(() => worker('globalThis.__bindingHold.waiting'), 'Collection preflight did not reach the controlled owner lookup');
  await dashboard('document.querySelector("#cancel-collection").click(); true', true);
  await until(() => dashboard('document.querySelector("#message")?.textContent.includes("Сбор остановлен")'), 'Cancellation waited for the suspended lookup', 3000);
  await releaseOwnerLookup();
  await assertNoLateStart(beforeCancellation);
  report.cases.push({ name: 'cancel-pending-owner-lookup-without-late-start', passed: true });
  await ready(); await wait(150);

  await holdNextOwnerLookup();
  const beforeReplacement = documentRequests.length;
  await dashboard('document.querySelector("#collect-book").click(); true', true);
  await until(() => worker('globalThis.__bindingHold.waiting'), 'Replacement preflight did not reach owner lookup');
  await cdp.call('Page.navigate', { url: 'about:blank' }, dashboardSession);
  await until(() => dashboard('location.href === "about:blank"'), 'Old dashboard document did not leave');
  await releaseOwnerLookup(); await wait(150);
  await cdp.call('Page.navigate', { url: dashboardURL }, dashboardSession);
  await ready();
  await assertNoLateStart(beforeReplacement);
  report.cases.push({ name: 'old-dashboard-document-cannot-complete-preflight', passed: true });

  await dashboard('document.querySelector("#collect-book").click(); true', true);
  const finished = await until(async () => {
    const state = await readState();
    if (state.state?.collection?.status === 'failed') throw Error(JSON.stringify(state.state.collection.diagnostics?.failure || state.state.collection.failed));
    return state.state?.collection?.status === 'finished' ? state.state : false;
  }, 'A fresh collection after cancellation did not finish', 30000);
  assert.ok(finished.snapshots.length >= 2);
  report.cases.push({ name: 'fresh-collection-after-cancel-and-replacement', passed: true, snapshots: finished.snapshots.length });

  await worker('globalThis.__bindingRestartMarker = true; true');
  const version = [...workerVersions.values()].find(value => value.scriptURL === `chrome-extension://${extensionId}/src/background.js` && value.runningStatus === 'running');
  if (version) await cdp.call('ServiceWorker.stopWorker', { versionId: version.versionId }, sourceSession);
  else assert.equal((await cdp.call('Target.closeTarget', { targetId: workerTarget })).success, true);
  await wait(100);
  const retained = await readState();
  assert.equal(retained.ok, true, retained.error);
  assert.equal(retained.state.collection.status, 'finished');
  assert.equal(retained.state.snapshots.length, finished.snapshots.length);
  await attachWorker();
  assert.equal(await worker('globalThis.__bindingRestartMarker === undefined'), true, 'The old worker was not actually stopped');
  report.cases.push({ name: 'worker-restart-retains-book-and-owner-authorization', passed: true });

  await dashboard(`(() => { const url=new URL(location.href); url.searchParams.set('workspace','00000000-0000-4000-8000-000000000081');
    history.replaceState({},'',url); window.dispatchEvent(new Event('focus')); return true; })()`);
  await until(() => dashboard('Boolean(document.querySelector("#message")?.textContent.includes("связ"))'), 'A genuine workspace mismatch did not reach the dashboard');
  await until(() => dashboard('!document.querySelector("#download-diagnostics").hidden'), 'Binding failure report is not downloadable');
  await dashboard('document.querySelector("#download-diagnostics").click(); true', true);
  const name = await until(async () => (await readdir(output)).find(value => /^exporter-problem-report-.*\.json$/.test(value)), 'Binding diagnostic JSON did not download');
  const diagnostic = JSON.parse(await readFile(path.join(output, name), 'utf8'));
  const failure = diagnostic.events.find(value => value.reason === 'exporter_binding_mismatch');
  assert.ok(failure, 'A binding mismatch degraded to generic connection_error');
  assert.equal(failure.binding.cause, 'document_mismatch', 'Changing the dashboard address must revoke its previous document binding');
  assert.equal(failure.binding.operation, 'GET_STATE');
  report.cases.push({ name: 'real-dashboard-navigation-has-downloadable-specific-diagnostics', passed: true,
    cause: failure.binding.cause, report: name });
  assert.equal(report.interceptionError, undefined, report.interceptionError);
  report.complete = true;
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ chrome: report.chrome, version: report.extensionVersion, cases: report.cases, report: path.join(output, 'report.json') }));
} catch (error) {
  report.error = error.message;
  if (cdp && dashboardSession) report.lastDashboard = await dashboard('({url:location.href,message:document.querySelector("#message")?.textContent})').catch(value => ({ error: value.message }));
  if (cdp && workerSession) report.sessions = await readSessions().catch(() => null);
  report.stderr = stderr;
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (stderr) console.error(stderr);
  throw error;
} finally {
  if (child && child.exitCode === null) {
    const stopped = once(child, 'exit').catch(() => {});
    child.kill('SIGTERM'); await Promise.race([stopped, wait(3000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  for (const stream of child?.stdio || []) stream?.destroy?.();
  await rm(temporary, { recursive: true, force: true });
}
