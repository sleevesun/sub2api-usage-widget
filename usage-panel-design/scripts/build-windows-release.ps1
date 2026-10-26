param(
  [string]$KeyFile = (Join-Path $env:USERPROFILE '.codex\keys\sub2api-usage-widget\updater.key'),
  [string]$PasswordFile = (Join-Path $env:USERPROFILE '.codex\keys\sub2api-usage-widget\updater-password.txt')
)
$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$previousKey = $env:TAURI_SIGNING_PRIVATE_KEY
$previousPassword = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
Push-Location -LiteralPath $projectRoot
try {
  if (!$env:TAURI_SIGNING_PRIVATE_KEY) {
    if (!(Test-Path -LiteralPath $KeyFile) -or !(Test-Path -LiteralPath $PasswordFile)) {
      throw 'Updater signing files are missing. Supply the signing environment variables or the protected local key files.'
    }
    $config = Get-Content -LiteralPath 'src-tauri\tauri.conf.json' -Raw | ConvertFrom-Json
    $publicKey = [System.IO.File]::ReadAllText($KeyFile + '.pub').Trim()
    if ($publicKey -ne $config.plugins.updater.pubkey) { throw 'Signing public key does not match this app. Do not replace an existing release key.' }
    $env:TAURI_SIGNING_PRIVATE_KEY = [System.IO.Path]::GetFullPath($KeyFile)
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [System.IO.File]::ReadAllText($PasswordFile).Trim()
  }
  & pnpm exec tauri build --bundles nsis --ci
  if ($LASTEXITCODE -ne 0) { throw 'Signed Windows build failed' }
  & node scripts/prepare-update-release.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Release preparation failed' }
  $releaseConfig = Get-Content -LiteralPath 'src-tauri\tauri.conf.json' -Raw | ConvertFrom-Json
  $releaseFolder = Join-Path $projectRoot ('release\v' + $releaseConfig.version)
  $env:SUB2API_UPDATE_INSTALLER = Join-Path $releaseFolder ('Sub2API-Usage_' + $releaseConfig.version + '_x64-setup.exe')
  $env:SUB2API_UPDATE_MANIFEST = Join-Path $releaseFolder 'latest.json'
  & cargo test --locked --manifest-path src-tauri/Cargo.toml --test updater_signature -- --ignored
  if ($LASTEXITCODE -ne 0) { throw 'Release signature verification failed' }
} finally {
  $env:TAURI_SIGNING_PRIVATE_KEY = $previousKey
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $previousPassword
  Remove-Item Env:\SUB2API_UPDATE_INSTALLER -ErrorAction SilentlyContinue
  Remove-Item Env:\SUB2API_UPDATE_MANIFEST -ErrorAction SilentlyContinue
  Pop-Location
}
