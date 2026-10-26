import { fetchRadarBenchScore, runningInTauriSync } from "./tauriBridge.js";

// Native invocations cannot be aborted. Keep admission shared across hook
// lifetimes so obsolete work drains before a replacement batch can start.
let activeNativeReads = 0;
const nativeQueue = [];
const canceled = () => new DOMException("读取已取消", "AbortError");

function drainNativeQueue() {
  while (activeNativeReads < 2 && nativeQueue.length > 0) nativeQueue.shift().grant();
}

function acquireNativeSlot(signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(canceled()); return; }
    const cancel = () => {
      const index = nativeQueue.indexOf(ticket);
      if (index >= 0) nativeQueue.splice(index, 1);
      reject(canceled());
    };
    const ticket = {
      grant() {
        signal?.removeEventListener("abort", cancel);
        activeNativeReads += 1;
        resolve(() => {
          activeNativeReads -= 1;
          drainNativeQueue();
        });
      },
    };
    signal?.addEventListener("abort", cancel, { once: true });
    nativeQueue.push(ticket);
    drainNativeQueue();
  });
}

export async function readRadarBenchScore(selection, signal) {
  if (runningInTauriSync()) {
    const release = await acquireNativeSlot(signal);
    try {
      if (signal?.aborted) throw canceled();
      const data = await fetchRadarBenchScore(selection.model, selection.effort);
      if (signal?.aborted) throw canceled();
      return data;
    } finally {
      release();
    }
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, 15000);
  try {
    const response = await fetch(`/radar-bench-score?${new URLSearchParams(selection)}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`雷达Bench接口返回 HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
