# Personal Planner

The product application. This is distinct from `experiments/offline-planner`, which is a
**frozen feasibility lab** that proved the offline hypotheses and is no longer evolved.
This app is where the real product is built, increment by increment, starting from the
proven domain and data layer.

## What this is

A local-first personal planner (tasks, date-only deadlines, work blocks, recurring series
with per-occurrence completion) built with React + TypeScript + Vite on Cloud Firestore's
persistent local cache. Decisions and increments are tracked in `odd/tasks/personal-planner-mvp.md`.

Current state (increment I6b — profile timezone): authentication gate, Home / Tasks / Calendar shell
navigation, a Home surface with real task and work-block counts, a full Tasks surface (create with an
optional date-only deadline validated by the domain module, rename, complete/uncomplete, delete), and
a Calendar surface: a week time grid rendering work blocks in the stored **profile timezone** (a
per-user profile document at `users/{uid}/profile/main`, initialized on first use from the browser's
resolved zone), with previous/next week and today navigation, a create form taking a start, an end
and an optional task, per-block delete, an explicit empty state, and visible error reporting for
rejected input — all wired to Firestore. No offline claim.

## Design foundation (DP1)

The design pass has started. `src/app.css` now defines the visual foundation as custom properties
in one place — surfaces, borders, a four-step type ramp, semantic and status colours, radii, the
4 pt spacing scale, elevation via the ring-as-border trick, component heights — ported from
`odd/design/reference-design-language.md`. Every colour, radius, space and type size in the file
comes from a token. The shell is a left sidebar (application name, icon navigation with a raised
pill on the active item, identity and sign-out) that becomes a top bar under 720 px. Motion is
deliberately absent: curves, durations and the reduced-motion block land in the next unit, measured
by its evidence harness.

The typeface is **Geist Sans**, self-hosted via `@fontsource-variable/geist` (variable weight,
latin subset, ~29 KB woff2 shipped as a build asset) with `font-display: swap` and a system
fallback stack. Self-hosting is deliberate: the product must work offline, and a font CDN would
break that promise.

## Install

```
npm install
```

Requires Node 22.x. Everything runs locally; no cloud project, account, or billing is involved.

## Verification

```
npm test             # domain tests (node:test, 7 passing expected)
npm run typecheck    # tsc --noEmit
npm run build        # production build
npm run test:emulator  # Firestore rules test against the Auth + Firestore emulators
npm run test:browser   # Playwright UI tests (walking skeleton + Tasks + Calendar surfaces) against the emulators
```

`npm run test:browser` starts the emulators, builds the app and serves it on port **4174**
(`127.0.0.1`). It requires ports 4174 (preview), 9199 (Auth), 8187 (Firestore) and 4400
(emulator hub) to be free, and runs only with the emulator environment
(`FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9199`, `FIRESTORE_EMULATOR_HOST=127.0.0.1:8187`,
`GCLOUD_PROJECT=demo-calendar-app`) that `firebase emulators:exec` provides.

`npm run test:emulator` starts the emulators itself via `firebase emulators:exec`; Java must
be installed. To keep emulators running for development instead:

```
npm run emulators    # Auth on 127.0.0.1:9199, Firestore on 127.0.0.1:8187
```

## Local-only boundary

- The app refuses to run from any origin other than `localhost` / `127.0.0.1`. There is no
  cloud fallback in this increment.
- Data lives in the Firestore persistent local cache in browser storage. **Browser storage is
  not a backup**; clearing site data loses it.
- Offline behaviour was proven in the frozen lab but is **not yet re-proven in this app**;
  that regression coverage arrives in increment I7. Until then, this app makes no offline
  claim the lab has not re-established here.
