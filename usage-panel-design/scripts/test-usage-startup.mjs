import assert from "node:assert/strict";

let loadInitialUsage;
try {
  ({ loadInitialUsage } = await import("../src/usageStartup.js"));
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
}
assert.equal(typeof loadInitialUsage, "function", "Both windows must be able to load initial usage without waiting for the main panel");
const envelope = { fetchedAtMs: 1234, usage: { quota: { limit: 100, remaining: 79 } } };
let refreshes = 0;
const refresh = async () => { refreshes += 1; return envelope; };
assert.equal(await loadInitialUsage(async () => null, refresh), envelope, "An empty cache triggers an immediate first read");
assert.equal(refreshes, 1);
assert.equal(await loadInitialUsage(async () => envelope, refresh), envelope, "A populated cache is reused");
assert.equal(refreshes, 1, "A cached result does not issue another request");
await assert.rejects(loadInitialUsage(async () => null, async () => { throw new Error("HTTP 502"); }), /502/, "Initial failures reach the window's error state");
console.log("Usage startup cache, first-read and error contracts passed");
