# Planner

A personal planner for tasks, date-only deadlines and time blocks. It works offline, syncs across
your own devices through Firestore, runs as a desktop app on Windows and Linux (Tauri 2), and has
an AI assistant that can read your plan and propose changes you confirm one by one.

[![CI](https://github.com/Mateocas1/planner/actions/workflows/ci.yml/badge.svg)](https://github.com/Mateocas1/planner/actions/workflows/ci.yml)

| Today | Tasks | Calendar |
| --- | --- | --- |
| ![Today](docs/screenshots/today.png) | ![Tasks](docs/screenshots/tasks.png) | ![Calendar](docs/screenshots/calendar.png) |

<p align="center"><img src="docs/screenshots/today-phone.png" width="320" alt="Today on a phone"></p>

The screenshots are captured by `app/scripts/ui-capture.mjs` against the local emulators.

## Status

- Personal project with one user, the author. No sharing, teams or roles.
- A web build is hosted at <https://cumbia-4ca6e.web.app>. It was deployed on 2026-10-21
  (HTTP 200, `last-modified` header checked on 2026-11-11), so it is older than this branch
  and does not include the desktop-only features.
- Desktop builds are made locally (a Windows NSIS installer and a Linux binary). There is no
  release or download link.

## How it was built

I design, decide and verify: I define the tests, the review criteria and the measurements.
AI agents write much of the code under those tests and that review.

## Stack

- **App:** React 19, TypeScript 5.9, Vite 8, Motion.
- **Data:** Firebase JS SDK 12: Firestore with the persistent local cache (offline reads and
  writes, multi-tab), Firebase Auth, Firestore security rules (`app/firestore.rules`).
- **Desktop:** Tauri 2 with Rust (`app/src-tauri`). Platform-independent logic lives in the
  `planner-core` crate (`app/src-tauri/core`), which is tested without a webview.
- **Tests:** `node:test` for the domain, the Firebase Emulator Suite for the rules, Playwright
  for the browser suite, `cargo test` for the core crate.

## The assistant cannot write on its own

The chat agent has 12 tools (`app/src/chat/tools.ts`). Read tools run at once; every write tool
renders a confirmation card, and nothing changes until you accept it. An accepted write goes
through the same validated data functions as the rest of the app (`app/src/chat/tools.ts:5-6`).

- **The API key never reaches the webview.** It is stored in the OS keyring (Windows Credential
  Manager, Linux Secret Service, `keyring` crate in `app/src-tauri/src/chat/mod.rs`) and Rust
  makes the HTTPS call. Provider URLs must be
  `https://`; plain `http://` is accepted only on loopback hosts (`app/src-tauri/core/src/chat.rs:427`).
- **Model output is validated against a schema.** The capture inbox turns a pasted email into
  proposed tasks through `app/src/capture/schema.ts`: unknown keys are dropped, at most 8 tasks
  are kept, and an injected `"op":"delete_all"` has nowhere to land
  (`app/src/capture/schema.test.ts:50`).
- The assistant is desktop-only and works with any OpenAI-compatible provider; you bring your
  own key.

There is no eval set for the assistant. Its safety rests on the confirmation step and the
schema check, not on measured model behavior.

## Run the web app locally

Requires Node 22 or later and Java (for the Firestore emulator). Everything runs against the
Firebase Emulator Suite in a `demo-*` project: no cloud project, account or billing.

```sh
cd app
npm ci
npm run emulators   # Auth and Firestore emulators
npm run dev         # in a second terminal, then open http://localhost:5173
```

The app is origin-driven: `localhost` and `127.0.0.1` use the demo emulators, any other origin
connects to the deployed Firebase project, so the local suites cannot reach production.

## Run the desktop shell

Linux (native): install `rustup` (stable), `webkit2gtk-4.1`, `gtk3`, `libsoup3`,
`libayatana-appindicator` and `librsvg`, then:

```sh
cd app
npm ci
npm run desktop:build:linux   # runs `tauri build --no-bundle`; output: src-tauri/target/release/planner
```

Windows is cross-built from WSL (`cargo-xwin`, `nsis`): `npm run desktop:dev` builds a debug exe
that loads the Vite dev server, and `npm run desktop:build` builds the release exe and the NSIS
installer. Details, Linux packaging and the per-window command ACL are in
`app/src-tauri/README.md`.

## Tests

```sh
cd app
npm run typecheck      # tsc --noEmit
npm test               # domain unit tests (node:test)
npm run test:emulator  # Firestore rules against the emulators (needs Java)
npm run test:browser   # Playwright suite against the emulators
cd src-tauri/core && cargo test   # Rust core crate
```

CI (`.github/workflows/ci.yml`) runs the type check, the unit tests and the Rust core tests on
every push and pull request. On 2026-11-11 they gave 1,013 unit tests passing and 139 core
tests passing (134 unit, 5 integration). The emulator and Playwright suites run locally only.

`npm run test:smoke` is the only test that talks to production. It reads `SMOKE_EMAIL` and
`SMOKE_PASSWORD` from the environment and fails fast without them.

## Limits

- Single user. No sharing, teams or roles.
- Browser storage is not a backup, and there is no export or restore yet.
- Recurrence is daily, weekly and monthly. A monthly series skips a month that lacks its anchor
  day (RFC 5545 behavior).
- Physical-device, storage-eviction and install-to-home-screen flows are not proven by tests.

## Layout

- `app/`: the product (React + Vite + Firestore), its tests and capture tooling.
- `app/src-tauri/`: the desktop shell (Rust) and the `planner-core` crate.
- `packaging/`: the Arch PKGBUILD and the per-user Linux install.
- `docs/screenshots/`: the captures above.
