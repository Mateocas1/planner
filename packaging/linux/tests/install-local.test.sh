#!/usr/bin/env bash
# Installs and uninstalls Planner into a throwaway home, never the real one:
#
#   packaging/linux/tests/install-local.test.sh
#
# HOME and the XDG dirs point into a temp dir (the data dir has a space in
# its path), and hyprctl, xdg-mime and the cache tools are stubs on PATH.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/../install-local.sh"
snippet="$here/../hyprland/planner.lua"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

failures=0
fail() { echo "FAIL: $1" >&2; failures=$((failures + 1)); }

mkdir -p "$tmp/home" "$tmp/stubs" "$tmp/bin"
for tool in hyprctl xdg-mime update-desktop-database gtk-update-icon-cache; do
  printf '#!/bin/sh\necho "%s $*" >> "%s/stub-calls"\n' "$tool" "$tmp" > "$tmp/stubs/$tool"
  chmod +x "$tmp/stubs/$tool"
done
printf '#!/bin/sh\necho planner\n' > "$tmp/planner-build"
chmod +x "$tmp/planner-build"

export HOME="$tmp/home"
export XDG_BIN_HOME="$tmp/bin"
export XDG_DATA_HOME="$tmp/my data"
export XDG_CONFIG_HOME="$tmp/config"
export PATH="$tmp/stubs:$PATH"
share="$XDG_DATA_HOME/planner"

# Install: every listed path exists, and the printed load line is guarded.
out="$("$script" "$tmp/planner-build")" || fail "install exited non-zero"
[ -s "$share/installed-files" ] || fail "no manifest"
while IFS= read -r path; do
  [ -e "$path" ] || fail "listed but missing: $path"
done < "$share/installed-files"
grep -qF "pcall(dofile, \"$share/hyprland.lua\")" <<< "$out" || fail "install does not print pcall(dofile, ...)"
grep -qF -- "--uninstall" <<< "$out" || fail "install does not mention --uninstall"

# The app writes the chord file later; a listed path with a quote must go too.
printf 'CTRL + K\n' > "$share/quickadd.bind"
odd="$XDG_DATA_HOME/it's \"odd\".txt"
: > "$odd"
printf '%s\n' "$odd" >> "$share/installed-files"
cp "$share/installed-files" "$tmp/listed"

# Uninstall: no listed path, no chord file, and the line to delete is printed.
out="$("$script" --uninstall)" || fail "uninstall exited non-zero"
while IFS= read -r path; do
  [ ! -e "$path" ] || fail "still present after uninstall: $path"
done < "$tmp/listed"
[ ! -e "$share/quickadd.bind" ] || fail "quickadd.bind left behind"
grep -qF "pcall(dofile, \"$share/hyprland.lua\")" <<< "$out" || fail "uninstall does not print the line to delete"
if grep -q '^hyprctl' "$tmp/stub-calls" 2>/dev/null; then fail "hyprctl was called"; fi

# A second uninstall has nothing to read and says so.
if "$script" --uninstall > /dev/null 2>&1; then fail "uninstall without a manifest succeeded"; fi

# The snippet: every window rule goes through pcall, and a rule Hyprland
# rejects with a Lua error does not stop the bind or the other rule.
if grep -nE '^[[:space:]]*hl\.window_rule\(' "$snippet"; then fail "unguarded hl.window_rule"; fi
if command -v lua > /dev/null; then
  lua_out="$(HOME="$tmp/home" XDG_DATA_HOME="$tmp/none" lua - "$snippet" 2>&1 <<'LUA'
    local binds, rules = 0, 0
    hl = {
      dsp = { exec_cmd = function(c) return c end },
      bind = function() binds = binds + 1 end,
      window_rule = function() rules = rules + 1; error("unknown field") end,
    }
    dofile(arg[1])
    io.write(binds, " ", rules)
LUA
)" || fail "snippet raised past a failing window rule: $lua_out"
  [ "$lua_out" = "1 2" ] || fail "expected 1 bind and 2 rules, got: $lua_out"
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures failure(s)" >&2
  exit 1
fi
echo "install-local: ok"
