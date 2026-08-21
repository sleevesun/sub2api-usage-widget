# macOS Development Handoff: Sub2API Usage Widget

Updated: 2026-07-20

## Next Session Goal

Continue development of the macOS version of the Sub2API Usage Widget. First establish a reproducible macOS development environment, then validate the menu-bar behavior and secure credential flow on a real Mac before making platform-specific changes.

## Current State

- The active desktop application is `usage-panel-design/`, not the repository root.
- It is a Tauri 2 desktop application with a React/Vite frontend and a Rust backend. It targets Windows and macOS from one codebase; it is not a browser extension.
- The app starts as a hidden tray/menu-bar widget, shows a 420 x 640 panel on left-click, reads the active Codex provider configuration, and requests `GET /v1/usage` from that provider's base URL.
- No Git repository or `.gitignore` was found in this directory. There is no commit, branch, remote, or historical diff to rely on during transfer.
- Generated folders are currently present: `usage-panel-design/node_modules/`, `usage-panel-design/dist/`, and `usage-panel-design/src-tauri/target/`. Treat source files and lockfiles as canonical; regenerate those folders on the Mac.

## What To Transfer

Transfer the complete `usage-panel-design/` directory, including `package.json`, `pnpm-lock.yaml`, `src/`, `src-tauri/`, `scripts/`, icons, and `README.md`.

Do not transfer real credentials or machine-specific data. In particular, do not copy a real `~/.codex/auth.json`, Keychain entries, a filled-in `sub2api_usage_config.json`, generated usage snapshots, or CSV output. The root-level `sub2api_usage_config.example.json` is only a template and must be populated locally without committing keys.

The root-level helper scripts are separate from the Tauri app:

- `collect_sub2api_usage.ps1` is Windows PowerShell-specific.
- `sub2api_usage_collector.py` is cross-platform and can be used on macOS only when batch collection is needed; it is not required by the widget.

## Architecture Map

| Path | Responsibility |
| --- | --- |
| `usage-panel-design/src/App.jsx` | React UI, usage normalization, trend calculations, settings sheet, UI-local persistence, and the fixed `Asia/Shanghai` display timezone. |
| `usage-panel-design/src/tauriBridge.js` | Frontend boundary for Tauri commands, events, and notification permission requests. |
| `usage-panel-design/src-tauri/src/lib.rs` | Codex config/auth lookup, Keychain/Credential Manager access, usage HTTP request, in-memory cache, tray/menu behavior, refresh loop, notifications, and window visibility behavior. |
| `usage-panel-design/src-tauri/tauri.conf.json` | Tauri app identifier, hidden always-on-top panel settings, Vite commands, bundle targets, and macOS `.icns` icon input. |
| `usage-panel-design/src-tauri/capabilities/default.json` | Webview permissions: Tauri core defaults and notification plugin access. |
| `usage-panel-design/scripts/test-normalize.mjs` | Frontend normalization and trend-series contract test. |
| `usage-panel-design/README.md` | Existing product behavior, prerequisites, local development, and Windows release notes. |

## Important Runtime Behavior

### Credentials and API access

1. The Rust backend resolves `CODEX_HOME` when set; otherwise it uses `~/.codex` on macOS.
2. `config.toml` supplies the active model provider and its `base_url`. It is required even when a custom API key is used.
3. A custom key has priority and is stored through the Rust `keyring` crate. On macOS this uses Keychain with service `com.sub2api.usage-widget` and account `api-key`.
4. Without a custom key, the backend falls back to `~/.codex/auth.json` and reads `OPENAI_API_KEY`.
5. The frontend never receives the full API key. It receives only key-source status and usage data.
6. Requests use a 15-second timeout and ask for 28 days of history. The request timezone is currently hard-coded to `Asia/Shanghai`.

### State, refresh, and notifications

- Rust keeps the current usage snapshot only in memory.
- The webview's `localStorage` preserves the display name, selected 5/10/30-minute refresh interval, notification preference, and locally inferred key-reset metadata. The backend restores refresh/notification state when the frontend starts.
- The default refresh interval is 10 minutes. The backend accepts 1-1440 minutes, but the current UI only offers 5, 10, and 30 minutes.
- A low-balance notification may be sent once when quota remaining is at or below $20. It becomes eligible again after a later usage response reports more than $20 remaining.
- Quota reset timing is inferred from a decrease in used amount at the same quota limit; the service response is not treated as an authoritative reset timestamp.

### Tray and window behavior

- The app starts hidden in the menu bar/tray.
- Left-clicking the icon toggles the main panel and attempts to position it near the click cursor.
- The tray menu contains Show, Refresh, and Quit.
- Closing the panel or losing focus hides it instead of terminating the application. The `--show` process argument keeps it visible for manual testing.

## macOS Setup

Run all application commands from `usage-panel-design/`, not the repository root.

1. Install Xcode Command Line Tools: `xcode-select --install`.
2. Install Rust through `rustup` and confirm `cargo --version` and `rustc --version` work.
3. Install Node and pnpm. The locked Vite 8.1.5 dependency requires Node `^20.19.0` or `>=22.12.0`; Node 24.14.0 was used for the checks recorded below. Ensure `node` is on `PATH` before invoking pnpm.
4. Install dependencies using the lockfile, then run the checks and development app:

```bash
cd usage-panel-design
pnpm install --frozen-lockfile
pnpm test:data
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri:dev
```

Use `pnpm tauri:build` for a macOS release build. Inspect the generated files under `src-tauri/target/release/bundle/`; no macOS build was performed during this Windows handoff.

## macOS Manual Acceptance Checklist

- Launch the app and confirm it remains in the menu bar without showing an unwanted dock/taskbar workflow.
- Left-click the menu-bar icon on each target display and verify that the panel appears on-screen, near the cursor, without clipping.
- Click outside the panel and close it; it should hide while the process continues. Verify the tray/menu-bar Show, Refresh, and Quit menu actions.
- With a valid local `~/.codex/config.toml` and `~/.codex/auth.json`, confirm that provider discovery and usage refresh work.
- Enter a custom key, confirm that it is accepted only after a successful usage request, restart the app, and confirm it survives via Keychain without exposing the raw key in the UI.
- Restore the Codex key and confirm the Keychain override is removed.
- Enable low-balance notification, grant macOS notification permission, and verify the threshold behavior.
- Change refresh interval and notification settings, restart the app, and verify the webview-local preferences are restored.
- Check reduced-motion behavior, Chinese text rendering, light/dark mode, and the fixed Asia/Shanghai date grouping on the target macOS version.

## Verification Already Performed

These checks ran successfully on Windows on 2026-07-20 with Node 24.14.0 available on `PATH`:

- `pnpm test:data`: passed (`usage normalization contract passed`).
- `pnpm build`: passed (Vite production build completed).
- `cargo test` in `usage-panel-design/src-tauri`: passed (2 Rust tests for API-key validation).

Not yet verified: `pnpm tauri:dev` or `pnpm tauri:build` on macOS, macOS Keychain integration, menu-bar positioning, macOS notification permission, code signing, notarization, or distribution artifacts.

## Decisions And Risks To Resolve On The Mac

- The bundle configuration has an app identifier and `.icns` icon, but no signing or notarization setup was found. Decide whether the app is only for local use or will be distributed outside the development machine.
- No release architecture strategy is recorded. Validate on the intended Apple Silicon and/or Intel target, then decide whether separate builds or a universal distribution are needed.
- The current hard-coded `Asia/Shanghai` timezone is product behavior. Confirm that it is intentional for macOS users before changing it.
- There is no automated macOS UI or integration test coverage. Treat the manual checklist above as the release gate until platform tests are added.
- Before using source control, add a `.gitignore` for generated dependencies/build outputs and create or identify the authoritative remote. Do not assume the current folder has recoverable history.

## Suggested Skills

- `$openai-docs`: use when the macOS work needs current Codex configuration or authentication guidance rather than relying on assumptions about `~/.codex`.
- `$handoff`: update this document after the first successful macOS run/build so the next developer has actual platform results.
- `$grilling`: use before committing to signing, notarization, release architecture, or distribution scope, where an unexamined decision could create rework.
