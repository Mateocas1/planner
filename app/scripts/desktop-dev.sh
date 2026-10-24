#!/usr/bin/env bash
# Desktop dev loop from WSL.
#
# `tauri dev` cannot be used here: it launches the freshly built exe itself, and
# a Windows exe cannot be started from WSL (no interop). Instead this builds the
# debug exe (which loads `build.devUrl`, the Vite dev server, because it is not
# built with the `custom-protocol` feature), copies it to the Windows Desktop and
# keeps Vite running. WSL2 forwards localhost, so the Windows webview reaches it.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="${DESKTOP_DEST:-/mnt/c/Users/$USER/Desktop}"
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

cd "$root/src-tauri"
cargo xwin build --target x86_64-pc-windows-msvc
cp -f target/x86_64-pc-windows-msvc/debug/planner.exe "$dest/Planner-dev.exe"
echo "Copied Planner-dev.exe to $dest. Run it on Windows; it loads http://localhost:5173."

cd "$root"
exec npx vite --host 127.0.0.1 --port 5173 --strictPort
