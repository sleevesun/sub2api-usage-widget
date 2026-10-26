# Sub2API Usage Widget

A lightweight Tauri 2 tray widget for Windows and macOS. It reads the active Codex provider configuration, queries Sub2API `/v1/usage`, and keeps the API key inside the Rust backend.

## Behavior

- Starts hidden and stays in the system tray.
- Left-clicking the tray icon toggles the usage panel, initially sized at 420 x 760.
- Drag the title or empty area at the top to move the panel. Header buttons retain their normal click behavior.
- Drag any panel edge or corner to resize it; the minimum panel size is 380 x 640.
- The floating orb keeps a visible circular body while loading, on read failures and at 0% quota. It independently reads initial usage when the shared cache is empty, and retains the last quota after later failures.
- Confirmed unrestricted quotas show `∞` with animated liquid and bubbles. The decorative water level stays inside the orb so its waves remain visible; it does not represent a remaining percentage.
- The panel stays open when it loses focus. Use the top-right collapse button, an explicit close action, or the tray icon to hide it instead of exiting the app.
- Refreshes usage in the Rust process every 10 minutes by default.
- Supports 5, 10, and 30 minute refresh intervals.
- Can send one system notification when the remaining quota falls below $20.
- Keeps API keys out of frontend storage and never returns a full key to the webview.
- Lets users override a missing or outdated Codex API key from the settings panel.
- Lets users set a custom Sub2API base URL from the settings panel; it overrides the Codex provider URL for this widget only.
- Validates a custom key before saving it to Windows Credential Manager or macOS Keychain.
- Falls back to `.codex/auth.json` when no custom key is stored.
- Requests 28 days of usage history and presents today, this week by day, the last 15 days, or four natural weeks including the current week.
- The model table follows the selected trend period and shows actual cost, request count and Token count together. Queries use inclusive dates in Asia/Shanghai; missing metrics display a dash, and failed queries offer a retry without showing another period's values.
- Detects a custom API key's quota reset after a later refresh observes its used amount decrease; the service API does not provide an authoritative reset timestamp for every key.
- Displays live RadarBench results in a six-model, six-effort matrix, replacing webmaster recommendations.
- Each supported cell shows the score out of 150, average API-equivalent USD cost, and average elapsed minutes together. There are no metric tabs or submission counters.
- Clicking a cell shows its task coverage and the known-sample denominators behind partial averages marked with `*`. The expanded matrix supports horizontal scrolling with the model column pinned.
- Reads `https://api.codexradar.com/api/v1/radar-bench-score` anonymously through Rust with at most two concurrent requests. Sub2API credentials are never attached, and the floating orb does not request benchmark data. The browser preview proxies to the same endpoint.
- Refreshes the matrix on the configured interval or manually. Failed reads retain the last successful cell, mark it as cached, and offer a retry.

## Codex Configuration

The backend reads `CODEX_HOME` when it is set. Otherwise it uses:

- Windows: `%USERPROFILE%\.codex`
- macOS: `~/.codex`

Expected files:

```text
.codex/
  auth.json       # OPENAI_API_KEY
  config.toml     # model_provider and model_providers.<name>.base_url
```

The settings panel accepts a full `http://` or `https://` Sub2API address. A
custom address is stored as non-sensitive app configuration and takes priority
over `config.toml` for this widget. Leave it empty and save to return to the
Codex provider address. When configuring a new API Key, the key is validated
against the address currently entered in the same settings panel.

## Prerequisites

Windows:

1. Install Rust with [rustup](https://rustup.rs/).
2. Install Visual Studio 2022 Build Tools with `Desktop development with C++` and a Windows 10/11 SDK.
3. Install WebView2 Runtime if it is not already present.

macOS:

1. Run `xcode-select --install`.
2. Install Rust with [rustup](https://rustup.rs/).

Node.js and pnpm are required on both platforms.

## Development

```bash
pnpm install
pnpm tauri:dev
```

The browser-only design preview is available with:

```bash
pnpm dev
```

Browser preview usage data is static and does not read local Codex credentials.
RadarBench data is live, using the Vite proxy to the same public score endpoint
as the desktop app.

## Build

```bash
pnpm test:data
pnpm test:usage
pnpm test:bench
pnpm test:windows
pnpm test:updates
cargo test --manifest-path src-tauri/Cargo.toml
pnpm build
pnpm release:windows
```

Installers are written under `src-tauri/target/release/bundle/`.

## Windows Release

The generated NSIS installer is:

```text
release/v0.3.0/Sub2API-Usage_0.3.0_x64-setup.exe
```

The portable executable is:

```text
src-tauri/target/release/sub2api-usage-widget.exe
```

This release is distributed as an installer so future versions can be installed
from inside the app. Existing portable users should exit the old app from the
tray and install this version once. Running the raw executable remains possible,
but accepting an update uses the installer and may migrate it to an installed
copy. Use the installed shortcut afterwards to avoid reopening an old portable
copy.

The previous portable build remains available for rollback:

```text
portable/Sub2API-Usage-Portable-RadarBench-20261026.exe
```

Launching the executable normally starts it hidden in the system tray. Use the
following command when the panel should open immediately for manual testing:

```powershell
.\src-tauri\target\release\sub2api-usage-widget.exe --show
```

## In-app updates (Windows)

Version 0.3.0 checks for updates shortly after startup. Settings contains manual
checking, release notes, download progress and an explicit download/install
button. No update is downloaded until accepted. Failed checks do not claim the
app is up to date; failed downloads can be retried. The orb never checks updates.
Browser previews and other platforms display the Windows support limitation.

The stable manifest is:

```text
https://github.com/sleevesun/sub2api-usage-widget/releases/latest/download/latest.json
```

The app uses the official Tauri updater, HTTPS and an embedded public key.
The signed NSIS installer uses the current user's installation scope, and the
updater runs it in passive mode. The application identifier and credential
storage remain unchanged. Installation exits the app and restarts it afterwards.
Save pending settings before accepting the update.

Release setup and publication instructions: [docs/windows-updates.md](docs/windows-updates.md).
