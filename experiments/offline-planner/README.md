# Offline planner feasibility experiment

This local diagnostic includes a minimal browser `Planner lab` for testing Firestore browser persistence and a generated Workbox app shell. It is not the product UI, a complete installable PWA, or a cloud deployment.

## Quick path

```sh
npm install
npm test
npm run typecheck
npm run test:emulator
npm run test:browser
npm run build
```

`test:browser` builds the production output, serves it with `vite preview` on `127.0.0.1:4173`, and starts the fixed `demo-calendar-offline` Auth and Firestore emulators. It proves initial server-confirmed records, offline edits, and server confirmation after reconnecting.

A second browser flow starts with clean storage, establishes generated Workbox worker readiness and control, then closes the page while offline. A new page in the same browser storage profile loads the cached app shell, restores the fake Auth session and pending cached data, accepts another offline task, and later synchronizes every expected record. A separate Firebase Web SDK client in the Node Playwright runner uses its default memory-only cache with `getDocsFromServer`/`getDocFromServer` to independently verify exact task fields/counts and the block before the online reload check. Desktop and mobile screenshots are written under ignored `test-results/` during the passing batch.

A multi-client diagnostic uses two isolated Playwright browser contexts for the same fake account. With both contexts offline, one title update and one completion update to different fields later coexist after ordered reconnection. Two conflicting title updates converge to the title sent by the context reconnected second in this emulator run; that is an observed ordered case, not a general last-write-wins guarantee or product conflict policy. Competing same-field edits can overwrite each other, so this evidence makes no no-data-loss claim.

## Lab boundary

The client refuses any origin other than `localhost` or `127.0.0.1` before Firebase initializes. It always uses project `demo-calendar-offline` with Auth `127.0.0.1:9099` and Firestore `127.0.0.1:8080`; it has no cloud fallback or configuration path. The app uses Firestore's persistent local cache and multi-tab manager, with emulator-only fake accounts. Metadata-inclusive snapshots label cached, pending-write, and server-confirmed records; browser online status alone is not backend proof.

Do not sign out or clear browser storage while pending writes are present. Browser persistence can be evicted and is not a backup. Cached provider data may not be fully loaded offline; this fixture only exercises its own small dataset.

## Deferred

This proves page close/reopen in one prepared browser profile only. It does not prove a full browser-process restart, fresh offline installation, data eviction, physical-device sync, background sync, service-worker update safety, conflict policy, recurrence UI, calendar grids, drag/drop, block deletion behavior, or real Firebase resources. The worker uses prompt registration and does not force an update or reload while pending writes exist; full upgrade policy remains deferred.

The Vite production build currently includes Firebase in an approximately 843 kB uncompressed JavaScript chunk; this feasibility fixture makes no bundle-size claim.

## Rollback

With user permission, remove `experiments/offline-planner` relative to this calendar repository root.

Unit 4 rollback boundary: restore `tests/browser.spec.ts` and this README to `c863311` and remove `tests/browser-helpers.ts` plus `tests/multi-client.spec.ts` together. The shared helper must not be removed by itself because the existing browser tests import it.
