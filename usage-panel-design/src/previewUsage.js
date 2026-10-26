import { addCalendarDays, dateKeyInTimezone } from "./usagePeriod.js";

function previewModelDays(todayKey) {
  return [
    { date: todayKey, model: "gpt-5.6-sol", actual_cost: 0.135122, requests: 2, total_tokens: 36496 },
    { date: addCalendarDays(todayKey, -1), model: "gpt-5.5", actual_cost: 0.142, requests: 3, total_tokens: 25800 },
    { date: addCalendarDays(todayKey, -7), model: "gpt-5.5", actual_cost: 0.251, requests: 4, total_tokens: 42800 },
    { date: addCalendarDays(todayKey, -20), model: "gpt-5.5", actual_cost: 0.239678, requests: 5, total_tokens: 240696 },
    { date: addCalendarDays(todayKey, -20), model: "gpt-5.4-mini", actual_cost: 0.01017735, requests: 1, total_tokens: 10000 },
  ];
}

export function createPreviewUsage(nowMs = Date.now()) {
  const todayKey = dateKeyInTimezone(new Date(nowMs));
  const days = new Map();
  for (const item of previewModelDays(todayKey)) {
    const day = days.get(item.date) ?? { date: item.date, cost: 0, requests: 0, tokens: 0 };
    day.cost += item.actual_cost;
    day.requests += item.requests;
    day.tokens += item.total_tokens;
    days.set(item.date, day);
  }
  return {
    keyName: "", status: "active", mode: "quota_limited", unit: "USD",
    quota: { limit: 300, used: 0.77797735, remaining: 299.22202265 },
    today: { requests: 2, tokens: 36496, cost: 0.135122 },
    total: { requests: 15, tokens: 355792, cost: 0.77797735 },
    days: [...days.values()],
    models: [
      { name: "gpt-5.5", cost: 0.632678, requests: 12, tokens: 309296 },
      { name: "gpt-5.6-sol", cost: 0.135122, requests: 2, tokens: 36496 },
      { name: "gpt-5.4-mini", cost: 0.01017735, requests: 1, tokens: 10000 },
    ],
    rateLimits: [{ window: "7d", used: 0.78, limit: 10, remaining: 9.22, resetAtMs: nowMs + 86400000 }],
    expiresAtMs: null, fetchedAtMs: nowMs,
  };
}

export async function fetchPreviewModelUsage(startDate, endDate, fetchedAtMs = Date.now()) {
  const models = new Map();
  for (const item of previewModelDays(dateKeyInTimezone(new Date(fetchedAtMs)))) {
    if (item.date < startDate || item.date > endDate) continue;
    const model = models.get(item.model) ?? { model: item.model, actual_cost: 0, requests: 0, total_tokens: 0 };
    model.actual_cost += item.actual_cost;
    model.requests += item.requests;
    model.total_tokens += item.total_tokens;
    models.set(item.model, model);
  }
  return { startDate, endDate, modelStats: [...models.values()] };
}
