import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { cp, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const output = path.resolve(process.argv[2] || '');
const nativeOnly = process.argv[3] === '--native-only';
assert.ok((process.argv.length === 3 || process.argv.length === 4 && nativeOnly) && output.startsWith('/private/tmp/'),
  'Usage: node test/acceptance/source-navigation-chrome.mjs /private/tmp/OUTPUT [--native-only]');
await mkdir(output, { mode: 0o700 });
const temporary = await mkdtemp(path.join(tmpdir(), 'thedeshar-source-navigation-'));
const here = path.dirname(fileURLToPath(import.meta.url)), exporter = path.join(here, '../..');
const origin = 'https://school-one.example';
const book = `${origin}/cabinet/school/materials/book/71/content`;
const section = `${origin}/lesson-editor/book/71/lesson/8/section/9`;
const bookHTML = '<!doctype html><meta charset="utf-8"><h1>White-label fixture</h1><ul><li class="unit_li" data-lesson-id="8"><span>Fixture lesson</span><button class="open_lesson-desc" onclick="location.assign(\'' + section + '\')">Открыть урок</button></li></ul>';
const sectionHTML = '<!doctype html><meta charset="utf-8"><input class="lesson-viewer-header_input" value="Fixture lesson"><div class="sections-list"><div class="sections-list_item current" data-section-id="9">Section</div></div><main class="lesson-viewer-layout_main"><div class="exercises-list">A loaded exercise</div></main>';
let chrome, cdp, qaSession, stderr = '', mode = 'ready', sourceSession;
const report = { complete: false, fixtureOrigin: origin, slowDelayMs: 65_000, nativeOnly, cases: [],
  limitations: ['The fixture host permission is pregranted in the isolated test manifest; the native permission prompt is not exercised.',
    'The shipping recovery manager uses controlled fixture authorization; owner/lease refusals are covered by its unit and background integration tests.',
    'The 65-second browser test exercises loading/status policy; collector deadlines and retry orchestration are tested separately with injected-clock integration tests.'] };

function connect(child) {
  let sequence = 0, buffer = '';
  const pending = new Map(), events = new Map();
  const close = error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  child.stdio[4].setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (!value.id) { events.get(value.method)?.(value.params, value.sessionId); continue; }
      const item = pending.get(value.id);
      if (!item) continue;
      pending.delete(value.id); clearTimeout(item.timer);
      if (value.error) item.reject(Error(item.method + ': ' + value.error.message)); else item.resolve(value.result);
    }
  });
  child.stdio[3].on('error', close); child.once('error', close); child.once('exit', () => close(Error('Isolated Chrome stopped')));
  return { on: (name, handler) => events.set(name, handler),
    call: (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(method + ': timed out')); }, 30000);
      pending.set(id, { method, timer, resolve, reject });
      child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    }) };
}

try {
  const extension = path.join(temporary, 'extension');
  await mkdir(extension);
  await cp(path.join(exporter, 'src'), path.join(extension, 'src'), { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(exporter, 'manifest.json'), 'utf8'));
  manifest.host_permissions.push(`${origin}/*`);
  manifest.background = { service_worker: 'qa-background.js', type: 'module' };
  await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(extension, 'qa-background.js'), 'chrome.runtime.onMessage.addListener((_message, _sender, respond) => { respond({ok:true, enabled:false}); });');
  await copyFile(path.join(here, 'source-navigation-page.mjs'), path.join(extension, 'source-navigation-page.mjs'));
  await writeFile(path.join(extension, 'source-navigation.html'), '<!doctype html><meta charset="utf-8"><script type="module" src="source-navigation-page.mjs"></script>');
  report.sources = {};
  for (const name of ['src/lib/source-site-registration.js', 'src/lib/source-origins.js', 'src/lib/source-navigation.js',
    'src/lib/source-transition-policy.js', 'src/lib/source-navigation-status.js', 'src/lib/source-navigation-errors.js',
    'src/lib/collection.js', 'src/lib/collection-transition.js', 'src/lib/settle-section.js',
    'src/capture/hook.js', 'src/capture/navigation.js', 'src/capture/content.js']) {
    report.sources[name] = createHash('sha256').update(await readFile(path.join(extension, name))).digest('hex');
  }
  chrome = spawn(process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--user-data-dir=' + path.join(temporary, 'profile'), '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    '--no-first-run', '--disable-background-networking', '--disable-component-update', '--no-proxy-server',
    '--host-resolver-rules=MAP * ~NOTFOUND', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  chrome.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16384); });
  cdp = connect(chrome);
  report.chrome = (await cdp.call('Browser.getVersion')).product;
  const { id } = await cdp.call('Extensions.loadUnpacked', { path: extension });
  const { targetId: qaTarget } = await cdp.call('Target.createTarget', { url: `chrome-extension://${id}/source-navigation.html` });
  ({ sessionId: qaSession } = await cdp.call('Target.attachToTarget', { targetId: qaTarget, flatten: true }));
  const evaluate = async (session, expression, userGesture = false) => {
    const value = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture }, session);
    if (value.exceptionDetails) throw Object.assign(Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text), { detail: value });
    return value.result.value;
  };
  const until = async (action, message, ms = 15000) => {
    const end = performance.now() + ms;
    while (performance.now() < end) { const value = await action(); if (value) return value; await wait(100); }
    throw Error(message);
  };
  await until(() => evaluate(qaSession, 'Boolean(globalThis.sourceNavigationQa?.ready)'), 'Fixture extension did not initialize');
  const { targetId: sourceTarget } = await cdp.call('Target.createTarget', { url: 'about:blank' });
  ({ sessionId: sourceSession } = await cdp.call('Target.attachToTarget', { targetId: sourceTarget, flatten: true }));
  cdp.on('Fetch.requestPaused', (request, session) => {
    void (async () => {
      if (session !== sourceSession) return;
      const url = new URL(request.request.url);
      if (url.origin !== origin) { await cdp.call('Fetch.failRequest', { requestId: request.requestId, errorReason: 'BlockedByClient' }, session); return; }
      if (url.pathname.startsWith('/lesson-editor/')) {
        if (mode === 'fail') { await cdp.call('Fetch.failRequest', { requestId: request.requestId, errorReason: 'ConnectionReset' }, session); return; }
        if (mode === 'slow') await wait(report.slowDelayMs);
      }
      await cdp.call('Fetch.fulfillRequest', { requestId: request.requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
        body: Buffer.from(url.pathname.startsWith('/lesson-editor/') ? sectionHTML : bookHTML).toString('base64') }, session);
    })().catch(error => { report.interceptionError = error.message; });
  });
  await cdp.call('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sourceSession);
  await cdp.call('Page.navigate', { url: book }, sourceSession);
  await until(() => evaluate(sourceSession, 'document.readyState === "complete"'), 'Source fixture did not load');
  const sourceTabId = await evaluate(qaSession, `(async () => (await chrome.tabs.query({})).find(tab => tab.url === ${JSON.stringify(book)}).id)()`);
  const connected = await evaluate(qaSession, `sourceNavigationQa.connect(${sourceTabId})`, true);
  assert.equal(connected.connected, true);
  assert.equal(connected.otherSiteTrusted, false);
  assert.equal(connected.scripts.length, 2);
  for (const script of connected.scripts) { assert.deepEqual(script.matches, [`${origin}/*`]); assert.equal(script.allFrames, false); }
  report.cases.push({ name: 'dynamic-white-label-registration', passed: true, actualRegisteredScripts: connected.scripts });
  mode = 'fail';
  const first = await evaluate(qaSession, `sourceNavigationQa.start(${sourceTabId})`);
  assert.equal(first.ok, true);
  report.first = first;
  const failed = await until(async () => {
    const status = await evaluate(qaSession, `sourceNavigationQa.status(${JSON.stringify(first.transition.id)})`);
    report.lastNativeStatus = status;
    return status.state === 'network_error' ? status : false;
  }, 'A real native navigation error was not classified');
  report.nativeFailure = { status: failed, frame: await evaluate(qaSession, 'sourceNavigationQa.frame()'), events: await evaluate(qaSession, 'sourceNavigationQa.events()') };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await wait(2000);
  const afterBackoff = await evaluate(qaSession, `sourceNavigationQa.status(${JSON.stringify(first.transition.id)})`);
  assert.equal(afterBackoff.state, 'network_error');
  assert.equal(afterBackoff.canRetry, true);
  const retry = await evaluate(qaSession, `sourceNavigationQa.retry(${JSON.stringify(first.transition.id)})`);
  assert.equal(retry.transition.attempt, 2);
  assert.equal(retry.transition.deadlineAt, first.transition.deadlineAt);
  const secondFailure = await until(async () => {
    const status = await evaluate(qaSession, `sourceNavigationQa.status(${JSON.stringify(first.transition.id)})`);
    return status.state === 'network_error' && status.attempt === 2 ? status : false;
  }, 'The second real native navigation error was not classified');
  await wait(5000);
  const afterSecondBackoff = await evaluate(qaSession, `sourceNavigationQa.status(${JSON.stringify(first.transition.id)})`);
  assert.equal(afterSecondBackoff.state, 'network_error');
  assert.equal(afterSecondBackoff.canRetry, true);
  mode = 'ready';
  const third = await evaluate(qaSession, `sourceNavigationQa.retry(${JSON.stringify(first.transition.id)})`);
  assert.equal(third.transition.attempt, 3);
  assert.equal(third.transition.deadlineAt, first.transition.deadlineAt);
  const recovered = await until(async () => {
    const status = await evaluate(qaSession, `sourceNavigationQa.status(${JSON.stringify(first.transition.id)})`);
    return status.state === 'same_book' && !status.browserLoading ? status : false;
  }, 'Native navigation did not recover after retry');
  report.cases.push({ name: 'two-native-errors-and-recovery-with-backoff', passed: true,
    failed, afterBackoff, secondFailure, afterSecondBackoff, recovered });
  if (!nativeOnly) {
  await evaluate(qaSession, 'sourceNavigationQa.clear()');
  await cdp.call('Page.navigate', { url: book }, sourceSession);
  await until(() => evaluate(sourceSession, 'document.readyState === "complete" && location.pathname.includes("/content")'), 'Could not return to source fixture');
  mode = 'slow';
  const slow = await evaluate(qaSession, `sourceNavigationQa.start(${sourceTabId})`);
  const started = performance.now();
  let after60;
  while (performance.now() - started < 62_000) { await wait(1000); }
  after60 = await evaluate(qaSession, `sourceNavigationQa.status(${JSON.stringify(slow.transition.id)})`);
  assert.equal(after60.state, 'loading'); assert.equal(after60.attempt, 1); assert.equal(after60.canRetry, false);
  const loaded = await until(async () => {
    const status = await evaluate(qaSession, `sourceNavigationQa.status(${JSON.stringify(slow.transition.id)})`);
    return status.state === 'same_book' && !status.browserLoading ? status : false;
  }, 'A slow native navigation did not finish', 15000);
  report.cases.push({ name: 'slow-document-over-60-seconds', passed: true, elapsedMs: Math.round(performance.now() - started), after60, loaded });
  }
  report.complete = true;
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ chrome: report.chrome, cases: report.cases.map(item => ({ name: item.name, passed: item.passed })), report: path.join(output, 'report.json') }));
} catch (error) {
  if (cdp && qaSession) {
    try {
      const state = await cdp.call('Runtime.evaluate', { expression: '(async () => ({events:sourceNavigationQa.events(),frame:await sourceNavigationQa.frame(),sessions:await chrome.storage.session.get(null)}))()', returnByValue:true, awaitPromise:true }, qaSession);
      report.failureDiagnostics = state.result.value;
    } catch { /* Preserve the original acceptance failure. */ }
  }
  report.error = { message: error.message, detail: error.detail };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (stderr) console.error(stderr);
  throw error;
} finally {
  if (chrome?.pid && chrome.exitCode === null && chrome.signalCode === null) {
    const exited = once(chrome, 'exit'); chrome.kill();
    if (await Promise.race([exited.then(() => false), wait(5000, true, { ref: false })])) { chrome.kill('SIGKILL'); await exited; }
  }
  await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
}
