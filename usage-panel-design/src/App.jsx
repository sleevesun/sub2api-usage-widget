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
import RadarBench from "./RadarBench.jsx";
import useRadarBench from "./useRadarBench";
import OrbVisual, { describeOrb } from "./OrbVisual.jsx";
import WindowResizeHandles from "./WindowResizeHandles.jsx";
import WindowHeader from "./WindowHeader.jsx";
import { loadInitialUsage } from "./usageStartup.js";
import { buildTrendSeries, dateKeyInTimezone, getUsagePeriod, USAGE_PERIOD_MODES } from "./usagePeriod.js";
import { normalizeModelStats } from "./modelUsage.js";
import { createPreviewUsage } from "./previewUsage.js";
import ModelUsage from "./ModelUsage.jsx";
import AppUpdatePanel, { AppUpdateNotice } from "./AppUpdatePanel.jsx";
import useAppUpdates from "./useAppUpdates.js";

export { buildTrendSeries } from "./usagePeriod.js";

const APP_TIME_ZONE = "Asia/Shanghai";
const KEY_RESET_STORAGE = "sub2api-key-reset-state";

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

const mockUsage = createPreviewUsage();

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
  const dailyUsage = raw.daily_usage ?? raw.dailyUsage ?? raw.days ?? [];
  const modelStats = raw.model_stats ?? raw.modelStats ?? raw.models ?? [];
  const quota = raw.quota ?? {};
  const today = raw.today ?? raw.today_usage ?? usageStats.today ?? {};
  const total = raw.total ?? raw.total_usage ?? usageStats.total ?? {};
  const rawRateLimits = raw.rate_limits ?? raw.rateLimits ?? [];
  const quotaLimit = numberValue(quota.limit, raw.limit);
  const fetchedAtMs = timestampToMs(wrapped.fetchedAtMs ?? wrapped.fetched_at_ms) ?? Date.now();
  const normalizedToday = {
    requests: numberValue(today.requests),
    tokens: numberValue(today.total_tokens, today.totalTokens, today.tokens),
    cost: numberValue(today.actual_cost, today.actualCost, today.cost),
  };
  const days = Array.isArray(dailyUsage)
    ? dailyUsage.map((day) => ({
        date: normalizeDateKey(day.date ?? day.day),
        cost: numberValue(day.actual_cost, day.actualCost, day.cost),
        requests: numberValue(day.requests),
        tokens: numberValue(day.total_tokens, day.totalTokens, day.tokens),
      })).filter((day) => day.date)
    : [];
  const snapshotDay = dateKeyInTimezone(new Date(fetchedAtMs));
  if ((raw.today ?? raw.today_usage ?? usageStats.today) && !days.some((day) => day.date === snapshotDay)) {
    days.push({ date: snapshotDay, ...normalizedToday });
  }

  return {
    keyName: currentUsage.keyName,
    status: raw.status ?? (raw.isValid === false ? "invalid" : "active"),
    mode: raw.mode ?? (quotaLimit > 0 ? "quota_limited" : "unrestricted"),
    unit: raw.unit ?? quota.unit ?? "USD",
    quota: {
      limit: quotaLimit,
      used: numberValue(quota.used, raw.used),
      remaining: numberValue(quota.remaining, raw.remaining),
    },
    today: normalizedToday,
    total: {
      requests: numberValue(total.requests),
      tokens: numberValue(total.total_tokens, total.totalTokens, total.tokens),
      cost: numberValue(total.actual_cost, total.actualCost, total.cost, quota.used),
    },
    days,
    models: normalizeModelStats(modelStats),
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
    fetchedAtMs,
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

function UsageOverview({ usage, warning, trendMode, onTrendModeChange, todayKey, bench, nowMs, native, modelRevision }) {
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
  const period = useMemo(() => getUsagePeriod(trendMode, todayKey), [trendMode, todayKey]);

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

      <RadarBench bench={bench} nowMs={nowMs} />

      <section className="data-section trend-section" aria-labelledby="trend-title">
        <div className="section-heading">
          <div>
            <h2 id="trend-title">消费趋势</h2>
            <p>{trend.rangeLabel}</p>
          </div>
          <span className="section-total">{money(trend.total, 4)}</span>
        </div>
        <div className="trend-mode-control" role="group" aria-label="消费趋势统计范围">
          {USAGE_PERIOD_MODES.map((item) => (
            <button
              className={trendMode === item.id ? "is-selected" : ""}
              type="button"
              key={item.id}
              aria-pressed={trendMode === item.id}
              onClick={() => onTrendModeChange(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <TrendChart series={trend} mode={trendMode} unit={usage.unit} />
      </section>

      <ModelUsage period={period} revision={modelRevision} native={native} unit={usage.unit} previewFetchedAtMs={usage.fetchedAtMs} />
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
  updater,
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
        <AppUpdatePanel updater={updater} />
      </div>
    </div>
  );
}


function OrbWindow({ usage, hasUsage, error, onOpenMain }) {
  const orbWindow = useMemo(() => getCurrentWindow(), []);
  const dragStartRef = useRef({ x: 0, y: 0, moved: false, dragging: false });
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const orbProps = { percent: quotaRemainingPercent(usage), mode: usage.mode, hasUsage, error };
  const orb = describeOrb(orbProps);

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
        data-low={orb.isLow ? "true" : "false"}
        role="button"
        tabIndex={0}
        aria-label={`打开 Sub2API 用量面板；${orb.description}`}
        title={orb.description}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={onContextMenu}
      >
        <OrbVisual {...orbProps} />
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
    baseUrl: runningInTauri ? null : "https://sub2api.example.com",
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
  const todayKey = dateKeyInTimezone(new Date(nowMs));
  const isOrbWindow = (() => {
    try { return runningInTauri && getCurrentWindow().label === "orb"; }
    catch { return false; }
  })();
  const bench = useRadarBench({ enabled: !isOrbWindow, refreshMinutes: sourceInfo.refreshMinutes });
  const updater = useAppUpdates({ enabled: !isOrbWindow });

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
          const initial = await loadInitialUsage(getCachedUsage, refreshUsage);
          if (!disposed) applyEnvelope(initial);
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
        const initial = await loadInitialUsage(getCachedUsage, refreshUsage);
        if (!disposed) applyEnvelope(initial);
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
    void bench.refresh();
    setRefreshing(true);
    setError(null);
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      spinTweenRef.current = gsap.to(refreshIconRef.current, { rotate: 360, duration: 0.7, repeat: -1, ease: "none" });
    }
    try {
      if (runningInTauri) applyEnvelope(await refreshUsage());
      else {
        await new Promise((resolve) => window.setTimeout(resolve, 450));
        applyEnvelope({ fetchedAtMs: Date.now(), usage: createPreviewUsage() });
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
        <WindowResizeHandles />
        <WindowHeader>
          <div className="brand-copy">
            <h1>用量</h1>
            <span className={error ? "is-error" : ""}>{serviceLabel}</span>
          </div>
          <div className="header-actions" data-no-window-drag>
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
              label="收起面板"
              onClick={async () => {
                try { await minimizeCurrentWindow(); }
                catch (err) { console.error("[minimize-btn]", err); }
              }}
            ><Minus size={18} /></IconButton>
          </div>
        </WindowHeader>

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
        <AppUpdateNotice updater={updater} onOpen={() => setSettingsOpen(true)} />

        <div className="content-scroll">
          {!hasUsage && !error && <LoadingView />}
          {!hasUsage && error && <ErrorView message={error} onRetry={refresh} onConfigure={() => setSettingsOpen(true)} />}
          {hasUsage && tab === "overview" && (
            <UsageOverview usage={usage} warning={error} trendMode={trendMode} onTrendModeChange={setTrendMode} todayKey={todayKey} bench={bench} nowMs={nowMs}
              native={runningInTauri} modelRevision={`${usage.fetchedAtMs}:${sourceInfo.baseUrl}:${sourceInfo.keySource}`} />
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
            updater={updater}
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
