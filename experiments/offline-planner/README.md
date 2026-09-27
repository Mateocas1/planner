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

A deletion-versus-queued-rename diagnostic uses an independently authenticated, memory-only SDK actor to delete the known task document. When that deletion reaches the emulator before the offline rename reconnects, the queued `updateDoc` rejects with the emulator error `NOT_FOUND: no entity to update`; the target remains absent and the browser reports that write error. When the queued rename is server-confirmed before deletion, the remote document first has the renamed title without a browser error; the later deletion converges in both browsers without an update rejection. Each ordered case independently verifies the known document is absent while the one control task and one block retain their expected fields. These are local emulator observations only, not a deletion-wins policy, no-data-loss guarantee, or physical-device result.

Block deletion through the UI is covered by the browser suite: the deleted block row leaves the rendered list, a forced-server read (`getDocFromServer`) proves its document absent with the blocks collection empty while the control task keeps its expected fields, and a reload shows the block still gone. No `pending write` label is asserted for the deleted row because a deleted document is excluded from collection snapshots. This proves only the single-block deletion path of this fixture, not a general deletion policy.

## Lab boundary

The client refuses any origin other than `localhost` or `127.0.0.1` before Firebase initializes. It always uses project `demo-calendar-offline` with Auth `127.0.0.1:9099` and Firestore `127.0.0.1:8087`; it has no cloud fallback or configuration path. The app uses Firestore's persistent local cache and multi-tab manager, with emulator-only fake accounts. Metadata-inclusive snapshots label cached, pending-write, and server-confirmed records; browser online status alone is not backend proof.

Do not sign out or clear browser storage while pending writes are present. Browser persistence can be evicted and is not a backup. Cached provider data may not be fully loaded offline; this fixture only exercises its own small dataset.

## Deferred

This proves page close/reopen in one prepared browser profile only. It does not prove a full browser-process restart, fresh offline installation, data eviction, physical-device sync, background sync, service-worker update safety, conflict policy, recurrence UI, calendar grids, drag/drop, or real Firebase resources. The worker uses prompt registration and does not force an update or reload while pending writes exist; full upgrade policy remains deferred.

The update characterization's test-only old/new build identities are restored to the ordinary production build in its `finally` block. In its local Chromium run, an old activated worker remains controlling while a distinct new version reaches `installing` and `installed`; after confirmed writes, closing the only app client lets that exact new version reach `activated` before an offline reopen serves the new shell and cached records. This is Chromium CDP lifecycle observation in one prepared browser profile, not a universal update-safety or product-policy claim. Its rollback boundary is only the test-mode Vite branch, the isolated browser test, and this note; it is not a product update policy.

The Vite production build currently includes Firebase in an approximately 843 kB uncompressed JavaScript chunk; this feasibility fixture makes no bundle-size claim.

## Rollback

With user permission, remove `experiments/offline-planner` relative to this calendar repository root.

Unit 4 rollback boundary: restore `tests/browser.spec.ts` and this README to `c863311` and remove `tests/browser-helpers.ts` plus `tests/multi-client.spec.ts` together. The shared helper must not be removed by itself because the existing browser tests import it.

Unit 5 rollback boundary: remove the two deletion-versus-queued-rename cases and their focused remote helper additions, then remove the preceding ordered-result paragraph. Retain the original three browser flows and every pre-existing helper export.

Unit 6 rollback boundary (`d25f771`, service-worker update with pending writes): restore `README.md`, `tests/browser.spec.ts`, and `vite.config.ts` to `d25f771^`. That commit added only the update-characterization test, its test-mode Vite build branch, and the matching README note, so restoring those three files removes it; `tests/browser-helpers.ts` and `tests/multi-client.spec.ts` were untouched by it. The block-deletion paragraph and its UI coverage postdate `d25f771` and are not part of this boundary.
