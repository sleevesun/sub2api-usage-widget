import { useCallback, useEffect, useRef, useState } from "react";
import { loadRadarBench, mergeRadarBenchCell, RADAR_BENCH_SELECTIONS, radarBenchKey } from "./radarBench.js";
import { readRadarBenchScore } from "./radarBenchTransport.js";

export default function useRadarBench({ enabled, refreshMinutes = 10 }) {
  const [state, setState] = useState({
    cells: {}, isRefreshing: false, resolved: 0, pendingCount: RADAR_BENCH_SELECTIONS.length,
    lastAttemptAtMs: null, batchError: null,
  });
  const mounted = useRef(false);
  const jobRef = useRef(null);
  const refresh = useCallback((selection) => {
    if (!enabled || !mounted.current) return Promise.resolve([]);
    if (jobRef.current) return jobRef.current.promise;
    const job = { controller: new AbortController(), promise: null };
    jobRef.current = job;
    const selections = selection ? [selection] : RADAR_BENCH_SELECTIONS;
    setState((current) => ({
      ...current, isRefreshing: true, resolved: 0, pendingCount: selections.length, batchError: null,
    }));
    job.promise = loadRadarBench(readRadarBenchScore, {
      selections,
      signal: job.controller.signal,
      onCell: (cell) => {
        if (!mounted.current || jobRef.current !== job || job.controller.signal.aborted) return;
        const key = radarBenchKey(cell);
        setState((current) => ({
          ...current,
          resolved: current.resolved + 1,
          cells: { ...current.cells, [key]: mergeRadarBenchCell(current.cells[key], cell) },
        }));
      },
    }).catch(() => {
      if (mounted.current && jobRef.current === job) {
        setState((current) => ({ ...current, batchError: "暂时无法读取雷达Bench，请重试。" }));
      }
      return [];
    }).finally(() => {
      if (jobRef.current !== job) return;
      jobRef.current = null;
      if (mounted.current && !job.controller.signal.aborted) {
        setState((current) => ({ ...current, isRefreshing: false, lastAttemptAtMs: Date.now() }));
      }
    });
    return job.promise;
  }, [enabled]);

  useEffect(() => {
    mounted.current = true;
    if (enabled) void refresh();
    return () => {
      mounted.current = false;
      jobRef.current?.controller.abort();
      jobRef.current = null;
    };
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled) return undefined;
    const minutes = Number.isFinite(refreshMinutes) && refreshMinutes > 0 ? refreshMinutes : 10;
    const timer = setInterval(() => { void refresh(); }, minutes * 60000);
    return () => clearInterval(timer);
  }, [enabled, refresh, refreshMinutes]);

  return { ...state, refresh };
}
