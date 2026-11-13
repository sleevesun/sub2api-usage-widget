import assert from "node:assert/strict";

let api = {};
try { api = await import("../src/localTps.js"); } catch (error) { if (error.code !== "ERR_MODULE_NOT_FOUND") throw error; }
assert.equal(typeof api.normalizeLocalTps, "function", "Local TPS needs a range-validated metadata contract");
const period = { key: "today:2026-11-13:2026-11-13", startDate: "2026-11-13", endDate: "2026-11-13" };
const stats = { model: "gpt-6.1-sol", samples: 2, outputTokens: 150, durationMs: 3000, firstSampleAtMs: Date.parse("2026-11-13T00:00:00Z"), lastSampleAtMs: Date.parse("2026-11-13T01:00:00Z"), tps: 999 };
const envelope = (models = [stats]) => ({ startDate: period.startDate, endDate: period.endDate, enabled: true, status: "collecting", models, lastReceivedAtMs: stats.lastSampleAtMs, recordedSamples: 2 });
const normalized = api.normalizeLocalTps(envelope(), period);
assert.equal(normalized.models[0].tps, 50, "Derive weighted TPS from totals, never a mean or an unverified rate");
assert.throws(() => api.normalizeLocalTps({ ...envelope(), startDate: "2026-11-12" }, period), /时段/);
assert.deepEqual(api.normalizeLocalTps(envelope([{ ...stats, durationMs: 0 }, { ...stats, model: "negative", outputTokens: -1 }]), period).models, []);
assert.deepEqual(api.normalizeLocalTps(envelope([{ ...stats, firstSampleAtMs: Date.parse("2026-11-12T15:59:59Z") }]), period).models, [], "Reject a sample range outside Beijing dates");
assert.deepEqual(api.normalizeLocalTps(envelope([stats, stats]), period).models, [], "Ambiguous duplicate model aggregates are not silently chosen");
const models = [{ name: "GPT-6.1-SOL", cost: 5, tps: null }, { name: "gpt-6-sol", cost: 2, tps: null }, { name: "gpt-6.1-sol-extra", cost: 1, tps: null }];
const merged = api.mergeLocalTps(models, normalized);
assert.equal(merged[0].tps, 50); assert.equal(merged[0].tpsSamples, 2);
assert.deepEqual(merged.map(row => row.cost), [5, 2, 1]);
assert.equal(merged[1].tps, null); assert.equal(merged[2].tps, null);
assert.equal(models[0].tps, null, "Do not mutate account consumption rows");
assert.equal(api.mergeLocalTps(models, { models: [] })[0].tps, null);

const pending = [];
const loader = api.createLocalTpsLoader((startDate, endDate) => new Promise((resolve, reject) => pending.push({ startDate, endDate, resolve, reject })));
const updates = [];
const first = loader.load(period, value => updates.push(value));
const shared = loader.load(period, value => updates.push(value));
assert.equal(pending.length, 1, "Polling must coalesce an in-flight snapshot read");
const older = { key: "older", startDate: "2026-11-12", endDate: "2026-11-12" };
const changed = loader.load(older, value => updates.push(value));
pending[1].resolve({ ...envelope([]), startDate: older.startDate, endDate: older.endDate }); await changed;
pending[0].resolve(envelope()); await Promise.all([first, shared]);
assert.equal(updates.length, 1); assert.equal(updates[0].periodKey, older.key);
const canceled = loader.load(period, value => updates.push(value)); loader.cancel(); pending[2].reject(new Error("late")); await canceled;
assert.equal(updates.length, 1);
console.log("Local TPS weighted totals, Beijing ranges, exact models, duplicate rejection, polling coalescing and obsolete responses passed");
