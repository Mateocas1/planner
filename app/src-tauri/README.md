# Planner desktop shell (Tauri 2, Windows)

The React app in `app/` wrapped in a Tauri 2 shell that uses the system WebView2 (no bundled browser). Windows 10/11 x64 is the only target. Everything is built from WSL; Windows executables cannot be run from WSL, so you run them on Windows.

## Prerequisites (WSL)

`rustup` with the `x86_64-pc-windows-msvc` target, `cargo-xwin`, `clang`, `lld`, `llvm`, `nsis` (`makensis`), and `npm ci` in `app/`.

## Commands (run in `app/`)

| Command | What it does |
| --- | --- |
| `npm run desktop:dev` | Builds the debug exe, copies `Planner-dev.exe` to the Windows Desktop and starts Vite on `localhost:5173`. Run the exe on Windows; WSL2 forwards `localhost`. |
| `npm run desktop:build` | `vite build` + release exe + NSIS installer (per-user install) in `src-tauri/target/x86_64-pc-windows-msvc/release/`. |
| `npm run desktop:copy` | Copies the NSIS installer and `Planner.exe` to `/mnt/c/Users/$USER/Desktop` (override with `DESKTOP_DEST` or a first argument). |

`tauri dev` is not used: it tries to launch the built exe from Linux. The debug exe is not built with Tauri's `custom-protocol` feature, so it loads `build.devUrl` (the Vite server) instead of embedded assets.

## Notes

- **Unsigned.** There is no code-signing certificate. Files copied locally carry no Mark-of-the-Web, so SmartScreen normally stays quiet. If Defender flags a build, submit it to Microsoft for analysis.
- **WebView2** is expected on the machine (preinstalled on Windows 10/11), so the installer does not bundle or download it.
- **Service worker** is skipped inside Tauri (`src/pwa-update.ts`): the assets ship inside the binary.
- **Firebase.** The release window origin is `http://tauri.localhost`, so it uses the production Firebase config. The dev exe origin is `localhost`, so it uses the emulators (`npm run emulators`).
- `src/lib.rs` registers plugins one `.plugin(...)` per line to keep merges simple.
