import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createLocalTpsLoader } from "./localTps.js";
import { getLocalCodexTps, setLocalCodexTpsEnabled } from "./tauriBridge.js";

export default function useLocalTps({ period, native }) {
  const [snapshot, setSnapshot] = useState(null);
  const [busy, setBusy] = useState(false);
  const [operationError, setOperationError] = useState(null);
  const periodRef = useRef(period);
  periodRef.current = period;
  const mounted = useRef(false);
  const mutation = useRef(false);
  const loader = useMemo(() => createLocalTpsLoader(getLocalCodexTps), []);
  const refresh = useCallback(() => {
    if (!native || mutation.current) return Promise.resolve();
    return loader.load(periodRef.current, next => { if (mounted.current) setSnapshot(next); });
  }, [loader, native]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const visibleRefresh = () => { if (document.visibilityState !== "hidden") void refresh(); };
    const timer = native ? setInterval(visibleRefresh, 10_000) : null;
    document.addEventListener("visibilitychange", visibleRefresh);
    window.addEventListener("focus", visibleRefresh);
    return () => {
      mounted.current = false;
      loader.cancel();
      if (timer !== null) clearInterval(timer);
      document.removeEventListener("visibilitychange", visibleRefresh);
      window.removeEventListener("focus", visibleRefresh);
    };
  }, [loader, refresh, native, period.key]);

  const setEnabled = useCallback(async enabled => {
    if (!native || mutation.current) return;
    mutation.current = true;
    setBusy(true); setOperationError(null); loader.cancel();
    try { await setLocalCodexTpsEnabled(enabled); }
    catch (error) { if (mounted.current) setOperationError(error?.message ?? String(error)); }
    finally {
      mutation.current = false;
      if (mounted.current) { setBusy(false); await refresh(); }
    }
  }, [native, loader, refresh]);

  const current = !native ? { status: "preview", enabled: false, models: [], recordedSamples: 0 }
    : snapshot?.periodKey === period.key ? snapshot
      : { status: "loading", enabled: null, models: [], recordedSamples: 0 };
  return { ...current, busy, operationError, setEnabled, retry: refresh };
}
