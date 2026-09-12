# Offline planner feasibility experiment

A small local-only foundation for testing task, block, recurrence, Auth, and Firestore-rule assumptions. It is not an app, UI, PWA, or cloud deployment.

## Quick path

```sh
npm install
npm test
npm run typecheck
npm run test:emulator
```

The emulator command uses the hardcoded Firebase demo project `demo-calendar-offline` and binds Auth/Firestore to `127.0.0.1`. It creates only disposable `@example.invalid` Auth-emulator accounts and synthetic documents; tests reject a missing or different emulator environment and never choose cloud hosts.

## What this unit checks

| Area | Evidence |
| --- | --- |
| Domain | Trimmed task titles, strict date-only deadlines, positive work blocks, and bounded UTC daily/weekly occurrences. |
| Timestamp subset | Zoned `YYYY-MM-DDTHH:mm:ss[.milliseconds](Z or ±HH:mm)` only; impossible dates/times and timezone-less values are rejected. |
| Completion | A validated `OccurrenceCompletion` is stored by deterministic occurrence ID; it does not affect a later occurrence. |
| Rules | An owner can write/read their `/users/{uid}/...` subtree; another user and an anonymous client are denied for both reads and writes. |

Expansion is capped at 366 inclusive UTC dates as a prototype safety limit, not product policy. Firestore is last-write-wins and its offline behavior is not proven here: this Node smoke test is not browser offline evidence. Monthly recurrence, DST/travel policy, a calendar engine, UI, PWA caching, sync/conflict policy, and real Firebase resources are intentionally next-unit work.

## Boundary and rollback

No user data, credentials, or admin SDK are used. Remove only `calendar/experiments/offline-planner` with user permission to roll back this experiment. Emulator import/export snapshots are optional later.
