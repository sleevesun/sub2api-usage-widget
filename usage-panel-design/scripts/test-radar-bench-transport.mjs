import assert from "node:assert/strict";
import { readRadarBenchScore } from "../src/radarBenchTransport.js";

const selection = { model: "gpt-6-astra", effort: "xhigh" };
const calls = [];
let active = 0;
let peak = 0;
const previousWindow = globalThis.window;
globalThis.window = {
  __TAURI_INTERNALS__: {
    invoke(command, args) {
      assert.equal(command, "fetch_radar_bench_score");
      assert.deepEqual(args, selection, "only public model/effort parameters reach Rust");
      active += 1;
      peak = Math.max(peak, active);
      return new Promise((resolve, reject) => calls.push({
        resolve(value) { active -= 1; resolve(value); },
        reject(error) { active -= 1; reject(error); },
      }));
    },
  },
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

try {
  const obsolete = new AbortController();
  const current = new AbortController();
  const canceledQueued = new AbortController();
  const oldResults = Promise.allSettled([
    readRadarBenchScore(selection, obsolete.signal),
    readRadarBenchScore(selection, obsolete.signal),
  ]);
  await tick();
  assert.equal(calls.length, 2);
  obsolete.abort();
  const newResults = Promise.allSettled([
    readRadarBenchScore(selection, current.signal),
    readRadarBenchScore(selection, canceledQueued.signal),
  ]);
  await tick();
  assert.equal(calls.length, 2, "replacement batches wait for obsolete native requests to drain");
  canceledQueued.abort();
  calls[0].resolve({ old: true });
  calls[1].resolve({ old: true });
  assert.ok((await oldResults).every((result) => result.status === "rejected" && result.reason.name === "AbortError"));
  await tick();
  assert.equal(calls.length, 3, "canceled queued requests never invoke Rust");
  calls[2].resolve({ score: 121.1 });
  const results = await newResults;
  assert.deepEqual(results[0], { status: "fulfilled", value: { score: 121.1 } });
  assert.equal(results[1].reason.name, "AbortError");
  assert.equal(peak, 2, "native requests stay bounded across effect replay or remount");

  const failed = Promise.allSettled([readRadarBenchScore(selection)]);
  await tick();
  calls[3].reject("HTTP 503");
  assert.equal((await failed)[0].status, "rejected");
  const recovered = readRadarBenchScore(selection);
  await tick();
  calls[4].resolve({ score: 122 });
  assert.deepEqual(await recovered, { score: 122 }, "errors release the native admission slot");
  assert.equal(active, 0);
} finally {
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
}
console.log("RadarBench native cancellation, admission limit and recovery contracts passed");
