# Product

<!-- impeccable:product-schema 1 -->

Status: implementation is authorized. `experiments/offline-planner/` is a bounded feasibility experiment that de-risks the offline planning hypotheses; it is not the product itself.

## Platform

web

## Stack

**Decided** (D7 in `odd/tasks/personal-planner-mvp.md`): React + TypeScript + Vite on Cloud Firestore with persistent local cache and the multi-tab manager. Local development and testing run on the Firebase Emulator Suite against a `demo-*` project — zero cost, no cloud resources, no billing. Firebase Auth provides authentication. Production hosting, and the production sign-in provider, are deferred until there is something to deploy; Firebase Hosting's free tier is the leading candidate. A paid managed sync service such as Dexie Cloud is rejected as the primary option because it fails the free-first requirement.

## Users

- **Confirmed:** Personal use by one individual managing tasks and calendar time.
- **Confirmed:** The first experience is an in-app home, not a marketing landing page.
- **Decided:** Authentication uses Firebase Auth; local development uses emulator accounts. Hosting, the production sign-in provider, and budget are deferred. No paid resource is required to build or test the MVP.

## Product Purpose

- **Confirmed:** Support personal planning with tasks plus a calendar.
- **Confirmed:** A task deadline and scheduled work blocks are distinct concepts.
- **Confirmed:** Users need full offline creation, editing, and planning for tasks and blocks, with cross-device sync.
- **Confirmed:** Recurrence is needed for both tasks and blocks.

## Positioning

- **Confirmed:** Keep task commitments and scheduled work blocks distinct while making both usable in one personal planning product.
- **Product principle:** Favor simplicity over premature abstractions.

## Operating Context

- **Confirmed:** Web is desktop- and mobile-first.
- **Confirmed:** Prioritize private development and local testing that can continue beyond the MVP, without requiring a public launch to external users.
- **Decided:** Local development and testing use the Firebase Emulator Suite with a `demo-*` project; no private cloud service is required to build the MVP.
- **Deferred:** A potential native desktop application may be considered later.
- **Confirmed:** An existing Google calendar is likely relevant.
- **Decided:** Google is out of the MVP; no OAuth scope is requested and no Google API is called, while the design keeps a later read-only overlay possible.
- **Confirmed:** Publishing work blocks to Google is not required initially; a later option should remain possible.

## Capabilities and Constraints

### Confirmed capabilities

- Create, edit, complete, and plan tasks.
- Create and edit scheduled work blocks.
- Set task deadlines separately from scheduled work blocks.
- Use recurrence for tasks and blocks.
- Work offline for task and block creation, editing, and planning.
- Sync the resulting personal data across devices.

### MVP surfaces

- **Decided:** Home, Tasks, and Calendar, behind a real authentication gate.
- **Decided:** Creation, editing, completion, deadlines, and time blocks across those surfaces.

### MVP scope exclusions

Decided for the MVP in `odd/tasks/personal-planner-mvp.md`:

- Teams, comments, attachments, reports, and automation.
- Multiple external calendar providers.
- Native desktop delivery.
- Full external calendar editing.
- Background sync while the app is closed.

### Resolved product decisions

Closed in `odd/tasks/personal-planner-mvp.md`; each entry names its decision id there.

- **Recurrence of a task (D1):** a series definition whose occurrences are derived and never stored; completion is per occurrence.
- **Recurrence limits (D2):** daily, weekly and monthly; an anchor day that does not exist in a month skips that month (RFC 5545).
- **Dates, DST and travel (D3):** deadlines are date-only; work blocks are absolute zoned instants; recurrence expands over calendar dates in the profile timezone.
- **Edit scope (D4):** edits apply to the whole series; per-occurrence overrides are out of MVP.
- **Conflict policy (D5):** per-document last write wins, disclosed as such; no loss-free claim and no conflict UI in MVP.
- **Google (D6):** out of MVP, path preserved.
- **Auth, hosting, budget and stack (D7):** Firebase Auth; zero-cost local development; hosting deferred; a paid managed sync service is rejected as the primary.
- **Repository layout (D8):** the product is a new application at `app/`; the feasibility lab stays frozen as the offline evidence harness.

### Technical constraints

- **Constraint:** Returning offline use requires prior online setup plus caching of the app and data.
- **Constraint:** Local browser storage is not a backup and may be cleared or evicted.
- **Constraint:** Google data available offline would be a stale cache.
- **Constraint:** Baseline sync is while the app is open or reopened; background sync for a closed app is not guaranteed.
- **Non-promise:** The product must not claim loss-proof browser storage or fully solved conflicts.

### Acceptance examples

- **Proposal:** Offline create, edit, and reopen retains unsynced changes.
- **Proposal:** Reconnecting does not create duplicate records.
- **Proposal:** A second device eventually converges with the same personal data.
- **Proposal:** Completing one recurring task occurrence does not complete future occurrences.
- **Proposal:** Disconnecting Google preserves the user's own tasks.

## Brand Commitments

- **Confirmed:** MacOS-inspired minimalism, glassmorphism, and animation are binding visual directions from the provided references.
- **Constraint:** Apply the visual direction without adding unnecessary complexity.

## Evidence on Hand

- **UI target:** The `references/*.mp4` recordings are the intended UI target — the visual direction to reproduce — not generic evidence.
- **Observed reference:** `references/brave_9aG7UlfC4Y.mp4` shows Home summary/cards and promotional perspective.
- **Observed reference:** `references/brave_agommCZfLm.mp4` shows a Calendar time grid plus task list.
- **Observed reference:** `references/brave_L1xfTRXpX0.mp4` shows a Tasks grouped list and right details panel.
- **Not confirmed:** The Tasks reference does not confirm a creation flow.
- **Limit:** Full motion analysis of the reference videos has not been completed.

## Product Principles

- Keep tasks, deadlines, and scheduled work blocks conceptually distinct.
- Make offline planning useful after a prepared online setup, without overstating storage or sync guarantees.
- Preserve a path to Google calendar interoperability without requiring it for the first release.
- Prioritize a calm, minimal personal-planning experience across desktop and mobile web.
- Defer integrations, platform expansion, and abstractions until a confirmed need exists.
