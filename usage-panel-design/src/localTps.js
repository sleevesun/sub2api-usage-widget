import { dateKeyInTimezone } from "./usagePeriod.js";

const count = value => Number.isSafeInteger(value) && value > 0;
const modelKey = value => typeof value === "string" ? value.trim().toLowerCase() : "";

export function normalizeLocalTps(snapshot, period) {
  if (snapshot?.startDate !== period.startDate || snapshot?.endDate !== period.endDate) {
    throw new Error("本机 TPS 返回的时段不一致");
  }
  if (!Array.isArray(snapshot.models) || typeof snapshot.enabled !== "boolean"
    || !["disabled", "waiting", "collecting", "error"].includes(snapshot.status)) {
    throw new Error("本机 TPS 数据格式无效");
  }
  const duplicates = new Map();
  for (const row of snapshot.models) {
    const key = modelKey(row?.model);
    duplicates.set(key, (duplicates.get(key) ?? 0) + 1);
  }
  const models = snapshot.models.filter(row => {
    if (!modelKey(row?.model) || duplicates.get(modelKey(row.model)) !== 1
      || !count(row.samples) || !count(row.outputTokens) || !count(row.durationMs)
      || !Number.isSafeInteger(row.firstSampleAtMs) || !Number.isSafeInteger(row.lastSampleAtMs)
      || row.firstSampleAtMs > row.lastSampleAtMs) return false;
    try {
      return dateKeyInTimezone(new Date(row.firstSampleAtMs)) >= period.startDate
        && dateKeyInTimezone(new Date(row.lastSampleAtMs)) <= period.endDate;
    } catch { return false; }
  }).map(row => ({ ...row, tps: row.outputTokens * 1000 / row.durationMs }));
  return {
    periodKey: period.key, enabled: snapshot.enabled, status: snapshot.status, models,
    error: typeof snapshot.error === "string" ? snapshot.error : null,
    lastReceivedAtMs: Number.isSafeInteger(snapshot.lastReceivedAtMs) ? snapshot.lastReceivedAtMs : null,
    recordedSamples: Number.isSafeInteger(snapshot.recordedSamples) && snapshot.recordedSamples >= 0 ? snapshot.recordedSamples : 0,
  };
}

export function mergeLocalTps(models, snapshot) {
  const local = new Map((snapshot?.models ?? []).map(row => [modelKey(row.model), row]));
  return models.map(model => {
    const sample = local.get(modelKey(model.name));
    return { ...model, tps: sample?.tps ?? null, tpsSamples: sample?.samples ?? 0,
      tpsFirstAtMs: sample?.firstSampleAtMs ?? null, tpsLastAtMs: sample?.lastSampleAtMs ?? null };
  });
}

export function createLocalTpsLoader(fetchSnapshot) {
  let generation = 0;
  const pending = new Map();
  return {
    async load(period, publish) {
      const request = ++generation;
      const key = `${period.startDate}:${period.endDate}`;
      let promise = pending.get(key);
      if (!promise) {
        try { promise = Promise.resolve(fetchSnapshot(period.startDate, period.endDate)); }
        catch (error) { promise = Promise.reject(error); }
        pending.set(key, promise);
        const cleanup = () => { if (pending.get(key) === promise) pending.delete(key); };
        void promise.then(cleanup, cleanup);
      }
      try {
        const snapshot = normalizeLocalTps(await promise, period);
        if (request === generation) publish(snapshot);
      } catch (error) {
        if (request === generation) publish({ periodKey: period.key, status: "error", enabled: null,
          error: error?.message ?? String(error), models: [], recordedSamples: 0 });
      }
    },
    cancel() { generation += 1; pending.clear(); },
  };
}
