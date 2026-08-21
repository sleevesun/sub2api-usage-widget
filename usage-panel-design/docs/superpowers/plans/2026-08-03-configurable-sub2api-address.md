# Configurable Sub2API Address Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Windows/Tauri usage widget edit and persist its Sub2API base address independently from the active Codex provider configuration.

**Architecture:** Keep API keys in the existing OS credential store. Store only the non-sensitive custom base URL in the Tauri application config directory as `sub2api-base-url.txt`; when present, it overrides the Codex provider `base_url`, and when absent the existing Codex value remains the fallback. Expose one Tauri command for saving the URL, return the effective URL through `get_source_info`, and wire the existing settings save flow to persist it.

**Tech Stack:** Rust/Tauri 2, `reqwest`, `serde`, React/Vite, Node assertion script.

## Global Constraints

- Preserve the existing API-key credential-store behavior.
- Do not write API keys or other secrets to the new URL configuration file.
- Accept only absolute `http://` or `https://` URLs and normalize trailing slashes.
- Existing Codex `config.toml` behavior remains the fallback when no custom address is saved.
- Run the Rust unit tests and the existing frontend data contract test before claiming completion.

---

### Task 1: Add a tested base-URL validation and override seam

**Files:**
- Modify: `src-tauri/src/lib.rs` in the URL/config helpers and `#[cfg(test)] mod tests`.

**Interfaces:**
- Produces `validate_base_url(value: String) -> Result<String, String>`.
- Produces `effective_base_url(custom_base_url: Option<String>, provider_base_url: String) -> String`.

- [x] **Step 1: Write the failing tests**

Add tests that call the two new helpers:

```rust
#[test]
fn validates_and_normalizes_base_urls() {
    assert_eq!(
        validate_base_url(" https://sub2api.example.com/// ".to_string()).unwrap(),
        "https://sub2api.example.com"
    );
}

#[test]
fn rejects_unsupported_or_empty_base_urls() {
    assert!(validate_base_url("".to_string()).is_err());
    assert!(validate_base_url("sub2api.example.com".to_string()).is_err());
    assert!(validate_base_url("ftp://sub2api.example.com".to_string()).is_err());
}

#[test]
fn custom_base_url_overrides_codex_provider_url() {
    assert_eq!(
        effective_base_url(
            Some("https://custom.example.com".to_string()),
            "https://codex.example.com".to_string(),
        ),
        "https://custom.example.com"
    );
    assert_eq!(
        effective_base_url(None, "https://codex.example.com".to_string()),
        "https://codex.example.com"
    );
}
```

- [x] **Step 2: Run the focused test and verify it fails**

Run from `usage-panel-design`:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml validates_and_normalizes_base_urls rejects_unsupported_or_empty_base_urls custom_base_url_overrides_codex_provider_url
```

Expected: compilation failure because the new helpers do not exist yet.

- [x] **Step 3: Implement the minimal helpers**

Use `url::Url` through the existing dependency set or add the smallest direct dependency if needed. Normalize by trimming whitespace, removing trailing `/`, parsing the URL, and accepting only `http` and `https`. Make `effective_base_url` return the custom value when present and the provider value otherwise.

- [x] **Step 4: Run the focused tests again**

Expected: all three URL tests pass.

### Task 2: Persist and use the custom address in the Rust backend

**Files:**
- Modify: `src-tauri/src/lib.rs`.

**Interfaces:**
- Adds `set_base_url(app: AppHandle, base_url: String) -> Result<(), String>` as a Tauri command.
- `get_source_info` reports the effective URL and whether a custom URL is configured.
- `read_credentials`, `set_api_key`, and refresh requests use the custom URL override.

- [x] **Step 1: Write the failing persistence/command seam test if a pure seam is available**

Keep filesystem and Tauri-handle concerns behind small helpers (`base_url_config_path`, `read_custom_base_url`, `write_custom_base_url`). Test the pure validation and precedence behavior from Task 1; exercise persistence through the command after implementation using the app config directory during manual/fixture verification.

- [x] **Step 2: Add non-secret config-file helpers**

Resolve the file as `app.path().app_config_dir().join("sub2api-base-url.txt")`. Treat a missing file as no override. Validate file contents before returning them, create the parent directory on write, and write only the normalized base URL.

- [x] **Step 3: Apply the override at every request/source-info boundary**

Resolve the effective URL from the persisted custom value first and the Codex provider value second. Use this resolution in API-key validation requests, normal refreshes, and the displayed `SourceInfo.base_url`.

- [x] **Step 4: Register `set_base_url` in `generate_handler!`**

The command must persist a normalized URL and return an error without changing the file when validation fails.

### Task 3: Make the React settings field editable and save it

**Files:**
- Modify: `src-tauri/src/lib.rs` (serialized source info field if needed).
- Modify: `src/tauriBridge.js`.
- Modify: `src/App.jsx`.

**Interfaces:**
- Bridge exports `setBaseUrl(baseUrl)`.
- `SettingsPanel` owns an editable `baseUrl` draft and passes it through `onSave`.
- `saveSettings` persists the URL, refreshes source info, and refreshes usage when running in Tauri.

- [x] **Step 1: Add `setBaseUrl` to the bridge**

```js
export const setBaseUrl = (baseUrl) => invoke("set_base_url", { baseUrl });
```

- [x] **Step 2: Replace the read-only address input with a controlled draft**

Initialize `baseUrl` from `sourceInfo.baseUrl`, update it on input, and include it in the existing settings save payload. Keep the browser preview seeded with its current mock URL.

- [x] **Step 3: Persist before closing settings**

In `saveSettings`, call `setBaseUrl(baseUrl.trim())` before closing the settings panel. Then reload `getSourceInfo()` and request fresh usage so the new address is active immediately. Preserve the current interval/notification persistence behavior.

- [x] **Step 4: Run the frontend contract test**

Run:

```powershell
pnpm test:data
```

Expected: `usage normalization contract passed`.

### Task 4: Verify the Windows build path and document the behavior

**Files:**
- Modify: `README.md` in the behavior/configuration sections.

- [x] **Step 1: Run Rust formatting and tests**

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
```

- [x] **Step 2: Run the frontend build**

```powershell
pnpm build
```

- [x] **Step 3: Review the diff for secret leakage and stale read-only UI**

Confirm the URL file contains no API key code, the address input no longer has `readOnly`, and all request paths use the same effective URL resolver.

- [x] **Step 4: Update README**

Document that the settings panel accepts a full `http://` or `https://` Sub2API address, that it overrides Codex `config.toml` for this widget only, and that clearing/reverting behavior uses the Codex provider address when supported by the UI.
