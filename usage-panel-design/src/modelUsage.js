const metricValue = (...values) => {
  const value = values.find((candidate) =>
    (typeof candidate === "number" || (typeof candidate === "string" && candidate.trim() !== ""))
    && Number.isFinite(Number(candidate)));
  return value === undefined ? null : Number(value);
};

export function normalizeModelStats(stats) {
  if (!Array.isArray(stats)) return [];
  return stats.filter((model) => model && typeof model === "object").map((model) => ({
    name: model.model ?? model.model_name ?? model.modelName ?? model.name ?? "未知模型",
    cost: metricValue(model.actual_cost, model.actualCost, model.cost),
    requests: metricValue(model.requests),
    tokens: metricValue(model.total_tokens, model.totalTokens, model.tokens),
  })).sort((a, b) => {
    if (a.cost === null) return b.cost === null ? 0 : 1;
    if (b.cost === null) return -1;
    return b.cost - a.cost || a.name.localeCompare(b.name);
  });
}

export function normalizeModelUsage(envelope, period) {
  if (envelope?.startDate !== period.startDate || envelope?.endDate !== period.endDate) {
    throw new Error("模型统计返回的时间范围不一致，请重试");
  }
  if (Array.isArray(envelope.modelStats) && envelope.modelStats.length > 0) {
    return normalizeModelStats(envelope.modelStats);
  }
  if (Array.isArray(envelope.dailyUsage)) {
    const hasActivity = envelope.dailyUsage.some((day) => {
      const date = String(day.date ?? day.day ?? "").slice(0, 10);
      return date >= period.startDate && date <= period.endDate
        && [day.actual_cost, day.actualCost, day.cost, day.requests, day.total_tokens, day.totalTokens, day.tokens]
          .some((value) => Number(value) > 0);
    });
    if (!hasActivity) return [];
  } else if (Array.isArray(envelope.modelStats) && envelope.modelStats.length === 0) {
    return [];
  }
  throw new Error("接口暂未提供该时段的模型明细");
}

export function createModelUsageLoader(fetchModels) {
  let generation = 0;
  return {
    async load(period, publish) {
      const request = ++generation;
      publish({ periodKey: period.key, status: "loading", models: [], error: null });
      try {
        const envelope = await fetchModels(period.startDate, period.endDate);
        if (request !== generation) return;
        const models = normalizeModelUsage(envelope, period);
        publish({ periodKey: period.key, status: "ready", models, error: null });
      } catch (error) {
        if (request !== generation) return;
        publish({ periodKey: period.key, status: "error", models: [], error: error?.message ?? String(error) });
      }
    },
    cancel() { generation += 1; },
  };
}
