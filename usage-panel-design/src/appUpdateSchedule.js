const START_DELAY = 4_000;
const NORMAL_DELAY = 30 * 60_000;
const RETRY_DELAY = 5 * 60_000;
const busyStates = ["checking", "downloading", "installing", "restarting"];

export function startAppUpdateChecks({ updater, host = window, page = document, now = Date.now }) {
  let stopped = false;
  let checking = false;
  let timer;
  let unsubscribe;
  let lastAttempt = null;
  let observedStatus;
  let observedErrorKind;
  const readyAt = now() + START_DELAY;
  const clearTimer = () => {
    host.clearTimeout(timer);
    timer = undefined;
  };
  const paused = (state) => !state.supported || busyStates.includes(state.status) || state.errorKind === "restart";
  const schedule = (delay) => {
    if (stopped) return;
    clearTimer();
    timer = host.setTimeout(() => { void run(); }, delay);
  };
  const scheduleResult = (state) => {
    if (paused(state)) clearTimer();
    else schedule(state.status === "error" ? RETRY_DELAY : NORMAL_DELAY);
  };
  const observe = () => {
    const state = updater.getSnapshot();
    if (state.status === observedStatus && state.errorKind === observedErrorKind) return;
    observedStatus = state.status;
    observedErrorKind = state.errorKind;
    if (state.status === "checking") lastAttempt = now();
    scheduleResult(state);
  };
  const run = async () => {
    if (stopped || checking) return;
    const state = updater.getSnapshot();
    if (paused(state)) {
      clearTimer();
      return;
    }
    if (page.visibilityState === "hidden") {
      scheduleResult(state);
      return;
    }
    checking = true;
    lastAttempt = now();
    try { await updater.check(); }
    catch { /* The controller exposes failures as state; always keep the next retry scheduled. */ }
    finally {
      checking = false;
      scheduleResult(updater.getSnapshot());
    }
  };
  const resume = () => {
    if (!stopped && now() >= readyAt && page.visibilityState !== "hidden"
      && (lastAttempt === null || now() - lastAttempt >= RETRY_DELAY)) void run();
  };
  void updater.initialize().then(() => {
    if (stopped || !updater.getSnapshot().supported) return;
    host.addEventListener("focus", resume);
    host.addEventListener("online", resume);
    page.addEventListener("visibilitychange", resume);
    unsubscribe = updater.subscribe(observe);
    observe();
    if (updater.getSnapshot().status === "idle") schedule(START_DELAY);
  });
  return () => {
    stopped = true;
    clearTimer();
    unsubscribe?.();
    host.removeEventListener("focus", resume);
    host.removeEventListener("online", resume);
    page.removeEventListener("visibilitychange", resume);
  };
}
