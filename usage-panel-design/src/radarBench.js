export const RADAR_BENCH_MODELS = [
  { id: "gpt-6-astra", label: "GPT-6 Astra", name: "Astra", generation: "GPT-6", family: "astra" },
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", name: "Sol", generation: "GPT-6.1", family: "sol" },
  { id: "gpt-6-sol", label: "GPT-6 Sol", name: "Sol", generation: "GPT-6", family: "sol" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", name: "Sol", generation: "GPT-5.6", family: "legacy" },
  { id: "gpt-6-luna", label: "GPT-6 Luna", name: "Luna", generation: "GPT-6", family: "luna" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", name: "Luna", generation: "GPT-5.6", family: "legacy" },
];
export const RADAR_BENCH_EFFORTS = ["ultra", "max", "xhigh", "high", "medium", "low"];
export const RADAR_BENCH_SELECTIONS = RADAR_BENCH_MODELS.flatMap(({ id: model }) =>
  RADAR_BENCH_EFFORTS
    .filter((effort) => !(model.endsWith("-luna") && effort === "ultra"))
    .map((effort) => ({ model, effort })),
);
export const radarBenchKey = ({ model, effort }) => `${model}/${effort}`;

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const count = (value) => Number.isInteger(value) && value >= 0;

function observedAverage(metric, samples, divisor = 1) {
  const knownSamples = count(metric?.known_samples) && metric.known_samples <= samples ? metric.known_samples : 0;
  const hasTotal = finite(metric?.known_total) && metric.known_total >= 0;
  return {
    value: knownSamples > 0 && hasTotal ? metric.known_total / knownSamples / divisor : null,
    knownSamples: hasTotal ? knownSamples : 0,
    partial: samples > 0 && (!hasTotal || knownSamples < samples || metric?.missing_samples > 0),
  };
}

export function normalizeRadarBenchScore(data, selection, fetchedAtMs = Date.now()) {
  if (data?.model !== selection.model || data?.effort !== selection.effort) {
    throw new Error("雷达Bench返回的模型或档位不匹配");
  }
  if (data.score_max !== 150) throw new Error("雷达Bench满分必须为150");
  if (data.score !== null && (!finite(data.score) || data.score < 0 || data.score > 150)) {
    throw new Error("雷达Bench分数无效");
  }
  if (!count(data.statistics?.sample_count) || !data.statistics?.metrics ||
      !count(data.coverage) || data.required_tasks !== 64 || data.coverage > data.required_tasks) {
    throw new Error("雷达Bench统计数据无效");
  }
  const samples = data.statistics.sample_count;
  const cost = observedAverage(data.statistics.metrics.api_equivalent_usd, samples);
  const duration = observedAverage(data.statistics.metrics.elapsed_ms, samples, 60000);
  return {
    ...selection,
    score: data.score,
    scoreMax: 150,
    status: data.score_status,
    samples,
    coverage: data.coverage,
    requiredTasks: data.required_tasks,
    averageCostUsd: cost.value,
    averageDurationMinutes: duration.value,
    costKnownSamples: cost.knownSamples,
    durationKnownSamples: duration.knownSamples,
    costPartial: cost.partial,
    durationPartial: duration.partial,
    fetchedAtMs,
    latestGradedAt: data.latest_graded_at ?? null,
    error: null,
    stale: false,
  };
}

export function mergeRadarBenchCell(previous, result) {
  if (result.error && finite(previous?.fetchedAtMs)) {
    return { ...previous, error: result.error, stale: true };
  }
  return { ...result, stale: false, error: result.error ?? null };
}

export async function loadRadarBench(fetchScore, {
  selections = RADAR_BENCH_SELECTIONS,
  onCell = () => {},
  signal,
} = {}) {
  const results = new Array(selections.length);
  let cursor = 0;
  async function worker() {
    while (!signal?.aborted && cursor < selections.length) {
      const index = cursor++;
      const selection = selections[index];
      let cell;
      try {
        cell = normalizeRadarBenchScore(await fetchScore(selection, signal), selection);
      } catch (error) {
        cell = { ...selection, error: error instanceof Error ? error.message : String(error) };
      }
      if (signal?.aborted) return;
      results[index] = cell;
      onCell(cell);
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, selections.length) }, worker));
  return results.filter(Boolean);
}
