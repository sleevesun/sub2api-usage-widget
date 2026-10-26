# Windows application updates

## Current delivery

The app is connected to the public `sleevesun/sub2api-usage-widget` repository.
Version 0.3.0 adds signed Tauri updates for Windows x64. Its stable endpoint is
`https://github.com/sleevesun/sub2api-usage-widget/releases/latest/download/latest.json`.
The first release must be published before this endpoint works. Until then,
checking reports that the service is unavailable; it does not report success.

Existing users of the old portable EXE must install 0.3.0 once. Tell them to quit
the old tray process, install `Sub2API-Usage_0.3.0_x64-setup.exe`, and use the
installed shortcut. The update source must remain publicly downloadable without
an embedded GitHub token. A machine that cannot reach GitHub may fail to check
or download updates; changing download hosting later needs a deliberate migration.

## Signing material

The updater public key is committed in `src-tauri/tauri.conf.json`. The encrypted
private key and its password are local files outside the checkout:

```text
%USERPROFILE%\.codex\keys\sub2api-usage-widget\updater.key
%USERPROFILE%\.codex\keys\sub2api-usage-widget\updater-password.txt
%USERPROFILE%\.codex\keys\sub2api-usage-widget\updater.key.pub
```

Back up the private key and password in a secure location. Do not regenerate or
replace the key for later releases: installed clients trust the existing public
key. Never paste either private file into an issue, source file or build log.
Updater signing is separate from Windows Authenticode publisher signing. No
Windows publisher certificate is configured by this change.

For GitHub builds, the repository owner must add these Actions repository secrets
under Settings → Secrets and variables → Actions:

- `TAURI_SIGNING_PRIVATE_KEY`: the contents of `updater.key`.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the contents of `updater-password.txt`.

The initial Release can be published from the verified local artifacts without
uploading signing secrets. Configure these secrets separately when enabling
cloud signing. The workflow skips builds with a notice until both are configured;
it also skips already published versions without changing their assets.

## Local release

From `usage-panel-design`:

```powershell
pnpm install --frozen-lockfile
pnpm test:data
pnpm test:usage
pnpm test:windows
pnpm test:bench
pnpm test:updates
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
pnpm release:windows
```

The build script reads the protected local signing files without printing them,
generates the NSIS installer/signature, prepares the manifest, and verifies the
real installer with the embedded public key. Verification also rejects a
modified installer without executing it. Output:

```text
release/v0.3.0/Sub2API-Usage_0.3.0_x64-setup.exe
release/v0.3.0/Sub2API-Usage_0.3.0_x64-setup.exe.sig
release/v0.3.0/latest.json
```

Upload these exact three files to the matching `v0.3.0` Release. The manifest's
installer URL includes the tag and the exact filename; renaming assets breaks
updates. Keep all three from the same successful build.

## Subsequent releases

1. Increment `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`
   to the same higher stable version. Refresh the Cargo lockfile for the package
   version and add `docs/releases/vVERSION.md` with the release notes.
2. Run the local release checks. After approved source changes are pushed,
   pushing `vVERSION` triggers the repository-root
   `.github/workflows/release-windows.yml`. Manual workflow dispatch builds
   downloadable artifacts without publishing a release.
3. A tag build prepares a **draft** Release containing the installer, signature
   and `latest.json`. Check that all assets are present, the tag/version matches
   and the installer works, then explicitly publish it as a stable Release and
   make it the latest release. Drafts and prereleases are not a stable update.
   The workflow refuses to replace assets for an already published tag; corrections
   require a higher version and a new tag. Reruns may only update a draft.
4. With 0.3.0 installed on a test machine, check for the higher version, confirm
   the notes, accept installation and verify the new version, saved API settings,
   window/orb behavior and tray. This full upgrade cannot be verified before a
   higher signed release is available. Do not test by publishing a fake version
   or downgrade to all users.

The current manifest contains only `windows-x86_64`. Keep that platform asset in
every stable release while these users depend on it. macOS and Linux update
distribution require their own build/signing/platform entries.
The existing macOS workflow remains available for manual artifact builds and
does not publish or change stable Releases.
