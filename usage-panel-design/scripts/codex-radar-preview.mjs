// Development-only anonymous adapter. Shipped apps use the Rust transport.
import { normalizeRadarSnapshot } from "../src/radarBench.js";

const SOURCE = "https://codexradar.com/";
const TTL = 10 * 60 * 1000;

export function parseRadarHomepage(html, fetchedAt = new Date().toISOString()) {
  const script = html.match(/<script\b[^>]*\bid\s*=\s*["']home-overview-data["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!script) throw new Error("官网未返回 home-overview-data，数据结构可能已更新");
  const overview = JSON.parse(script[1]);
  if (!Array.isArray(overview?.scores?.rows)) throw new Error("官网 scores.rows 格式已变化");
  const { rows, ...metadata } = overview.scores;
  const models = new Set(rows.filter((row) => typeof row?.model === "string").map((row) => row.model.trim().toLowerCase()));
  const unsupported = [];
  for (const match of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const heading = match[1].match(/<th\b[^>]*scope\s*=\s*["']row["'][^>]*>([\s\S]*?)<\/th>/i);
    if (!heading) continue;
    const model = heading[1].replace(/<[^>]*>/g, " ").trim().toLowerCase()
      .replace(/[‐‑–—]/g, "-").replace(/\s+/g, "-");
    if (!models.has(model)) continue;
    for (const cell of match[1].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)) {
      const column = cell[1].match(/data-cir-column\s*=\s*["']([^"']+)["']/i);
      if (column && /data-heat-state\s*=\s*["']unsupported["']/i.test(cell[0])) {
        unsupported.push({ model, effort: column[1].toLowerCase() });
      }
    }
  }
  return normalizeRadarSnapshot({ source: SOURCE, fetched_at: fetchedAt, rows, unsupported, metadata, status: "latest" });
}

export function createPreviewRadarReader(fetchImpl = fetch, now = Date.now) {
  let snapshot = null;
  let lastError = null;
  let pending = null;
  return async (force = false) => {
    if (pending) return pending;
    if (!force && snapshot && now() - Date.parse(snapshot.fetched_at) < TTL) {
      return { ...snapshot, status: lastError ? "stale" : "cached", ...(lastError ? { error: lastError } : {}) };
    }
    pending = Promise.resolve().then(async () => {
      try {
        const response = await fetchImpl(SOURCE, {
          credentials: "omit", signal: AbortSignal.timeout(20000),
          headers: { Accept: "text/html", "Cache-Control": "no-cache" },
        });
        if (!response.ok) throw new Error(`官网返回 HTTP ${response.status}`);
        const next = parseRadarHomepage(await response.text(), new Date(now()).toISOString());
        snapshot = next;
        lastError = null;
        return next;
      } catch (failure) {
        lastError = failure?.name === "TimeoutError" ? "官网读取超时，请稍后刷新" : failure?.message || String(failure);
        if (!snapshot) throw new Error(lastError);
        return { ...snapshot, status: "stale", error: lastError };
      }
    }).finally(() => { pending = null; });
    return pending;
  };
}

export function codexRadarPreview() {
  const read = createPreviewRadarReader();
  const configure = (server) => { server.middlewares.use(async (request, response, next) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname !== "/api/codex-radar") return next();
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET") { response.statusCode = 405; response.end(JSON.stringify({ error: "仅支持读取" })); return; }
    try { response.end(JSON.stringify(await read(url.searchParams.get("refresh") === "1"))); }
    catch (failure) { response.statusCode = 503; response.end(JSON.stringify({ error: failure.message })); }
  }); };
  return { name: "codex-radar-preview", configureServer: configure, configurePreviewServer: configure };
}
