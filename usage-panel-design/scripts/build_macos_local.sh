#!/usr/bin/env bash
# Build Sub2API Usage Widget natively on macOS
# Usage: ./build_macos_local.sh
# Prerequisites:
#   - macOS 12+ (Monterey)
#   - Xcode Command Line Tools: xcode-select --install
#   - Rust: https://sh.rustup.rs
#   - Node.js 18+: https://nodejs.org  (or `nvm install 20`)
#   - pnpm: npm install -g pnpm

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${PROJECT_ROOT}"

# ---- helpers ----
pass() { echo -e "\033[32m✔\033[0m $1"; }
info() { echo -e "\033[36mℹ\033[0m $1"; }
warn() { echo -e "\033[33m!\033[0m $1"; }
fail() { echo -e "\033[31m✘\033[0m $1" >&2; exit 1; }

# ---- preflight ----
info "Checking build environment..."
[[ "$(uname -s)" == "Darwin" ]] || fail "This script only runs on macOS."

if ! command -v xcodebuild >/dev/null 2>&1 && ! xcode-select -p >/dev/null 2>&1; then
  warn "Xcode Command Line Tools missing. Install with:"
  echo "    xcode-select --install"
  exit 1
fi
pass "Xcode Command Line Tools"

if ! command -v rustc >/dev/null 2>&1; then
  warn "Rust toolchain missing. Install with:"
  echo "    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  exit 1
fi
pass "Rust toolchain: $(rustc --version)"

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js missing (>=18 required). Install via: nvm install 20"
fi
NODE_MAJOR="$(node -v | sed -E 's/v([0-9]+).*/\1/')"
[[ "${NODE_MAJOR}" -ge 18 ]] || fail "Node.js >=18 required, got v$(node -v)"
pass "Node.js: $(node -v)"

if ! command -v pnpm >/dev/null 2>&1; then
  info "pnpm missing, installing via npm..."
  npm install -g pnpm
fi
pass "pnpm: $(pnpm --version)"

# ---- install frontend deps ----
info "Installing / verifying frontend dependencies..."
if [ -f pnpm-lock.yaml ]; then
  pnpm install --frozen-lockfile || pnpm install
else
  pnpm install
fi
pass "Frontend dependencies ready"

# ---- build ----
info "Starting Tauri build (Apple Silicon + Intel both require native toolchain)..."
info "  This will build a .app matching your macOS CPU architecture."
info "  Expect 5-15 minutes on first run (Rust crates compile)."
echo ""

export CI=true
export TAURI_SKIP_SIGNING=true
export APPLE_SIGNING_IDENTITY=""
export APPLE_CERTIFICATE=""
export APPLE_CERTIFICATE_PASSWORD=""

pnpm tauri build

# ---- summary ----
BUNDLE_DIR="${PROJECT_ROOT}/src-tauri/target/release/bundle/macos"
echo ""
pass "Build complete!"
echo ""
echo "Artifacts:"
ls -lah "${BUNDLE_DIR}" | tail -n +2
echo ""
echo "To run locally (unsigned):"
echo "    Right-click '${BUNDLE_DIR}/Sub2API Usage.app' → Open"
echo ""
echo "Or remove quarantine attribute then open:"
echo "    xattr -dr com.apple.quarantine \"${BUNDLE_DIR}/Sub2API Usage.app\""
echo ""
echo "To distribute, zip the .app:"
echo "    cd \"${BUNDLE_DIR}\" && zip -r ~/Desktop/Sub2API-Usage-macOS.zip \"Sub2API Usage.app\""
