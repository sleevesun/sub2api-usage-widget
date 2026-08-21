import assert from "node:assert/strict";
import { createServer } from "vite";

const server = await createServer({
  server: { middlewareMode: true },
  appType: "custom",
});

try {
  const { buildTrendSeries, normalizeEnvelope, quotaRemainingPercent } = await server.ssrLoadModule("/src/App.jsx");
  const normalized = normalizeEnvelope(
    {
      fetchedAtMs: 1,
      usage: {
        isValid: true,
        status: "active",
        unit: "USD",
        quota: { limit: 300, used: 0.7779, remaining: 299.2221 },
        usage: {
          today: { requests: 2, total_tokens: 36496, actual_cost: 0.135122 },
          total: { requests: 15, total_tokens: 355792, actual_cost: 0.77797735 },
        },
        daily_usage: [
          { date: "2026-07-17", actual_cost: 0.135122 },
        ],
        rate_limits: [
          { window: "7d", used: 0.7779, limit: 10, reset_at: 1784949882 },
        ],
        model_stats: [
          { model: "gpt-5.5", actual_cost: 0.632678 },
          { model: "gpt-5.4-mini", actual_cost: 0.01017735 },
        ],
      },
    },
    { keyName: "测试密钥" },
  );

  assert.equal(normalized.keyName, "测试密钥");
  assert.equal(normalized.quota.remaining, 299.2221);
  assert.equal(normalized.today.requests, 2);
  assert.equal(normalized.today.tokens, 36496);
  assert.equal(normalized.today.cost, 0.135122);
  assert.equal(normalized.total.requests, 15);
  assert.equal(normalized.total.tokens, 355792);
  assert.equal(normalized.days[0].date, "2026-07-17");
  assert.equal(normalized.models[0].name, "gpt-5.5");
  assert.equal(normalized.models[0].cost, 0.632678);
  assert.equal(normalized.rateLimits[0].window, "7d");
  assert.equal(normalized.rateLimits[0].resetAtMs, 1784949882000);

  assert.equal(quotaRemainingPercent(normalized), 99.74);
  assert.equal(
    quotaRemainingPercent({ quota: { limit: 100, remaining: 180 } }),
    100,
  );
  assert.equal(
    quotaRemainingPercent({ quota: { limit: 0, remaining: 0 }, mode: "unrestricted" }),
    null,
  );

  const dailyTrend = buildTrendSeries(normalized.days, "days", "2026-07-20");
  assert.equal(dailyTrend.points.length, 15);
  assert.equal(dailyTrend.points[0].key, "2026-07-06");
  assert.equal(dailyTrend.points.at(-1).key, "2026-07-20");
  assert.equal(dailyTrend.points.find((point) => point.key === "2026-07-17").cost, 0.135122);
  assert.equal(dailyTrend.points.find((point) => point.key === "2026-07-18").cost, 0);

  const weeklyTrend = buildTrendSeries(normalized.days, "week", "2026-07-20");
  assert.equal(weeklyTrend.points.length, 7);
  assert.equal(weeklyTrend.points[0].key, "2026-07-20");
  assert.equal(weeklyTrend.points[1].future, true);

  const fourWeekTrend = buildTrendSeries(normalized.days, "weeks", "2026-07-20");
  assert.equal(fourWeekTrend.points.length, 4);
  assert.equal(fourWeekTrend.points[0].key, "2026-06-29");
  assert.equal(fourWeekTrend.points.at(-1).key, "2026-07-20");
} finally {
  await server.close();
}

console.log("usage normalization contract passed");
