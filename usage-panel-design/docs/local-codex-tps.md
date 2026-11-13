# Local Codex TPS

The model-consumption table can show a **local Codex reference TPS** alongside account consumption. Expand “本机 Codex TPS” below the table and explicitly enable sampling, then restart Codex. New complete requests will be collected while the tray App is running. The App never launches model requests as part of normal sampling.

## Measurement and scope

- TPS = sum of Codex-reported output tokens / sum of successful request seconds. Reasoning tokens are not added again to output tokens.
- HTTP start is the API event timestamp minus its reported duration. The end is the transport-level `response.completed`, paired with its separate usage completion. This includes network and first-token waiting and excludes gaps between requests.
- Only complete HTTP/SSE requests with consistent identity and timing are accepted. Failed, incomplete, overlapping/ambiguous streams, WebSocket traffic, tool-generating responses and identifiable overlapping tool activity are omitted. Late failure, overlap, WebSocket or tool metadata retracts affected samples while their request metadata remains in the analysis buffer.
- Aggregate by exact model identifier (case-insensitive, without alias/family guessing) and Beijing completion date. A request crossing midnight belongs to its completion date. Weight by total tokens and total duration, never the average of individual rates.
- The table retains all account consumption models and its existing cost sorting. Local TPS does not replace account costs, requests or tokens and does not imply coverage of other devices, accounts or clients. Hover a value to see the sample count, time coverage and measurement definition. Missing samples remain `—`.

## Configuration and privacy

The receiver binds only `127.0.0.1` on an available port and retains that port across App restarts. It accepts bounded OTLP/HTTP JSON (including gzip); browser-origin requests are rejected. Concurrent connections, body sizes, metadata buffers and saved sample counts are bounded.

The explicit enable action updates only the current `CODEX_HOME/config.toml` (or `~/.codex/config.toml`) OTel log exporter and content-logging controls. It disables prompt, agent-response, assessment and tool-output content logging. Existing third-party log exporters are not replaced. Trace/metrics exporters and unrelated settings are preserved.

A journal in the App configuration directory backs up only changed non-secret settings: absent/`none` exporter state, three booleans and the tool-output length limit. It contains no exporter authentication headers. TOML comments and other settings are preserved. Writes check for concurrent edits. Disabling stops reception and restores only owned values, preserving subsequent user edits and any replacement exporter. Restart Codex after enabling or disabling. If Codex's home changes, the App refuses to write into a different home using an old journal.

Only completed sample digests, model identifiers, output counts and request timing are saved in `codex-tps-samples.json` beside `codex-tps-settings.json` in the App configuration directory. Raw telemetry, conversation identifiers, prompts, tool arguments/results, credentials, account details and provider URLs are not persisted. Samples retain at most 35 days / 50,000 records. Malformed saved files are preserved and surfaced as an error.

Historical session JSONL lacks sufficient request timing for this measurement and is not scanned or backfilled. Codex must emit the documented OTel log events; organization requirements or a different/overridden configuration can prevent their arrival. An enabled receiver without usable events shows a waiting/no-sample state. Existing measured samples remain available after stopping collection.

Official configuration reference: https://developers.openai.com/codex/config-advanced/#observability-and-telemetry

## Verification

`pnpm test:usage` covers exact model matching, weighted totals, Beijing ranges, duplicate model aggregates, stale request results, render states and source labels. `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib local_tps` covers whitelist extraction, dual completion events, duplicate/out-of-order batches, tools/failures/ambiguity, persistence, restarts, occupied ports and reversible configuration.

On November 13, 2026, the final explicit ignored smoke test sent one short no-tool request through the locally installed Codex. The production Rust receiver accepted one sample with 194 output tokens / 11,868 ms (approximately 16.3 TPS), matching Codex's own output usage. The user's live configuration SHA-256 was unchanged; all enable/restore operations used temporary test directories. This is a single local observation, not a model benchmark.

The earlier successful-tool delay control was blocked by permission/approval checks and was not retried or bypassed. Synthetic tests verify conservative tool exclusion and retraction; a real successful-tool isolation experiment is not claimed. Continuous human orb drag latency and a complete old-client install/restart upgrade likewise remain separate manual checks.

To explicitly rerun the real request (this makes one short model call):

```powershell
$env:SUB2API_TPS_CODEX_EXE = (Get-Command codex.exe).Source
try {
  cargo test --locked --manifest-path src-tauri/Cargo.toml --lib live_codex_metadata_reaches_production_receiver_without_changing_user_config -- --ignored --nocapture
} finally {
  Remove-Item Env:\SUB2API_TPS_CODEX_EXE -ErrorAction SilentlyContinue
}
```
