import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { pipeline } from 'node:stream';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const [archiveArg, baselineArg, candidateArg, outputArg] = process.argv.slice(2);
if (!archiveArg || !baselineArg || !candidateArg || !outputArg || process.argv.length !== 6) {
  throw new Error('Usage: node test/acceptance/paired-chrome.mjs BOOK.zip BASELINE.zip CANDIDATE.zip OUTPUT_DIR (use - for baseline smoke)');
}
const archive = path.resolve(archiveArg);
const baseline = path.resolve(baselineArg);
const candidate = candidateArg === '-' ? null : path.resolve(candidateArg);
const output = path.resolve(outputArg);
const workspace = await realpath(path.join(here, '../../..'));
const physicalOutput = path.join(await realpath(path.dirname(output)), path.basename(output));
const workspaceRelative = path.relative(workspace, physicalOutput);
if (!workspaceRelative || (!path.isAbsolute(workspaceRelative) && workspaceRelative.split(path.sep)[0] !== '..')) {
  throw new Error('Replay output must be outside the project workspace');
}
const chromePath = process.env.CHROME_PATH || (platform() === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : platform() === 'win32' ? path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') : '/usr/bin/google-chrome');
const repeats = Number(process.env.REPLAY_REPEATS || (candidate ? '3' : '1'));
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 3) throw new Error('Invalid REPLAY_REPEATS');
const fileTransportBytes = process.env.CHROME_BLOB_FILE_TRANSPORT_BYTES;
if (fileTransportBytes && !/^\d{1,9}$/.test(fileTransportBytes)) throw new Error('Invalid CHROME_BLOB_FILE_TRANSPORT_BYTES');
const mediaRate = Number(process.env.REPLAY_MIB_PER_SECOND || '0') * 1024 * 1024;
if (!Number.isFinite(mediaRate) || mediaRate < 0) throw new Error('Invalid REPLAY_MIB_PER_SECOND');
const fullHd = process.env.REPLAY_FULL_HD === '1';
const dedup = process.env.REPLAY_DEDUP === '1';
const reuse = process.env.REPLAY_REUSE === '1';
const strictWebp = process.env.REPLAY_STRICT_WEBP === '1';
if ([fullHd, dedup, reuse, strictWebp].filter(Boolean).length > 1) throw new Error('Choose one replay comparison mode');
const python = process.env.PYTHON_PATH || (platform() === 'win32' ? 'python' : 'python3');
await stat(chromePath);
await mkdir(output, { mode: 0o700 });
const temp = await mkdtemp(path.join(tmpdir(), 'thedeshar-webp-replay-'));

class PipeCDP {
  #child;
  #pending = new Map();
  #counter = 0;
  #events = new Map();
  #buffer = '';
  #closed = false;
  constructor(child) {
    this.#child = child;
    child.stdio[3].on('error', error => this.#disconnect(error));
    child.stdio[4].setEncoding('utf8').on('data', chunk => {
      this.#buffer += chunk;
      let end;
      while ((end = this.#buffer.indexOf('\0')) !== -1) {
        const item = JSON.parse(this.#buffer.slice(0, end));
        this.#buffer = this.#buffer.slice(end + 1);
        if (item.id) {
          const handler = this.#pending.get(item.id);
          this.#pending.delete(item.id);
          if (!handler) continue;
          clearTimeout(handler.timer);
          if (item.error) handler.reject(new Error(`${handler.method}: ${item.error.message}`));
          else handler.resolve(item.result);
        } else this.#events.get(item.method)?.(item.params);
      }
    });
    child.once('error', error => this.#disconnect(error));
    child.once('exit', () => this.#disconnect(new Error('Chrome stopped')));
  }
  #disconnect(error) {
    this.#closed = true;
    for (const { timer, reject } of this.#pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.#pending.clear();
  }
  on(method, fn) { this.#events.set(method, fn); }
  call(method, params = {}, sessionId) {
    if (this.#closed) return Promise.reject(new Error('Chrome stopped'));
    return new Promise((resolve, reject) => {
      const id = ++this.#counter;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method}: timed out`));
      }, 12_000);
      this.#pending.set(id, { method, resolve, reject, timer });
      this.#child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
  }
}

async function pageResult(client, sessionId, expression, userGesture = false) {
  const response = await client.call('Runtime.evaluate', { expression, returnByValue: true, userGesture }, sessionId);
  if (response.exceptionDetails) throw new Error('Browser replay expression failed');
  return response.result.value;
}

async function rssBytes(client) {
  const { processInfo } = await client.call('SystemInfo.getProcessInfo');
  const ids = processInfo.map(({ id }) => id);
  if (!ids.length || !ids.every(Number.isSafeInteger)) throw new Error('Could not identify Chrome processes');
  if (platform() === 'win32') {
    const script = `Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum | Select-Object -ExpandProperty Sum`;
    const value = Number((await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])).stdout.trim());
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid Chrome working-set sample');
    return value;
  }
  const { stdout } = await execute('ps', ['-o', 'rss=', '-p', ids.join(',')]);
  if (!/^\s*\d+(?:\s+\d+)*\s*$/.test(stdout)) throw new Error('Invalid Chrome RSS sample');
  return stdout.trim().split(/\s+/).reduce((sum, rss) => sum + Number(rss) * 1024, 0);
}

async function waitUntil(condition, timeout, error) {
  const end = performance.now() + timeout;
  do {
    const value = await condition();
    if (value) return value;
    await wait(250);
  } while (performance.now() < end);
  throw new Error(error);
}

async function sha256(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function preparePage(build) {
  const dir = path.join(temp, build);
  const html = (await readFile(path.join(dir, 'exporter.html'), 'utf8'))
    .replace(/<script type="module" src="src\/ui\/(?:help|exporter)\.js"><\/script>/g, '')
    .replace('</head>', '<script type="module" src="replay-page.mjs"></script></head>');
  await copyFile(path.join(here, 'replay-page.mjs'), path.join(dir, 'replay-page.mjs'));
  await writeFile(path.join(dir, 'replay.html'), html);
  return dir;
}

async function runOne(build, pair, directory, mediaBase, keepArchive) {
  const profile = path.join(temp, `profile-${pair}-${build}`);
  const downloads = path.join(temp, `downloads-${pair}-${build}`);
  await mkdir(downloads);
  const chrome = spawn(chromePath, [
    ...(process.env.CHROME_HEADFUL === '1' ? [] : ['--headless=new']), `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    '--no-first-run', '--disable-background-networking', '--disable-component-update', '--no-proxy-server',
    ...(fileTransportBytes ? [`--blob-transport-by-file-trigger=${fileTransportBytes}`] : []),
    '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let stderr = '';
  chrome.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16_384); });
  const exited = once(chrome, 'exit').catch(() => {});
  const cdp = new PipeCDP(chrome);
  let download, progress;
  cdp.on('Browser.downloadWillBegin', value => { download = value; });
  cdp.on('Browser.downloadProgress', value => { progress = value; });
  let samplePromise;
  let sampling = true;
  let sampleError;
  try {
    const { product } = await cdp.call('Browser.getVersion');
    const { id } = await cdp.call('Extensions.loadUnpacked', { path: directory });
    await cdp.call('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloads, eventsEnabled: true });
    const { targetId } = await cdp.call('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true });
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
      const message = exceptionDetails.exception?.description?.split('\n')[0] || exceptionDetails.text;
      sampleError = new Error(`Chrome replay: ${message}`);
    });
    await cdp.call('Runtime.enable', {}, sessionId);
    await cdp.call('Page.navigate', { url: `chrome-extension://${id}/replay.html?tab=7&mediaBase=${encodeURIComponent(mediaBase)}` }, sessionId);
    await waitUntil(async () => {
      if (sampleError) throw sampleError;
      const state = await pageResult(cdp, sessionId, `(() => ({ ready: Boolean(globalThis.__replay && !document.getElementById('export')?.hidden && !document.getElementById('export')?.disabled), message: document.getElementById('message')?.textContent }))()`);
      if (state.message) throw new Error('Exporter refused the replay input: ' + state.message);
      return state.ready;
    }, 15_000, 'Replay did not enable the Download archive button');
    const idleRss = await rssBytes(cdp);
    let peakRss = idleRss, samples = 0;
    samplePromise = (async () => {
      while (sampling) {
        await wait(750);
        if (!sampling) break;
        try {
          const bytes = await rssBytes(cdp);
          peakRss = Math.max(peakRss, bytes);
          samples++;
        } catch (error) {
          if (sampling) sampleError = error;
          return;
        }
      }
    })();
    await pageResult(cdp, sessionId, `globalThis.__replay.started = performance.now(); document.getElementById('export').click(); true`, true);
    const telemetry = await waitUntil(async () => {
      if (sampleError) throw sampleError;
      const state = await pageResult(cdp, sessionId, `({ ...globalThis.__replay, error: !document.getElementById('message').hidden && document.getElementById('message').classList.contains('error') ? document.getElementById('message').textContent : undefined })`);
      if (state.error) throw new Error('Exporter reported an error: ' + state.error + ' (media requests: ' + state.mediaRequests + '; recent stages: ' + JSON.stringify(state.lastEvents) + '; blob read error: ' + JSON.stringify(state.blobReadError) + ')');
      if (progress?.state === 'canceled') throw new Error('Chrome canceled the test download');
      return state.zip && state;
    }, 240_000, 'Exporter did not finish creating the replay ZIP');
    sampling = false;
    await samplePromise;
    if (sampleError) throw sampleError;
    await waitUntil(() => download && progress?.state === 'completed', 120_000, 'Chrome did not save the replay ZIP');
    const saved = progress.filePath || path.join(downloads, download.guid);
    assert.equal((await stat(saved)).size, telemetry.zip.size);
    const result = { build, pair, chrome: product, ...telemetry.zip, idleRss, peakRss, samples,
      mediaRequests: telemetry.mediaRequests, downloadedBytes: telemetry.downloadedBytes,
      codecFailures: telemetry.codecFailures, messageKinds: telemetry.messageKinds,
      sha256: await sha256(saved),
    };
    if (keepArchive) {
      const savedArchive = path.join(output, `${build}.zip`);
      await rename(saved, savedArchive).catch(async error => {
        if (error.code !== 'EXDEV') throw error;
        await copyFile(saved, savedArchive);
      });
      await chmod(savedArchive, 0o600);
      result.archive = savedArchive;
    }
    console.log(JSON.stringify(result));
    return result;
  } catch (error) {
    const blobInfo = await (async () => {
      const { targetId } = await cdp.call('Target.createTarget', { url: 'chrome://blob-internals' });
      const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true });
      await wait(500);
      return pageResult(cdp, sessionId, `Array.from(document.querySelectorAll('li')).reduce((out, li) => { const m = li.textContent.match(/^Status: (BlobStatus::[A-Z_]+)/); if (m) out[m[1]] = (out[m[1]] || 0) + 1; return out }, {})`);
    })().catch(() => null);
    if (blobInfo) await writeFile(path.join(output, `${build}-${pair}-blob-internals.json`), JSON.stringify(blobInfo), { mode: 0o600 });
    const histograms = await cdp.call('Browser.getHistograms', { query: 'Storage.Blob' }).catch(() => null);
    if (histograms) await writeFile(path.join(output, `${build}-${pair}-blob-histograms.json`), JSON.stringify(histograms, null, 2), { mode: 0o600 });
    await writeFile(path.join(output, `${build}-${pair}-chrome.log`), stderr, { mode: 0o600 });
    throw error;
  } finally {
    sampling = false;
    await samplePromise;
    try { await cdp.call('Browser.close'); } catch { chrome.kill(); }
    await Promise.race([exited, wait(2_000, undefined, { ref: false })]);
    if (chrome.exitCode == null && chrome.signalCode == null) chrome.kill('SIGKILL');
    await exited;
    await rm(profile, { recursive: true, force: true });
    await rm(downloads, { recursive: true, force: true });
  }
}

async function startMediaServer() {
  const token = randomBytes(16).toString('hex');
  let sendAt = 0;
  async function* paced(stream) {
    for await (const chunk of stream) {
      const now = performance.now();
      sendAt = Math.max(now, sendAt) + chunk.length * 1000 / mediaRate;
      await wait(Math.max(0, sendAt - now));
      yield chunk;
    }
  }
  const server = createServer(async (request, response) => {
    const match = new RegExp(`^/${token}/(\\d{1,5}\\.bin)$`).exec(request.url);
    if (request.method !== 'GET' || !match) { response.writeHead(404).end(); return; }
    const file = path.join(temp, 'replay-media', match[1]);
    try {
      const { size } = await stat(file);
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(size),
        'access-control-allow-origin': '*', 'cache-control': 'no-store' });
      const stream = createReadStream(file, { highWaterMark: 256 * 1024 });
      response.on('close', () => stream.destroy());
      pipeline(mediaRate ? paced(stream) : stream, response, () => {});
    } catch { response.writeHead(404).end(); }
  });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  return { server, mediaBase: `http://127.0.0.1:${server.address().port}/${token}` };
}

const sourceStat = await stat(archive);
const report = { packages: { baseline: { sha256: await sha256(baseline), filename: path.basename(baseline) },
  ...(candidate ? { candidate: { sha256: await sha256(candidate), filename: path.basename(candidate) } } : {}) }, host: { platform: platform(), arch: arch(), release: release(), cpu: cpus()[0].model, ram: totalmem() },
  input: { filename: path.basename(archive), bytes: sourceStat.size, sha256: await sha256(archive) },
  mode: `Installed Chrome ${process.env.CHROME_HEADFUL === '1' ? 'GUI' : 'headless'}; full production export UI; offline replay of saved capture and media bytes`, mediaRate, fileTransportBytes: fileTransportBytes ?? null, runs: [] };
let mediaServer;
try {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  const args = [path.join(here, 'stage-replay.py'), archive, temp, baseline, ...(candidate ? [candidate] : [])];
  console.log((await execute(python, args, { timeout: 90_000 })).stdout.trim());
  mediaServer = await startMediaServer();
  const builds = { baseline: await preparePage('baseline'), ...(candidate ? { candidate: await preparePage('candidate') } : {}) };
  for (let pair = 1; pair <= repeats; pair++) {
    for (const build of pair % 2 ? Object.keys(builds) : Object.keys(builds).reverse()) {
      try { report.runs.push(await runOne(build, pair, builds[build], mediaServer.mediaBase, pair === 1)); }
      catch (error) {
        const result = { build, pair, error: error.message };
        report.runs.push(result);
        console.error(JSON.stringify(result));
      }
      await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    }
  }
  const sourceAfter = await stat(archive);
  assert.equal(sourceAfter.size, sourceStat.size);
  assert.equal(sourceAfter.mtimeMs, sourceStat.mtimeMs);
  if (candidate) {
    const eligible = repeats === 3 && !fileTransportBytes && process.env.CHROME_HEADFUL === '1';
    const allSucceeded = report.runs.length === 6 && report.runs.every(run => !run.error);
    const median = values => [...values].sort((a, b) => a - b)[1];
    if (eligible && allSucceeded) {
      const before = report.runs.filter(run => run.build === 'baseline');
      const after = report.runs.filter(run => run.build === 'candidate');
      const savedBytes = Math.min(...after.map(run => before.find(old => old.pair === run.pair).size - run.size));
      const addedMedianMs = median(after.map(run => run.readyMs)) - median(before.map(run => run.readyMs));
      const codecHealthy = after.every(run => run.codecFailures === 0);
      if (reuse) {
        const stable = runs => runs.every(run => run.mediaRequests === runs[0].mediaRequests &&
          run.downloadedBytes === runs[0].downloadedBytes && run.size === runs[0].size);
        const matchingZipSize = [...before, ...after].every(run => run.size === before[0].size);
        const savedRequests = before[0].mediaRequests - after[0].mediaRequests;
        const savedDownloadBytes = before[0].downloadedBytes - after[0].downloadedBytes;
        const expected = stable(before) && stable(after) && matchingZipSize && savedRequests > 0 &&
          savedDownloadBytes > 0 && codecHealthy;
        report.comparison = { matchingZipSize, savedRequests, savedDownloadBytes, savedBytes, addedMedianMs, pass: false };
        if (expected) {
          try {
            const { stdout } = await execute(python, [path.join(here, 'verify-book-archive.py'),
              before[0].archive, after[0].archive, '--same-media'], { timeout: 90_000 });
            report.comparison.archiveVerification = JSON.parse(stdout);
            report.comparison.pass = true;
          } catch {
            report.comparison.reason = 'archive-verification-failed';
          }
        } else report.comparison.reason = 'unexpected-replay-results';
      } else {
        const matchingInput = [...before, ...after].every(run => run.mediaRequests === before[0].mediaRequests &&
          run.downloadedBytes === before[0].downloadedBytes);
        const meetsTargets = dedup ? savedBytes > 0 : (fullHd || strictWebp || savedBytes >= 500_000_000) && addedMedianMs <= 60_000;
        report.comparison = { matchingInput, savedBytes, addedMedianMs, codecHealthy,
          pass: matchingInput && meetsTargets && codecHealthy };
      }
    } else report.comparison = { pass: false, reason: eligible ? 'incomplete-pairs' : 'diagnostic-run' };
  }
  if (report.runs.some(run => run.error) || report.comparison?.pass === false) process.exitCode = 1;
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
} finally {
  mediaServer?.server.closeAllConnections();
  mediaServer?.server.close();
  await rm(temp, { recursive: true, force: true });
}
