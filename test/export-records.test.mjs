import test from "node:test";
import assert from "node:assert/strict";
import { prepareDiskExport } from "../src/ui/export-record-stream.js";
import { memoryExportSpool } from './export-file-fixture.js';

const prepare = (summary, options) => prepareDiskExport(summary, { spool: memoryExportSpool(), ...options });

function exportSource({ revision = 12, snapshotCount = 5, captureCount = 6, mutate } = {}) {
  const requests = [];
  return { requests, async send(type, payload = {}) {
    requests.push({ type, ...payload });
    if (type === "GET_EXPORT_INFO") return { revision, snapshotCount, captureCount };
    const total = payload.kind === "snapshots" ? snapshotCount : captureCount;
    const nextOffset = Math.min(payload.offset + payload.limit, total);
    const result = { revision, total, nextOffset, records: Array.from({ length: nextOffset - payload.offset }, (_, index) => ({ index: payload.offset + index, raw: payload.kind })) };
    return mutate?.(result, payload) || result;
  } };
}

test("raw export records are written one at a time while retained summary stays compact", async () => {
  const source = exportSource(), progress = [];
  const summary = { exportRevision: 12, snapshots: [{ title: "metadata" }], captures: [{ data: true }], collection: { title: "Book" } };
  const result = await prepare(summary, { send: source.send, onProgress: value => progress.push(value) });
  assert.equal(result.state.snapshots.length, 5);
  assert.equal(result.state.captures.length, 6);
  for (const entry of result.prepared.entries.filter(entry => entry.name.startsWith('originals/responses/')))
    assert.equal(JSON.parse(await entry.data.text()).raw, 'captures');
  assert.ok(result.state.captures.every(item => item.raw === undefined));
  assert.ok(source.requests.slice(1).every(item => item.limit === 1 && item.revision === 12));
  assert.deepEqual(progress.at(-1), { loaded: 11, total: 11 });
  assert.equal(summary.snapshots.length, 1);
});

test("an export changed before or during batching is never mixed into a ZIP", async () => {
  await assert.rejects(prepare({ exportRevision: 11 }, { send: exportSource().send }), error => error.code === "export_changed");
  const source = exportSource({ mutate(result, payload) { return payload.kind === "captures" ? { ...result, revision: 13 } : result; } });
  await assert.rejects(prepare({ exportRevision: 12 }, { send: source.send }), error => error.code === "export_changed");
});

test("malformed and nonadvancing export pages fail instead of looping forever", async () => {
  for (const mutate of [result => ({ ...result, nextOffset: 0 }), result => ({ ...result, records: [] }), result => ({ ...result, total: 999 })]) {
    await assert.rejects(prepare({ exportRevision: 12 }, { send: exportSource({ mutate }).send }), /прочитать часть/);
  }
});

test("cancellation prevents the next raw page request", async () => {
  const controller = new AbortController(), source = exportSource();
  await assert.rejects(prepare({ exportRevision: 12 }, { send: source.send, signal: controller.signal, onProgress({ loaded }) { if (loaded) controller.abort(); } }), { name: "AbortError" });
  assert.equal(source.requests.length, 2);
});


test("export summaries require a nonnegative integer revision before any raw page is requested", async () => {
  for (const exportRevision of [undefined, null, -1, 1.5, "12", Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    let requests = 0;
    await assert.rejects(prepare({ exportRevision, snapshots: [{ raw: true }] }, {
      send() { requests++; throw new Error("Invalid summary must not request raw records"); },
    }), error => error.code === "invalid_export_revision");
    assert.equal(requests, 0);
  }
  const source = exportSource({ revision: 0, snapshotCount: 0, captureCount: 0 });
  assert.deepEqual((await prepare({ exportRevision: 0 }, { send: source.send })).state.captures, []);
});
