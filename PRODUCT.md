# Product

<!-- impeccable:product-schema 1 -->

Planning only: this document records product requirements and proposals; it does not authorize application implementation.

## Platform

web

## Stack

Research and recommendation delegated; final stack and hosting selection pending user approval. Compare fully local development against a private cloud-backed test environment before choosing.

## Users

- **Confirmed:** Personal use by one individual managing tasks and calendar time.
- **Confirmed:** The first experience is an in-app home, not a marketing landing page.
- **Open choice:** Authentication, hosting, and budget are not decided.

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
- **Open choice:** Fully local backend versus private cloud test services; compare both before choosing.
- **Deferred:** A potential native desktop application may be considered later.
- **Confirmed:** An existing Google calendar is likely relevant.
- **Open choice:** Google provider connection and read scope are not finally approved.
- **Confirmed:** Publishing work blocks to Google is not required initially; a later option should remain possible.

## Capabilities and Constraints

### Confirmed capabilities

- Create, edit, complete, and plan tasks.
- Create and edit scheduled work blocks.
- Set task deadlines separately from scheduled work blocks.
- Use recurrence for tasks and blocks.
- Work offline for task and block creation, editing, and planning.
- Sync the resulting personal data across devices.

### Proposed MVP surfaces

- **Proposal:** Home, Tasks, and Calendar.
- **Proposal:** Creation, editing, completion, deadlines, and time blocks across those surfaces.

### Proposed scope exclusions

The following are recommended exclusions, not separately user-confirmed decisions:

- Teams, comments, attachments, reports, and automation.
- Multiple external calendar providers.
- Native desktop delivery.
- Full external calendar editing.

### Open product choices

- **Open:** What recurrence means for a task, including whether it creates independent occurrences.
- **Open:** Exact recurrence limits; simple daily, weekly, and monthly patterns are a proposal.
- **Open:** Behavior for invalid monthly dates, daylight-saving changes, and travel/time-zone changes.
- **Open:** Whether edits apply to one occurrence or an entire series.
- **Open:** Conflict policy; explicit user resolution is proposed but not approved.
- **Open:** Google connection and read scope.
- **Open:** Authentication, hosting, budget, and final stack.

### Technical constraints

- **Constraint:** Returning offline use requires prior online setup plus caching of the app and data.
- **Constraint:** Local browser storage is not a backup and may be cleared or evicted.
- **Constraint:** Google data available offline would be a stale cache.
- **Constraint:** Baseline sync is while the app is open or reopened; background sync for a closed app is not guaranteed.
- **Non-promise:** The product must not claim loss-proof browser storage or fully solved conflicts.

### Proposed acceptance examples

- **Proposal:** Offline create, edit, and reopen retains unsynced changes.
- **Proposal:** Reconnecting does not create duplicate records.
- **Proposal:** A second device eventually converges with the same personal data.
- **Proposal:** Completing one recurring task occurrence does not complete future occurrences.
- **Proposal:** Disconnecting Google preserves the user's own tasks.

## Brand Commitments

- **Confirmed:** MacOS-inspired minimalism, glassmorphism, and animation are binding visual directions from the provided references.
- **Constraint:** Apply the visual direction without adding unnecessary complexity.

## Evidence on Hand

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
