import { useEffect, useMemo, useState } from "react";
import { createModelUsageLoader } from "./modelUsage.js";
import { fetchModelUsage } from "./tauriBridge.js";
import { fetchPreviewModelUsage } from "./previewUsage.js";

export default function useModelUsage({ period, revision, native, previewFetchedAtMs }) {
  const [state, setState] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const loader = useMemo(() => createModelUsageLoader(native ? fetchModelUsage
    : (startDate, endDate) => fetchPreviewModelUsage(startDate, endDate, previewFetchedAtMs)), [native, previewFetchedAtMs]);
  const requestKey = `${period.key}:${revision}:${attempt}`;
  useEffect(() => {
    void loader.load(period, (next) => setState({ ...next, requestKey }));
    return () => loader.cancel();
  }, [loader, period.key, period.startDate, period.endDate, requestKey]);
  const current = state?.requestKey === requestKey
    ? state
    : { periodKey: period.key, status: "loading", models: [], error: null };
  return { ...current, retry: () => setAttempt((value) => value + 1) };
}
