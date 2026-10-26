import assert from "node:assert/strict";

let bench;
try {
  bench = await import("../src/radarBench.js");
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND" || !error.message.includes("radarBench.js")) throw error;
  bench = {};
}
assert.equal(typeof bench.normalizeRadarBenchScore, "function", "RadarBench score normalization is not implemented");

const { normalizeRadarBenchScore, loadRadarBench, mergeRadarBenchCell, RADAR_BENCH_SELECTIONS } = bench;
const selection = { model: "gpt-5.6-sol", effort: "max" };
const responseFor = (selected = selection) => ({
  ...selected,
  score: 81.8,
  score_max: 150,
  score_status: "provisional",
  coverage: 39,
  required_tasks: 64,
  latest_graded_at: "2026-10-13T05:33:40.273079Z",
  statistics: {
    sample_count: 39,
    metrics: {
      api_equivalent_usd: { total: null, mean: null, known_total: 74.8, known_samples: 10, missing_samples: 29 },
      elapsed_ms: { total: 56628000, mean: 1452000, known_total: 56628000, known_samples: 39, missing_samples: 0 },
    },
  },
});

const partial = normalizeRadarBenchScore(responseFor(), selection, 1234);
assert.equal(partial.score, 81.8, "score is already on the 150-point scale");
assert.ok(Math.abs(partial.averageCostUsd - 7.48) < 1e-10, "partial averages use known evidence even when mean is null");
assert.equal(partial.averageDurationMinutes, 24.2, "elapsed milliseconds become minutes");
assert.equal(partial.costPartial, true);
assert.equal(partial.durationPartial, false);
assert.equal(partial.costKnownSamples, 10);
assert.equal(partial.samples, 39);
assert.equal(partial.coverage, 39);
assert.equal(partial.fetchedAtMs, 1234);

const zeroResponse = responseFor();
zeroResponse.score = 0;
zeroResponse.statistics.metrics.api_equivalent_usd.known_total = 0;
zeroResponse.statistics.metrics.elapsed_ms.known_total = 0;
const zero = normalizeRadarBenchScore(zeroResponse, selection, 2000);
assert.equal(zero.score, 0);
assert.equal(zero.averageCostUsd, 0);
assert.equal(zero.averageDurationMinutes, 0);

const noEvidence = responseFor();
noEvidence.score = null;
noEvidence.coverage = 0;
noEvidence.statistics.sample_count = 0;
for (const metric of Object.values(noEvidence.statistics.metrics)) {
  Object.assign(metric, { total: null, mean: null, known_total: 0, known_samples: 0, missing_samples: 0 });
}
const missing = normalizeRadarBenchScore(noEvidence, selection);
assert.equal(missing.score, null);
assert.equal(missing.averageCostUsd, null);
assert.equal(missing.averageDurationMinutes, null);
assert.equal(missing.costPartial, false);

assert.throws(() => normalizeRadarBenchScore({ ...responseFor(), model: "gpt-6-sol" }, selection), /模型|档位|identity/i);
assert.throws(() => normalizeRadarBenchScore({ ...responseFor(), score_max: 100 }, selection), /150|满分/i);
assert.throws(() => normalizeRadarBenchScore({ ...responseFor(), score: 151 }, selection), /分数|score/i);
assert.throws(() => normalizeRadarBenchScore({ ...responseFor(), statistics: null }, selection), /统计|statistics/i);
assert.equal(RADAR_BENCH_SELECTIONS.length, 34);
assert.ok(!RADAR_BENCH_SELECTIONS.some((item) => item.model.endsWith("-luna") && item.effort === "ultra"));

let active = 0;
let peak = 0;
const delivered = [];
const subset = RADAR_BENCH_SELECTIONS.slice(0, 4);
const results = await loadRadarBench(async (item) => {
  active += 1;
  peak = Math.max(peak, active);
  await new Promise((resolve) => setImmediate(resolve));
  active -= 1;
  if (item.effort === "max") throw new Error("HTTP 503");
  return responseFor(item);
}, { selections: subset, onCell: (cell) => delivered.push(cell) });
assert.equal(peak, 2, "load is bounded to two concurrent requests");
assert.equal(delivered.length, 4, "one failure does not prevent later cells from loading");
assert.deepEqual(results.map(({ model, effort }) => ({ model, effort })), subset, "results keep matrix order");
assert.match(results[1].error, /503/);
assert.equal(results[0].score, 81.8);

const retained = mergeRadarBenchCell(partial, { ...selection, error: "HTTP 503" });
assert.equal(retained.score, partial.score);
assert.equal(retained.fetchedAtMs, 1234);
assert.equal(retained.stale, true);
assert.match(retained.error, /503/);
const recovered = mergeRadarBenchCell(retained, { ...partial, fetchedAtMs: 3000 });
assert.equal(recovered.stale, false);
assert.equal(recovered.error, null);
assert.equal(recovered.fetchedAtMs, 3000);
assert.equal(mergeRadarBenchCell(null, { ...selection, error: "HTTP 503" }).score, undefined);

const controller = new AbortController();
let attempts = 0;
let canceledUpdates = 0;
await loadRadarBench(async (item) => {
  attempts += 1;
  controller.abort();
  return responseFor(item);
}, { selections: subset, signal: controller.signal, onCell: () => { canceledUpdates += 1; } });
assert.equal(attempts, 1, "cancellation prevents queued requests");
assert.equal(canceledUpdates, 0, "canceled work does not update the UI");

console.log("RadarBench data, partial averages, bounded loading and recovery contracts passed");
