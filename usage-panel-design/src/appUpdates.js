export function createAppUpdater({ getInfo, check, restart }) {
  let state = {
    status: "idle", currentVersion: "", supported: false,
    version: null, notes: "", date: null, canInstall: false,
    downloadedBytes: 0, totalBytes: null, error: null,
  };
  let initialization;
  let operation;
  let update;
  const listeners = new Set();
  const publish = (patch) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  const initialize = () => {
    initialization ??= Promise.resolve().then(getInfo).then((info) => {
      publish({ currentVersion: info.version, supported: info.supported, status: info.supported ? "idle" : "unsupported" });
    }).catch(() => {
      initialization = undefined;
      publish({ status: "error", error: "无法读取当前版本，请重新打开应用后重试。" });
    });
    return initialization;
  };
  const checking = async () => {
    await initialize();
    if (!state.supported || ["downloading", "installing", "restarting"].includes(state.status)) return;
    if (operation) return operation;
    publish({ status: "checking", error: null, canInstall: false });
    operation = (async () => {
      try {
        await update?.close();
        update = null;
        publish({ version: null, notes: "", date: null, downloadedBytes: 0, totalBytes: null });
        update = await check();
        publish(update ? {
          status: "available", version: update.version, notes: update.body ?? "",
          date: update.date ?? null, canInstall: true,
        } : { status: "current" });
      } catch {
        publish({ status: "error", error: "暂时无法连接更新服务，请稍后重试。", canInstall: false });
      }
    })();
    try { await operation; } finally { operation = null; }
  };
  const install = async () => {
    if (!update || operation || !state.canInstall) return;
    publish({ status: "downloading", downloadedBytes: 0, totalBytes: null, error: null, canInstall: false });
    operation = (async () => {
      let installed = false;
      try {
        await update.downloadAndInstall((event) => {
          if (event.event === "Started") {
            const size = event.data?.contentLength;
            publish({ downloadedBytes: 0, totalBytes: Number.isFinite(size) && size > 0 ? size : null });
          } else if (event.event === "Progress") {
            const chunk = event.data?.chunkLength;
            if (Number.isFinite(chunk) && chunk > 0) publish({ downloadedBytes: state.downloadedBytes + chunk });
          } else if (event.event === "Finished") {
            publish({ status: "installing" });
          }
        }, { timeout: 180000 });
        installed = true;
        publish({ status: "restarting" });
        await restart();
      } catch {
        publish({ status: "error", canInstall: !installed, error: installed
          ? "更新已安装，请退出应用后重新打开。"
          : "更新未完成，请检查网络后重试；当前版本仍可使用。" });
      }
    })();
    try { await operation; } finally { operation = null; }
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    initialize, check: checking, install,
  };
}
