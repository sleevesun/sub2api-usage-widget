import assert from "node:assert/strict";
import { createPreviewRadarReader, parseRadarHomepage } from "./codex-radar-preview.mjs";

const row = { model: " GPT-6.1-FUTURE ", effort: " MAX ", score150: 101, cost_usd: null, model_elapsed_seconds: 120 };
const html = (rows = [row]) => `<script type="application/json" id="home-overview-data">${JSON.stringify({ scores: { rows, round_id: "fixture" } })}</script>`;
assert.equal(parseRadarHomepage(html()).rows[0].model, "gpt-6.1-future");
assert.equal(parseRadarHomepage(html()).metadata.round_id, "fixture");
assert.deepEqual(parseRadarHomepage(html([])).rows, []);
assert.throws(() => parseRadarHomepage("<html></html>"), /home-overview-data/);

let calls = 0, fail = true, now = Date.parse("2026-11-12T00:00:00Z");
const read = createPreviewRadarReader(() => {
  calls += 1;
  if (fail) throw new Error("fixture offline");
  return Promise.resolve({ ok: true, text: async () => html() });
}, () => now);
await assert.rejects(read(), /offline/);
fail = false;
const first = await read();
assert.equal(first.status, "latest", "A synchronous failure must clear pending so retry succeeds");
assert.equal((await read()).status, "cached");
assert.equal(calls, 2);
fail = true;
assert.equal((await read(true)).status, "stale");
assert.equal((await read()).status, "stale");
assert.equal((await read()).fetched_at, first.fetched_at);
fail = false; now += 600001;
assert.equal((await read()).status, "latest");
let release;
const shared = createPreviewRadarReader(() => new Promise(resolve => { release = () => resolve({ ok: true, text: async () => html() }); }));
const a = shared(true), b = shared(true);
await Promise.resolve(); release();
assert.deepEqual(await a, await b);
console.log("Radar preview parses dynamic rounds, retries, retains stale snapshots and coalesces reads");
