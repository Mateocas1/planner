# Personal Planner

The product application. This is distinct from `experiments/offline-planner`, which is a
**frozen feasibility lab** that proved the offline hypotheses and is no longer evolved.
This app is where the real product is built, increment by increment, starting from the
proven domain and data layer.

## What this is

A local-first personal planner (tasks, date-only deadlines, work blocks, recurring series
with per-occurrence completion) built with React + TypeScript + Vite on Cloud Firestore's
persistent local cache. Decisions and increments are tracked in `odd/tasks/personal-planner-mvp.md`.

Current state (increment I1a — Foundation): toolchain, domain module, Firebase client,
emulator configuration, security rules, and a placeholder entry point. There is no real UI yet.

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
```

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
