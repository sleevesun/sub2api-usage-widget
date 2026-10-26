import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { RADAR_BENCH_SELECTIONS, normalizeRadarBenchScore, radarBenchKey } from "../src/radarBench.js";

const cells = Object.fromEntries(RADAR_BENCH_SELECTIONS.map((selection) => {
  const data = {
    ...selection, score: 121.1, score_max: 150, score_status: "provisional", coverage: 62, required_tasks: 64,
    statistics: { sample_count: 63, metrics: {
      api_equivalent_usd: { known_total: 211.05, known_samples: 63, missing_samples: 0 },
      elapsed_ms: { known_total: 49896000, known_samples: 63, missing_samples: 0 },
    } },
  };
  return [radarBenchKey(selection), normalizeRadarBenchScore(data, selection, 1234)];
}));
cells["gpt-6-luna/low"] = { ...cells["gpt-6-luna/low"], score: 0, averageCostUsd: 0, averageDurationMinutes: 0 };
cells["gpt-5.6-sol/max"] = { ...cells["gpt-5.6-sol/max"], averageCostUsd: 7.48, costPartial: true, costKnownSamples: 10, samples: 39 };
cells["gpt-5.6-luna/max"] = { model: "gpt-5.6-luna", effort: "max", error: "HTTP 503" };
const state = { cells, isRefreshing: false, resolved: 34, lastAttemptAtMs: 1234, refresh: async () => {} };

const server = await createServer({ server: { middlewareMode: true }, appType: "custom" });
try {
  let RadarBench;
  try {
    ({ default: RadarBench } = await server.ssrLoadModule("/src/RadarBench.jsx"));
  } catch (error) {
    if (error.code !== "ERR_LOAD_URL") throw error;
  }
  assert.equal(typeof RadarBench, "function", "The approved RadarBench matrix is not implemented");
  const html = renderToStaticMarkup(createElement(RadarBench, { bench: state, nowMs: 2000 }));
  assert.ok(html.includes("雷达Bench"));
  for (const effort of ["ULTRA", "MAX", "XHIGH", "HIGH", "MEDIUM", "LOW"]) assert.ok(html.includes(effort));
  assert.ok(html.includes("121.1") && html.includes("$3.35") && html.includes("13.2m"), "all three measurements render together");
  assert.ok(html.includes("$7.48*"), "partial averages remain visibly marked");
  assert.ok(html.includes("$0.00") && html.includes("0.0m"), "zero measurements do not become missing values");
  assert.ok(html.includes("无此档位"), "unsupported combinations are distinguishable from failed requests");
  assert.ok(html.includes("503"), "failed public reads expose their state");
  assert.ok(html.includes("覆盖 62/64"));
  assert.ok(!html.includes("站长推荐"));
  assert.ok(!html.includes("矩阵指标") && !html.includes("data-bench-metric"), "there are no metric tabs");
  assert.ok(!/\d+\s*(?:题)?次/.test(html), "submission counters are absent");
} finally {
  await server.close();
}
console.log("RadarBench matrix rendering contract passed");
