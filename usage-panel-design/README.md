# Sub2API Usage Widget

A lightweight Tauri 2 tray widget for Windows and macOS. It reads the active Codex provider configuration, queries Sub2API `/v1/usage`, and keeps the API key inside the Rust backend.

## Behavior

- Starts hidden and stays in the system tray.
- Left-clicking the tray icon toggles the compact 420 x 640 usage panel.
- Closing or unfocusing the panel hides it instead of exiting the app.
- Refreshes usage in the Rust process every 10 minutes by default.
- Supports 5, 10, and 30 minute refresh intervals.
- Can send one system notification when the remaining quota falls below $20.
- Keeps API keys out of frontend storage and never returns a full key to the webview.
- Lets users override a missing or outdated Codex API key from the settings panel.
- Lets users set a custom Sub2API base URL from the settings panel; it overrides the Codex provider URL for this widget only.
- Validates a custom key before saving it to Windows Credential Manager or macOS Keychain.
- Falls back to `.codex/auth.json` when no custom key is stored.
- Requests 28 days of usage history and presents this week by day, the last 15 days, or four natural weeks including the current week.
- Detects a custom API key's quota reset after a later refresh observes its used amount decrease; the service API does not provide an authoritative reset timestamp for every key.

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

Browser preview data is static and does not read local Codex credentials.

## Build

```bash
pnpm test:data
pnpm build
pnpm tauri:build
```

Installers are written under `src-tauri/target/release/bundle/`.

## Windows Release

The generated NSIS installer is:

```text
src-tauri/target/release/bundle/nsis/Sub2API Usage_0.2.0_x64-setup.exe
```

The portable executable is:

```text
src-tauri/target/release/sub2api-usage-widget.exe
```

For a directly runnable copy, use:

```text
portable/Sub2API-Usage-Portable-Fixed.exe
```

Launching the executable normally starts it hidden in the system tray. Use the
following command when the panel should open immediately for manual testing:

```powershell
.\src-tauri\target\release\sub2api-usage-widget.exe --show
```
