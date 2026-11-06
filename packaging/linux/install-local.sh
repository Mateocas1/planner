#!/usr/bin/env bash
# Installs Planner for the current user only (no root):
#
#   packaging/linux/install-local.sh [path/to/planner]
#
# - the binary            -> ${XDG_BIN_HOME:-~/.local/bin}/planner
# - the desktop entry     -> $XDG_DATA_HOME/applications/com.picala.planner.desktop
#   (launcher entry, "Quick add" action, handler for calendar:// links)
# - the icons             -> $XDG_DATA_HOME/icons/hicolor/<size>/apps/com.picala.planner.png
# - the Hyprland snippet  -> $XDG_DATA_HOME/planner/hyprland.lua (not loaded until
#   you add the dofile line it prints to ~/.config/hypr/hyprland.lua)
# - a list of every file written -> $XDG_DATA_HOME/planner/installed-files
#
# Start at sign-in needs nothing here: the in-app switch writes
# ~/.config/autostart/Planner.desktop pointing at the running binary, which
# uwsm/systemd starts at login. Enable it from the installed binary, not a
# build in target/, so the entry points at ~/.local/bin/planner.
#
# The default binary is the release build of `npm run desktop:build:linux`.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
binary="${1:-$repo/app/src-tauri/target/release/planner}"
icons="$repo/app/src-tauri/icons"
app_id="com.picala.planner"

[ -n "${HOME:-}" ] || { echo "install-local: HOME is not set" >&2; exit 1; }
if [ ! -x "$binary" ]; then
  echo "install-local: no executable at $binary (run 'npm run desktop:build:linux' in app/ first)" >&2
  exit 1
fi

bin_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
data_dir="${XDG_DATA_HOME:-$HOME/.local/share}"
apps_dir="$data_dir/applications"
share_dir="$data_dir/planner"
manifest="$share_dir/installed-files"
target="$bin_dir/planner"
case "$target" in
  *[[:space:]\"\'\\]*) echo "install-local: $target has spaces or quotes; set XDG_BIN_HOME to a plain path" >&2; exit 1 ;;
esac

mkdir -p "$bin_dir" "$apps_dir" "$share_dir"
: > "$manifest"
record() { printf '%s\n' "$1" >> "$manifest"; }

install -m755 "$binary" "$target"
record "$target"

# The launcher may not have ~/.local/bin on its PATH: point Exec at the binary.
sed "s|^Exec=planner|Exec=$target|" "$here/$app_id.desktop" > "$apps_dir/$app_id.desktop"
chmod 644 "$apps_dir/$app_id.desktop"
record "$apps_dir/$app_id.desktop"

for size in 32 64 128 256 512; do
  case "$size" in
    256) source_icon="$icons/128x128@2x.png" ;;
    512) source_icon="$icons/icon.png" ;;
    *) source_icon="$icons/${size}x${size}.png" ;;
  esac
  icon_dir="$data_dir/icons/hicolor/${size}x${size}/apps"
  mkdir -p "$icon_dir"
  install -m644 "$source_icon" "$icon_dir/$app_id.png"
  record "$icon_dir/$app_id.png"
done

sed "s|^local planner = \"planner\"|local planner = \"$target\"|" "$here/hyprland/planner.lua" > "$share_dir/hyprland.lua"
chmod 644 "$share_dir/hyprland.lua"
record "$share_dir/hyprland.lua"
record "$manifest"

# Caches and the calendar:// handler; each step is optional.
if command -v update-desktop-database > /dev/null; then
  update-desktop-database "$apps_dir" || true
fi
if command -v gtk-update-icon-cache > /dev/null && [ -f "$data_dir/icons/hicolor/index.theme" ]; then
  gtk-update-icon-cache -q -t "$data_dir/icons/hicolor" || true
fi
if command -v xdg-mime > /dev/null; then
  # Writes the default to mimeapps.list (a shared file: not in the list above).
  mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}"
  xdg-mime default "$app_id.desktop" x-scheme-handler/calendar || true
fi

cat <<EOF
Planner installed for $(id -un):
  binary         $target
  desktop entry  $apps_dir/$app_id.desktop
  icons          $data_dir/icons/hicolor/*/apps/$app_id.png
  installed list $manifest  (remove with: xargs rm -f < "$manifest")

Hyprland (global quick add, floating quick-add and timer windows): add this line
to ~/.config/hypr/hyprland.lua, then run 'hyprctl reload' and 'hyprctl configerrors':
  dofile("$share_dir/hyprland.lua")
EOF
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "Note: $bin_dir is not on PATH; the desktop entry and the snippet use the full path." ;;
esac
