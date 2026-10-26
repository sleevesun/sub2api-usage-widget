import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { runningInTauriSync } from "./tauriBridge.js";
import packageInfo from "../package.json";

export const appUpdateTransport = {
  getInfo: () => runningInTauriSync() ? invoke("get_update_info") : Promise.resolve({ version: packageInfo.version, supported: false }),
  check: () => check({ timeout: 20000 }),
  restart: () => relaunch(),
};
