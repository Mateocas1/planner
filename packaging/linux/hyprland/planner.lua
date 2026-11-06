-- Planner on Hyprland (Lua config, Hyprland 0.56+).
--
-- Load it from ~/.config/hypr/hyprland.lua, after Omarchy's defaults, with
-- the path your install used:
--   dofile(os.getenv("HOME") .. "/.local/share/planner/hyprland.lua") -- install-local.sh
--   dofile("/usr/share/planner/hyprland.lua")                          -- the Arch package
-- then validate with `hyprctl reload` and `hyprctl configerrors`.
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

-- Quick add: the same default chord as Windows (Ctrl+Alt+Space; free in
-- Omarchy's defaults). If Day settings use another chord, change it here too.
hl.bind("CTRL + ALT + SPACE", hl.dsp.exec_cmd(run(planner .. " --quickadd")), {
  description = "Planner quick add",
})

-- Quick-add window: a floating palette centered on the focused monitor, at
-- the size the app asks for (Hyprland would otherwise give it half the
-- monitor). It keeps focus while open: with Omarchy's follow_mouse = 1 the
-- first mouse nudge would focus the window under the cursor, and the app
-- hides the palette when it loses focus. Enter, Esc or the chord close it.
-- The page draws its own surface, so no border, shadow or default opacity.
hl.window_rule({
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
hl.window_rule({
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
