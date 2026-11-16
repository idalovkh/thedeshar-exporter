import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const [archive] = process.argv.slice(2);
assert.ok(archive && process.argv.length === 3, 'Usage: node test/acceptance/fullhd-chrome.mjs EXPORTER.zip');
const strictWebp = process.env.REPLAY_STRICT_WEBP === '1';
const chromePath = process.env.CHROME_PATH || (platform() === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : platform() === 'win32' ? path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') : '/usr/bin/google-chrome');
const python = process.env.PYTHON_PATH || (platform() === 'win32' ? 'python' : 'python3');
const here = path.dirname(fileURLToPath(import.meta.url));
const execute = promisify(execFile);
await stat(chromePath);
const temporary = await mkdtemp(path.join(tmpdir(), 'thedeshar-fullhd-chrome-'));
const verifyPixels = `
import base64, hashlib, io, json, sys
from PIL import Image

with open(sys.argv[1], encoding='utf-8') as report:
    for result in json.load(report):
        if 'hashes' not in result:
            continue
        with Image.open(io.BytesIO(base64.b64decode(result['base64']))) as image:
            assert image.n_frames == result['frames'], result['name']
            assert image.size == (result['width'], result['height']), result['name']
            for index, expected in enumerate(result['hashes']):
                image.seek(index)
                actual = hashlib.sha256(image.convert('RGBA').tobytes()).hexdigest()
                assert actual == expected, f"{result['name']}: raw RGBA mismatch in frame {index}"
`;

function connect(chrome) {
  const pending = new Map();
  let sequence = 0;
  let buffer = '';
  chrome.stdio[4].setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
      else request.resolve(message.result);
    }
  });
  function close(error) {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }
  chrome.stdio[3].on('error', close);
  chrome.once('error', close);
  chrome.once('exit', () => close(new Error('Chrome stopped')));
  return async (method, params = {}, sessionId) => {
    const id = ++sequence;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        pending.set(id, { method, resolve, reject });
        timer = setTimeout(() => reject(new Error(`${method}: timed out`)), 30_000);
        chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
      });
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  };
}

let chrome;
let stderr = '';
try {
  const directory = path.join(temporary, 'extension');
  await mkdir(directory);
  await execute(python, ['-m', 'zipfile', '-e', path.resolve(archive), directory]);
  await execute(python, [path.join(here, 'generate-fullhd-fixtures.py'), path.join(directory, 'fixtures')]);
  await copyFile(path.join(here, 'fullhd-page.mjs'), path.join(directory, 'fullhd-page.mjs'));
  await writeFile(path.join(directory, 'fullhd.html'), '<!doctype html><meta charset="utf-8"><script type="module" src="fullhd-page.mjs"></script>');
  // The minimum supported Chrome predates Extensions.loadUnpacked in CDP.
  const loadAtLaunch = process.env.CHROME_LOAD_EXTENSION === '1';
  chrome = spawn(chromePath, [
    ...(process.env.CHROME_HEADFUL === '1' ? [] : ['--headless=new']),
    `--user-data-dir=${path.join(temporary, 'profile')}`, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    ...(loadAtLaunch ? [`--load-extension=${directory}`] : []),
    '--no-first-run', '--disable-background-networking', '--disable-component-update', '--no-proxy-server',
    '--host-resolver-rules=MAP * ~NOTFOUND', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  chrome.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16_384); });
  const cdp = connect(chrome);
  const { product } = await cdp('Browser.getVersion');
  let id;
  if (loadAtLaunch) {
    const deadline = performance.now() + 12_000;
    while (!id) {
      const { targetInfos } = await cdp('Target.getTargets');
      const worker = targetInfos.find(({ url, type }) => type === 'service_worker' &&
        url.startsWith('chrome-extension://') && url.endsWith('/src/background.js'));
      if (worker) id = new URL(worker.url).hostname;
      else if (performance.now() > deadline) throw new Error('Chrome did not load the extension at launch');
      else await wait(150);
    }
  } else {
    ({ id } = await cdp('Extensions.loadUnpacked', { path: directory }));
  }
  const { targetId } = await cdp('Target.createTarget', {
    url: `chrome-extension://${id}/fullhd.html${strictWebp ? '?strict-webp=1' : ''}`,
  });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  const deadline = performance.now() + 12_000;
  while (true) {
    const response = await cdp('Runtime.evaluate', { expression: 'Boolean(globalThis.fullhdAcceptance)', returnByValue: true }, sessionId);
    if (response.result.value) break;
    if (performance.now() > deadline) throw new Error('Chrome did not start Full HD fixtures');
    await wait(150);
  }
  const response = await cdp('Runtime.evaluate', { expression: 'globalThis.fullhdAcceptance', returnByValue: true, awaitPromise: true }, sessionId);
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  const { results: browserResults, failures } = response.result.value;
  const report = path.join(temporary, 'results.json');
  await writeFile(report, JSON.stringify(browserResults));
  await execute(python, ['-c', verifyPixels, report]);
  const results = browserResults.map(({ hashes, base64, ...result }) => ({ ...result, ...(hashes ? { exactRgba: true } : {}) }));
  console.log(JSON.stringify({ product, results, failures }, null, 2));
  if (failures.length) throw new Error(`${failures.length} Full HD fixture(s) failed`);
} catch (error) {
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
