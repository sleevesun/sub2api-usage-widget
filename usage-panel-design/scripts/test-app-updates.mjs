import assert from "node:assert/strict";

let createAppUpdater;
try { ({ createAppUpdater } = await import("../src/appUpdates.js")); }
catch (error) { if (error.code !== "ERR_MODULE_NOT_FOUND") throw error; }
assert.equal(typeof createAppUpdater, "function", "The in-app update controller is not implemented");

const info = async () => ({ version: "0.3.0", supported: true });
let checks = 0;
const latest = createAppUpdater({ getInfo: info, check: async () => { checks++; return null; }, restart: async () => {} });
await latest.initialize();
assert.equal(latest.getSnapshot().currentVersion, "0.3.0");
assert.equal(checks, 0, "Initialization must never download or check implicitly");
await latest.check();
assert.equal(latest.getSnapshot().status, "current");

let installs = 0;
let restarts = 0;
let closes = 0;
let failDownload = true;
let downloadOptions;
const update = {
  version: "0.3.1", body: "修复刷新问题\n保留现有设置", date: "2026-10-27T00:00:00Z",
  close: async () => { closes++; },
  downloadAndInstall: async (onEvent, options) => {
    downloadOptions = options;
    installs++;
    onEvent({ event: "Started", data: {} });
    onEvent({ event: "Progress", data: { chunkLength: 50 } });
    if (failDownload) throw new Error("network failed");
    onEvent({ event: "Started", data: { contentLength: 100 } });
    onEvent({ event: "Progress", data: { chunkLength: 100 } });
    onEvent({ event: "Finished" });
  },
};
const app = createAppUpdater({ getInfo: info, check: async () => update, restart: async () => { restarts++; } });
const observed = [];
const stop = app.subscribe(() => observed.push(app.getSnapshot()));
await app.check();
assert.equal(app.getSnapshot().status, "available");
assert.equal(app.getSnapshot().version, "0.3.1");
assert.equal(installs, 0, "Finding an update must not install it");
await app.install();
assert.deepEqual(downloadOptions, { timeout: 180000 }, "The download has its own timeout, separate from the metadata check");
assert.equal(app.getSnapshot().status, "error");
assert.equal(app.getSnapshot().canInstall, true, "A failed download can be retried");
assert.equal(restarts, 0, "A failed download must never restart the app");
assert.ok(observed.some((state) => state.status === "downloading" && state.downloadedBytes === 50 && state.totalBytes === null));
failDownload = false;
await app.install();
assert.equal(installs, 2);
assert.equal(restarts, 1);
assert.equal(app.getSnapshot().status, "restarting");
assert.ok(observed.some((state) => state.status === "installing"));
stop();

let releaseCheck;
let concurrentChecks = 0;
const concurrent = createAppUpdater({ getInfo: info, check: () => { concurrentChecks++; return new Promise((resolve) => { releaseCheck = resolve; }); }, restart: async () => {} });
const first = concurrent.check();
await new Promise((resolve) => setImmediate(resolve));
const second = concurrent.check();
releaseCheck(null);
await Promise.all([first, second]);
assert.equal(concurrentChecks, 1, "Repeated clicks must share the in-flight check");

let finishInstall;
const busy = createAppUpdater({ getInfo: info, check: async () => ({ ...update, downloadAndInstall: () => new Promise((resolve) => { finishInstall = resolve; }) }), restart: async () => {} });
await busy.check();
const installing = busy.install();
await new Promise((resolve) => setImmediate(resolve));
await busy.check();
await busy.install();
assert.equal(busy.getSnapshot().status, "downloading", "Checks cannot replace an update while installing");
finishInstall();
await installing;

let requestCount = 0;
const preview = createAppUpdater({ getInfo: async () => ({ version: "0.3.0", supported: false }), check: async () => { requestCount++; }, restart: async () => {} });
await preview.check();
await preview.install();
assert.equal(preview.getSnapshot().status, "unsupported");
assert.equal(requestCount, 0, "Previews and unsupported platforms must not contact the updater");

const unavailable = createAppUpdater({ getInfo: info, check: async () => { throw new Error("404 latest.json"); }, restart: async () => {} });
await unavailable.check();
assert.equal(unavailable.getSnapshot().status, "error", "Missing release metadata must not claim up-to-date");
assert.equal(unavailable.getSnapshot().canInstall, false);

let replacementChecks = 0;
const replacement = createAppUpdater({ getInfo: info, check: async () => ++replacementChecks === 1 ? update : null, restart: async () => {} });
await replacement.check();
await replacement.check();
assert.equal(closes, 1, "Superseded updater resources must be closed");
assert.equal(replacement.getSnapshot().version, null);

let recheckFails = false;
let retainedCloses = 0;
const retainedUpdate = { ...update, close: async () => { retainedCloses++; } };
const retained = createAppUpdater({ getInfo: info, check: async () => {
  if (recheckFails) throw new Error("temporarily offline");
  return retainedUpdate;
}, restart: async () => {} });
await retained.check();
recheckFails = true;
const rechecking = [];
retained.subscribe(() => rechecking.push(retained.getSnapshot()));
await retained.check();
assert.equal(retained.getSnapshot().status, "error");
assert.equal(retained.getSnapshot().version, "0.3.1", "A later failed check must retain an already discovered update");
assert.equal(retained.getSnapshot().canInstall, true, "An existing update remains available for explicit installation");
assert.equal(retainedCloses, 0, "A failed metadata check must not dispose the previously discovered update");
assert.ok(rechecking.some((state) => state.status === "checking" && state.version === "0.3.1"), "Background checks must not make an existing update disappear");

let cleanupChecks = 0;
const cleanupFailure = createAppUpdater({ getInfo: info, check: async () => ++cleanupChecks === 1
  ? { ...update, close: async () => { throw new Error("already closed"); } }
  : null, restart: async () => {} });
await cleanupFailure.check();
await cleanupFailure.check();
assert.equal(cleanupFailure.getSnapshot().status, "current", "Cleanup of old resources must not discard a successful metadata check");
assert.equal(cleanupFailure.getSnapshot().version, null);

const restartFailure = createAppUpdater({ getInfo: info,
  check: async () => ({ ...update, downloadAndInstall: async () => {} }),
  restart: async () => { throw new Error("relaunch failed"); } });
await restartFailure.check();
await restartFailure.install();
assert.equal(restartFailure.getSnapshot().status, "error");
assert.equal(restartFailure.getSnapshot().errorKind, "restart", "An installed update awaiting restart must be distinguishable from an unreachable update service");
assert.equal(restartFailure.getSnapshot().canInstall, false);
await restartFailure.check();
assert.equal(restartFailure.getSnapshot().errorKind, "restart", "A completed installation cannot be replaced by another metadata check before restarting");
console.log("In-app update state, explicit install, retry, progress, concurrency and unavailable-source checks passed");
