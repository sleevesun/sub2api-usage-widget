import { useCallback, useEffect, useRef, useState } from "react";
import { createRadarLoader } from "./radarBench.js";
import { readRadarSnapshot } from "./radarBenchTransport.js";

let lastSnapshot = null;

export default function useRadarBench({ enabled, refreshMinutes = 10 }) {
  const [state, setState] = useState(() => ({ snapshot: lastSnapshot, loading: enabled && !lastSnapshot, error: null }));
  const loader = useRef(null);
  if (!loader.current) loader.current = createRadarLoader(readRadarSnapshot, lastSnapshot);
  const mounted = useRef(false);
  const refresh = useCallback((force = true) => {
    if (!enabled || !mounted.current) return Promise.resolve();
    return loader.current.load(force, (next) => {
      if (!mounted.current) return;
      if (next.snapshot) lastSnapshot = next.snapshot;
      setState(next);
    });
  }, [enabled]);

  useEffect(() => {
    mounted.current = true;
    if (enabled) void refresh(false);
    return () => {
      mounted.current = false;
      loader.current.cancel();
    };
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled) return undefined;
    const minutes = Number.isFinite(refreshMinutes) && refreshMinutes > 0 ? refreshMinutes : 10;
    const timer = setInterval(() => { void refresh(false); }, minutes * 60000);
    return () => clearInterval(timer);
  }, [enabled, refreshMinutes, refresh]);

  return { ...state, refresh };
}
