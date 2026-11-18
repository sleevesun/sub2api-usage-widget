import { Channel, invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { runningInTauriSync } from "./tauriBridge.js";
import packageInfo from "../package.json";

export const appUpdateTransport = {
  getInfo: () => runningInTauriSync() ? invoke("get_update_info") : Promise.resolve({ version: packageInfo.version, supported: false }),
  check: async () => {
    const update = await check({ timeout: 20000 });
    if (!update) return null;
    return {
      version: update.version, body: update.body, date: update.date,
      close: () => update.close(),
      downloadAndInstall: (onMessage) => {
        const onEvent = new Channel(onMessage);
        return invoke("install_portable_update", { version: update.version, onEvent });
      },
    };
  },
  restart: () => relaunch(),
};
