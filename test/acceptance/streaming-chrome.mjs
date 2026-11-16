import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const [outputArg, sizeFlag] = process.argv.slice(2);
assert.ok(outputArg && (!sizeFlag || sizeFlag === '--large') && process.argv.length <= 4,
  'Usage: node test/acceptance/streaming-chrome.mjs OUTPUT_DIR [--large]');
const large = sizeFlag === '--large';
const execute = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const exporter = await realpath(path.join(here, '../..'));
const workspace = await realpath(path.join(exporter, '..'));
const output = path.resolve(outputArg);
const physicalOutput = path.join(await realpath(path.dirname(output)), path.basename(output));
const relative = path.relative(workspace, physicalOutput);
assert.ok(relative && (path.isAbsolute(relative) || relative.split(path.sep)[0] === '..'), 'Acceptance output must be outside the workspace');
await mkdir(output, { mode: 0o700 });
const temporary = await mkdtemp(path.join(tmpdir(), 'thedeshar-streaming-chrome-'));
const chromePath = process.env.CHROME_PATH || (platform() === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : platform() === 'win32' ? path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') : '/usr/bin/google-chrome');
const python = process.env.PYTHON_PATH || (platform() === 'win32' ? 'python' : 'python3');

class PipeCDP {
  #child; #sequence = 0; #pending = new Map(); #buffer = ''; #events = new Map();
  constructor(child) {
    this.#child = child;
    child.stdio[3].on('error', error => this.#close(error));
    child.stdio[4].setEncoding('utf8').on('data', chunk => {
      this.#buffer += chunk;
      let end;
      while ((end = this.#buffer.indexOf('\0')) >= 0) {
        const value = JSON.parse(this.#buffer.slice(0, end));
        this.#buffer = this.#buffer.slice(end + 1);
        if (!value.id) { this.#events.get(value.method)?.(value.params); continue; }
        const pending = this.#pending.get(value.id);
        if (!pending) continue;
        this.#pending.delete(value.id); clearTimeout(pending.timer);
        if (value.error) pending.reject(Error(pending.method + ': ' + value.error.message));
        else pending.resolve(value.result);
      }
    });
    child.once('error', error => this.#close(error));
    child.once('exit', () => this.#close(Error('Isolated Chrome stopped')));
  }
  #close(error) {
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
  }
  on(method, action) { this.#events.set(method, action); }
  call(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.#sequence;
      const timer = setTimeout(() => { this.#pending.delete(id); reject(Error(method + ': timed out')); }, 30000);
      this.#pending.set(id, { method, resolve, reject, timer });
      this.#child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
  }
}

async function evaluate(cdp, sessionId, expression) {
  const value = await cdp.call('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
  if (value.exceptionDetails) throw Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
  return value.result.value;
}

async function rssBytes(cdp) {
  const { processInfo } = await cdp.call('SystemInfo.getProcessInfo');
  const ids = processInfo.map(process => process.id);
  assert.ok(ids.length && ids.every(Number.isSafeInteger), 'Chrome process IDs are unavailable');
  let bytes;
  if (platform() === 'win32') {
    const command = 'Get-Process -Id ' + ids.join(',') + ' -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum | Select-Object -ExpandProperty Sum';
    bytes = Number((await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command])).stdout.trim());
  } else {
    const value = (await execute('ps', ['-o', 'rss=', '-p', ids.join(',')])).stdout;
    assert.match(value, /^\s*\d+(?:\s+\d+)*\s*$/u, 'Invalid RSS sample');
    bytes = value.trim().split(/\s+/u).reduce((sum, rss) => sum + Number(rss) * 1024, 0);
  }
  assert.ok(Number.isSafeInteger(bytes) && bytes > 0, 'Invalid Chrome RSS sample');
  return bytes;
}

async function runCase(cdp, sessionId, kind, expectedCRC) {
  const idleRSS = await rssBytes(cdp);
  const idleHeap = await cdp.call('Runtime.getHeapUsage', {}, sessionId);
  let peakRSS = idleRSS, peakHeap = idleHeap.usedSize, samples = 0, nextSample = 0, nextProgress = 0;
  const phases = {};
  const started = performance.now();
  await evaluate(cdp, sessionId, 'globalThis.startStreamingAcceptance(' + JSON.stringify(kind) + ',' + expectedCRC + '); true');
  for (;;) {
    const state = await evaluate(cdp, sessionId, 'globalThis.streamingAcceptance');
    if (state.done) {
      if (state.error) throw Object.assign(Error('Case ' + kind + ': ' + state.error.message), { acceptance: state });
      return { kind, ...state.result, measurements: state.measurements,
        elapsedWallMs: Math.round(performance.now() - started),
        memory: { idleRSS, peakRSS, idleJSHeap: idleHeap.usedSize, peakJSHeap: peakHeap, samples, phases } };
    }
    const elapsed = performance.now() - started;
    if (elapsed > 600000) throw Error('Streaming case ' + kind + ' exceeded ten minutes');
    if (elapsed >= nextSample) {
      const rss = await rssBytes(cdp);
      const heap = await cdp.call('Runtime.getHeapUsage', {}, sessionId);
      peakRSS = Math.max(peakRSS, rss); peakHeap = Math.max(peakHeap, heap.usedSize); samples++;
      const phase = state.phase || 'starting';
      phases[phase] = Math.max(phases[phase] || 0, rss);
      nextSample = elapsed + 500;
    }
    if (elapsed >= nextProgress) {
      console.error('Streaming case ' + kind + ': ' + state.phase + (state.bytes === undefined ? '' : ' ' + state.bytes + '/' + state.total));
      nextProgress = elapsed + 15000;
    }
    await wait(100);
  }
}

const report = {
  host: { platform: platform(), arch: arch(), release: release(), cpu: cpus()[0]?.model, ram: totalmem() },
  mode: 'Installed Chrome extension in an isolated temporary profile; real OPFS and IndexedDB; synthetic media',
  externalSaveDialogTested: false,
  largeArchivesRequested: large,
  limitations: [
    'The output FileSystemFileHandle belongs to OPFS; the external save picker and its permission flow are not tested.',
    'Large ZIPs repeat one streamed 64 MiB source under distinct entry paths; this measures ZIP growth, not real-CDN download throughput.',
    'RSS is sampled combined Chrome process RSS; shared pages can be counted repeatedly and peaks between samples can be missed.',
    'Disk write/close/corruption faults are injected around real OPFS handles, not produced by exhausting the host disk.',
    'This run does not establish absence of OOM on arbitrary computers, or support for untested operating systems and Chrome versions.',
  ],
  cases: [],
};
let chrome, stderr = '', pageException;
try {
  await stat(chromePath);
  const extension = path.join(temporary, 'extension');
  await mkdir(extension);
  await cp(path.join(exporter, 'src'), path.join(extension, 'src'), { recursive: true });
  await copyFile(path.join(exporter, 'manifest.json'), path.join(extension, 'manifest.json'));
  await mkdir(path.join(extension, 'test'));
  await copyFile(path.join(exporter, 'test/export-store-checks.js'), path.join(extension, 'test/export-store-checks.js'));
  await copyFile(path.join(here, 'streaming-page.mjs'), path.join(extension, 'streaming-page.mjs'));
  await writeFile(path.join(extension, 'streaming.html'), '<!doctype html><meta charset="utf-8"><script type="module" src="streaming-page.mjs"></script>');
  report.sources = {};
  for (const file of ['manifest.json', 'src/lib/export-spool.js', 'src/lib/archive-stream.js', 'src/lib/package.js',
    'src/lib/store.js', 'src/lib/workspace-export-store.js', 'src/ui/export-record-stream.js', 'src/ui/download-disk-media.js']) {
    report.sources[file] = createHash('sha256').update(await readFile(path.join(extension, file))).digest('hex');
  }
  const loadAtLaunch = process.env.CHROME_LOAD_EXTENSION === '1';
  chrome = spawn(chromePath, [
    ...(process.env.CHROME_HEADFUL === '1' ? [] : ['--headless=new']),
    '--user-data-dir=' + path.join(temporary, 'profile'), '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    ...(loadAtLaunch ? ['--load-extension=' + extension] : []),
    '--no-first-run', '--disable-background-networking', '--disable-component-update', '--no-proxy-server',
    '--host-resolver-rules=MAP * ~NOTFOUND', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  chrome.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16384); });
  const cdp = new PipeCDP(chrome);
  report.chrome = (await cdp.call('Browser.getVersion')).product;
  let id;
  if (loadAtLaunch) {
    const deadline = performance.now() + 15000;
    while (!id) {
      const targets = await cdp.call('Target.getTargets');
      const worker = targets.targetInfos.find(target => target.type === 'service_worker' &&
        target.url.startsWith('chrome-extension://') && target.url.endsWith('/src/background.js'));
      if (worker) id = new URL(worker.url).hostname;
      else if (performance.now() > deadline) throw Error('Chrome did not load the isolated extension');
      else await wait(150);
    }
  } else ({ id } = await cdp.call('Extensions.loadUnpacked', { path: extension }));
  const { targetId } = await cdp.call('Target.createTarget', { url: 'chrome-extension://' + id + '/streaming.html' });
  const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true });
  cdp.on('Runtime.exceptionThrown', event => { pageException = event.exceptionDetails.exception?.description || event.exceptionDetails.text; });
  await cdp.call('Runtime.enable', {}, sessionId);
  const deadline = performance.now() + 15000;
  while (!await evaluate(cdp, sessionId, 'Boolean(globalThis.streamingAcceptance?.ready)')) {
    if (pageException) throw Error(pageException);
    if (performance.now() > deadline) throw Error('Streaming acceptance module did not become ready');
    await wait(100);
  }
  const crcScript = [
    'import json, zlib',
    'block=bytearray([17])*(1024*1024)',
    'block[:3]=b"ID3"',
    'crc=zlib.crc32(block)',
    'block[:3]=bytes([17])*3',
    'for _ in range(63): crc=zlib.crc32(block,crc)',
    'print(json.dumps({"crc":crc}))',
  ].join('\n');
  const expectedCRC = JSON.parse((await execute(python, ['-c', crcScript])).stdout).crc;
  for (const kind of ['small', 'failures', ...(large ? [16, 59] : [])]) {
    const result = await runCase(cdp, sessionId, kind, expectedCRC);
    if (result.base64) {
      const filename = path.join(output, 'small.zip');
      await writeFile(filename, Buffer.from(result.base64, 'base64'));
      delete result.base64;
      const verifyScript = [
        'import json,sys,zipfile',
        'with zipfile.ZipFile(sys.argv[1]) as archive:',
        ' assert archive.testzip() is None',
        ' manifest=json.loads(archive.read("manifest.json"))',
        ' names=set(archive.namelist())',
        ' for item in manifest["inventory"]["pages"]+manifest["inventory"]["responses"]+manifest["inventory"]["assets"]:',
        '  assert not item.get("file") or item["file"] in names',
        ' raw=json.loads(archive.read("originals/pages/00001.json"))',
        ' assert raw["blocks"][0]["text"]=="😀"*140000',
        ' audio=[item for item in manifest["inventory"]["assets"] if item["mimeType"]=="audio/mpeg"]',
        ' assert len(audio)==2 and audio[0]["file"]==audio[1]["file"]',
        ' assert archive.read(audio[0]["file"])==b"ID3same audio bytes"',
        ' print(json.dumps({"independentZipCRC":True,"manifestReferences":True,"rawUnicodeCodePoints":140000,"audioBytesExact":True}))',
      ].join('\n');
      result.independentVerification = JSON.parse((await execute(python, ['-c', verifyScript, filename])).stdout);
      result.archive = filename;
    }
    report.cases.push(result);
    console.error('Streaming case ' + kind + ' passed; peak RSS ' + Math.round(result.memory.peakRSS / 1024 / 1024) + ' MiB');
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  }
  if (large) {
    const smaller = report.cases.find(result => result.kind === 16);
    const bigger = report.cases.find(result => result.kind === 59);
    report.memoryComparison = {
      archiveGrowthBytes: bigger.archiveBytes - smaller.archiveBytes,
      peakRSSGrowthBytes: bigger.memory.peakRSS - smaller.memory.peakRSS,
      peakJSHeapGrowthBytes: bigger.memory.peakJSHeap - smaller.memory.peakJSHeap,
      appReadWriteBoundBytes: 1024 * 1024,
      wholeFileReads: smaller.measurements.wholeFileReads + bigger.measurements.wholeFileReads,
    };
  }
  report.complete = true;
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ chrome: report.chrome, cases: report.cases.map(({ kind, archiveBytes, memory }) =>
    ({ kind, archiveBytes, peakRSS: memory.peakRSS, peakJSHeap: memory.peakJSHeap })),
  memoryComparison: report.memoryComparison, report: path.join(output, 'report.json') }, null, 2));
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
