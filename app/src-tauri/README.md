# Planner desktop shell (Tauri 2, Windows)

The React app in `app/` wrapped in a Tauri 2 shell that uses the system WebView2 (no bundled browser). Windows 10/11 x64 is the only target. Everything is built from WSL; Windows executables cannot be run from WSL, so you run them on Windows.

## Prerequisites (WSL)

`rustup` with the `x86_64-pc-windows-msvc` target, `cargo-xwin`, `clang`, `lld`, `llvm`, `nsis` (`makensis`), and `npm ci` in `app/`.

## Commands (run in `app/`)

| Command | What it does |
| --- | --- |
| `npm run desktop:dev` | Builds the debug exe, copies `Planner-dev.exe` to the Windows Desktop and starts Vite on `localhost:5173`. Run the exe on Windows; WSL2 forwards `localhost`. |
| `npm run desktop:build` | `vite build` + release exe + NSIS installer (per-user install) in `src-tauri/target/x86_64-pc-windows-msvc/release/`. |
| `npm run desktop:copy` | Copies only the NSIS installer to `/mnt/c/Users/$USER/Desktop` (override with `DESKTOP_DEST` or a first argument). |

`tauri dev` is not used: it tries to launch the built exe from Linux. The debug exe is not built with Tauri's `custom-protocol` feature, so it loads `build.devUrl` (the Vite server) instead of embedded assets.

## Window chrome (T3)

- **Native decorations stay on.** Windows 11 draws the caption buttons (system hovers, red close hover, snap-layouts flyout on maximize hover) and the caption strip (drag, double-click maximize). `tauri-plugin-decorum` was evaluated and rejected: its Windows snap-layout support is a synthetic `Win+Z` keystroke fired after a hover timer, and it injects a full-width drag strip that would swallow clicks on the app's top bar.
- **Mica backdrop (Windows 11).** The main window ships `transparent: true`; `src/window.rs` applies `window-vibrancy` Mica through the `desktop_backdrop` command, re-applied on every theme change with the app's dark/light appearance. On Windows 10 the command errors and the frontend keeps the opaque web design. `src/ui/DesktopShell.tsx` + `DesktopShell.css` own the page-side classes (`desktop-shell`, `desktop-mica`).
- **Window state.** `tauri-plugin-window-state` remembers size, position, maximized state and monitor; it only restores a saved position when some connected monitor contains it, so off-screen states are never restored.
- **Drag region.** The app's top bar carries `data-tauri-drag-region` (header + title span only, so its buttons stay clickable); it is inert in the browser.

## Notes

- **Unsigned.** There is no code-signing certificate. Files copied locally carry no Mark-of-the-Web, so SmartScreen normally stays quiet. If Defender flags a build, submit it to Microsoft for analysis.
- **WebView2** is expected on the machine (preinstalled on Windows 10/11), so the installer does not bundle or download it.
- **Service worker** is skipped inside Tauri (`src/pwa-update.ts`): the assets ship inside the binary.
- **Firebase.** The release window origin is `http://tauri.localhost`, so it uses the production Firebase config. The dev exe origin is `localhost`, so it uses the emulators (`npm run emulators`).
- `src/lib.rs` registers plugins one `.plugin(...)` per line to keep merges simple.

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
