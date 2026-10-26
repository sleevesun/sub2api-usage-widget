import { useEffect, useState, useSyncExternalStore } from "react";
import { createAppUpdater } from "./appUpdates.js";
import { appUpdateTransport } from "./appUpdateTransport.js";

export default function useAppUpdates({ enabled }) {
  const [updater] = useState(() => createAppUpdater(appUpdateTransport));
  const state = useSyncExternalStore(updater.subscribe, updater.getSnapshot, updater.getSnapshot);
  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    let timer;
    updater.initialize().then(() => {
      if (active && updater.getSnapshot().supported) timer = window.setTimeout(() => { void updater.check(); }, 4000);
    });
    return () => { active = false; window.clearTimeout(timer); };
  }, [enabled, updater]);
  return { state, check: updater.check, install: updater.install };
}
