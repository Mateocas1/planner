#!/usr/bin/env bash
# Release build (exe + NSIS installer) from WSL: `npm run desktop:build`.
#
# The tauri CLI runs a *host-Linux* tray check whenever the `tray-icon`
# feature is enabled: it asks pkg-config where the appindicator library is so
# the deb/appimage metadata can depend on it. That metadata is only read by the
# Linux bundlers, which this Windows-only cross build never runs, but the CLI
# panics ("Can't detect any appindicator library") when pkg-config cannot
# answer -- and this box has neither pkg-config nor libappindicator, and no
# sudo to install them. So when the real answer is missing, a stub pkg-config
# on PATH replies with a `-L` path; nothing else is faked and the NSIS bundle
# is unaffected. Installing `pkg-config libayatana-appindicator3-dev` makes
# the stub unnecessary (the script then does not install it).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

stub=""
if ! pkg-config --libs-only-L ayatana-appindicator3-0.1 >/dev/null 2>&1; then
  stub="$(mktemp -d)"
  trap 'rm -rf "$stub"' EXIT
  cat > "$stub/pkg-config" <<'EOF'
#!/bin/sh
# tauri-cli only ever runs: pkg-config --libs-only-L <libname>
case "$1" in
  --libs-only-L) printf '%s\n' "-L/tmp" ;;
  *) exit 1 ;;
esac
EOF
  chmod +x "$stub/pkg-config"
fi

cd "$root"
PATH="${stub:+$stub:}$PATH" exec npx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc
