# Planner desktop shell (Tauri 2, Windows and Linux)

The React app in `app/` wrapped in a Tauri 2 shell that uses the system webview (WebView2 on Windows, WebKitGTK on Linux; no bundled browser). Windows 10/11 x64 is built from WSL and run on Windows; Linux (Ronda 6, tested on Arch/Hyprland) is built and run natively.

## Linux (native)

Prerequisites: `rustup` (stable), `webkit2gtk-4.1`, `gtk3`, `libsoup3`, `libayatana-appindicator`, `librsvg`, `base-devel`, and `npm ci` in `app/`. `npm run desktop:build:linux` builds `src-tauri/target/release/planner` (embedded assets, no bundle); run it from a graphical session. On Linux the chat key lives in the desktop Secret Service (GNOME Keyring/KWallet), the tray uses AppIndicator/StatusNotifier, and the Windows-only pieces (Mica backdrop, WebView2 memory target, taskbar progress, idle probe) are compiled out; the actionable notifications are XDG notifications (see below). `rust-ini` is pinned to 0.21.1 in `Cargo.lock`: 0.21.3 added `ParseOption` fields that break `tauri-plugin-deep-link` 2.6.2 on Linux.

**Animation flashes on WebKitGTK (Ronda 6 S5).** WebKitGTK 2.54 presents one stale frame when an animation it runs on its compositor (opacity, transform, filter; WAAPI, Motion, CSS transitions and keyframes alike) ends: the New task scrim blinked off as it landed, the sheet vanished for a frame at the end of its flight, a closed sheet flashed back once. On Linux only, the `webkitgtk-marker` plugin (`src/window.rs`) sets `window.__WEBKITGTK__` before any app script, and `main.tsx` installs `src/ui/compositorHandoff.ts`: while a composited animation runs, it adds a no-op `clip-path` effect (the element's own value) that WebKit cannot composite, so the animation runs on the main thread and its last frame is the one committed. The same guard fixes the reduced-motion close, which flashed the whole panel and scrim once before they unmounted (T10c): app.css gives every element a 1 ms `all` transition under reduced motion, and when Motion ends an animation (final value inline, then `cancel()`) WebKit starts that transition from the value *under* the animation, so one frame paints opacity 1. The guard wraps `cancel()` of composited script animations to resolve that commit with `transition-property: none` inline, then restores the inline value (12/12 → 0/12 flashes; `odd/runs/r6-motion2.md`). The task-details View Transition shows no stale frames on WebKitGTK and needs no guard change. Windows never registers the plugin. Rejected: `WEBKIT_DISABLE_DMABUF_RENDERER=1` (no flashes, about 15 fps), `WEBKIT_DISABLE_COMPOSITING_MODE=1` (the transparent window paints only the sheet), and the damage-tracking, multi-commit and GPU-raster switches (no change). Evidence: `odd/runs/r6-motion.md`.

## Hyprland and install (Linux, Ronda 6 phase B)

- **Quick add without a global grab.** Wayland gives apps no global keys (the global-shortcut plugin's X11 grab only sees XWayland windows), so under Wayland (`WAYLAND_DISPLAY` set and `GDK_BACKEND` not starting with `x11`) `quickadd.rs` registers nothing and reports the chord as unregistered; a compositor bind runs `planner --quickadd` instead. `calendar://quickadd` does the same. A second process forwards its arguments through the single-instance plugin, and `deeplink::on_second_instance` toggles the quick-add window without raising `main` (raising it would blur-hide the palette). A cold launch with the trigger keeps `main` hidden and shows quick add once its page has loaded (`quickadd::on_page_load`). The argument check lives in `planner_core::launch` (unit-tested). The trigger also works on Windows, where the global hotkey stays the primary path.
- **Hyprland snippet.** `packaging/linux/hyprland/planner.lua` (Lua config, Hyprland 0.56+, checked with `Hyprland --verify-config`): binds the quick-add chord to `planner --quickadd`, floats and centers quick add at 560×150 with `stay_focused` (Omarchy's `follow_mouse = 1` would otherwise move focus on the first mouse nudge and the palette would hide), and floats, pins and corners the focus pill without taking focus. Wayland clients cannot place themselves, so `set_position` calls are no-ops there and the rules own placement. On Linux the pill window is resizable with equal min and max sizes: GTK sizes a non-resizable window to its content's natural height (65 px), which overrode the 220×44 rule.
- **Chord sync.** Under Wayland, `quickadd.rs` writes the chord chosen in Day settings to `$XDG_DATA_HOME/planner/quickadd.bind` as a Hyprland key string (`CTRL + SHIFT + K`) and, when `HYPRLAND_INSTANCE_SIGNATURE` is set, runs `hyprctl reload`. It does this at startup only when the file differs (a missing file with the default chord stays missing) and on every change. `planner_core::hyprbind` converts with a strict whitelist (four modifiers, letters, digits, F1–F24, a fixed table of named and keypad keys; unit-tested); a chord outside it leaves the bind unchanged. The snippet reads the file as data and checks it against the same whitelist before binding: Hyprland reports an unknown keysym as a config error that `pcall` does not catch, so a missing or invalid line falls back to `CTRL + ALT + space`. A core test keeps the snippet's fallback, path and key table in step with the Rust side.
- **Backdrop.** Opaque by default. `PLANNER_BACKDROP=blur` makes `desktop_backdrop` succeed on Linux, so the page goes translucent as over Mica; use it only with compositor blur on (commented out in the snippet: Omarchy ships blur off).
- **Install.** `packaging/linux/install-local.sh` (per-user: `~/.local/bin`, desktop entry with the `calendar://` handler and a Quick add action, hicolor icons, the snippet in `~/.local/share/planner/`, file list for removal) or `packaging/arch/PKGBUILD` (`makepkg` builds from the checkout into `$srcdir/target`; package `picala-planner`, conflicts with extra/planner over `/usr/bin/planner`). Start at sign-in needs no extra file: `tauri-plugin-autostart` writes `~/.config/autostart/Planner.desktop` with `--autostart`, which uwsm's XDG autostart runs.

## Prerequisites (WSL)

`rustup` with the `x86_64-pc-windows-msvc` target, `cargo-xwin`, `clang`, `lld`, `llvm`, `nsis` (`makensis`), and `npm ci` in `app/`.

## Commands (run in `app/`)

| Command | What it does |
| --- | --- |
| `npm run desktop:dev` | Builds the debug exe, copies `Planner-dev.exe` to the Windows Desktop and starts Vite on `localhost:5173`. Run the exe on Windows; WSL2 forwards `localhost`. |
| `npm run desktop:build` | `vite build` + release exe + NSIS installer (per-user install) in `src-tauri/target/x86_64-pc-windows-msvc/release/`. Runs through `scripts/desktop-build.sh`, which answers tauri-cli's host-side appindicator check with a stub `pkg-config` when the real one (and the library) is missing: that check only feeds the Linux bundlers this build never runs. |
| `npm run desktop:copy` | Copies only the NSIS installer to `/mnt/c/Users/$USER/Desktop` (override with `DESKTOP_DEST` or a first argument). |

`tauri dev` is not used: it tries to launch the built exe from Linux. The debug exe is not built with Tauri's `custom-protocol` feature, so it loads `build.devUrl` (the Vite server) instead of embedded assets.

## Window chrome (T3)

- **Native decorations stay on.** Windows 11 draws the caption buttons (system hovers, red close hover, snap-layouts flyout on maximize hover) and the caption strip (drag, double-click maximize). `tauri-plugin-decorum` was evaluated and rejected: its Windows snap-layout support is a synthetic `Win+Z` keystroke fired after a hover timer, and it injects a full-width drag strip that would swallow clicks on the app's top bar.
- **Mica backdrop (Windows 11).** The main window ships `transparent: true`; `src/window.rs` applies `window-vibrancy` Mica through the `desktop_backdrop` command, re-applied on every theme change with the app's dark/light appearance. On Windows 10 the command errors and the frontend keeps the opaque web design. `src/ui/DesktopShell.tsx` + `DesktopShell.css` own the page-side classes (`desktop-shell`, `desktop-mica`).
- **Window state.** `tauri-plugin-window-state` remembers size, position, maximized state and monitor; it only restores a saved position when some connected monitor contains it, so off-screen states are never restored.
- **Drag region.** The app's top bar carries `data-tauri-drag-region` (header + title span only, so its buttons stay clickable); it is inert in the browser.

## Actionable notifications (T7)

- **Windows toasts with buttons.** `tauri-plugin-notification` cannot add action buttons on desktop, so `notify.rs` draws toasts with `tauri-winrt-notification` (the Tauri-org fork of `winrt-notification` that adds buttons plus an in-process `Activated` handler). The block-start toast carries [Start focus] and [+5 min]; the shutdown nudge carries [Close the day]. Pressed actions are reported to the webview as `notify-action` events; what to notify when, dedupe and snooze live in the frontend's pure half (`src/desktop-notify.ts`), so no decision exists twice.
- **AppUserModelID.** A desktop toast only shows for a registered AUMID. The NSIS installer stamps its shortcuts with the bundle identifier, so the installed app's AUMID is `com.picala.planner` (read from the app config). An exe run from a `target/` build directory is not registered, so dev builds fall back to the PowerShell AUMID (same guard `tauri-plugin-notification` uses): the toast shows with PowerShell's identity and the in-process activation still works.
- **Linux notifications (R7-03).** The same requests become XDG desktop notifications through `notify-rust` (already in the tree through `tauri-plugin-notification`, so no new crate) with the same translated words and buttons, plus the XDG `default` action that servers such as mako invoke on a body click. They stay until answered; a worker thread waits for the answer and reports the same `notify-action` payload as Windows. Dismissing or expiring one reports nothing.
- **Focus Assist / Do Not Disturb** is the OS's own toast behaviour; the app does nothing about it on purpose (S10).

## Tray and close-to-tray (T6)

- **Close hides (L13).** The main window's close button saves the window state *while the window is still visible*, hides it, and leaves the app running for the hotkey, the timer and the tray. Quit lives in the tray menu and is the real exit (it writes the state first, then `app.exit`, and the window-state plugin saves once more on `RunEvent::Exit`).
- **The tray icon** (left click) toggles the main window: it hides the window that is already in front, otherwise it unminimizes, shows and focuses it; a double click always opens. The right-click menu holds the disabled **Up next** line, the focus line while a session runs (`Focus: 18 min left`), **Open Planner** and **Quit**; the tooltip mirrors Up next, and signed out the line reads `Sign in to see Up next`.
- **One notice per install.** The first close shows the toast "Planner is still running in the tray" (`tauri-plugin-notification`, Rust-side only, no JS permission). The shown flag is `tray-notice.shown` in the app config dir, written only after the toast was accepted.
- **Data path.** `src/desktop-tray.ts` words the label from `src/domain/upNext.ts` (the same block pair the sidebar card and Now mode show) and `src/domain/focus.ts`, then pushes `{upNext, focus, progress}` to the `tray_sync` command in `src-tauri/src/tray.rs` — at most one push per 10 s, at least one per minute while focus runs. Rust owns the menu rows, the tooltip and `set_progress_bar` (`Normal` running, `Paused` paused, `None` without a session).

## Start at sign-in (T10)

- **Switch.** Day settings → "Open Planner when I sign in to Windows" (desktop only, off by default). It reads the real state from `tauri-plugin-autostart`, the per-user `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` entry (no admin rights), which launches `Planner.exe --autostart`.
- **Hidden launch.** The main window is created hidden (`visible: false` in `tauri.conf.json`). `src/autostart.rs` shows it for every launch except `--autostart`. `window-state` excludes visibility from its flags, so a saved state can never show a sign-in launch.
- **Reveal rule.** Once the store and profile have loaded, `src/desktop-autostart.ts` (`shouldRevealAtSignIn`) shows the window only when the morning brief applies today: blocks start today and the brief was not dismissed on this device. Otherwise the process stays in the background; the tray (T6) is the way back to it.

## Notes

- **Unsigned.** There is no code-signing certificate. Files copied locally carry no Mark-of-the-Web, so SmartScreen normally stays quiet. If Defender flags a build, submit it to Microsoft for analysis.
- **WebView2** is expected on the machine (preinstalled on Windows 10/11), so the installer does not bundle or download it.
- **Service worker** is skipped inside Tauri (`src/pwa-update.ts`): the assets ship inside the binary.
- **Firebase.** The release window origin is `http://tauri.localhost`, so it uses the production Firebase config. The dev exe origin is `localhost`, so it uses the emulators (`npm run emulators`).
- `src/lib.rs` registers plugins one `.plugin(...)` per line to keep merges simple.

## WebView2 browser args and memory pass (T12)

- **`additionalBrowserArgs` is pinned to wry's default set**, identical on both
  windows (`--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`).
  Setting the key replaces wry's built-in default (`wry 0.57
  `src/webview2/mod.rs``:303`), so the string restates it; the point is control,
  not change — a future wry upgrade cannot silently add or drop process args,
  and the two windows must carry the exact same string because WebView2 only
  coalesces environments with identical options into one shared browser
  process (differing args would spawn a second one).
  - `msWebOOUI`: off — Edge's text-selection "mini menu" overlay (wry
    [#535](https://github.com/tauri-apps/wry/issues/535)); the app never uses it.
  - `msPdfOOUI`: off — Edge's PDF reader overlay UI; the shell never opens PDFs.
  - `msSmartScreenProtection`: off — SmartScreen checks on webview downloads
    (tauri-apps/tauri[#1345](https://github.com/tauri-apps/tauri/issues/1345));
    the app downloads nothing (Google import goes through the system browser).
- **Nothing else is added, on purpose.** GPU-affecting switches would break S3
  motion smoothness; `--disable-component-update` would starve spellcheck
  dictionaries of a feature the app's text fields use; other Edge feature
  names are undocumented for WebView2. The memory lever is
  `ICoreWebView2_19::SetMemoryUsageTargetLevel` (the documented WebView2 API,
  `src/memory.rs`) applied while a window is hidden or minimized, not
  command-line features.

## Chat (desktop LLM panel)

- **Key storage (S3).** The user's OpenAI-compatible API key lives only in the Windows Credential Manager (service `com.picala.planner`, user `chat-api-key`, `keyring` crate with the `windows-native` backend). The webview gets `chat_key_status() -> { hasKey, baseUrl }`, `chat_key_set(key, baseUrl)` and `chat_key_clear()`; the key itself is never returned to the page, never logged, and never written to disk by the app. Keys that are empty, over 512 characters or contain control characters (CRLF header injection) are rejected, as are URLs with userinfo. The non-secret provider address is validated in Rust and stored in `chat-provider.json` next to the memory file, bound to the key: changing provider means setting the key again. The webview never sends a base URL per call, and rejection messages never echo the URL.
- **Streaming (S3).** `chat_stream(request, on_event)` reads the stored provider address and runs in a `std::thread` on the existing `ureq` dependency (no tokio/reqwest): POST `{base_url}/chat/completions` with `stream: true`, SSE decoded line by line in `planner_core::chat` (unit-tested on Linux) and reported as `ChatEvent`s over a Tauri `Channel` — `reasoning` once when `delta.reasoning_content` first appears, `delta` per content piece, then `done`/`cancelled`/`error` with the contract's snake_case codes (401/403 → `unauthorized`, 429 → `rate_limited`, transport failures → `network`, anything else → `provider`, no key → `no_key`, bad address → `invalid_request`). Base URLs must be `https://` (or `http://` on `localhost`/`127.0.0.1`), without userinfo. Connect timeout 15 s; each read times out after 5 s and the stream keeps waiting (checking the cancel flag) until 300 s pass without data, so `chat_cancel(id)` is observable within seconds even while the provider stalls. SSE lines over 1 MiB fail the stream as `provider`. A duplicate in-flight request id is rejected, and at most 4 streams run at once; a worker removes its registry entry only while it still owns the id. `chat_complete(request)` (memory extraction) is async and runs its blocking HTTP work on Tauri's blocking pool.
- **Memory store (S5).** Durable memories persist in `chat-memories.json` in the app data dir (`app_local_data_dir`), owned by `chat/memory_store.rs` and reached from the webview only through `chat_memories_list/apply/delete/clear`. Writes are atomic (temp file in the same dir → `write_all` → `sync_all` → rename). Load classification: a missing file is an empty store; a corrupt file is moved aside under a unique timestamped backup (`chat-memories.json.bak-<ms>-<seq>`, at most 3 kept) and the store starts empty; any other read error (permissions, sharing violation, invalid UTF-8) refuses to load and every write command refuses to run, so a transient failure can never wipe the file. Caps live in `planner_core::chat`: at most 200 memories (a full store drops new topics in place, never evicts), content truncated to 2000 characters, titles truncated to 200, topic keys at most 120 characters, and at most 64 ops per `apply` call — more rejects the whole call. Upserts are keyed by `topicKey` and never duplicate.
- The provider base URL and model are non-secret settings (task C3); the default provider is `https://api.nan.builders/v1`.

## Per-window command ACL (ronda3 S3)

Tauri's ACL gates every custom command per window. `build.rs` declares all commands in a `tauri_build::AppManifest` (`tauri_build::Attributes::new().app_manifest(...)`), which makes tauri-build autogenerate an `allow-<command>` / `deny-<command>` permission pair for each (underscores become dashes, e.g. `chat_key_set` → `allow-chat-key-set`) into `src-tauri/permissions/autogenerated/` (gitignored build output). A window can only invoke a command granted through one of its capabilities in `capabilities/*.json` (`default.json` → `main`, `pill.json` → `pill`, `quickadd.json` → `quickadd`); anything else is denied at the IPC boundary. Secret/key, chat, memory, Engram, OAuth, deep-link, tray, idle and notification commands are `main`-only; the pill gets only its three `pill_*` commands and quick-add only `desktop_backdrop` + `quickadd_focus_main`.

`core/tests/acl.rs` keeps the three sources in sync: every `generate_handler!` command must be in the `AppManifest`, every manifest command must be granted to at least one window, no sensitive command may be granted to `pill`/`quickadd`, and capabilities may only reference app permissions the manifest generates.

**Adding a command.** (1) Implement it and register it in `generate_handler!` in `src/lib.rs`. (2) Add its snake_case name to the `COMMANDS` const in `build.rs`. (3) Invoke it only from the window(s) you grant: add `allow-<command-with-dashes>` to the matching capability file in `capabilities/` (`default.json` for main-window code under `App.tsx`/`ui/`/`chat/`/`data/`, `pill.json` only for `ui/FocusPill.tsx`, `quickadd.json` only for `ui/QuickAddWindow.tsx`). `cargo test` in `src-tauri/core` fails if any step is skipped or if a sensitive command reaches an auxiliary window.

## Content Security Policy

Set in `tauri.conf.json` (`app.security.csp`); `devCsp` is `null` so the dev exe can reach Vite HMR and the emulators. Tauri adds a hash for the one inline theme script in `index.html` at build time. Not runtime-verified from WSL: if login, sync or import breaks on Windows, look for CSP violations in WebView2 DevTools first.

| Directive | Value | Why |
| --- | --- | --- |
| `default-src` | `'self'` | Everything not listed below is same-origin only. |
| `script-src` | `'self'` | No remote or injected script; the theme bootstrap is allowed by Tauri's hash. |
| `style-src` | `'self' 'unsafe-inline'` | The UI sets inline styles (motion, drag, sizing). |
| `style-src-attr` | `'unsafe-inline'` | Keeps `style=""` attributes working even if Tauri adds a nonce to `style-src`. |
| `img-src` | `'self' data: blob:` | Bundled icons, CSS data-URI masks, generated blobs. |
| `font-src` | `'self' data:` | Self-hosted Onest font files. |
| `connect-src` | `'self' ipc: http://ipc.localhost` + `https://firestore.googleapis.com`, `wss://firestore.googleapis.com`, `https://identitytoolkit.googleapis.com`, `https://securetoken.googleapis.com`, `https://www.googleapis.com` | Tauri IPC; Firestore (fetch long-poll/WebChannel; `wss` included defensively); Firebase Auth sign-in and token refresh; Google Calendar REST. |
| `frame-src` | `https://cumbia-4ca6e.firebaseapp.com` | Firebase Auth's helper iframe. Email/password does not use it today; kept in case the SDK opens it. |
| `worker-src` | `'self' blob:` | Defensive; the app registers no worker in the shell. |
| `object-src` | `'none'` | No plugins. |
| `base-uri`, `form-action` | `'self'` | Blocks base-tag and form-post hijacking. |

Not allowed on purpose: `https://apis.google.com` and `accounts.google.com` scripts (Firebase popup auth and Google Identity Services are not used in the desktop shell; the Google import goes through the system browser).

`dangerousDisableAssetCspModification: ["style-src"]` keeps Tauri from adding nonces/hashes to `style-src`: a nonce would void `'unsafe-inline'`, and React 19 and Motion inject `<style>` elements and `insertRule` at runtime. Scripts still get Tauri's automatic hashes.
