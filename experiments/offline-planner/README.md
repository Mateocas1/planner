# Offline planner feasibility experiment

This local diagnostic includes a minimal browser `Planner lab` for testing Firestore browser persistence. It is not the product UI, a PWA, or a cloud deployment.

## Quick path

```sh
npm install
npm test
npm run typecheck
npm run test:emulator
npm run test:browser
npm run build
```

`test:browser` starts the fixed `demo-calendar-offline` Auth and Firestore emulators, runs Vite on `127.0.0.1:4173`, and creates a disposable `@example.invalid` account. It proves that an already-loaded browser can create a task and block, receive server-confirmed snapshot metadata, edit and create tasks while the Playwright context is offline, then receive server-confirmed records after reconnecting.

The test also signs the same fake user into a separate Firebase Web SDK client in the Node Playwright runner. That client uses its default memory-only cache and `getDocsFromServer`/`getDocFromServer`, so it independently verifies the two expected tasks, their title and completion fields, and the work block before the browser reload check. Desktop and mobile screenshots are written under ignored `test-results/` during the same passing run.

## Lab boundary

The client refuses any origin other than `localhost` or `127.0.0.1` before Firebase initializes. It always uses project `demo-calendar-offline` with Auth `127.0.0.1:9099` and Firestore `127.0.0.1:8080`; it has no cloud fallback or configuration path. The app uses Firestore's persistent local cache and multi-tab manager, with emulator-only fake accounts. Metadata-inclusive snapshots label cached, pending-write, and server-confirmed records; browser online status alone is not backend proof.

Do not sign out or clear browser storage while pending writes are present. Browser persistence can be evicted and is not a backup. Cached provider data may not be fully loaded offline; this fixture only exercises its own small dataset.

## Deferred

This does not prove offline app-shell reopening, PWA/service-worker behavior, physical-device sync, conflict policy, recurrence UI, calendar grids, drag/drop, block deletion behavior, or real Firebase resources.

The Vite production build currently includes Firebase in an approximately 843 kB uncompressed JavaScript chunk; this feasibility fixture makes no bundle-size claim.

## Rollback

With user permission, remove `experiments/offline-planner` relative to this calendar repository root.
