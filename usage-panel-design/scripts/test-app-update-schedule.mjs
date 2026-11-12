import assert from "node:assert/strict";

const { startAppUpdateChecks } = await import("../src/appUpdateSchedule.js").catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  return {};
});
assert.equal(typeof startAppUpdateChecks, "function", "Long-running apps need scheduled update checks");
const minute = 60_000;
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fixture({ supported = true } = {}) {
  let time = 0;
  let nextId = 0;
  let checks = 0;
  const timers = new Map();
  const events = () => {
    const handlers = new Map();
    return {
      addEventListener: (name, handler) => {
        if (!handlers.has(name)) handlers.set(name, new Set());
        handlers.get(name).add(handler);
      },
      removeEventListener: (name, handler) => handlers.get(name)?.delete(handler),
      dispatch: (name) => handlers.get(name)?.forEach((handler) => handler()),
      count: () => [...handlers.values()].reduce((sum, group) => sum + group.size, 0),
    };
  };
  const host = { ...events(), setTimeout: (callback, delay) => {
    const id = ++nextId;
    timers.set(id, { callback, at: time + delay });
    return id;
  }, clearTimeout: (id) => timers.delete(id) };
  const page = { ...events(), visibilityState: "visible" };
  const state = { supported, status: "idle" };
  const listeners = new Set();
  const notify = () => listeners.forEach((listener) => listener());
  let checkResult = "current";
  const updater = {
    initialize: async () => {}, getSnapshot: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    check: async () => { checks++; state.status = "checking"; notify(); state.status = checkResult; notify(); },
  };
  return {
    host, page, state, updater, notify,
    start: () => startAppUpdateChecks({ updater, host, page, now: () => time }),
    checks: () => checks,
    fail: () => { checkResult = "error"; },
    recover: () => { checkResult = "current"; },
    timerCount: () => timers.size,
    subscriptionCount: () => listeners.size,
    async advance(ms) {
      const target = time + ms;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        time = timer.at;
        timers.delete(id);
        timer.callback();
        await flush();
      }
      time = target;
      await flush();
    },
  };
}

const active = fixture();
const stop = active.start();
await flush();
await active.advance(3999);
assert.equal(active.checks(), 0);
await active.advance(1);
assert.equal(active.checks(), 1, "Startup checks after four seconds");
await active.advance(30 * minute);
assert.equal(active.checks(), 2, "An app left running discovers later releases");
active.fail();
await active.advance(30 * minute);
assert.equal(active.checks(), 3);
await active.advance(5 * minute);
assert.equal(active.checks(), 4, "Failed checks retry after five minutes");
active.recover();
active.host.dispatch("focus");
await flush();
assert.equal(active.checks(), 4, "Repeated focus events are throttled");
await active.advance(5 * minute);
assert.equal(active.checks(), 5);
await active.advance(5 * minute);
active.host.dispatch("focus");
await flush();
assert.equal(active.checks(), 6, "Returning to the app rechecks when the last attempt is old enough");

active.page.visibilityState = "hidden";
await active.advance(30 * minute);
assert.equal(active.checks(), 6, "Hidden apps defer metadata reads");
active.page.visibilityState = "visible";
active.page.dispatch("visibilitychange");
await flush();
assert.equal(active.checks(), 7);
await active.advance(5 * minute);
active.state.status = "downloading";
active.host.dispatch("online");
await flush();
assert.equal(active.checks(), 7, "Automatic checks cannot replace an active download");
active.state.status = "current";
active.host.dispatch("online");
await flush();
assert.equal(active.checks(), 8, "Network recovery can trigger a throttled recheck");
stop();
assert.equal(active.timerCount(), 0);
assert.equal(active.host.count() + active.page.count(), 0);
assert.equal(active.subscriptionCount(), 0);
await active.advance(60 * minute);
assert.equal(active.checks(), 8, "Unmounted windows stop all scheduled checks");

const preview = fixture({ supported: false });
const stopPreview = preview.start();
await flush();
await preview.advance(60 * minute);
preview.host.dispatch("focus");
assert.equal(preview.checks(), 0);
assert.equal(preview.timerCount(), 0);
stopPreview();

const canceled = fixture();
const stopCanceled = canceled.start();
stopCanceled();
await flush();
assert.equal(canceled.timerCount(), 0, "An initialization completed after unmount cannot schedule a check");

const manual = fixture();
const stopManual = manual.start();
await flush();
manual.state.status = "checking";
manual.notify();
await manual.advance(4000);
manual.state.status = "error";
manual.notify();
await manual.advance(5 * minute);
assert.equal(manual.checks(), 1, "A manual check overlapping startup must retry five minutes after failure");
await manual.advance(2 * minute);
manual.state.status = "checking";
manual.notify();
manual.state.status = "error";
manual.notify();
await manual.advance(5 * minute);
assert.equal(manual.checks(), 2, "Manual check failures between periodic checks must also retry after five minutes");
manual.state.status = "error";
manual.state.errorKind = "restart";
manual.notify();
await manual.advance(60 * minute);
manual.host.dispatch("focus");
await flush();
assert.equal(manual.checks(), 2, "An installed update awaiting a manual restart must not be checked or downloaded again");
stopManual();
assert.equal(manual.subscriptionCount(), 0);

console.log("Update startup, periodic discovery, retry, foreground, visibility, busy states and cleanup checks passed");
