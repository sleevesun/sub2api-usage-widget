import "./appUpdates.css";

const busyStates = ["checking", "downloading", "installing", "restarting"];
const sizeText = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export default function AppUpdatePanel({ updater }) {
  const { state, check, install } = updater;
  const busy = busyStates.includes(state.status);
  const percent = state.totalBytes > 0 ? Math.min(100, Math.floor(state.downloadedBytes / state.totalBytes * 100)) : null;
  const labels = {
    idle: "可手动检查新版本", checking: "正在检查更新…", current: "已是最新版本",
    available: `发现新版本 ${state.version}`, downloading: percent === null ? "正在下载更新…" : `正在下载 ${percent}%`,
    installing: "校验并安装更新，即将退出应用…", restarting: "更新已安装，正在重新打开…",
    unsupported: "自动更新适用于 Windows 安装版", error: state.error,
  };
  return (
    <section className="app-update-section" aria-labelledby="app-update-title">
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

export function AppUpdateNotice({ updater, onOpen }) {
  const { state } = updater;
  if (!state.version || !["available", "downloading", "installing", "restarting"].includes(state.status)) return null;
  return <button type="button" className="app-update-notice" onClick={onOpen}>
    <span>{state.status === "available" ? `新版本 ${state.version} 可用` : state.status === "downloading" ? "正在下载应用更新" : "正在安装应用更新"}</span>
    <span>查看 ›</span>
  </button>;
}
