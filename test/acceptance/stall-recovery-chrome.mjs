import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { fixtureBook, fixtureOrigin, fixtureHTML, fixtureJSON } from './collection-navigation-fixture.mjs';
const output = path.resolve(process.argv[2] || '');
assert.ok(output.startsWith('/private/tmp/') && process.argv.length === 3,
  'Usage: node test/acceptance/stall-recovery-chrome.mjs /private/tmp/OUTPUT');
await mkdir(output, { mode: 0o700 });
const temporary = await mkdtemp(path.join(tmpdir(), 'thedeshar-stall-recovery-'));
const source = fileURLToPath(new URL('../..', import.meta.url));
const report = { complete: false, cases: [], limitations: [
  'Shipping worker/dashboard/content scripts; synthetic HTTP and a fresh Chrome profile.',
  'Two document loads hang; clock offsets exercise the 30/60-second policy without long sleeps.',
  'No production account, permission prompt, direct request replay or media download is exercised.',
] };
let child, cdp, workerSession, dashboardSession, oldSource, extensionId, stderr = '', documentCount = 0;
const sessions = new Map();
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
async function evaluate(session, expression) {
  const result = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session);
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function until(action, message, timeout = 25000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    try { const result = await action(); if (result) return result; }
    catch (error) { if (!/Cannot find default execution context|Execution context was destroyed/.test(error.message)) throw error; }
    await wait(100);
  }
  throw Error(message);
}
const worker = expression => evaluate(workerSession, expression);
const dashboard = expression => evaluate(dashboardSession, expression);
async function advance(ms) {
  await worker(`globalThis.__stallOffset += ${ms}; true`);
  await dashboard(`globalThis.__stallOffset += ${ms}; true`);
}
try {
  const extension = path.join(temporary, 'extension');
  await mkdir(extension);
  for (const name of ['src', 'manifest.json', 'exporter.html']) await cp(path.join(source, name), path.join(extension, name), { recursive: true });
  report.extensionVersion = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8')).version;
  child = spawn(process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', `--user-data-dir=${path.join(temporary, 'profile')}`, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    '--no-first-run', '--disable-background-networking', '--disable-component-update', '--no-proxy-server',
    '--host-resolver-rules=MAP * ~NOTFOUND', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
  cdp = connect(child);
  report.chrome = (await cdp.call('Browser.getVersion')).product;
  cdp.on('Target.attachedToTarget', ({ sessionId, targetInfo }) => {
    void (async () => {
      sessions.set(targetInfo.targetId, sessionId);
      await cdp.call('Fetch.enable', { patterns: [{ urlPattern: fixtureOrigin + '/*', requestStage: 'Request' }] }, sessionId);
      await cdp.call('Runtime.runIfWaitingForDebugger', {}, sessionId);
    })().catch(error => { report.attachmentError = error.message; });
  });
  cdp.on('Fetch.requestPaused', (request, session) => {
    void (async () => {
      if (request.resourceType === 'Document' && [2, 3].includes(++documentCount)) return;
      const data = fixtureJSON(new URL(request.request.url).pathname);
      await cdp.call('Fetch.fulfillRequest', { requestId: request.requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: data ? 'application/json' : 'text/html; charset=utf-8' }],
        body: Buffer.from(data ? JSON.stringify(data) : fixtureHTML()).toString('base64') }, session);
    })().catch(error => { report.interceptionError = error.message; });
  });
  await cdp.call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
    filter: [{ type: 'page', exclude: false }, { exclude: true }] });
  ({ id: extensionId } = await cdp.call('Extensions.loadUnpacked', { path: extension }));
  const workerTarget = await until(async () => (await cdp.call('Target.getTargets')).targetInfos.find(target =>
    target.type === 'service_worker' && target.url === `chrome-extension://${extensionId}/src/background.js`), 'Worker did not start');
  ({ sessionId: workerSession } = await cdp.call('Target.attachToTarget', { targetId: workerTarget.targetId, flatten: true }));
  await worker('globalThis.__stallOffset=0; globalThis.__stallDate=Date.now.bind(Date); Date.now=()=>__stallDate()+__stallOffset; true');
  const sourceTarget = await cdp.call('Target.createTarget', { url: fixtureBook });
  await until(() => sessions.get(sourceTarget.targetId), 'Source did not attach');
  const sourceSession = sessions.get(sourceTarget.targetId);
  await until(() => evaluate(sourceSession, 'document.readyState === "complete" && Boolean(document.querySelector(".unit_li"))'), 'Fixture did not load');
  oldSource = await worker(`(async () => (await chrome.tabs.query({})).find(tab=>tab.url===${JSON.stringify(fixtureBook)}).id)()`);
  const dashboardTarget = await cdp.call('Target.createTarget', { url: `chrome-extension://${extensionId}/exporter.html?tab=${oldSource}` });
  await until(() => sessions.get(dashboardTarget.targetId), 'Dashboard did not attach');
  dashboardSession = sessions.get(dashboardTarget.targetId);
  await until(() => dashboard('Boolean(document.querySelector("#collect-book") && !document.querySelector("#collect-book").disabled)'), 'Dashboard did not become ready');
  await dashboard('globalThis.__stallOffset=0; globalThis.__stallPerformance=performance.now.bind(performance); Object.defineProperty(performance,"now",{value:()=>__stallPerformance()+__stallOffset}); document.querySelector("#collect-book").click(); true');
  await until(() => documentCount === 2, 'Initial collection load was not intercepted');
  const initial = await worker(`(async()=>{const s=await chrome.storage.session.get(null); return s['source-navigation:${oldSource}'];})()`);
  assert.ok(initial?.id);
  await advance(31000);
  const reload = await until(() => worker(`(async()=>{const s=await chrome.storage.session.get(null);const i=s['source-navigation:${oldSource}'];return i?.attempt===2?i:null;})()`), 'The hung browser load was not restarted');
  assert.equal(reload.deadlineAt, initial.deadlineAt);
  await until(() => documentCount === 3, 'Reload did not issue its document request');
  await advance(61000);
  const replacement = await until(() => worker(`(async()=>{const s=await chrome.storage.session.get(null);return Object.entries(s).find(([k,v])=>k.startsWith('source-navigation:') && v.attempt===3)?.[1] || null;})()`), 'The second hang did not create a replacement tab');
  assert.notEqual(replacement.tabId, oldSource);
  assert.equal(replacement.deadlineAt, initial.deadlineAt);
  report.cases.push({ name: 'hung-load-reload-and-tab-replacement-with-one-deadline', passed: true });
  report.replacement = { previousTabId: oldSource, newTabId: replacement.tabId };
  await until(() => dashboard('document.querySelector("#collection-title")?.textContent === "Сбор завершён"'), 'Collection did not finish after recovery');
  const final = await dashboard(`chrome.runtime.sendMessage({type:'GET_STATE',workspaceId:new URL(location.href).searchParams.get('workspace'),tabId:${replacement.tabId},summary:true})`);
  report.final = { status: final.state?.collection?.status, pages: final.state?.snapshots?.length,
    responses: final.state?.captures?.length, diagnostics: final.state?.collection?.diagnostics };
  assert.equal(final.ok, true, final.error);
  assert.equal(final.state.collection.status, 'finished');
  assert.equal(await worker(`chrome.tabs.get(${oldSource}).then(()=>true,()=>false)`), false);
  assert.equal(final.state.snapshots.length, 2);
  report.cases.push({ name: 'dashboard-keeps-ownership-and-closes-old-source-after-save', passed: true });
  report.complete = true;
} catch (error) {
  report.error = error.stack || error.message;
  if (dashboardSession) report.dashboard = await dashboard('({url:location.href,text:document.body.innerText})').catch(() => null);
  if (workerSession) report.sessions = await worker('chrome.storage.session.get(null)').catch(() => null);
  process.exitCode = 1;
} finally {
  report.documentCount = documentCount;
  if (stderr) report.chromeStderr = stderr;
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), wait(3000)]); }
  await rm(temporary, { recursive: true, force: true });
}
console.log(JSON.stringify({ output, complete: report.complete, cases: report.cases, error: report.error }));
