import { useEffect, useRef } from "react";
import { GearSix } from "@phosphor-icons/react";
import "./appUpdates.css";

const busyStates = ["checking", "downloading", "installing", "restarting"];
const sizeText = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export default function AppUpdatePanel({ updater, focusOnMount = false }) {
  const { state, check, install } = updater;
  const sectionRef = useRef(null);
  useEffect(() => {
    if (!focusOnMount) return;
    sectionRef.current?.scrollIntoView({ block: "nearest" });
    sectionRef.current?.focus({ preventScroll: true });
  }, [focusOnMount]);
  const busy = busyStates.includes(state.status) || state.errorKind === "restart";
  const percent = state.totalBytes > 0 ? Math.min(100, Math.floor(state.downloadedBytes / state.totalBytes * 100)) : null;
  const labels = {
    idle: "可手动检查新版本", checking: "正在检查更新…", current: "已是最新版本",
    available: `发现新版本 ${state.version}`, downloading: percent === null ? "正在下载更新…" : `正在下载 ${percent}%`,
    installing: "校验并安装更新，即将退出应用…", restarting: "更新已安装，正在重新打开…",
    unsupported: "自动更新适用于 Windows 安装版", error: state.error,
  };
  return (
    <section ref={sectionRef} tabIndex={-1} className="app-update-section" aria-labelledby="app-update-title">
      <div className="app-update-heading"><h3 id="app-update-title">应用更新</h3><span>当前版本 {state.currentVersion || "读取中"}</span></div>
      <p className={`app-update-status${state.status === "error" ? " is-error" : ""}`} role="status">{labels[state.status]}</p>
      {state.version && <div className="app-update-release">
        <strong>版本 {state.version}</strong>
        <p>{state.notes || "此版本包含功能改进和问题修复。"}</p>
      </div>}
      {state.status === "downloading" && <div className="app-update-progress">
        <progress aria-label="更新下载进度" max={state.totalBytes || undefined} value={state.totalBytes ? state.downloadedBytes : undefined} />
        <span>{sizeText(state.downloadedBytes)}{state.totalBytes ? ` / ${sizeText(state.totalBytes)}` : ""}</span>
      </div>}
      <div className="app-update-actions">
        <button type="button" className="secondary" disabled={!state.supported || busy} onClick={() => { void check(); }}>
          {state.status === "checking" ? "检查中…" : state.status === "error" ? "重新检查" : "检查更新"}
        </button>
        {state.canInstall && <button type="button" className="primary-button" onClick={() => { void install(); }}>下载并安装</button>}
      </div>
      {state.canInstall && <p className="app-update-hint">安装时会退出应用，完成后重新打开。请先保存面板设置。</p>}
    </section>
  );
}

function updateAttention(state) {
  if (!state.supported) return null;
  if (state.errorKind === "restart") {
    return { kind: "installed", message: "更新已安装，请重新打开应用", action: "查看详情", label: "设置，更新已安装，请重新打开应用" };
  }
  if (state.version && (state.canInstall || ["available", ...busyStates].includes(state.status))) {
    const message = state.status === "downloading" ? `正在下载新版本 ${state.version}`
      : ["installing", "restarting"].includes(state.status) ? `正在安装新版本 ${state.version}`
      : `新版本 ${state.version} 可用`;
    return { kind: "available", message, action: "查看更新", label: `设置，有新版本 ${state.version}` };
  }
  return state.status === "error"
    ? { kind: "error", message: "更新检查未完成", action: "重试", label: "设置，更新检查未完成" }
    : null;
}

export function AppUpdateSettingsButton({ updater, onOpen }) {
  const attention = updateAttention(updater.state);
  const label = attention?.label ?? "设置";
  return <button type="button" className="icon-button app-update-settings" aria-label={label} data-tooltip={label}
    onClick={() => onOpen(attention ? "updates" : "general")}>
    <GearSix size={18} />
    {attention && <span className={`app-update-badge is-${attention.kind}`} aria-hidden="true" />}
  </button>;
}

export function AppUpdateNotice({ updater, onOpen }) {
  const attention = updateAttention(updater.state);
  if (!attention) return null;
  return <div className={`app-update-notice is-${attention.kind}`} role="status">
    <button type="button" onClick={() => {
      onOpen();
      if (attention.kind === "error") void updater.check();
    }}>
      <span>{attention.message}</span><span>{attention.action} ›</span>
    </button>
  </div>;
}
