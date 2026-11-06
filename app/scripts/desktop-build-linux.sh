#!/usr/bin/env bash
# Native Linux release build: `npm run desktop:build:linux`.
#
# Runs `vite build` (tauri's beforeBuildCommand) and a release `cargo build`
# with the embedded assets, without a bundle: the binary lands in
# src-tauri/target/release/planner and runs in place. Needs webkit2gtk-4.1,
# gtk3, libsoup3 and libayatana-appindicator (all present on Omarchy/Arch).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

cd "$root"
exec npx tauri build --no-bundle "$@"
