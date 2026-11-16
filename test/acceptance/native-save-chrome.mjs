import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const [outputArg] = process.argv.slice(2);
assert.ok(outputArg && process.argv.length === 3, 'Usage: node test/acceptance/native-save-chrome.mjs OUTPUT_DIR');
const output = path.resolve(outputArg);
assert.ok(output.startsWith('/private/tmp/'), 'Native QA report must live under /private/tmp');
await mkdir(output, { mode: 0o700 });
const temporary = await mkdtemp(path.join(tmpdir(), 'thedeshar-native-save-chrome-'));
const profile = path.join(temporary, 'profile');
const here = path.dirname(fileURLToPath(import.meta.url));
const exporter = path.join(here, '../..');
const execute = promisify(execFile);
const externalFile = '/private/tmp/thedeshar-native-save-qa.zip';
const runId = randomUUID();
let chrome, stderr = '';
const report = { runId, externalFile, headful: true, nativePickerRequested: true, externalSaveDialogTested: false };

function connect(child) {
  const pending = new Map();
  let sequence = 0, buffer = '', disconnected;
  const close = error => { disconnected = error; for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); } pending.clear(); };
  child.stdio[4].setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      const request = pending.get(value.id);
      if (!request) continue;
      pending.delete(value.id); clearTimeout(request.timer);
      if (value.error) request.reject(Error(request.method + ': ' + value.error.message));
      else request.resolve(value.result);
    }
  });
  child.stdio[3].on('error', close);
  child.once('error', close);
  child.once('exit', () => close(Error('Isolated Chrome stopped')));
  return (method, params = {}, sessionId) => disconnected ? Promise.reject(disconnected) : new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(method + ': timed out')); }, 30000);
    pending.set(id, { method, resolve, reject, timer });
    child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
  });
}

try {
  const extension = path.join(temporary, 'extension');
  await mkdir(extension);
  await cp(path.join(exporter, 'src'), path.join(extension, 'src'), { recursive: true });
  await copyFile(path.join(exporter, 'manifest.json'), path.join(extension, 'manifest.json'));
  await copyFile(path.join(here, 'native-save-page.mjs'), path.join(extension, 'native-save-page.mjs'));
  await writeFile(path.join(extension, 'native-save.html'), '<!doctype html><html lang="ru"><meta charset="utf-8"><title>TheDeshar — Native Save QA</title><style>body{font:18px system-ui;margin:36px;max-width:800px}button{font:inherit;padding:14px 20px}p{line-height:1.6}</style><h1>TheDeshar — Native Save QA</h1><p>Изолированная проверка системного сохранения ZIP. Сохраните файл /private/tmp/thedeshar-native-save-qa.zip.</p><button id="save" disabled>Проверить сохранение ZIP</button><p id="status">Запуск проверки…</p><script type="module" src="native-save-page.mjs"></script></html>');
  chrome = spawn(process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--user-data-dir=' + profile, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    '--no-first-run', '--disable-background-networking', '--disable-component-update', '--no-proxy-server',
    '--host-resolver-rules=MAP * ~NOTFOUND', '--new-window', '--window-size=1000,760', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  chrome.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16384); });
  const cdp = connect(chrome);
  report.chrome = (await cdp('Browser.getVersion')).product;
  const { id } = await cdp('Extensions.loadUnpacked', { path: extension });
  const url = 'chrome-extension://' + id + '/native-save.html?run=' + runId;
  const { targetId } = await cdp('Target.createTarget', { url, newWindow: true, width: 1000, height: 760, background: false });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  async function state() {
    const response = await cdp('Runtime.evaluate', { expression: 'globalThis.nativeSaveAcceptance', returnByValue: true }, sessionId);
    if (response.exceptionDetails) throw Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  }
  const deadline = performance.now() + 600000;
  let ready = false, lastStatus;
  for (;;) {
    const current = await state();
    if (current?.status === 'error') throw Object.assign(Error(current.error.message), { acceptance: current });
    if (current?.status === 'ready' && !ready) {
      ready = true;
      report.resources = current.resources;
      console.log('NATIVE_SAVE_READY ' + JSON.stringify({ chromePid: chrome.pid, profile, title: 'TheDeshar — Native Save QA', targetId, sessionId, url, resources: current.resources, output }));
    }
    if (current?.status && current.status !== lastStatus) {
      console.log('NATIVE_SAVE_STATUS ' + current.status); lastStatus = current.status;
    }
    if (current?.status === 'done') {
      report.acceptance = current;
      assert.equal(current.gesture.trusted, true);
      assert.equal(current.gesture.active, true);
      assert.equal(current.result.name, path.basename(externalFile));
      const verify = [
        'import json,sys,zipfile',
        'with zipfile.ZipFile(sys.argv[1]) as archive:',
        ' assert archive.testzip() is None',
        ' manifest=json.loads(archive.read("manifest.json"))',
        ' raw=json.loads(archive.read("originals/pages/00001.json"))',
        ' assert raw["blocks"][0]["text"]=="Native external Save QA "+sys.argv[2]',
        ' media=archive.read(manifest["inventory"]["assets"][0]["file"])',
        ' assert media==b"ID3"+bytes([17])*(65553-3)',
        ' print(json.dumps({"crcValid":True,"rawBytesValid":True,"mediaBytesValid":True,"entries":len(archive.namelist())}))',
      ].join('\n');
      report.independentVerification = JSON.parse((await execute(process.env.PYTHON_PATH || 'python3', ['-c', verify, externalFile, runId])).stdout);
      report.sha256 = createHash('sha256').update(await readFile(externalFile)).digest('hex');
      report.externalSaveDialogTested = true;
      report.complete = true;
      await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
      console.log('NATIVE_SAVE_VERIFIED ' + JSON.stringify({ externalFile, bytes: current.result.size, report: path.join(output, 'report.json'), resources: current.resources }));
      await wait(5000);
      break;
    }
    if (performance.now() > deadline) throw Error('Native Save QA waited ten minutes without completion');
    await wait(200);
  }
} catch (error) {
  report.complete = false;
  report.error = { message: error.message, acceptance: error.acceptance };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (stderr) console.error(stderr);
  throw error;
} finally {
  if (chrome?.pid && chrome.exitCode === null && chrome.signalCode === null) {
    const exited = once(chrome, 'exit');
    chrome.kill();
    const expired = await Promise.race([exited.then(() => false), wait(5000, true, { ref: false })]);
    if (expired) { chrome.kill('SIGKILL'); await exited; }
  }
  await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
}
