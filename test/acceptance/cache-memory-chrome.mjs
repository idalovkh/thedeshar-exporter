import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const [outputArg, baselineArg, candidateArg] = process.argv.slice(2);
assert.ok(outputArg?.startsWith('/private/tmp/') && baselineArg && candidateArg && process.argv.length === 5,
  'Usage: node test/acceptance/cache-memory-chrome.mjs /private/tmp/OUTPUT BASELINE.zip CANDIDATE.zip');
const output = path.resolve(outputArg), here = path.dirname(fileURLToPath(import.meta.url));
const execute = promisify(execFile), temporary = await mkdtemp(path.join(tmpdir(), 'thedeshar-cache-memory-'));
await mkdir(output, { mode: 0o700 });
const report = { complete: false, variants: [], limitations: [
  'Synthetic 4-MiB PDF-like streams, 64/128 MiB total; no source/CDN requests or user books.',
  'RSS is the sum of sampled isolated Chrome processes; shared pages can be counted more than once.',
  'This checks bounded streaming and cache behavior, not the native decoder peak for large images.'
] };
let child, client, stderr = '';

function connect(process) {
  let sequence = 0, buffer = '';
  const pending = new Map();
  const close = error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  process.stdio[4].setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      const item = pending.get(value.id); if (!item) continue;
      pending.delete(value.id); clearTimeout(item.timer);
      if (value.error) item.reject(new Error(`${item.method}: ${value.error.message}`)); else item.resolve(value.result);
    }
  });
  process.stdio[3].on('error', close); process.once('error', close); process.once('exit', () => close(new Error('Isolated Chrome stopped')));
  return { call: (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: timed out`)); }, 30000);
    pending.set(id, { method, timer, resolve, reject });
    process.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
  }) };
}

async function evaluate(sessionId, expression, awaitPromise = false) {
  const result = await client.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function until(action, description, timeout = 20000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) { const value = await action(); if (value) return value; await wait(100); }
  throw new Error(description);
}

async function rssBytes() {
  const { processInfo } = await client.call('SystemInfo.getProcessInfo');
  const ids = processInfo.map(process => process.id);
  assert.ok(ids.length && ids.every(Number.isSafeInteger));
  const text = (await execute('ps', ['-o', 'rss=', '-p', ids.join(',')])).stdout;
  assert.match(text, /^\s*\d+(?:\s+\d+)*\s*$/);
  return text.trim().split(/\s+/).reduce((sum, value) => sum + Number(value) * 1024, 0);
}

async function stop() {
  if (!child) return;
  const stopped = once(child, 'exit');
  if (child.exitCode === null && child.signalCode === null) await client.call('Browser.close').catch(() => {});
  if (child.exitCode === null && child.signalCode === null) await Promise.race([stopped, wait(5000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await Promise.race([stopped, wait(5000)]); }
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'Isolated browser did not stop');
  for (const stream of child.stdio) stream?.destroy?.();
  child = null;
}

try {
  assert.equal(platform(), 'darwin', 'This measured runner currently supports macOS');
  for (const [name, archive] of [['baseline', baselineArg], ['candidate', candidateArg]]) {
    const extension = path.join(temporary, name); await mkdir(extension);
    await execute(process.env.PYTHON_PATH || 'python3', ['-m', 'zipfile', '-e', path.resolve(archive), extension]);
    await cp(path.join(here, 'cache-memory-page.mjs'), path.join(extension, 'qa-cache.mjs'));
    if (name === 'candidate') {
      await mkdir(path.join(extension, 'test'));
      await cp(path.join(here, '../prepared-media-cache-checks.js'), path.join(extension, 'test/prepared-media-cache-checks.js'));
    }
    await writeFile(path.join(extension, 'qa-cache.html'), '<!doctype html><script type="module" src="qa-cache.mjs"></script>');
    child = spawn(process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
      '--headless=new', '--user-data-dir=' + path.join(temporary, name + '-profile'), '--remote-debugging-pipe',
      '--enable-unsafe-extension-debugging', '--no-first-run', '--disable-background-networking', '--disable-component-update',
      '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND', '--disable-background-timer-throttling', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16384); });
    client = connect(child);
    const chrome = (await client.call('Browser.getVersion')).product;
    const { id } = await client.call('Extensions.loadUnpacked', { path: extension });
    const { targetId } = await client.call('Target.createTarget', { url: `chrome-extension://${id}/qa-cache.html` });
    const { sessionId } = await client.call('Target.attachToTarget', { targetId, flatten: true });
    await until(() => evaluate(sessionId, 'typeof globalThis.startCacheMemoryCase === "function"'), 'QA module failed to load');
    const result = { name, chrome, version: JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8')).version, cases: [] };
    report.variants.push(result);
    for (const [kind, count] of [['cold', 16], ['warm', 16], ['scaled', 32]]) {
      let peakRSS = await rssBytes(), peakHeap = 0, samples = 0;
      await evaluate(sessionId, `globalThis.startCacheMemoryCase(${count}); true`);
      const finished = await until(async () => {
        const state = await evaluate(sessionId, 'globalThis.cacheMemoryState');
        peakRSS = Math.max(peakRSS, await rssBytes());
        peakHeap = Math.max(peakHeap, (await client.call('Runtime.getHeapUsage', {}, sessionId)).usedSize); samples++;
        if (state.error) throw new Error(state.error.stack || state.error.message);
        return state.done ? state.result : null;
      }, `${name} ${kind} timed out`, 120000);
      assert.equal(finished.wholeReads, 0); assert.ok(finished.largestRead <= 1024 * 1024);
      assert.ok(finished.largestWrite <= 1024 * 1024); assert.ok(finished.peakActive <= 6);
      if (name === 'candidate' && kind === 'warm') { assert.equal(finished.validatedResponses, 16); assert.equal(finished.networkBytes, 0); }
      if (name === 'baseline' && kind === 'warm') assert.equal(finished.fullResponses, 16);
      result.cases.push({ kind, ...finished, memory: { peakRSS, peakHeap, samples } });
      console.log(`${name} ${kind}: ${finished.elapsedMs} ms, RSS ${Math.round(peakRSS / 1048576)} MiB, transferred ${finished.networkBytes}`);
    }
    if (name === 'candidate') result.cacheChecks = await evaluate(sessionId, 'globalThis.runRealCacheChecks()', true);
    await stop();
  }
  report.complete = true;
} catch (error) { report.error = { message: error.message, stack: error.stack, stderr }; throw error; }
finally {
  await stop();
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await rm(temporary, { recursive: true, force: true });
}
