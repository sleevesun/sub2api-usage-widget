import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { gsap } from "gsap";
import {
  ArrowClockwise,
  CaretDown,
  ChartBar,
  CheckCircle,
  Eye,
  EyeSlash,
  GearSix,
  Key,
  Minus,
  Moon,
  Pulse,
  Sun,
  Wallet,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import {
  clearApiKeyOverride,
  fetchRadar,
  getCachedUsage,
  getSourceInfo,
  ensureNotificationPermission,
  minimizeCurrentWindow,
  onUsageError,
  onUsageUpdated,
  onOpenSettings,
  orbOpenSettings,
  orbHide,
  refreshUsage,
  runningInTauri as runningInTauriAsync,
  runningInTauriSync,
  setApiKey,
  setBaseUrl,
  setNotificationEnabled,
  setRefreshInterval,
  showMainWindow,
  moveOrbWindow,
} from "./tauriBridge";
import { getCurrentWindow } from "@tauri-apps/api/window";

const APP_TIME_ZONE = "Asia/Shanghai";
const KEY_RESET_STORAGE = "sub2api-key-reset-state";

// 站长推荐真实数据源：dradar 项目服务端（https://api.codexradar.com）
// API 文档：GET /api/v1/radar-insights?v=20260815-equal-iq-v2&benchmark=deep-swe
// dev 环境通过 vite proxy 规避 CORS；Tauri webview 直接请求完整 URL
const RADAR_API_URL = import.meta.env.DEV
  ? "/radar-api?v=20260815-equal-iq-v2&benchmark=deep-swe"
  : "https://api.codexradar.com/api/v1/radar-insights?v=20260815-equal-iq-v2&benchmark=deep-swe";

// 初始空状态（加载中）
const radarInitial = { generatedAt: null, categories: [] };

// 解析 model 字段："gpt-5.6-sol" → { version: "5.6", name: "sol" }；"gpt-5.5" → { version: "5.5", name: "" }
const parseModel = (modelStr) => {
  const match = modelStr.match(/gpt-(\d+\.\d+)(?:-(\w+))?/);
  if (match) return { version: match[1], name: match[2] || "" };
  return { version: "", name: modelStr };
};

// 将 API 返回的 recommendations 转换为组件格式
// 过滤掉不需要展示的分类（如跑龙虾类任务）
const RADAR_HIDDEN_KEYS = new Set(["lobster_tasks"]);
const normalizeRadar = (data) => {
  if (!data || !Array.isArray(data.recommendations)) return null;
  return {
    generatedAt: data.generated_at ? Date.parse(data.generated_at) : Date.now(),
    sourceUpdatedAt: data.source_updated_at ? Date.parse(data.source_updated_at) : null,
    categories: data.recommendations
      .filter((rec) => !RADAR_HIDDEN_KEYS.has(rec.key))
      .map((rec) => ({
      key: rec.key,
      title: rec.title,
      models: (rec.items || []).map((item) => {
        const parsed = parseModel(item.model);
        return {
          version: parsed.version,
          name: parsed.name,
          effort: item.effort,
          iq: Math.round(item.iq * 10) / 10,
          durationMin: Math.round(item.average_duration_minutes),
          costUsd: Math.round(item.average_cost_usd * 100) / 100,
          passed: Math.round(item.passed),
          samples: item.samples,
          trend48h: Array.isArray(item.trend_48h) ? item.trend_48h.length : 0,
        };
      }),
    })),
  };
};

const verClass = (version) => `ver ver-${version.replace(".", "-")}`;
const nameClass = (name) => (name ? `name-${name}` : "");
const effortClass = (effort) => {
  const map = { low: "low", med: "med", medium: "med", high: "high", xhigh: "xhigh", max: "max", ultra: "ultra" };
  return map[effort] ?? "med";
};

const formatDuration = (minutes) => {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h${m}`;
};

const formatRelativeTime = (ms, nowMs = Date.now()) => {
  if (!ms) return "未提供";
  const diff = nowMs - ms;
  if (diff < 0) return "未来时间";
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
};

const mockUsage = {
  keyName: "",
  status: "active",
  mode: "quota_limited",
  unit: "USD",
  quota: { limit: 300, used: 0.77797735, remaining: 299.22202265 },
  today: { requests: 2, tokens: 36496, cost: 0.135122 },
  total: { requests: 15, tokens: 355792, cost: 0.77797735 },
  days: [
    { date: "2026-06-30", cost: 0.064, requests: 1, tokens: 12000 },
    { date: "2026-07-02", cost: 0.142, requests: 3, tokens: 25800 },
    { date: "2026-07-08", cost: 0.251, requests: 4, tokens: 42800 },
    { date: "2026-07-14", cost: 0.643, requests: 5, tokens: 96500 },
    { date: "2026-07-17", cost: 0.135122, requests: 2, tokens: 36496 },
    { date: "2026-07-20", cost: 0.135122, requests: 2, tokens: 36496 },
  ],
  models: [
    { name: "gpt-5.5", cost: 0.632678 },
    { name: "gpt-5.6-sol", cost: 0.135122 },
    { name: "gpt-5.4-mini", cost: 0.01017735 },
  ],
  rateLimits: [
    { window: "7d", used: 0.78, limit: 10, remaining: 9.22, resetAtMs: Date.now() + 86400000 },
  ],
  expiresAtMs: null,
  fetchedAtMs: Date.now(),
};

const emptyUsage = {
  ...mockUsage,
  quota: { limit: 0, used: 0, remaining: 0 },
  today: { requests: 0, tokens: 0, cost: 0 },
  total: { requests: 0, tokens: 0, cost: 0 },
  days: [],
  models: [],
  rateLimits: [],
};

export const quotaRemainingPercent = (usage) => {
  const limit = Number(usage?.quota?.limit);
  const remaining = Number(usage?.quota?.remaining);
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining)) return null;
  return Number(Math.min(100, Math.max(0, (remaining / limit) * 100)).toFixed(2));
};

const numberValue = (...values) => {
  const value = values.find((candidate) => Number.isFinite(Number(candidate)));
  return value === undefined ? 0 : Number(value);
};

const normalizeDateKey = (value) => {
  if (typeof value !== "string") return "";
  const match = value.match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
};

const timestampToMs = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

export const normalizeEnvelope = (envelope, currentUsage = emptyUsage) => {
  const wrapped = envelope?.fetchedAtMs !== undefined ? envelope : { usage: envelope ?? {} };
  const raw = wrapped.usage ?? {};
  const usageStats = raw.usage ?? {};
  const dailyUsage = raw.daily_usage ?? raw.dailyUsage ?? [];
  const modelStats = raw.model_stats ?? raw.modelStats ?? [];
  const quota = raw.quota ?? {};
  const today = raw.today ?? raw.today_usage ?? usageStats.today ?? {};
  const total = raw.total ?? raw.total_usage ?? usageStats.total ?? {};
  const rawRateLimits = raw.rate_limits ?? raw.rateLimits ?? [];

  return {
    keyName: currentUsage.keyName,
    status: raw.status ?? (raw.isValid === false ? "invalid" : "active"),
    mode: raw.mode ?? "unrestricted",
    unit: raw.unit ?? quota.unit ?? "USD",
    quota: {
      limit: numberValue(quota.limit, raw.limit),
      used: numberValue(quota.used, raw.used),
      remaining: numberValue(quota.remaining, raw.remaining),
    },
    today: {
      requests: numberValue(today.requests),
      tokens: numberValue(today.total_tokens, today.totalTokens, today.tokens),
      cost: numberValue(today.actual_cost, today.actualCost, today.cost),
    },
    total: {
      requests: numberValue(total.requests),
      tokens: numberValue(total.total_tokens, total.totalTokens, total.tokens),
      cost: numberValue(total.actual_cost, total.actualCost, total.cost, quota.used),
    },
    days: Array.isArray(dailyUsage)
      ? dailyUsage
          .map((day) => ({
            date: normalizeDateKey(day.date ?? day.day),
            cost: numberValue(day.actual_cost, day.actualCost, day.cost),
            requests: numberValue(day.requests),
            tokens: numberValue(day.total_tokens, day.totalTokens, day.tokens),
          }))
          .filter((day) => day.date)
      : [],
    models: Array.isArray(modelStats)
      ? modelStats
          .map((model) => ({
            name: model.model ?? model.model_name ?? model.modelName ?? "未知模型",
            cost: numberValue(model.actual_cost, model.actualCost, model.cost),
          }))
          .sort((a, b) => b.cost - a.cost)
      : [],
    rateLimits: Array.isArray(rawRateLimits)
      ? rawRateLimits.map((limit) => ({
          window: limit.window ?? "额度窗口",
          used: numberValue(limit.used),
          limit: numberValue(limit.limit),
          remaining: numberValue(limit.remaining, numberValue(limit.limit) - numberValue(limit.used)),
          resetAtMs: timestampToMs(limit.reset_at ?? limit.resetAt),
        }))
      : [],
    expiresAtMs: timestampToMs(raw.expires_at ?? raw.expiresAt),
    fetchedAtMs: timestampToMs(wrapped.fetchedAtMs ?? wrapped.fetched_at_ms) ?? Date.now(),
  };
};

const formatMoney = (value, digits = 2, currency = "USD") =>
  new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);

const compactNumber = (value) =>
  new Intl.NumberFormat("zh-CN", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);

function dateKeyInTimezone(date, timeZone = APP_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const find = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return `${find("year")}-${find("month")}-${find("day")}`;
}

function parseDateKey(value) {
  return new Date(`${value}T12:00:00Z`);
}

function addCalendarDays(value, amount) {
  const date = parseDateKey(value);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function startOfNaturalWeek(value) {
  const weekday = parseDateKey(value).getUTCDay();
  return addCalendarDays(value, -((weekday + 6) % 7));
}

function formatDateLabel(value) {
  const date = parseDateKey(value);
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "UTC",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatWeekday(value) {
  return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][parseDateKey(value).getUTCDay()];
}

function formatTimestamp(value) {
  if (!value) return "未提供";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: APP_TIME_ZONE,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function formatRelativeReset(value, nowMs) {
  if (!value) return "未提供";
  const diff = value - nowMs;
  if (diff <= 0) return "等待同步";
  const minutes = Math.ceil(diff / 60000);
  if (minutes < 60) return `${minutes} 分钟后`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 48) return `${hours} 小时 ${remainingMinutes} 分钟后`;
  return `${Math.floor(hours / 24)} 天后`;
}

function readLocalState(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? { ...fallback, ...JSON.parse(value) } : fallback;
  } catch {
    return fallback;
  }
}

function saveLocalState(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function updateKeyResetState(previous, usage, observedAtMs) {
  const sameLimit = previous.quotaLimit > 0
    && Math.abs(previous.quotaLimit - usage.quota.limit) < 0.000001;
  const resetDetected = sameLimit && usage.quota.used + 0.000001 < previous.quotaUsed;
  return {
    quotaLimit: usage.quota.limit,
    quotaUsed: usage.quota.used,
    observedAtMs,
    lastDetectedAtMs: resetDetected ? observedAtMs : previous.lastDetectedAtMs ?? null,
    previousUsed: resetDetected ? previous.quotaUsed : previous.previousUsed ?? null,
  };
}

export function buildTrendSeries(days, mode, todayKey = dateKeyInTimezone(new Date())) {
  const usageByDate = new Map();
  days.forEach((day) => {
    usageByDate.set(day.date, (usageByDate.get(day.date) ?? 0) + day.cost);
  });

  if (mode === "weeks") {
    const firstWeek = addCalendarDays(startOfNaturalWeek(todayKey), -21);
    const points = Array.from({ length: 4 }, (_, index) => {
      const start = addCalendarDays(firstWeek, index * 7);
      const end = addCalendarDays(start, 6);
      const dates = Array.from({ length: 7 }, (_, offset) => addCalendarDays(start, offset));
      const cost = dates.reduce(
        (sum, date) => sum + (date > todayKey ? 0 : usageByDate.get(date) ?? 0),
        0,
      );
      return {
        key: start,
        label: formatDateLabel(start),
        secondaryLabel: formatDateLabel(end),
        cost,
        future: false,
        current: index === 3,
      };
    });
    return {
      points,
      total: points.reduce((sum, point) => sum + point.cost, 0),
      rangeLabel: "含本周在内的 4 个自然周",
    };
  }

  const isWeek = mode === "week";
  const start = isWeek ? startOfNaturalWeek(todayKey) : addCalendarDays(todayKey, -14);
  const count = isWeek ? 7 : 15;
  const points = Array.from({ length: count }, (_, index) => {
    const date = addCalendarDays(start, index);
    const future = date > todayKey;
    return {
      key: date,
      label: isWeek ? formatWeekday(date) : formatDateLabel(date),
      secondaryLabel: "",
      cost: future ? null : usageByDate.get(date) ?? 0,
      future,
      current: date === todayKey,
    };
  });
  return {
    points,
    total: points.reduce((sum, point) => sum + (point.cost ?? 0), 0),
    rangeLabel: isWeek
      ? `${formatDateLabel(start)} 至 ${formatDateLabel(todayKey)}`
      : `${formatDateLabel(start)} 至 ${formatDateLabel(todayKey)}`,
  };
}

function IconButton({ label, children, onClick, active = false }) {
  return (
    <button
      className={`icon-button${active ? " is-active" : ""}`}
      type="button"
      aria-label={label}
      data-tooltip={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Metric({ icon, label, value, detail }) {
  return (
    <div className="metric">
      <div className="metric-label">
        {icon}
        <span>{label}</span>
      </div>
      <strong>{value}</strong>
      <span className="metric-detail">{detail}</span>
    </div>
  );
}

function RadarInsights({ radar, nowMs }) {
  const empty = !radar || !radar.categories || radar.categories.length === 0;
  if (empty) {
    return (
      <section className="data-section radar-section" aria-labelledby="radar-title">
        <div className="section-heading">
          <div>
            <h2 id="radar-title">站长推荐</h2>
            <p>加载中…</p>
          </div>
        </div>
        <div className="skeleton" style={{ height: 120, borderRadius: "var(--radius)" }} />
      </section>
    );
  }
  return (
    <section className="data-section radar-section" aria-labelledby="radar-title">
      <div className="section-heading">
        <div>
          <h2 id="radar-title">站长推荐</h2>
          <p>更新于 {formatRelativeTime(radar.generatedAt, nowMs)}</p>
        </div>
        <a className="radar-link" href="https://deng.codexradar.com/" target="_blank" rel="noopener noreferrer">codexradar ↗</a>
      </div>
      <div className="radar-grid">
        {radar.categories.map((cat) => (
          <div className="radar-col" key={cat.key}>
            <div className="radar-col-head">{cat.title}</div>
            <div className="radar-cells">
              {cat.models.map((model, idx) => (
                <div className="radar-cell" key={`${cat.key}-${idx}`}>
                  <div className="radar-model-row">
                    <span className="radar-model">
                      <span className={verClass(model.version)}>{model.version}</span>
                      {model.name && <span className={nameClass(model.name)}> {model.name}</span>}
                    </span>
                    <span className={`radar-effort ${effortClass(model.effort)}`}>{model.effort}</span>
                  </div>
                  <div className="radar-stats">
                    <span><b>{model.iq}</b><small>IQ</small></span>
                    <span><b>{formatDuration(model.durationMin)}</b><small>效率</small></span>
                    <span><b>${model.costUsd.toFixed(2)}</b><small>费用</small></span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function LoadingView() {
  return (
    <div className="loading-view" aria-label="正在读取用量">
      <div className="skeleton skeleton-title" />
      <div className="skeleton skeleton-value" />
      <div className="skeleton skeleton-line" />
      <div className="skeleton-grid">
        <div className="skeleton" />
        <div className="skeleton" />
        <div className="skeleton" />
      </div>
    </div>
  );
}

function ErrorView({ message, onRetry, onConfigure }) {
  return (
    <div className="error-view" role="alert">
      <WarningCircle size={24} weight="fill" />
      <h2>暂时无法读取用量</h2>
      <p>{message}</p>
      <div className="error-actions">
        <button type="button" onClick={onRetry}>重新查询</button>
        <button type="button" className="secondary" onClick={onConfigure}>打开设置</button>
      </div>
    </div>
  );
}

function TrendChart({ series, mode, unit }) {
  const availableCosts = series.points
    .map((point) => point.cost)
    .filter((value) => value !== null);
  const maxCost = Math.max(0.000001, ...availableCosts);
  const formatValue = (value) => {
    if (value === null) return "";
    return formatMoney(value, value < 1 ? 3 : 2, unit);
  };

  return (
    <div
      className={`trend-chart trend-chart-${mode}`}
      style={{ gridTemplateColumns: `repeat(${series.points.length}, minmax(0, 1fr))` }}
      role="img"
      aria-label={`${series.rangeLabel}的消费趋势`}
    >
      {series.points.map((point, index) => {
        const height = point.cost === null
          ? 0
          : point.cost > 0
            ? Math.max((point.cost / maxCost) * 100, 7)
            : 2;
        const showLabel = mode !== "days" || index === 0 || index === series.points.length - 1 || index % 3 === 0;
        const showValue = mode !== "days" && point.cost !== null;
        return (
          <div
            className={`trend-column${point.future ? " is-future" : ""}${point.current ? " is-current" : ""}${point.cost === 0 ? " is-zero" : ""}`}
            key={point.key}
          >
            <span className="trend-value">{showValue ? formatValue(point.cost) : ""}</span>
            <div className="trend-bar-wrap">
              <span className="trend-bar" style={{ "--bar-height": `${height}%` }} />
            </div>
            <span className={`trend-date${showLabel ? "" : " is-hidden"}`}>
              {point.label}
              {point.secondaryLabel && <small>{point.secondaryLabel}</small>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function UsageOverview({ usage, warning, trendMode, onTrendModeChange, todayKey, radar, nowMs }) {
  const money = (value, digits) => formatMoney(value, digits, usage.unit);
  const usedPercent = usage.quota.limit > 0
    ? (usage.quota.used / usage.quota.limit) * 100
    : 0;
  const remainingPercent = usage.quota.limit > 0
    ? (usage.quota.remaining / usage.quota.limit) * 100
    : 0;
  const trend = useMemo(
    () => buildTrendSeries(usage.days, trendMode, todayKey),
    [usage.days, trendMode, todayKey],
  );
  const maxModel = Math.max(0.000001, ...usage.models.map((model) => model.cost));
  const trendModes = [
    { id: "week", label: "本周" },
    { id: "days", label: "15 日" },
    { id: "weeks", label: "4 周" },
  ];

  return (
    <div className="tab-content" data-animate-panel>
      {warning && (
        <div className="runtime-warning" role="status">
          <WarningCircle size={15} weight="fill" />
          <span>{warning}</span>
        </div>
      )}

      <section className="balance-section" aria-labelledby="balance-title">
        <div className="balance-heading">
          <div>
            <p id="balance-title">剩余额度</p>
            <div className="balance-value">
              <span className="currency">$</span>
              <strong>{usage.quota.remaining.toFixed(2)}</strong>
            </div>
          </div>
          <div className="quota-summary">
            <span>总额度</span>
            <strong>{usage.quota.limit > 0 ? `${usage.quota.limit.toFixed(1)} / ${usage.quota.limit.toFixed(0)}` : "—"}</strong>
          </div>
        </div>
        <div className="quota-track" aria-label={`剩余 ${remainingPercent.toFixed(1)}%`}>
          <span style={{ width: `${Math.max(Math.min(remainingPercent, 100), remainingPercent > 0 ? 1.2 : 0)}%` }} />
        </div>
        <div className="quota-caption">
          <span>已用 {money(usage.quota.used, 4)}</span>
          <span>{remainingPercent.toFixed(1)}%</span>
        </div>
      </section>

      <section className="metrics-grid" aria-label="今日用量">
        <Metric
          icon={<Wallet size={15} weight="regular" />}
          label="今日消费"
          value={money(usage.today.cost, 4)}
          detail={`累计 ${money(usage.total.cost, 4)}`}
        />
        <Metric
          icon={<Pulse size={15} weight="regular" />}
          label="请求"
          value={usage.today.requests}
          detail={`累计 ${usage.total.requests} 次`}
        />
        <Metric
          icon={<ChartBar size={15} weight="regular" />}
          label="Token"
          value={compactNumber(usage.today.tokens)}
          detail={`累计 ${compactNumber(usage.total.tokens)}`}
        />
      </section>

      <RadarInsights radar={radar} nowMs={nowMs} />

      <section className="data-section trend-section" aria-labelledby="trend-title">
        <div className="section-heading">
          <div>
            <h2 id="trend-title">消费趋势</h2>
            <p>{trend.rangeLabel}</p>
          </div>
          <span className="section-total">{money(trend.total, 4)}</span>
        </div>
        <div className="trend-mode-control" role="group" aria-label="消费趋势统计范围">
          {trendModes.map((item) => (
            <button
              className={trendMode === item.id ? "is-selected" : ""}
              type="button"
              key={item.id}
              onClick={() => onTrendModeChange(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <TrendChart series={trend} mode={trendMode} unit={usage.unit} />
      </section>

      <section className="data-section model-section" aria-labelledby="model-title">
        <div className="section-heading">
          <div>
            <h2 id="model-title">模型消费</h2>
            <p>按实际费用排序</p>
          </div>
        </div>
        {usage.models.length > 0 ? (
          <div className="model-list">
            {usage.models.map((model) => (
              <div className="model-row" key={model.name}>
                <div className="model-copy">
                  <span>{model.name}</span>
                  <strong>{money(model.cost, 4)}</strong>
                </div>
                <div className="model-bar" aria-hidden="true">
                  <span style={{ width: `${(model.cost / maxModel) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="inline-empty">暂无模型消费记录</div>
        )}
      </section>
    </div>
  );
}

function KeysView({ usage, resetState, nowMs }) {
  const money = (value, digits) => formatMoney(value, digits, usage.unit);
  const monogram = usage.keyName.trim().charAt(0) || "K";
  const displayKeyName = usage.keyName.trim() || "未命名 API Key";

  return (
    <div className="tab-content" data-animate-panel>
      <section className="key-detail" aria-labelledby="key-detail-title">
        <div className="key-detail-header">
          <div className="key-avatar">{monogram}</div>
          <div>
            <h2 id="key-detail-title">{displayKeyName}</h2>
            <p>sk-••••••••••••••••</p>
          </div>
          <span className={`status-label${usage.status !== "active" ? " is-error" : ""}`}>
            {usage.status === "active" ? <CheckCircle size={14} weight="fill" /> : <WarningCircle size={14} weight="fill" />}
            {usage.status === "active" ? "有效" : "异常"}
          </span>
        </div>
        <dl className="definition-grid">
          <div><dt>模式</dt><dd>{usage.mode === "quota_limited" ? "额度限制" : "不限额"}</dd></div>
          <div><dt>单位</dt><dd>{usage.unit}</dd></div>
          <div><dt>已使用</dt><dd>{money(usage.quota.used, 4)}</dd></div>
          <div><dt>剩余额度</dt><dd>{money(usage.quota.remaining, 2)}</dd></div>
        </dl>
      </section>

      <section className="data-section" aria-labelledby="key-reset-title">
        <div className="section-heading">
          <div>
            <h2 id="key-reset-title">额度重置</h2>
            <p>{usage.rateLimits.length > 0 ? "按已配置的限额窗口" : "当前 Key 未配置自动重置窗口"}</p>
          </div>
        </div>
        {usage.rateLimits.length > 0 ? (
          <div className="reset-list">
            {usage.rateLimits.map((limit) => (
              <div className="reset-row" key={limit.window}>
                <strong>{limit.window}</strong>
                <span>{money(limit.used, 3)} / {money(limit.limit, 3)}</span>
                <time title={formatTimestamp(limit.resetAtMs)}>{formatRelativeReset(limit.resetAtMs, nowMs)}</time>
              </div>
            ))}
          </div>
        ) : (
          <div className="reset-empty">总额度只会在后台调整或人工重置时变化。</div>
        )}
        <div className="reset-observation">
          <span>检测到的累计额度重置</span>
          <strong>{resetState.lastDetectedAtMs ? formatTimestamp(resetState.lastDetectedAtMs) : "尚未检测到"}</strong>
        </div>
        {usage.expiresAtMs && (
          <div className="reset-observation">
            <span>Key 过期时间</span>
            <strong>{formatTimestamp(usage.expiresAtMs)}</strong>
          </div>
        )}
      </section>

      <section className="data-section" aria-labelledby="key-usage-title">
        <div className="section-heading">
          <div>
            <h2 id="key-usage-title">累计用量</h2>
            <p>当前 Key 的完整周期</p>
          </div>
        </div>
        <div className="usage-rows">
          <div><span>请求次数</span><strong>{usage.total.requests}</strong></div>
          <div><span>输入及输出 Token</span><strong>{compactNumber(usage.total.tokens)}</strong></div>
          <div><span>实际消费</span><strong>{money(usage.total.cost, 4)}</strong></div>
        </div>
      </section>
    </div>
  );
}

function SecureKeyInput({
  value,
  onChange,
  show,
  onToggle,
  placeholder,
  label,
  onSubmit,
  disabled,
}) {
  return (
    <div className="secure-input">
      <input
        type={show ? "text" : "password"}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !disabled) onSubmit();
        }}
      />
      <button
        type="button"
        aria-label={show ? `隐藏 ${label}` : `显示 ${label}`}
        data-tooltip={show ? `隐藏 ${label}` : `显示 ${label}`}
        onClick={onToggle}
      >
        {show ? <EyeSlash size={17} /> : <Eye size={17} />}
      </button>
    </div>
  );
}

function SettingsPanel({
  keyName,
  sourceInfo,
  onClose,
  onSave,
  onSaveApiKey,
  onRestoreCodexKey,
}) {
  const [interval, setIntervalValue] = useState(String(sourceInfo.refreshMinutes ?? 10));
  const [notifications, setNotifications] = useState(sourceInfo.notificationsEnabled ?? true);
  const [displayName, setDisplayName] = useState(keyName);
  const [baseUrl, setBaseUrlValue] = useState(sourceInfo.baseUrl ?? "");
  const [baseUrlDirty, setBaseUrlDirty] = useState(false);
  const [apiKey, setApiKeyValue] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [keySaving, setKeySaving] = useState(false);
  const [keyFeedback, setKeyFeedback] = useState(null);

  useEffect(() => {
    if (!baseUrlDirty) setBaseUrlValue(sourceInfo.baseUrl ?? "");
  }, [baseUrlDirty, sourceInfo.baseUrl]);

  const sourceLabel = sourceInfo.keySource === "secureStore"
    ? "当前使用系统凭据库中的自定义 Key"
    : sourceInfo.keySource === "codexAuth"
      ? "当前使用 Codex auth.json"
      : "当前未配置 API Key";

  const saveApiKey = async () => {
    if (!apiKey.trim() || keySaving) return;
    setKeySaving(true);
    setKeyFeedback(null);
    try {
      await onSaveApiKey(apiKey, baseUrl);
      setApiKeyValue("");
      setShowApiKey(false);
      setKeyFeedback({ type: "success", message: "API Key 已验证并安全保存" });
    } catch (message) {
      setKeyFeedback({ type: "error", message: String(message) });
    } finally {
      setKeySaving(false);
    }
  };

  const restoreCodexKey = async () => {
    if (keySaving) return;
    setKeySaving(true);
    setKeyFeedback(null);
    try {
      await onRestoreCodexKey();
      setApiKeyValue("");
      setKeyFeedback({
        type: "success",
        message: sourceInfo.codexKeyConfigured ? "已恢复使用 Codex auth.json" : "自定义 API Key 已移除",
      });
    } catch (message) {
      setKeyFeedback({ type: "error", message: String(message) });
    } finally {
      setKeySaving(false);
    }
  };

  return (
    <div className="settings-layer" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <button className="settings-backdrop" type="button" aria-label="关闭设置" onClick={onClose} />
      <div className="settings-sheet" data-settings-sheet>
        <div className="settings-header">
          <div>
            <h2 id="settings-title">面板设置</h2>
            <p>API Key 仅保存在系统凭据库。</p>
          </div>
          <IconButton label="关闭" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>

        <label className="field">
          <span>显示名称</span>
          <input value={displayName} placeholder="可留空" onChange={(event) => setDisplayName(event.target.value)} />
        </label>

        <div className="field api-key-field">
          <span>API Key</span>
          <SecureKeyInput
            value={apiKey}
            onChange={(value) => {
              setApiKeyValue(value);
              setKeyFeedback(null);
            }}
            show={showApiKey}
            onToggle={() => setShowApiKey((value) => !value)}
            placeholder={sourceInfo.keyConfigured ? "输入新 Key 以替换当前配置" : "输入 Sub2API Key"}
            label="API Key"
            onSubmit={saveApiKey}
            disabled={!apiKey.trim() || keySaving}
          />
          <div className="key-source-row">
            <span className={`key-source${sourceInfo.keyConfigured ? " is-configured" : ""}`}>{sourceLabel}</span>
            <button className="inline-command" type="button" disabled={!apiKey.trim() || keySaving} onClick={saveApiKey}>
              {keySaving ? "验证中" : "验证并使用"}
            </button>
          </div>
          {sourceInfo.customKeyConfigured && sourceInfo.codexKeyConfigured && (
            <button className="restore-command" type="button" disabled={keySaving} onClick={restoreCodexKey}>恢复 Codex Key</button>
          )}
          {keyFeedback && <p className={`key-feedback is-${keyFeedback.type}`} role="status">{keyFeedback.message}</p>}
        </div>

        <label className="field">
          <span>Sub2API 地址</span>
          <input
            type="url"
            value={baseUrl}
            placeholder="https://your-sub2api.example.com"
            autoComplete="url"
            spellCheck={false}
            onChange={(event) => {
              setBaseUrlDirty(true);
              setBaseUrlValue(event.target.value);
            }}
          />
          <small className="field-hint">
            {sourceInfo.customBaseUrlConfigured
              ? "当前使用自定义地址；留空后保存可恢复 Codex 配置"
              : "默认读取 Codex config.toml，可在此覆盖"}
          </small>
        </label>

        <div className="field">
          <span>自动刷新</span>
          <div className="interval-control" role="group" aria-label="自动刷新间隔">
            {["5", "10", "30"].map((value) => (
              <button className={interval === value ? "is-selected" : ""} type="button" key={value} onClick={() => setIntervalValue(value)}>
                {value} 分钟
              </button>
            ))}
          </div>
        </div>

        <div className="setting-row">
          <div>
            <strong>低额度提醒</strong>
            <span>低于 $20 时发送系统通知</span>
          </div>
          <button
            className={`switch${notifications ? " is-on" : ""}`}
            type="button"
            role="switch"
            aria-checked={notifications}
            aria-label="低额度提醒"
            onClick={() => setNotifications((value) => !value)}
          >
            <span />
          </button>
        </div>

        <button className="primary-button" type="button" onClick={() => onSave({ displayName: displayName.trim(), baseUrl: baseUrl.trim(), interval: Number(interval), notifications })}>
          保存设置
        </button>
      </div>
    </div>
  );
}


function OrbWindow({ usage, hasUsage, error, onOpenMain }) {
  const orbWindow = useMemo(() => getCurrentWindow(), []);
  const dragStartRef = useRef({ x: 0, y: 0, moved: false, dragging: false });
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const percent = quotaRemainingPercent(usage);
  const level = percent === null ? 0 : percent;
  const label = percent === null ? "—" : `${Math.round(percent)}%`;

  useEffect(() => {
    if (!hasUsage) return undefined;
    orbWindow.show().catch(() => {});
    return undefined;
  }, [hasUsage, orbWindow]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onClick, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onClick, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const liquidY = 100 - level;
  const isLow = level > 0 && level < 20;
  const liquidColor = isLow || error ? "#ff9f0a" : "#2c8be0";
  const liquidColor2 = isLow || error ? "#e67e00" : "#1c6fc7";
  const liquidColorTop = isLow || error ? "#ffc94d" : "#6cb4e8";

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    dragStartRef.current = { x: e.clientX, y: e.clientY, moved: false, dragging: true };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = async (e) => {
    const s = dragStartRef.current;
    if (!s.dragging) return;
    if (!s.moved) {
      if (Math.abs(e.clientX - s.x) > 4 || Math.abs(e.clientY - s.y) > 4) s.moved = true;
    }
    if (s.moved) {
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;
      s.x = e.clientX;
      s.y = e.clientY;
      try {
        await moveOrbWindow(dx, dy);
      } catch (err) {
        console.error("[orb] moveOrbWindow failed:", err);
      }
    }
  };

  const onPointerUp = async () => {
    const wasMoved = dragStartRef.current.moved;
    dragStartRef.current.dragging = false;
    if (!wasMoved && !menuOpen) {
      console.log("[orb] 左键单击 → openMain");
      try {
        await onOpenMain();
      } catch (err) {
        console.error("[orb] onOpenMain 失败:", err);
      }
    } else if (wasMoved) {
      console.log("[orb] 拖拽结束，不打开主面板");
    }
  };

  const onContextMenu = (e) => {
    console.log("[orb] 右键 → 切换菜单");
    e.preventDefault();
    dragStartRef.current.dragging = false;
    setMenuOpen((cur) => !cur);
  };

  const closeMenu = () => setMenuOpen(false);

  const openMainFromMenu = async () => {
    console.log("[orb] 菜单: 打开主面板");
    closeMenu();
    try { await onOpenMain(); } catch (err) { console.error("[orb] openMain 失败:", err); }
  };
  const openSettingsFromMenu = async () => {
    console.log("[orb] 菜单: 设置");
    closeMenu();
    try { await orbOpenSettings(); } catch (err) { console.error("[orb] openSettings 失败:", err); }
  };
  const refreshFromMenu = async () => {
    console.log("[orb] 菜单: 立即刷新");
    closeMenu();
    try { await refreshUsage(); } catch (err) { console.error("[orb] refresh 失败:", err); }
  };
  const hideOrbFromMenu = async () => {
    console.log("[orb] 菜单: 关闭悬浮球");
    closeMenu();
    try { await orbHide(); } catch (err) { console.error("[orb] hide 失败:", err); }
  };

  return (
    <main className="orb-window-root" data-error={error ? "true" : "false"}>
      <div
        className="orb-window-button"
        data-low={isLow ? "true" : "false"}
        role="button"
        tabIndex={0}
        aria-label="打开 Sub2API 用量面板"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={onContextMenu}
      >
        <svg viewBox="0 0 100 100" className="orb-window-svg" width="72" height="72" aria-hidden="true">
          <defs>
            <clipPath id="orbClip">
              <circle cx="50" cy="50" r="49" />
            </clipPath>
            <linearGradient id="liquidGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={liquidColorTop} />
              <stop offset="60%" stopColor={liquidColor} />
              <stop offset="100%" stopColor={liquidColor2} />
            </linearGradient>
            <radialGradient id="shineGrad" cx="30%" cy="22%" r="55%">
              <stop offset="0%" stopColor="rgba(255,255,255,0.72)" />
              <stop offset="45%" stopColor="rgba(255,255,255,0.1)" />
              <stop offset="100%" stopColor="rgba(255,255,255,0)" />
            </radialGradient>
          </defs>

          <g clipPath="url(#orbClip)">
            <rect x="0" y={liquidY} width="100" height={100 - liquidY} fill="url(#liquidGrad)" />
            <path
              d={`M 0 ${liquidY} Q 12.5 ${liquidY - 2.5} 25 ${liquidY} T 50 ${liquidY} T 75 ${liquidY} T 100 ${liquidY} L 100 ${liquidY + 4} L 0 ${liquidY + 4} Z`}
              fill="rgba(255,255,255,0.35)"
            >
              <animate attributeName="d"
                values={`M 0 ${liquidY} Q 12.5 ${liquidY - 2.5} 25 ${liquidY} T 50 ${liquidY} T 75 ${liquidY} T 100 ${liquidY} L 100 ${liquidY + 4} L 0 ${liquidY + 4} Z;
                        M 0 ${liquidY} Q 12.5 ${liquidY + 2.5} 25 ${liquidY} T 50 ${liquidY} T 75 ${liquidY} T 100 ${liquidY} L 100 ${liquidY + 4} L 0 ${liquidY + 4} Z;
                        M 0 ${liquidY} Q 12.5 ${liquidY - 2.5} 25 ${liquidY} T 50 ${liquidY} T 75 ${liquidY} T 100 ${liquidY} L 100 ${liquidY + 4} L 0 ${liquidY + 4} Z`}
                dur="3.2s" repeatCount="indefinite" />
            </path>
            <path
              d={`M 0 ${liquidY + 1.5} Q 16 ${liquidY - 1} 32 ${liquidY + 1.5} T 64 ${liquidY + 1.5} T 100 ${liquidY + 1.5} L 100 ${liquidY + 5} L 0 ${liquidY + 5} Z`}
              fill="rgba(255,255,255,0.22)"
            >
              <animate attributeName="d"
                values={`M 0 ${liquidY + 1.5} Q 16 ${liquidY - 1} 32 ${liquidY + 1.5} T 64 ${liquidY + 1.5} T 100 ${liquidY + 1.5} L 100 ${liquidY + 5} L 0 ${liquidY + 5} Z;
                        M 0 ${liquidY + 1.5} Q 16 ${liquidY + 3.5} 32 ${liquidY + 1.5} T 64 ${liquidY + 1.5} T 100 ${liquidY + 1.5} L 100 ${liquidY + 5} L 0 ${liquidY + 5} Z;
                        M 0 ${liquidY + 1.5} Q 16 ${liquidY - 1} 32 ${liquidY + 1.5} T 64 ${liquidY + 1.5} T 100 ${liquidY + 1.5} L 100 ${liquidY + 5} L 0 ${liquidY + 5} Z`}
                dur="4.4s" repeatCount="indefinite" />
            </path>
            <circle cx="30" cy={88} r="1.8" fill="rgba(255,255,255,0.65)">
              <animate attributeName="cy" values={`${88};${68};${88}`} dur="4.6s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.7;1;0.7" dur="4.6s" repeatCount="indefinite" />
            </circle>
            <circle cx="44" cy={92} r="1.2" fill="rgba(255,255,255,0.45)">
              <animate attributeName="cy" values={`${92};${72};${92}`} dur="3.8s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.5;0.9;0.5" dur="3.8s" repeatCount="indefinite" />
            </circle>
            <circle cx="56" cy={90} r="1" fill="rgba(255,255,255,0.4)">
              <animate attributeName="cy" values={`${90};${74};${90}`} dur="5.2s" repeatCount="indefinite" />
            </circle>
          </g>

          <circle cx="50" cy="50" r="49" fill="url(#shineGrad)" />
          <circle cx="50" cy="50" r="48.5" fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="1.5" />
          <text x="50" y="50" textAnchor="middle" dominantBaseline="central"
            fontSize="20" fontWeight="700" fill="#ffffff"
            style={{ fontFamily: "system-ui,-apple-system,Segoe UI,sans-serif", letterSpacing: "-0.02em", paintOrder: "stroke fill" }}
            stroke="#0a2540" strokeWidth="3.5" strokeLinejoin="round" strokeLinecap="round"
            filter="url(#orbTextShadow)">
            {label}
          </text>
          <filter id="orbTextShadow" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="0" dy="1" stdDeviation="0.5" floodColor="#0a2540" floodOpacity="0.5" />
          </filter>
        </svg>
      </div>

      {menuOpen && (
        <div className="orb-window-menu" ref={menuRef} role="menu" aria-label="悬浮球菜单">
          <button type="button" role="menuitem" className="orb-menu-item" onClick={openMainFromMenu}>
            <Eye size={14} /> <span>打开主面板</span>
          </button>
          <button type="button" role="menuitem" className="orb-menu-item" onClick={openSettingsFromMenu}>
            <GearSix size={14} /> <span>设置</span>
          </button>
          <button type="button" role="menuitem" className="orb-menu-item" onClick={refreshFromMenu}>
            <ArrowClockwise size={14} /> <span>立即刷新</span>
          </button>
          <div className="orb-menu-sep" />
          <button type="button" role="menuitem" className="orb-menu-item orb-menu-item-danger" onClick={hideOrbFromMenu}>
            <X size={14} /> <span>关闭悬浮球</span>
          </button>
        </div>
      )}
    </main>
  );
}


export default function App() {
  const rootRef = useRef(null);
  const refreshIconRef = useRef(null);
  const spinTweenRef = useRef(null);
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem("sub2api-theme");
    return ["light", "dark", "system"].includes(saved) ? saved : "light";
  });

  useEffect(() => {
    localStorage.setItem("sub2api-theme", theme);
    const applyTheme = () => {
      const isDark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
    };
    applyTheme();
    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = () => applyTheme();
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
  }, [theme]);
  const [tab, setTab] = useState("overview");
  const [trendMode, setTrendMode] = useState("week");
  const [refreshing, setRefreshing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 同步检测 window.__TAURI_INTERNALS__，首次渲染即可正确判断
  const runningInTauri = runningInTauriSync();
  const [usage, setUsage] = useState(() => {
    const savedName = localStorage.getItem("sub2api-key-name");
    const initial = runningInTauri ? emptyUsage : mockUsage;
    return savedName ? { ...initial, keyName: savedName } : initial;
  });
  const usageRef = useRef(usage);
  const [sourceInfo, setSourceInfo] = useState({
    baseUrl: runningInTauri ? null : "http://10.255.240.106:9019",
    providerName: runningInTauri ? null : "浏览器预览",
    refreshMinutes: 10,
    notificationsEnabled: true,
    keyConfigured: !runningInTauri,
    codexKeyConfigured: false,
    customKeyConfigured: false,
    customBaseUrlConfigured: false,
    keySource: runningInTauri ? "none" : "codexAuth",
  });
  const [keyResetState, setKeyResetState] = useState(() => readLocalState(KEY_RESET_STORAGE, {}));
  const keyResetRef = useRef(keyResetState);
  const [hasUsage, setHasUsage] = useState(!runningInTauri);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(runningInTauri ? "等待首次查询" : "刚刚");
  const [nowMs, setNowMs] = useState(Date.now());
  const [radar, setRadar] = useState(radarInitial);
  const todayKey = dateKeyInTimezone(new Date(nowMs));
  const isOrbWindow = (() => {
    try { return runningInTauri && getCurrentWindow().label === "orb"; }
    catch { return false; }
  })();

  const replaceUsage = (updater) => {
    setUsage((current) => {
      const next = typeof updater === "function" ? updater(current) : updater;
      usageRef.current = next;
      return next;
    });
  };

  const applyEnvelope = (envelope) => {
    if (!envelope) return;
    const next = normalizeEnvelope(envelope, usageRef.current);
    replaceUsage(next);
    const nextKeyState = updateKeyResetState(keyResetRef.current, next, next.fetchedAtMs);
    keyResetRef.current = nextKeyState;
    setKeyResetState(nextKeyState);
    saveLocalState(KEY_RESET_STORAGE, nextKeyState);
    setHasUsage(true);
    setError(null);
    setLastUpdated("刚刚");
  };

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);

  // 站长推荐：从 dradar 服务端获取真实数据
  // Tauri 环境走 Rust 后端（绕开 WebView CORS/CSP 限制）
  // dev 环境走 vite proxy
  const refreshRadar = async () => {
    try {
      let data;
      if (runningInTauri) {
        data = await fetchRadar();
      } else {
        const res = await fetch(RADAR_API_URL);
        if (!res.ok) return;
        data = await res.json();
      }
      const normalized = normalizeRadar(data);
      if (normalized) setRadar(normalized);
    } catch {
      // 静默失败，保留上次数据或空状态
    }
  };

  useEffect(() => {
    refreshRadar();
    const timer = window.setInterval(refreshRadar, 5 * 60 * 1000); // 每 5 分钟刷新
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!runningInTauri) return undefined;

    let disposed = false;
    const unlistenCallbacks = [];
    const initialize = async () => {
      const stopUpdated = await onUsageUpdated((envelope) => {
        if (!disposed) applyEnvelope(envelope);
      });
      if (disposed) stopUpdated();
      else unlistenCallbacks.push(stopUpdated);

      const stopError = await onUsageError((message) => {
        if (!disposed) setError(message);
      });
      if (disposed) stopError();
      else unlistenCallbacks.push(stopError);

      // 非 orb 窗口才需要响应打开设置面板事件
      if (!isOrbWindow) {
        const stopSettings = await onOpenSettings(() => {
          if (!disposed) setSettingsOpen(true);
        });
        if (disposed) stopSettings();
        else unlistenCallbacks.push(stopSettings);
      }

      if (isOrbWindow) {
        try {
          const cached = await getCachedUsage();
          if (cached && !disposed) applyEnvelope(cached);
        } catch (message) {
          if (!disposed) setError(String(message));
        }
        return;
      }

      try {
        const savedInterval = Number(localStorage.getItem("sub2api-refresh-minutes"));
        const savedNotifications = localStorage.getItem("sub2api-notifications") === "true";
        if ([5, 10, 30].includes(savedInterval)) await setRefreshInterval(savedInterval);
        if (savedNotifications && await ensureNotificationPermission()) await setNotificationEnabled(true);

        const info = await getSourceInfo();
        if (!disposed) setSourceInfo(info);
        const cached = await getCachedUsage();
        if (cached) {
          if (!disposed) applyEnvelope(cached);
        } else {
          const fresh = await refreshUsage();
          if (!disposed) applyEnvelope(fresh);
        }
        if (!info.keyConfigured && !disposed) setSettingsOpen(true);
      } catch (message) {
        if (!disposed) setError(String(message));
      }
    };

    initialize();
    return () => {
      disposed = true;
      unlistenCallbacks.forEach((unlisten) => unlisten());
    };
  }, []);

  useLayoutEffect(() => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) return undefined;
    const context = gsap.context(() => {
      gsap.from("[data-animate-header]", { opacity: 0, y: -8, duration: 0.35, ease: "power3.out" });
      gsap.from("[data-animate-panel] > *", { opacity: 0, y: 10, duration: 0.4, stagger: 0.04, ease: "power3.out" });
    }, rootRef);
    return () => context.revert();
  }, [tab, hasUsage]);

  useLayoutEffect(() => {
    if (!settingsOpen || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return undefined;
    const context = gsap.context(() => {
      gsap.from("[data-settings-sheet]", { yPercent: 10, opacity: 0, duration: 0.28, ease: "power3.out" });
    }, rootRef);
    return () => context.revert();
  }, [settingsOpen]);

  const stopRefreshAnimation = () => {
    spinTweenRef.current?.kill();
    spinTweenRef.current = null;
    if (refreshIconRef.current) gsap.set(refreshIconRef.current, { rotate: 0 });
  };

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setError(null);
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      spinTweenRef.current = gsap.to(refreshIconRef.current, { rotate: 360, duration: 0.7, repeat: -1, ease: "none" });
    }
    try {
      if (runningInTauri) applyEnvelope(await refreshUsage());
      else {
        await new Promise((resolve) => window.setTimeout(resolve, 450));
        applyEnvelope({ fetchedAtMs: Date.now(), usage: mockUsage });
      }
    } catch (message) {
      setError(String(message));
    } finally {
      stopRefreshAnimation();
      setRefreshing(false);
    }
  };

  const saveSettings = async ({ displayName, baseUrl, interval, notifications }) => {
    localStorage.setItem("sub2api-key-name", displayName);
    replaceUsage((current) => ({ ...current, keyName: displayName }));
    setSourceInfo((current) => ({ ...current, refreshMinutes: interval, notificationsEnabled: notifications }));
    if (runningInTauri) {
      try {
        await setBaseUrl(baseUrl);
        if (notifications && !(await ensureNotificationPermission())) throw new Error("系统通知权限未开启");
        await setRefreshInterval(interval);
        await setNotificationEnabled(notifications);
        const info = await getSourceInfo();
        setSourceInfo(info);
        if (info.keyConfigured) applyEnvelope(await refreshUsage());
      } catch (message) {
        setError(String(message));
        return;
      }
    }
    localStorage.setItem("sub2api-refresh-minutes", String(interval));
    localStorage.setItem("sub2api-notifications", String(notifications));
    setSettingsOpen(false);
  };

  const saveApiKeyOverride = async (apiKey, baseUrl) => {
    if (!runningInTauri) {
      setSourceInfo((current) => ({ ...current, keyConfigured: true, customKeyConfigured: true, keySource: "secureStore" }));
      return;
    }
    applyEnvelope(await setApiKey(apiKey, baseUrl));
    setSourceInfo(await getSourceInfo());
  };

  const restoreCodexKey = async () => {
    if (!runningInTauri) {
      setSourceInfo((current) => ({ ...current, customKeyConfigured: false, keySource: current.codexKeyConfigured ? "codexAuth" : "none", keyConfigured: current.codexKeyConfigured }));
      return;
    }
    applyEnvelope(await clearApiKeyOverride());
    setSourceInfo(await getSourceInfo());
  };

  const monogram = usage.keyName.trim().charAt(0) || "K";
  const displayKeyName = usage.keyName.trim() || "未命名 API Key";
  const serviceLabel = error ? "查询异常" : hasUsage ? "服务正常" : "正在读取";
  const keySourceLabel = sourceInfo.keySource === "secureStore"
    ? "自定义 Key · 系统安全存储"
    : sourceInfo.keySource === "codexAuth"
      ? "读取自 Codex auth.json"
      : "未配置，点击输入";

  if (isOrbWindow) {
    return (
      <OrbWindow
        usage={usage}
        hasUsage={hasUsage}
        error={error}
        onOpenMain={showMainWindow}
      />
    );
  }

  const effectiveTheme = theme === "system"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : theme;

  return (
    <main className="preview-stage" data-theme={effectiveTheme} ref={rootRef}>
      <section className="extension-panel" aria-label="Sub2API 用量面板">
        <header className="app-header" data-animate-header>
          <div className="brand-copy">
            <h1>用量</h1>
            <span className={error ? "is-error" : ""}>{serviceLabel}</span>
          </div>
          <div className="header-actions">
            <div className="theme-toggle" role="group" aria-label="外观">
              <button type="button" aria-pressed={theme === "system"} onClick={() => setTheme("system")}>系统</button>
              <button type="button" aria-pressed={theme === "light"} onClick={() => setTheme("light")}>浅</button>
              <button type="button" aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}>深</button>
            </div>
            <IconButton label="刷新用量" onClick={refresh} active={refreshing}>
              <span ref={refreshIconRef} className="refresh-icon"><ArrowClockwise size={18} /></span>
            </IconButton>
            <IconButton label="设置" onClick={() => setSettingsOpen(true)}><GearSix size={18} /></IconButton>
            <IconButton
              label="最小化"
              onClick={async () => {
                try { await minimizeCurrentWindow(); }
                catch (err) { console.error("[minimize-btn]", err); }
              }}
            ><Minus size={18} /></IconButton>
          </div>
        </header>

        <div className="key-selector">
          <button type="button" aria-label="配置 API Key" onClick={() => setSettingsOpen(true)}>
            <span className="key-monogram">{monogram}</span>
            <span className="selector-copy">
              <strong>{displayKeyName}</strong>
              <small>{runningInTauri ? keySourceLabel : "浏览器样例数据"}</small>
            </span>
            <CaretDown size={16} />
          </button>
        </div>

        <nav className="tabs" aria-label="用量视图">
          <button className={tab === "overview" ? "is-active" : ""} type="button" onClick={() => setTab("overview")}>概览</button>
          <button className={tab === "keys" ? "is-active" : ""} type="button" onClick={() => setTab("keys")}>API Key</button>
        </nav>

        <div className="content-scroll">
          {!hasUsage && !error && <LoadingView />}
          {!hasUsage && error && <ErrorView message={error} onRetry={refresh} onConfigure={() => setSettingsOpen(true)} />}
          {hasUsage && tab === "overview" && (
            <UsageOverview usage={usage} warning={error} trendMode={trendMode} onTrendModeChange={setTrendMode} todayKey={todayKey} radar={radar} nowMs={nowMs} />
          )}
          {hasUsage && tab === "keys" && <KeysView usage={usage} resetState={keyResetState} nowMs={nowMs} />}
        </div>

        <footer className="app-footer">
          <span>每 {sourceInfo.refreshMinutes ?? 10} 分钟自动刷新</span>
          <span>更新于 {lastUpdated}</span>
        </footer>

        {settingsOpen && (
          <SettingsPanel
            keyName={usage.keyName}
            sourceInfo={sourceInfo}
            onClose={() => setSettingsOpen(false)}
            onSave={saveSettings}
            onSaveApiKey={saveApiKeyOverride}
            onRestoreCodexKey={restoreCodexKey}
          />
        )}
      </section>
    </main>
  );
}