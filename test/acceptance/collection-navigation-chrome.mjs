import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import * as simpleFixture from './collection-navigation-fixture.mjs';
import { lessonEntryFixture } from './lesson-entry-fixture.mjs';
import { probeNavigationAPI } from './navigation-api-probe.mjs';
import { confirmedLessonsFixture } from './confirmed-lessons-fixture.mjs';
import { resumeCollectionFixture } from './resume-collection-fixture.mjs';
import { resumeLessonFixture } from './resume-lesson-fixture.mjs';

const output = path.resolve(process.argv[2] || '');
const source = path.resolve(process.argv[3] || fileURLToPath(new URL('../..', import.meta.url)));
const caseName = process.argv[4] || 'race';
assert.ok(output.startsWith('/private/tmp/') && process.argv.length >= 3 && process.argv.length <= 5,
  'Usage: node test/acceptance/collection-navigation-chrome.mjs /private/tmp/OUTPUT [SOURCE_DIRECTORY] [race|slow|network|manual|lesson-before|lesson-after|lesson-crossing|lesson-crossing-mismatch|lesson-manual|api-probe|confirmed-lessons|confirmed-lessons-fallback|resume-confirmed|resume-from-lesson]');
assert.ok(['race', 'slow', 'network', 'manual', 'lesson-before', 'lesson-after', 'lesson-crossing', 'lesson-crossing-mismatch', 'lesson-manual', 'api-probe', 'confirmed-lessons', 'confirmed-lessons-fallback', 'resume-confirmed', 'resume-from-lesson'].includes(caseName));
const fixture = resumeLessonFixture(caseName) || resumeCollectionFixture(caseName) || confirmedLessonsFixture(caseName) || lessonEntryFixture(caseName) || simpleFixture;
const { fixtureBook, fixtureOrigin, fixtureSection, fixtureHTML, fixtureJSON } = fixture;
await mkdir(output, { mode: 0o700 });
const temporary = await mkdtemp(path.join(tmpdir(), 'thedeshar-collection-navigation-'));
const report = { complete: false, cases: [], source, fixtureOrigin, slowDelayMs: 65_000,
  limitations: ['All source HTTP requests are intercepted synthetic fixtures; no user books or production service are contacted.',
    'The race is deliberately scheduled with a debugger pause before the shipping content script issues its navigation. The history event is produced by real Chrome.',
    'The existing supported-host permissions are used; permission prompts and media ZIP creation are outside this navigation check.'] };
let child, cdp, stderr = '', sourceSession, dashboardSession, workerSession;
let scenario, sourceTabId, breakpointId, raceInFlight;

function connect(process) {
  let sequence = 0, buffer = '';
  const pending = new Map(), events = new Map();
  const close = error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  process.stdio[4].setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (!value.id) { events.get(value.method)?.(value.params, value.sessionId); continue; }
      const item = pending.get(value.id);
      if (!item) continue;
      pending.delete(value.id); clearTimeout(item.timer);
      if (value.error) item.reject(Error(`${item.method}: ${value.error.message}`)); else item.resolve(value.result);
    }
  });
  process.stdio[3].on('error', close); process.once('error', close); process.once('exit', () => close(Error('Isolated Chrome stopped')));
  return { on: (name, handler) => events.set(name, handler),
    call: (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(`${method}: timed out`)); }, 30000);
      pending.set(id, { method, timer, resolve, reject });
      process.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    }) };
}

async function evaluate(session, expression, userGesture = false) {
  const value = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture }, session);
  if (value.exceptionDetails) throw Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
  return value.result.value;
}
async function until(action, message, ms = 20000) {
  const end = performance.now() + ms;
  while (performance.now() < end) { const value = await action(); if (value) return value; await wait(100); }
  throw Error(message);
}
const readState = () => evaluate(dashboardSession, `(async () => {
 const query = new URL(location.href).searchParams;
 return chrome.runtime.sendMessage({type:'GET_STATE',tabId:Number(query.get('tab')),workspaceId:query.get('workspace')});
})()`);
const sessions = () => evaluate(workerSession, 'chrome.storage.session.get(null)');
const browserEvents = () => evaluate(workerSession, 'globalThis.__navigationAcceptanceEvents || []');

try {
  const extension = path.join(temporary, 'extension');
  await mkdir(extension);
  for (const name of ['src', 'manifest.json', 'exporter.html']) await cp(path.join(source, name), path.join(extension, name), { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
  assert.equal(manifest.background.service_worker, 'src/background.js');
  report.extensionVersion = manifest.version;
  report.sources = {};
  async function sourceFiles(relative) {
    const files = [];
    for (const entry of await readdir(path.join(extension, relative), { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) files.push(...await sourceFiles(name)); else files.push(name);
    }
    return files.sort();
  }
  for (const name of ['manifest.json', 'exporter.html', ...await sourceFiles('src')]) {
    report.sources[name] = createHash('sha256').update(await readFile(path.join(extension, name))).digest('hex');
  }
  child = spawn(process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--user-data-dir=' + path.join(temporary, 'profile'), '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    '--no-first-run', '--disable-background-networking', '--disable-component-update', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND', 'about:blank',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16384); });
  cdp = connect(child);
  report.chrome = (await cdp.call('Browser.getVersion')).product;
  await cdp.call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: output });
  const { id } = await cdp.call('Extensions.loadUnpacked', { path: extension });
  const worker = await until(async () => (await cdp.call('Target.getTargets')).targetInfos.find(target => target.type === 'service_worker' && target.url === `chrome-extension://${id}/src/background.js`), 'Shipping background did not start');
  ({ sessionId: workerSession } = await cdp.call('Target.attachToTarget', { targetId: worker.targetId, flatten: true }));
  await cdp.call('Runtime.enable', {}, workerSession);
  await until(() => evaluate(workerSession, 'Boolean(globalThis.chrome?.runtime?.id && globalThis.chrome?.webNavigation)'), 'Shipping worker extension APIs did not initialize');
  await evaluate(workerSession, `globalThis.__navigationAcceptanceEvents=[];
   for(const name of ['onBeforeNavigate','onCommitted','onHistoryStateUpdated','onErrorOccurred']) chrome.webNavigation[name].addListener(event=>{
    if(event.frameId===0) globalThis.__navigationAcceptanceEvents.push({name,...event});
   });`);
  const { targetId: sourceTarget } = await cdp.call('Target.createTarget', { url: 'about:blank' });
  ({ sessionId: sourceSession } = await cdp.call('Target.attachToTarget', { targetId: sourceTarget, flatten: true }));
  await cdp.call('Debugger.enable', {}, sourceSession);
  cdp.on('Debugger.paused', (event, session) => {
    if (session !== sourceSession || !breakpointId || !event.hitBreakpoints?.includes(breakpointId)) return;
    const capturedBreakpoint = breakpointId; breakpointId = null;
    raceInFlight = (async () => {
      const before = await sessions();
      const intent = Object.values(before).find(value => value?.tabId === sourceTabId && value?.command);
      assert.ok(intent, 'The real background must arm an intent before the content navigation');
      scenario.paused = { intent, location: event.callFrames[0].location, url: event.callFrames[0].url };
      const result = await cdp.call('Debugger.evaluateOnCallFrame', { callFrameId: event.callFrames[0].callFrameId,
        expression: 'history.replaceState({acceptance:true}, "", location.href); location.href', returnByValue: true }, sourceSession);
      assert.ok(!result.exceptionDetails, 'The real source history update failed');
      const history = await until(async () => (await browserEvents()).find(value => value.tabId === sourceTabId && value.name === 'onHistoryStateUpdated' && value.url === fixtureBook && value.timeStamp >= (scenario.eventStart || 0)), 'Chrome did not emit the old-document history event', 5000);
      // Let the shipping background consume the browser event before resuming
      // location.assign; this is the specific ordering that used to fail.
      await wait(150);
      scenario.race = { before: intent, after: await sessions(), event: history };
      await cdp.call('Debugger.removeBreakpoint', { breakpointId: capturedBreakpoint }, sourceSession);
      await cdp.call('Debugger.resume', {}, sourceSession);
    })().catch(async error => {
      scenario.raceError = error.message;
      await cdp.call('Debugger.resume', {}, sourceSession).catch(() => {});
    });
  });
  cdp.on('Fetch.requestPaused', (request, session) => {
    void (async () => {
      if (session !== sourceSession) return;
      const url = new URL(request.request.url);
      if (url.origin !== fixtureOrigin) { await cdp.call('Fetch.failRequest', { requestId: request.requestId, errorReason: 'BlockedByClient' }, session); return; }
      const data = fixtureJSON(url.pathname, scenario);
      if (data) {
        scenario.authorRequests++;
        if (fixture.deferJSON?.(url.pathname, scenario)) {
          (scenario.deferredAuthorRequests ||= []).push(request.requestId);
          return;
        }
        await cdp.call('Fetch.fulfillRequest', { requestId: request.requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(data)).toString('base64') }, session);
        return;
      }
      if (request.resourceType !== 'Document') {
        await cdp.call('Fetch.fulfillRequest', { requestId: request.requestId, responseCode: 204 }, session); return;
      }
      scenario.documentRequests.push({ url: request.request.url, at: performance.now() });
      if (scenario.slow && url.href === fixtureBook && scenario.collecting && !scenario.slowHeld) {
        scenario.slowHeld = true;
        await wait(report.slowDelayMs);
      }
      if (scenario.networkFailure && url.href === fixtureSection && !scenario.failureInjected) {
        scenario.failureInjected = true;
        await cdp.call('Fetch.failRequest', { requestId: request.requestId, errorReason: 'ConnectionReset' }, session); return;
      }
      await cdp.call('Fetch.fulfillRequest', { requestId: request.requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
        body: Buffer.from(fixtureHTML({ lessonNavigation: scenario.lessonNavigation })).toString('base64') }, session);
    })().catch(error => { scenario.interceptionError = error.message; });
  });
  await cdp.call('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sourceSession);
  // One fresh Chrome profile per invocation keeps each case independent of a
  // previously completed source workspace without clearing its data.
  const cases = [fixture.scenario || {
    race: { name: 'initial-own-reload-with-old-document-history-and-SPA', injectHistory: true, lessonNavigation: 'spa' },
    slow: { name: 'slow-initial-book-reload-over-60-seconds', slow: true, lessonNavigation: 'document' },
    network: { name: 'native-navigation-failure-and-automatic-recovery', networkFailure: true, lessonNavigation: 'document' },
    manual: { name: 'manual-same-URL-reload-stops-with-downloadable-browser-context', manualReload: true, lessonNavigation: 'spa' },
    'api-probe': { name: 'native-navigation-API-cross-world-ordering', navigationProbe: true },
  }[caseName]];
  for (const config of cases) {
    scenario = { ...config, authorRequests: 0, documentRequests: [], collecting: false };
    await cdp.call('Page.navigate', { url: fixtureBook }, sourceSession);
    await until(() => evaluate(sourceSession, 'document.readyState === "complete" && document.querySelector(".unit_li") !== null'), 'Source book fixture did not load');
    sourceTabId = await evaluate(workerSession, `(async () => (await chrome.tabs.query({})).find(tab=>tab.url===${JSON.stringify(fixtureBook)}).id)()`);
    if (scenario.navigationProbe) {
      const probe = await probeNavigationAPI({ evaluate, workerSession, sourceSession, sourceTabId, book: fixtureBook, section: fixtureSection });
      report.cases.push({ name: scenario.name, passed: true, probe });
      continue;
    }
    const { targetId: dashboardTarget } = await cdp.call('Target.createTarget', { url: `chrome-extension://${id}/exporter.html?tab=${sourceTabId}` });
    ({ sessionId: dashboardSession } = await cdp.call('Target.attachToTarget', { targetId: dashboardTarget, flatten: true }));
    await until(() => evaluate(dashboardSession, 'Boolean(document.querySelector("#collect-book") && !document.querySelector("#collect-book").hidden && !document.querySelector("#collect-book").disabled)'), 'Shipping dashboard did not offer collection');
    if (scenario.injectHistory) {
      const content = await readFile(path.join(extension, 'src/capture/content.js'), 'utf8');
      const lineNumber = content.split('\n').findIndex(line => line.includes('const current = new URL(location.href), expected = new URL(message.expectedUrl), target = new URL(message.url);'));
      assert.ok(lineNumber > 0);
      const breakpoint = await cdp.call('Debugger.setBreakpointByUrl', { lineNumber, url: `chrome-extension://${id}/src/capture/content.js` }, sourceSession);
      breakpointId = breakpoint.breakpointId;
      scenario.breakpoint = breakpoint;
      scenario.eventStart = (await browserEvents()).at(-1)?.timeStamp || 0;
    }
    scenario.collecting = true;
    const started = performance.now();
    await evaluate(dashboardSession, 'document.querySelector("#collect-book").click(); true', true);
    if (scenario.resumeCollection) {
      scenario.beforeResume = await until(async () => {
        const state = (await readState()).state;
        return state.collection?.resume?.confirmed?.some(page => page.url === fixtureSection) ? state : false;
      }, 'The shipping collector did not persist the first section');
      await until(() => scenario.deferredAuthorRequests?.length, 'The incomplete second section was not held');
      await evaluate(dashboardSession, 'document.querySelector("#cancel-collection").click(); true', true);
      const stopped = await until(async () => {
        const response = await readState();
        if (!response.ok && response.code === 'stale_collection') return false;
        assert.equal(response.ok, true, response.error);
        const state = response.state;
        return state.collection?.status === 'cancelled' && !state.enabled ? state : false;
      }, 'The shipping stop button did not retain an interrupted collection');
      assert.equal(stopped.collection.resume.confirmed.length, 1);
      scenario.stoppedStatus = stopped.collection.status;
      scenario.stoppedSourceUrl = await evaluate(sourceSession, 'location.href');
      scenario.resumePhase = 'resuming';
      for (const requestId of scenario.deferredAuthorRequests) {
        await cdp.call('Fetch.failRequest', { requestId, errorReason: 'Aborted' }, sourceSession).catch(() => {});
      }
      if (!scenario.resumeFromLesson) {
        await cdp.call('Page.navigate', { url: fixtureBook }, sourceSession);
        await until(() => evaluate(sourceSession, 'document.readyState === "complete" && document.querySelector(".unit_li") !== null'), 'Source did not return to contents after stop');
      }
      scenario.resumeSourceBeforeClick = await evaluate(sourceSession, 'location.href');
      scenario.resumeDocumentRequestIndex = scenario.documentRequests.length;
      await until(() => evaluate(dashboardSession, 'Boolean(!document.querySelector("#collect-book").hidden && !document.querySelector("#collect-book").disabled && document.querySelector("#collect-label").textContent.trim() === "Продолжить сбор")'),
        'The shipping dashboard did not offer saved collection continuation');
      scenario.continueBeforeClick = await evaluate(dashboardSession, `({hidden:document.querySelector('#collect-book').hidden,
        disabled:document.querySelector('#collect-book').disabled,label:document.querySelector('#collect-label').textContent.trim()})`);
      await evaluate(dashboardSession, 'document.querySelector("#collect-book").click(); true', true);
      await until(async () => ['running', 'finished', 'failed'].includes((await readState()).state.collection?.status),
        'The shipping continue button did not start a resume collection');
    }
    if (scenario.manualSection) {
      scenario.beforeManualSection = await until(async () => {
        const stored = await sessions();
        const intent = Object.values(stored).find(value => value?.tabId === sourceTabId && value?.command);
        return intent?.target?.kind === 'lesson' && intent.observedUrl === fixtureSection ? intent : false;
      }, 'The staged first lesson did not bind its concrete first section');
      await evaluate(sourceSession, 'globalThis.__lessonEntryManual(); true', true);
    }
    if (scenario.manualReload) {
      scenario.beforeManualReload = await until(async () => {
        const stored = await sessions();
        const intent = Object.values(stored).find(value => value?.tabId === sourceTabId && value?.command);
        return intent?.phase === 'committed' ? intent : false;
      }, 'The shipping transition did not reach its initial commit');
      await cdp.call('Page.reload', {}, sourceSession);
    }
    if (scenario.slow) {
      await until(() => scenario.slowHeld, 'The collector did not start the initial reload');
      await wait(61_000);
      const stored = await sessions();
      const intent = Object.values(stored).find(value => value?.tabId === sourceTabId && value?.command);
      assert.equal(intent?.attempt, 1, 'A still-loading page was restarted after 60 seconds');
      const browserTab = await evaluate(workerSession, `chrome.tabs.get(${sourceTabId})`);
      assert.equal(browserTab.status, 'loading');
      const state = await readState();
      assert.equal(state.state.collection.status, 'running');
      scenario.after60 = { attempt: intent.attempt, deadlineAt: intent.deadlineAt, phase: intent.phase, browserStatus: browserTab.status };
    }
    const result = await until(async () => {
      const state = await readState();
      return ['finished', 'failed', 'cancelled'].includes(state.state?.collection?.status) ? state.state : false;
    }, 'The shipping collection did not finish', fixture.finishTimeoutMs || (scenario.networkFailure ? 35000 : 25000));
    await raceInFlight;
    scenario.elapsedMs = Math.round(performance.now() - started);
    scenario.result = result;
    scenario.browserEvents = (await browserEvents()).filter(value => value.tabId === sourceTabId);
    if (scenario.lessonEntry) scenario.sourceEvents = await evaluate(sourceSession, 'JSON.parse(sessionStorage.getItem("lesson-entry-events") || "[]")');
    scenario.sessions = await sessions();
    await writeFile(path.join(output, `${scenario.name}.json`), JSON.stringify(scenario, null, 2));
    assert.equal(scenario.raceError, undefined, scenario.raceError);
    assert.equal(scenario.interceptionError, undefined, scenario.interceptionError);
    if (scenario.manualReload || scenario.manualSection) {
      assert.equal(result.collection.status, 'failed');
      const failure = result.collection.diagnostics.failure;
      assert.equal(failure.reason, 'source_left_page');
      const cause = scenario.manualSection ? 'unexpected_target' : 'navigation_after_commit';
      assert.equal(failure.navigation?.cause, cause);
      if (scenario.manualSection) {
        assert.equal(failure.navigation.observedUrl, fixture.manualTarget);
        assert.ok(!result.snapshots.some(value => value.url === fixture.manualTarget),
          'The post-pin manual section was saved before the collector stopped');
      }
      assert.ok(failure.navigation.sourceDocumentId && failure.navigation.currentDocumentId,
        'Real compact Chrome document identities did not reach the stored failure');
      await until(() => evaluate(dashboardSession, '!document.querySelector("#download-diagnostics").hidden'), 'The stopped collection has no report button');
      assert.equal(await evaluate(dashboardSession, 'document.querySelector("#export").hidden || document.querySelector("#export").disabled'), true);
      await evaluate(dashboardSession, 'document.querySelector("#download-diagnostics").click(); true', true);
      const downloaded = await until(async () => (await readdir(output)).find(name => /^exporter-problem-report-.*\.json$/.test(name)), 'The problem report did not download');
      const problem = JSON.parse(await readFile(path.join(output, downloaded), 'utf8'));
      assert.equal(problem.collection.failure.navigation.cause, cause);
      assert.equal(problem.collection.failure.navigation.sourceDocumentId, failure.navigation.sourceDocumentId);
      assert.equal(problem.collection.failure.navigation.currentDocumentId, failure.navigation.currentDocumentId);
      assert.ok(problem.collection.failure.navigation.events.length <= 32);
      scenario.downloadedReport = downloaded;
      report.cases.push({ name: scenario.name, passed: true, elapsedMs: scenario.elapsedMs,
        cause: failure.navigation.cause, report: downloaded });
      await cdp.call('Target.closeTarget', { targetId: dashboardTarget });
      continue;
    }
    if (fixture.validateStopped) {
      assert.equal(result.collection.status, 'failed');
      fixture.validateStopped(result, scenario);
      assert.equal(await evaluate(dashboardSession, 'document.querySelector("#export").hidden || document.querySelector("#export").disabled'), true);
      report.cases.push({ name: scenario.name, passed: true, elapsedMs: scenario.elapsedMs, dropped: result.dropped });
      await cdp.call('Target.closeTarget', { targetId: dashboardTarget });
      continue;
    }
    assert.equal(result.collection.status, 'finished', JSON.stringify(result.collection.diagnostics?.failure || result.collection.failed));
    if (fixture.validateFinished) fixture.validateFinished(result, scenario);
    else {
      assert.equal(result.collection.items.filter(value => value.kind === 'lesson').length, 1);
      assert.ok(result.collection.items.every(value => value.status === 'visited'));
      assert.ok(result.snapshots.some(value => value.url === fixtureBook));
      assert.ok(result.snapshots.some(value => value.url === fixtureSection));
      assert.ok(result.captures.some(value => value.data?.Value?.Count === 0 && value.data?.Value?.SectionId === 9));
    }
    await until(() => evaluate(dashboardSession, '!document.querySelector("#export").hidden && !document.querySelector("#export").disabled'), 'The complete book is not available for export');
    if (scenario.injectHistory) {
      assert.ok(scenario.race?.event, 'The original old-document history ordering was not exercised');
      const after = Object.values(scenario.race.after).find(value => value?.tabId === sourceTabId && value?.command);
      assert.equal(scenario.race.event.documentId, scenario.race.before.attemptSourceBrowserDocumentId);
      assert.deepEqual(after, scenario.race.before, 'An ignored history event wrote or changed the armed transition');
    }
    if (scenario.slow) { assert.ok(scenario.elapsedMs >= 65000); assert.equal(scenario.documentRequests.filter(value => value.url === fixtureBook).length, 3); }
    if (scenario.networkFailure) {
      assert.equal(scenario.failureInjected, true);
      const retries = result.collection.diagnostics.events.filter(value => value.status === 'retrying' && value.reason === 'source_network_error');
      assert.ok(retries.length > 0);
      assert.equal(retries[0].attempt, 2);
      assert.ok(retries.every(value => value.attempt <= 3));
    }
    report.cases.push({ name: scenario.name, passed: true, elapsedMs: scenario.elapsedMs,
      captures: result.captures.length, snapshots: result.snapshots.length });
    await cdp.call('Target.closeTarget', { targetId: dashboardTarget });
  }
  report.complete = true;
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ chrome: report.chrome, version: report.extensionVersion, cases: report.cases, report: path.join(output, 'report.json') }));
} catch (error) {
  report.error = error.message;
  if (scenario) report.lastScenario = scenario;
  if (cdp && dashboardSession) report.lastState = await readState().catch(value => ({ error: value.message }));
  if (cdp && workerSession) { report.sessions = await sessions().catch(() => null); report.browserEvents = await browserEvents().catch(() => null); }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (stderr) console.error(stderr);
  throw error;
} finally {
  if (child && child.exitCode === null) {
    const stopped = once(child, 'exit').catch(() => {});
    child.kill('SIGTERM');
    await Promise.race([stopped, wait(5000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  // Chrome's updater descendants can keep inherited stderr open after the
  // isolated browser exits. Close only this runner's pipe endpoints.
  for (const stream of child?.stdio || []) stream?.destroy?.();
  await rm(temporary, { recursive: true, force: true });
}
