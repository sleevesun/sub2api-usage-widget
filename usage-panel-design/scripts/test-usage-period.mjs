import assert from "node:assert/strict";

let getUsagePeriod;
let buildTrendSeries;
let dateKeyInTimezone;
try {
  ({ getUsagePeriod, buildTrendSeries, dateKeyInTimezone } = await import("../src/usagePeriod.js"));
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
}
assert.equal(typeof getUsagePeriod, "function", "Trend and model statistics need a shared calendar period");

for (const [mode, startDate, endDate] of [
  ["today", "2026-10-13", "2026-10-13"],
  ["week", "2026-10-12", "2026-10-13"],
  ["days", "2026-09-29", "2026-10-13"],
  ["weeks", "2026-09-21", "2026-10-13"],
]) {
  const period = getUsagePeriod(mode, "2026-10-13");
  assert.equal(period.startDate, startDate);
  assert.equal(period.endDate, endDate);
  assert.ok(period.key.includes(startDate) && period.key.includes(endDate));
}
assert.equal(getUsagePeriod("week", "2026-10-19").startDate, "2026-10-19");
assert.equal(getUsagePeriod("week", "2026-10-18").startDate, "2026-10-12");
assert.equal(getUsagePeriod("weeks", "2026-01-01").startDate, "2025-12-08");
assert.equal(getUsagePeriod("days", "2024-03-01").startDate, "2024-02-16");
assert.equal(dateKeyInTimezone(new Date("2026-10-12T16:01:00Z")), "2026-10-13");
assert.throws(() => getUsagePeriod("week", "2026-02-30"), /日期/);
assert.throws(() => getUsagePeriod("all", "2026-10-13"), /范围/);

const days = [
  { date: "2026-09-20", cost: 100 },
  { date: "2026-09-21", cost: 8 },
  { date: "2026-09-29", cost: 4 },
  { date: "2026-10-12", cost: 2 },
  { date: "2026-10-13", cost: 1 },
  { date: "2026-10-14", cost: 500 },
];
for (const [mode, total] of [["today", 1], ["week", 3], ["days", 7], ["weeks", 15]]) {
  assert.equal(buildTrendSeries(days, mode, "2026-10-13").total, total);
}
assert.equal(buildTrendSeries([], "today", "2026-10-13").points.length, 1);
assert.equal(buildTrendSeries([], "today", "2026-10-13").total, 0);
assert.equal(buildTrendSeries(days, "week", "2026-10-13").points[2].cost, null);
console.log("Shared periods, 本日, timezone, natural weeks and trend bounds passed");
