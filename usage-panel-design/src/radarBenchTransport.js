import { fetchCodexRadarSnapshot, runningInTauriSync } from "./tauriBridge.js";

const canceled = () => new DOMException("读取已取消", "AbortError");

export function createRadarReader({ isNative = runningInTauriSync, readNative = fetchCodexRadarSnapshot, fetchImpl = (...args) => fetch(...args) } = {}) {
  let pending = null;
  return function read(force = false, signal) {
    if (signal?.aborted) return Promise.reject(canceled());
    if (!pending) {
      pending = Promise.resolve().then(async () => {
        if (isNative()) return readNative(force);
        const response = await fetchImpl(`/api/codex-radar${force ? "?refresh=1" : ""}`, {
          credentials: "omit", signal: AbortSignal.timeout(20000),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `官网返回 HTTP ${response.status}`);
        return data;
      }).finally(() => { pending = null; });
    }
    // A canceled subscriber must not cancel another hook's joined request.
    const shared = pending;
    return new Promise((resolve, reject) => {
      const abort = () => reject(canceled());
      signal?.addEventListener("abort", abort, { once: true });
      shared.then((data) => signal?.aborted ? reject(canceled()) : resolve(data), reject)
        .finally(() => signal?.removeEventListener("abort", abort));
    });
  };
}

export const readRadarSnapshot = createRadarReader();
