-- Planner on Hyprland (Lua config, Hyprland 0.56+).
--
-- Load it from ~/.config/hypr/hyprland.lua, after Omarchy's defaults, with
-- the path your install used:
--   pcall(dofile, os.getenv("HOME") .. "/.local/share/planner/hyprland.lua") -- install-local.sh
--   pcall(dofile, "/usr/share/planner/hyprland.lua")                          -- the Arch package
-- then validate with `hyprctl reload` and `hyprctl configerrors`. pcall keeps
-- the rest of your config loading once Planner is uninstalled (the file is
-- gone) or if a Hyprland update rejects a rule below.
--
-- Wayland does not let an app grab global keys, so the quick-add chord is a
-- compositor bind that runs `planner --quickadd`; the running Planner gets the
-- request through its single-instance channel and toggles the quick-add
-- window (a cold launch opens it too). The window rules give the two small
-- windows what Windows gives them through always-on-top and positioning,
-- which a Wayland client cannot set itself.

-- install-local.sh rewrites this line with the absolute path it installed.
local planner = "planner"

-- Planner's Wayland app id (the binary name).
local class = "^(planner)$"

local function run(command)
  -- Omarchy's helper scopes the process like other launched apps.
  if o and o.launch then
    return o.launch(command)
  end
  return command
end

-- Quick add: the chord chosen in Day settings. Planner writes it, in
-- Hyprland's key-string form, to $XDG_DATA_HOME/planner/quickadd.bind and runs
-- `hyprctl reload`; the file is read as data, never run. Without the file, or
-- when its line is not modifiers plus one known key, the default chord
-- applies: Ctrl+Alt+Space, as on Windows and free in Omarchy's defaults.
-- (Hyprland reports an unknown key as a config error rather than a Lua error,
-- so the line is checked against the keys Planner writes before binding.)
local default_chord = "CTRL + ALT + space"

local modifiers = { CTRL = true, ALT = true, SHIFT = true, SUPER = true }
local named_keys = {
  space = true, Return = true, Tab = true, Escape = true, BackSpace = true,
  Delete = true, Insert = true, Home = true, End = true, Page_Up = true,
  Page_Down = true, Up = true, Down = true, Left = true, Right = true,
  comma = true, period = true, slash = true, grave = true, minus = true,
  equal = true, bracketleft = true, bracketright = true, semicolon = true,
  apostrophe = true, backslash = true, KP_Add = true, KP_Subtract = true,
  KP_Multiply = true, KP_Divide = true, KP_Decimal = true, KP_Enter = true,
}

local function known_key(key)
  if named_keys[key] or key:match("^[A-Z0-9]$") or key:match("^KP_[0-9]$") then
    return true
  end
  local n = tonumber(key:match("^F([1-9][0-9]?)$"))
  return n ~= nil and n <= 24
end

-- "CTRL + ALT + space": one or more distinct modifiers, then one known key.
local function valid_chord(line)
  local tokens, seen = {}, {}
  for token in (line .. " + "):gmatch("(.-) %+ ") do
    tokens[#tokens + 1] = token
  end
  if #tokens < 2 or table.concat(tokens, " + ") ~= line then
    return false
  end
  for i = 1, #tokens - 1 do
    if not modifiers[tokens[i]] or seen[tokens[i]] then
      return false
    end
    seen[tokens[i]] = true
  end
  return known_key(tokens[#tokens])
end

local function chosen_chord()
  local data = os.getenv("XDG_DATA_HOME")
  if not (data and data:sub(1, 1) == "/") then
    data = (os.getenv("HOME") or "") .. "/.local/share"
  end
  local file = io.open(data .. "/planner/quickadd.bind", "r")
  if not file then
    return nil
  end
  local line = file:read("*l")
  file:close()
  if line and #line <= 80 and valid_chord(line) then
    return line
  end
  return nil
end

hl.bind(chosen_chord() or default_chord, hl.dsp.exec_cmd(run(planner .. " --quickadd")), {
  description = "Planner quick add",
})

-- Every Planner window is fully opaque. Omarchy gives every window a default
-- opacity (0.985 active, 0.96 inactive), which lets the wallpaper show through
-- the page and makes the compositor redraw what is behind the window on every
-- animation frame. The page paints its own opaque background on Linux.
pcall(hl.window_rule, {
  match = { class = class },
  tag = "-default-opacity",
  opacity = "1 1",
})

-- Quick-add window: a floating palette centered on the focused monitor, at
-- the size the app asks for (Hyprland would otherwise give it half the
-- monitor). It keeps focus while open: with Omarchy's follow_mouse = 1 the
-- first mouse nudge would focus the window under the cursor, and the app
-- hides the palette when it loses focus. Enter, Esc or the chord close it.
-- The page draws its own surface, so no border, shadow or default opacity.
-- Each rule goes through pcall: a field a Hyprland release no longer knows
-- raises a Lua error, which would otherwise skip the rules after it.
pcall(hl.window_rule, {
  match = { class = class, title = "^(Quick add)$" },
  float = true,
  center = true,
  stay_focused = true,
  size = { 560, 150 },
  border_size = 0,
  no_shadow = true,
  tag = "-default-opacity",
  opacity = "1 1",
})

-- Focus-timer pill: floating, pinned to every workspace (the always-on-top of
-- Windows), top-right corner, and never takes focus when it appears.
pcall(hl.window_rule, {
  match = { class = class, title = "^(Focus timer)$" },
  float = true,
  pin = true,
  no_initial_focus = true,
  size = { 220, 44 },
  move = { "(monitor_w-window_w-24)", "(monitor_h*0.04)" },
  border_size = 0,
  no_shadow = true,
  tag = "-default-opacity",
  opacity = "1 1",
})

-- Optional translucent backdrop (the Linux stand-in for Mica). Omarchy ships
-- with blur off, and turning it on changes every translucent window, so it is
-- left to you. To try it: uncomment the line below, start Planner with
-- PLANNER_BACKDROP=blur in its environment (e.g. `Exec=env PLANNER_BACKDROP=blur
-- planner` in the desktop entry), and restart Planner. The page then drops its
-- opaque background the way it does over Mica.
-- hl.config({ decoration = { blur = { enabled = true, size = 8, passes = 2 } } })
