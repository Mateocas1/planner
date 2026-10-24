#!/usr/bin/env bash
# Copies the Windows desktop artifacts built from WSL to the Windows Desktop.
# Usage: scripts/desktop-copy.sh [dest-dir]   (default: /mnt/c/Users/$USER/Desktop)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="${1:-${DESKTOP_DEST:-/mnt/c/Users/$USER/Desktop}}"
target="$root/src-tauri/target/x86_64-pc-windows-msvc"
release="$target/release"

[ -d "$dest" ] || { echo "desktop-copy: destination '$dest' not found" >&2; exit 1; }

copied=0
copy() { cp -f "$1" "$dest/$2" && echo "copied $2 ($(du -h "$1" | cut -f1))" && copied=1; }

installer="$(ls -t "$release"/bundle/nsis/*-setup.exe 2>/dev/null | head -n1 || true)"
[ -n "$installer" ] && copy "$installer" "$(basename "$installer")"
# Only the installer: a loose release exe on the Desktop runs beside the installed
# app and looked like a single-instance failure (two windows).

if [ "$copied" = 0 ]; then
  echo "desktop-copy: nothing to copy; run 'npm run desktop:build' first" >&2
  exit 1
fi
