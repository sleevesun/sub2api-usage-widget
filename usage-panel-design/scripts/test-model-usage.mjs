import assert from "node:assert/strict";

let normalizeModelStats;
let normalizeModelUsage;
let createModelUsageLoader;
try {
  ({ normalizeModelStats, normalizeModelUsage, createModelUsageLoader } = await import("../src/modelUsage.js"));
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
}
assert.equal(typeof normalizeModelStats, "function", "Model rows must retain cost, requests and tokens");

const models = normalizeModelStats([
  { model: "small", actual_cost: 0, cost: 10, requests: 0, total_tokens: 0 },
  { model_name: "large", actualCost: "2.5", requests: "12", totalTokens: "32000" },
  { model: "unknown" },
]);
assert.deepEqual(models.map((model) => model.name), ["large", "small", "unknown"]);
assert.deepEqual(models[0], { name: "large", cost: 2.5, requests: 12, tokens: 32000 });
assert.deepEqual(models[1], { name: "small", cost: 0, requests: 0, tokens: 0 });
assert.deepEqual(models[2], { name: "unknown", cost: null, requests: null, tokens: null });
assert.deepEqual(normalizeModelStats([{ model: "blank", actual_cost: " ", requests: null, total_tokens: "" }])[0],
  { name: "blank", cost: null, requests: null, tokens: null }, "Blank metrics must not become zeros");

const today = { key: "today:2026-10-13:2026-10-13", startDate: "2026-10-13", endDate: "2026-10-13" };
const week = { key: "week:2026-10-12:2026-10-13", startDate: "2026-10-12", endDate: "2026-10-13" };
const envelope = (period, stats = []) => ({ startDate: period.startDate, endDate: period.endDate, modelStats: stats });
assert.deepEqual(normalizeModelUsage(envelope(today), today), []);
assert.throws(() => normalizeModelUsage(envelope(week), today), /范围/);
assert.throws(() => normalizeModelUsage({ ...envelope(today), modelStats: null }, today), /明细/);
assert.deepEqual(normalizeModelUsage({
  ...envelope(today),
  modelStats: null,
  dailyUsage: [{ date: "2026-10-12", actual_cost: 9 }, { date: "2026-10-13", requests: 0, actual_cost: 0, total_tokens: 0 }],
}, today), []);
assert.throws(() => normalizeModelUsage({
  ...envelope(today),
  modelStats: null,
  dailyUsage: [{ date: "2026-10-13", requests: 1, actual_cost: 0.4 }],
}, today), /明细/);

const pending = [];
const updates = [];
const loader = createModelUsageLoader((startDate, endDate) => new Promise((resolve, reject) => {
  pending.push({ startDate, endDate, resolve, reject });
}));
const first = loader.load(today, (state) => updates.push(state));
const second = loader.load(week, (state) => updates.push(state));
assert.equal(pending[0].startDate, today.startDate);
assert.equal(pending[1].startDate, week.startDate);
pending[1].resolve(envelope(week, [{ model: "week-model", actual_cost: 3, requests: 4, total_tokens: 5 }]));
await second;
pending[0].resolve(envelope(today, [{ model: "obsolete", actual_cost: 99 }]));
await first;
assert.deepEqual(updates.filter((state) => state.status === "ready").map((state) => state.models[0].name), ["week-model"]);
assert.equal(updates.at(-1).periodKey, week.key);

const canceled = loader.load(today, (state) => updates.push(state));
loader.cancel();
const countBeforeCancelCompletion = updates.length;
pending[2].reject(new Error("obsolete failure"));
await canceled;
assert.equal(updates.length, countBeforeCancelCompletion, "An unmounted request must not publish its later failure");

const failed = loader.load(today, (state) => updates.push(state));
pending[3].reject(new Error("HTTP 503"));
await failed;
assert.equal(updates.at(-1).status, "error");
assert.equal(updates.at(-1).periodKey, today.key);
assert.deepEqual(updates.at(-1).models, [], "Failure must not relabel models from another period");
assert.match(updates.at(-1).error, /503/);
const retry = loader.load(today, (state) => updates.push(state));
pending[4].resolve(envelope(today, [{ model: "recovered", actual_cost: 1, requests: 2, total_tokens: 3 }]));
await retry;
assert.equal(updates.at(-1).status, "ready");
assert.equal(updates.at(-1).models[0].name, "recovered");
console.log("Model metrics, period validation, missing detail, obsolete responses, cancellation and retry passed");
