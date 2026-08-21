import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";

// 异步版（用于需要等待 Tauri runtime 就绪的场景）
export const runningInTauri = async () => {
  try {
    return await isTauri();
  } catch {
    return false;
  }
};

// 同步版：Tauri v2 在页面加载时同步注入 window.__TAURI_INTERNALS__，
// 首次渲染即可正确判断，无需异步缓存
export const runningInTauriSync = () => {
  return typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
};

export const minimizeCurrentWindow = async () => {
  if (!(await runningInTauri())) return false;
  try {
    const w = getCurrentWindow();
    await w.minimize();
    return true;
  } catch (err) {
    console.error("[tauri] minimize 失败:", err);
    // 前端 minimize 失败时走后端兜底 (Rust window_label=main 直接 hide)
    try { await invoke("minimize_main_window_command"); return true; } catch {}
    return false;
  }
};

export const getSourceInfo = () => invoke("get_source_info");
export const getCachedUsage = () => invoke("get_cached_usage");
export const refreshUsage = () => invoke("refresh_usage");
export const setApiKey = (apiKey, baseUrl) => invoke("set_api_key", { apiKey, baseUrl });
export const setBaseUrl = (baseUrl) => invoke("set_base_url", { baseUrl });
export const clearApiKeyOverride = () => invoke("clear_api_key_override");
export const setRefreshInterval = (minutes) =>
  invoke("set_refresh_interval", { minutes });
export const setNotificationEnabled = (enabled) =>
  invoke("set_notification_enabled", { enabled });
export const showMainWindow = () => invoke("show_main_window_command");
export const orbOpenSettings = () => invoke("orb_open_settings");
export const orbHide = () => invoke("orb_hide");
export const ensureNotificationPermission = async () => {
  if (await isPermissionGranted()) return true;
  return (await requestPermission()) === "granted";
};
export const onUsageUpdated = (handler) => listen("usage-updated", (event) => handler(event.payload));
export const onUsageError = (handler) => listen("usage-error", (event) => handler(event.payload));
export const onOpenSettings = (handler) => listen("open-settings", () => handler());
export const fetchRadar = () => invoke("fetch_radar_data");
export const moveOrbWindow = (dx, dy) => invoke("move_orb_window", { deltaX: dx, deltaY: dy });
