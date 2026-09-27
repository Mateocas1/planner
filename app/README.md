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
navigation, a Home surface of stat cards, each one a fact the store holds (open tasks, completed
tasks, tasks due today in the planner timezone, work blocks in the current week, repeating series)
with a calm single-sentence empty state instead of a row of zeroes, a full Tasks surface (create with an
optional date-only deadline validated by the domain module; compact rows grouped into counted Open and
Completed sections; a details panel, opened by selecting a row, holding rename, the deadline, the
completion state and delete), and a Calendar surface: a week time grid rendering work blocks in the stored **profile timezone** (a
per-user profile document at `users/{uid}/profile/main`, initialized on first use from the browser's
resolved zone), with previous/next week and today navigation, each block drawn as a card (time range and
linked task title), the profile timezone's current day highlighted, a static pending state for a block
whose write is not yet acknowledged, a create form taking a start, an end
and an optional task, per-block delete, an explicit empty state, and visible error reporting for
rejected input — all wired to Firestore, with the built app shell cached by a service worker so the
app opens and renders its cached data offline (see "Offline app shell" below).

## Design foundation (DP1)

The design pass has started. `src/app.css` now defines the visual foundation as custom properties
in one place — surfaces, borders, a four-step type ramp, semantic and status colours, radii, the
4 pt spacing scale, elevation via the ring-as-border trick, component heights — ported from
`odd/design/reference-design-language.md`. Every colour, radius, space and type size in the file
comes from a token. The shell is a left sidebar (application name, icon navigation with a raised
pill on the active item, identity and sign-out) that becomes a top bar under 720 px.

The typeface is **Geist Sans**, self-hosted via `@fontsource-variable/geist` (variable weight,
latin subset, ~29 KB woff2 shipped as a build asset) with `font-display: swap` and a system
fallback stack. Self-hosting is deliberate: the product must work offline, and a font CDN would
break that promise.

## Motion (DP1b)

`src/app.css` also carries the motion system from `odd/design/motion-system.md`: the canonical curves
(`--ease-out`, `--ease-in-out`, `--ease-drawer`, `--spring`, with `--ease` defaulting to the strong
ease-out) and intent-named durations (`--dur-press` 120 ms, `--dur-hover` 140 ms, `--dur-enter`
200 ms, `--dur-panel` 280 ms, `--dur-signature` 400 ms). View switches fade-and-rise (4 px) on every
navigation — the keyed view surface remounts, so the animation replays. Hover and press are gated to
cursor devices (`hover: hover` and `pointer: fine`). `prefers-reduced-motion` and the in-app
`data-motion="reduce"` attribute both degrade transform motion to an opacity-only ~120 ms fade —
gentler, not zero. Only `transform` and `opacity` animate; `transition: all` is forbidden.

Animation durations are validated by eye, not asserted. The harness that measured them frame by frame
and fitted easing curves by RMS error was removed once the audit showed it cost more than the three
transitions it guarded.

## Install

```
npm install
```

Requires Node 22.x. Development and the whole test suite run locally against the emulators, with
no cloud project, account or billing involved. The published build talks to the real Firebase
project instead; see the section below.

## Verification

```
npm test             # domain tests (node:test, 9 passing expected)
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

## Where the app runs

- The app is origin-driven: `localhost` / `127.0.0.1` uses the `demo-calendar-app` emulators,
  while any other origin connects to the real Firebase project and no emulator. That keeps the
  local suite structurally unable to reach production.
- Data lives in the Firestore persistent local cache in browser storage. **Browser storage is
  not a backup**; clearing site data loses it.
- Offline reads and writes are exercised by the browser suite, which drives the app offline and
  back. The app claims only what those tests show.

## Offline app shell

`vite-plugin-pwa` generates a Workbox service worker that precaches the built shell — the HTML, JS,
CSS and the self-hosted Geist font — and `src/main.tsx` registers it where the browser supports one.
The registration uses `registerType: "prompt"`: a waiting update is never activated and the page is
never force-reloaded, so a new build cannot interrupt unsent writes queued in the Firestore
persistent local cache. Reloading with no network serves the precached shell, which then renders the
cached data. Firestore data itself is not precached; it comes from the persistent local cache.
