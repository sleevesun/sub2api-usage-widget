export const RADAR_EFFORTS = ["ultra", "max", "xhigh", "high", "medium", "low"];
const targetModel = /^gpt-6(?:\.1)?(?:-|$)/i;
export const numeric = (value) => typeof value === "number" && Number.isFinite(value);
const measurement = (value) => numeric(value) && value >= 0 ? value : null;
export const scored = (row) => numeric(row?.score150) && row.score150 >= 0;
export const keyOf = (row) => `${row.model}/${row.effort}`;
export const scoreText = (value) => measurement(value) !== null ? value.toFixed(2) : "—";
export const costText = (value) => measurement(value) !== null ? `$${value.toFixed(value > 0 && value < 0.1 ? 4 : 2)}` : "—";
export const minutes = (row) => measurement(row?.model_elapsed_seconds) !== null ? row.model_elapsed_seconds / 60 : null;
export const timeText = (row) => numeric(minutes(row)) ? `${minutes(row).toFixed(1)} 分钟` : "—";
export const modelName = (model) => model.replace(/^gpt-/i, "GPT-").replace(/-([a-z])/g, (_, letter) => ` ${letter.toUpperCase()}`);
export const modelParts = (model) => {
  const match = model.match(/^gpt-(\d+(?:\.\d+)?)(?:-(.*))?$/i);
  return {
    generation: match ? `GPT-${match[1]}` : model,
    name: match?.[2]?.replace(/(^|-)([a-z])/g, (_, space, letter) => `${space ? " " : ""}${letter.toUpperCase()}`) || "GPT",
  };
};
export const dateText = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
}).format(new Date(value)) : "未提供";

export function normalizeRadarSnapshot(data) {
  if (!Array.isArray(data?.rows)) throw new Error("官网 scores.rows 格式已变化");
  const keys = new Set();
  const rows = data.rows.filter((row) => row && typeof row.model === "string" && targetModel.test(row.model.trim())
    && typeof row.effort === "string" && row.effort.trim()).map((row) => {
    const normalized = {
      model: row.model.trim().toLowerCase(), effort: row.effort.trim().toLowerCase(),
      score150: measurement(row.score150), cost_usd: measurement(row.cost_usd),
      model_elapsed_seconds: measurement(row.model_elapsed_seconds),
      cost_kind: typeof row.cost_kind === "string" ? row.cost_kind : "unknown",
    };
    const key = keyOf(normalized);
    if (keys.has(key)) throw new Error("官网返回重复的模型与档位");
    keys.add(key);
    return normalized;
  });
  const models = new Set(rows.map((row) => row.model));
  const unsupported = (Array.isArray(data.unsupported) ? data.unsupported : [])
    .filter((row) => typeof row?.model === "string" && models.has(row.model.trim().toLowerCase())
      && typeof row.effort === "string" && row.effort.trim())
    .map((row) => ({ model: row.model.trim().toLowerCase(), effort: row.effort.trim().toLowerCase() }));
  return {
    source: "https://codexradar.com/", fetched_at: data.fetched_at, score_max: 150, rows, unsupported,
    metadata: data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata) ? data.metadata : {},
    status: ["latest", "cached", "stale"].includes(data.status) ? data.status : "latest",
    ...(typeof data.error === "string" ? { error: data.error } : {}),
  };
}

export function modelsInOrder(rows) {
  const best = new Map();
  for (const row of rows) best.set(row.model, Math.max(best.get(row.model) ?? -1, scored(row) ? row.score150 : -1));
  const version = (model) => model.match(/^gpt-(\d+)(?:\.(\d+))?/i)?.slice(1).map((part) => Number(part || 0)) || [0, 0];
  return [...best.keys()].sort((a, b) => {
    const av = version(a), bv = version(b);
    return bv[0] - av[0] || bv[1] - av[1] || best.get(b) - best.get(a) || a.localeCompare(b);
  });
}

export function effortColumns(snapshot) {
  const all = new Set([...snapshot.rows, ...(snapshot.unsupported || [])].map((row) => row.effort));
  return [...RADAR_EFFORTS, ...[...all].filter((effort) => !RADAR_EFFORTS.includes(effort)).sort()];
}

export function rankRows(rows, type = "score", { onlyAbove90 = false, limit = 5 } = {}) {
  const eligible = rows.filter((row) => scored(row) && (!onlyAbove90 || row.score150 > 90))
    .filter((row) => type === "value" ? numeric(row.cost_usd) && row.cost_usd > 0
      : type === "speed" ? numeric(minutes(row)) && minutes(row) > 0 : true);
  const metric = (row) => type === "value" ? row.score150 / row.cost_usd : type === "speed" ? row.score150 / minutes(row) : row.score150;
  const effortIndex = (row) => RADAR_EFFORTS.includes(row.effort) ? RADAR_EFFORTS.indexOf(row.effort) : RADAR_EFFORTS.length;
  return eligible.sort((a, b) => metric(b) - metric(a) || b.score150 - a.score150 || a.model.localeCompare(b.model)
    || effortIndex(a) - effortIndex(b) || a.effort.localeCompare(b.effort)).slice(0, limit);
}

export function resolveRadarSelection(snapshot, selected, rankingRows = null) {
  const candidates = rankingRows || snapshot?.rows || [];
  const current = selected && candidates.find((item) => keyOf(item) === keyOf(selected));
  if (current) return current;
  if (!rankingRows && selected && snapshot?.rows.some((item) => item.model === selected.model)
    && effortColumns(snapshot).includes(selected.effort) && !snapshot.unsupported.some((item) => keyOf(item) === keyOf(selected))) {
    return { model: selected.model, effort: selected.effort };
  }
  return rankRows(candidates)[0] || null;
}

// A loader belongs to one hook lifetime. Transport coalesces reads across lifetimes.
export function createRadarLoader(readSnapshot, initialSnapshot = null) {
  let generation = 0;
  let lastSnapshot = initialSnapshot;
  return {
    async load(force, publish) {
      const request = ++generation;
      publish({ snapshot: lastSnapshot, loading: true, error: null });
      try {
        const snapshot = normalizeRadarSnapshot(await readSnapshot(force));
        if (request !== generation) return;
        lastSnapshot = snapshot;
        publish({ snapshot, loading: false, error: snapshot.status === "stale" ? snapshot.error || "官网读取失败" : null });
      } catch (failure) {
        if (request !== generation) return;
        const error = failure?.message || String(failure);
        lastSnapshot = lastSnapshot ? { ...lastSnapshot, status: "stale", error } : null;
        publish({ snapshot: lastSnapshot, loading: false, error });
      }
    },
    cancel() { generation += 1; },
  };
}
