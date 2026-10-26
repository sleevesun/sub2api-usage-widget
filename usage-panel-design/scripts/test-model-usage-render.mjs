import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { normalizeModelStats } from "../src/modelUsage.js";
import { createPreviewUsage, fetchPreviewModelUsage } from "../src/previewUsage.js";
import { dateKeyInTimezone, getUsagePeriod, buildTrendSeries } from "../src/usagePeriod.js";

const server = await createServer({ server: { middlewareMode: true, watch: null, hmr: false }, appType: "custom" });
try {
  const { ModelUsageTable } = await server.ssrLoadModule("/src/ModelUsage.jsx");
  const html = renderToStaticMarkup(createElement(ModelUsageTable, {
    unit: "USD",
    models: normalizeModelStats([
      { model: "gpt-6-astra", actual_cost: 2.5, requests: 12, total_tokens: 32000 },
      { model: "zero", actual_cost: 0, requests: 0, total_tokens: 0 },
      { model: "unknown" },
    ]),
  }));
  for (const label of ["模型", "消费金额", "请求数", "Token", "US$2.5000", "3.2万", "US$0.0000"]) {
    assert.ok(html.includes(label), `Missing model table content: ${label}`);
  }
  assert.ok(html.includes('title="请求数：12"'));
  assert.ok(html.includes('title="Token：32,000"'));
  assert.equal((html.match(/>—</g) ?? []).length, 3, "Missing metrics must remain distinct from zero");

  const preview = createPreviewUsage();
  const todayKey = dateKeyInTimezone(new Date(preview.fetchedAtMs));
  for (const mode of ["today", "week", "days", "weeks"]) {
    const period = getUsagePeriod(mode, todayKey);
    const envelope = await fetchPreviewModelUsage(period.startDate, period.endDate, preview.fetchedAtMs);
    const models = normalizeModelStats(envelope.modelStats);
    const total = models.reduce((sum, model) => sum + model.cost, 0);
    assert.ok(Math.abs(total - buildTrendSeries(preview.days, mode, todayKey).total) < 1e-9, `${mode} must use the same date range for chart and models`);
    assert.ok(models.every((model) => model.requests !== null && model.tokens !== null));
  }
  const today = await fetchPreviewModelUsage(todayKey, todayKey, preview.fetchedAtMs);
  assert.equal(today.modelStats.length, 1);
  assert.equal(today.modelStats[0].requests, 2);
  assert.equal(today.modelStats[0].total_tokens, 36496);
} finally {
  await server.close();
}

const realDate = Date;
const beforeMidnight = realDate.parse("2026-10-13T15:59:00Z");
const afterMidnight = realDate.parse("2026-10-13T16:01:00Z");
const midnightPreview = createPreviewUsage(beforeMidnight);
try {
  globalThis.Date = class extends realDate {
    constructor(...args) { super(...(args.length ? args : [afterMidnight])); }
    static now() { return afterMidnight; }
  };
  const nextDay = dateKeyInTimezone(new Date());
  assert.equal(nextDay, "2026-10-14");
  for (const mode of ["today", "week", "days", "weeks"]) {
    const period = getUsagePeriod(mode, nextDay);
    const envelope = await fetchPreviewModelUsage(period.startDate, period.endDate, midnightPreview.fetchedAtMs);
    const total = normalizeModelStats(envelope.modelStats).reduce((sum, model) => sum + model.cost, 0);
    assert.ok(Math.abs(total - buildTrendSeries(midnightPreview.days, mode, nextDay).total) < 1e-9,
      `${mode}: preview model data must retain the chart snapshot across Shanghai midnight`);
  }
  const refreshedPreview = createPreviewUsage();
  const refreshed = await fetchPreviewModelUsage(nextDay, nextDay, refreshedPreview.fetchedAtMs);
  assert.equal(refreshed.modelStats[0].actual_cost, refreshedPreview.today.cost);
  assert.equal(refreshed.modelStats[0].requests, refreshedPreview.today.requests);
  assert.equal(refreshed.modelStats[0].total_tokens, refreshedPreview.today.tokens);
} finally {
  globalThis.Date = realDate;
}
console.log("Model table metrics, zero/missing values, preview periods and midnight snapshot consistency passed");
