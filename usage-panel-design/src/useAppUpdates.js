import { useEffect, useState, useSyncExternalStore } from "react";
import { createAppUpdater } from "./appUpdates.js";
import { appUpdateTransport } from "./appUpdateTransport.js";
import { startAppUpdateChecks } from "./appUpdateSchedule.js";

export default function useAppUpdates({ enabled }) {
  const [updater] = useState(() => createAppUpdater(appUpdateTransport));
  const state = useSyncExternalStore(updater.subscribe, updater.getSnapshot, updater.getSnapshot);
  useEffect(() => {
    if (!enabled) return undefined;
    return startAppUpdateChecks({ updater });
  }, [enabled, updater]);
  return { state, check: updater.check, install: updater.install };
}
