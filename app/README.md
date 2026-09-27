# Personal Planner

The product application. This is distinct from `experiments/offline-planner`, which is a
**frozen feasibility lab** that proved the offline hypotheses and is no longer evolved.
This app is where the real product is built, increment by increment, starting from the
proven domain and data layer.

## What this is

A local-first personal planner (tasks, date-only deadlines, work blocks, recurring series
with per-occurrence completion) built with React + TypeScript + Vite on Cloud Firestore's
persistent local cache. Decisions and increments are tracked in `odd/tasks/personal-planner-mvp.md`.

Current state (increment I3 — Calendar surface): authentication gate, Home / Tasks / Calendar shell
navigation, a Home surface with real task and work-block counts, a full Tasks surface (create with an
optional date-only deadline validated by the domain module, rename, complete/uncomplete, delete), and
a Calendar surface: a week time grid rendering work blocks in the browser's local timezone (the
profile timezone is I6), with previous/next week and today navigation, a create form taking a start,
an end and an optional task, per-block delete, an explicit empty state, and visible error reporting
for rejected input — all wired to Firestore. Recurrence and the visual design pass are still ahead.
No offline claim.

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
