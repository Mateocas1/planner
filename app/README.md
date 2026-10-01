# Personal Planner

The product application. This is distinct from `experiments/offline-planner`, which is a
**frozen feasibility lab** that proved the offline hypotheses and is no longer evolved.
This app is where the real product is built, increment by increment, starting from the
proven domain and data layer.

## What this is

A local-first personal planner (tasks, date-only deadlines, work blocks, recurring series
with per-occurrence completion) built with React + TypeScript + Vite on Cloud Firestore's
persistent local cache. Decisions and increments are tracked in `odd/tasks/personal-planner-mvp.md`.

Current state (Liquid Glass redesign on top of increment I6b — profile timezone): an authentication
gate and a shell with three views.

- **Today** answers "what now, what next": the block running now with its progress and what follows
  (and "Mark task done" when it belongs to a task), tasks due today or overdue plus repeating tasks
  due today, deadlines in the next seven days, and today's schedule with its free gaps and a now marker.
- **Tasks** lists Repeating, Open and Completed in inset grouped lists; a round check completes a row
  in place, and selecting a row opens a glass details sheet with rename, deadline, completion and
  delete (series: frequency, anchor, upcoming occurrences, delete).
- **Calendar** shows a week or a day in the stored **profile timezone** (a per-user profile document
  at `users/{uid}/profile/main`, initialized on first use from the browser's resolved zone): a Due row
  of deadlines apart from work blocks, a scrolling 24-hour grid with a now line, overlapping blocks
  side by side, a pending state for writes not yet acknowledged, block details with delete, creation
  from New block or an empty slot, and an Unscheduled panel whose Plan sets aside an hour for a task in
  the next free slot. A phone shows one day under a week strip.

New task is reachable from every view. Forms close as soon as a write is accepted locally instead of
waiting for the server, so they keep working offline; a later server rejection is shown as a toast.

## Design

The visual direction, tokens and motion are specified in `odd/design/DESIGN.md` and prototyped in
`odd/design/prototype/liquid-glass.html`. In code: `src/app.css` holds every token (light and dark),
the glass material and the components; `src/ui/motion.ts` holds the three springs; `src/ui/Sheet.tsx`
is the sheet that grows out of the element that opened it. Motion uses the `motion` library for
springs, layout moves and sheet morphs, and CSS transitions for hover and press; everything respects
`prefers-reduced-motion`, `prefers-reduced-transparency` and `prefers-contrast`.

The typeface is **Onest**, self-hosted via `@fontsource-variable/onest` (variable weight, latin and
latin-ext subsets shipped as build assets) with `font-display: swap` and a system fallback stack.
Self-hosting is deliberate: the product must work offline, and a font CDN would break that promise.

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
npm run test:smoke     # one offline smoke test against the deployed site (see below)
```

`npm run test:browser` starts the emulators, builds the app and serves it on port **4174**
(`127.0.0.1`). It requires ports 4174 (preview), 9199 (Auth), 8187 (Firestore) and 4400
(emulator hub) to be free, and runs only with the emulator environment
(`FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9199`, `FIRESTORE_EMULATOR_HOST=127.0.0.1:8187`,
`GCLOUD_PROJECT=demo-calendar-app`) that `firebase emulators:exec` provides.

`npm run test:emulator` starts the emulators itself via `firebase emulators:exec`; Java must
be installed. To keep emulators running for development instead:

`npm run test:smoke` is the one exception to "local only": it runs a single Playwright test
against the **deployed site** (`https://cumbia-4ca6e.web.app`, configured in
`playwright.smoke.config.ts`) with no local server and no emulator. It signs in to one fixed,
clearly-marked smoke account (created on the first ever run and signed in afterwards), creates a
task through the UI, reloads online to confirm the task survives a fresh load, then takes the
browser offline and reloads again to prove both offline claims: the service worker serves the
shell, and Firestore's persistent cache renders the task. It starts no emulator and is matched
only by `smoke.spec.ts`, so neither the local suite nor the smoke run picks up the other's tests.

The smoke credentials are read from the environment, never from source. Copy `app/.env.example`
to `app/.env` and fill it in, or export them in the shell:

```
SMOKE_EMAIL=... SMOKE_PASSWORD=... npm run test:smoke
```

Without them the smoke job fails fast with a clear message; the unit and emulator suites never
need them. Emulator-only passwords (the browser suite and `ui-capture.mjs`) are a separate,
non-secret local value.

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
CSS and the self-hosted Onest font — and `src/main.tsx` registers it where the browser supports one.
The registration uses `registerType: "prompt"`: a waiting update is never activated and the page is
never force-reloaded, so a new build cannot interrupt unsent writes queued in the Firestore
persistent local cache. Reloading with no network serves the precached shell, which then renders the
cached data. Firestore data itself is not precached; it comes from the persistent local cache.

`npm run test:smoke` is the deployed-site proof of that promise: after signing in and creating a
task, it reloads the page with the network off and asserts both halves separately — the app chrome
(`Personal Planner`, the `Main` navigation and the signed-in identity) from the worker's precache,
and the created task's title from the persistent cache.

## Installable

`vite-plugin-pwa` also emits a web app manifest, so the published app installs to a device home
screen and opens standalone (`display: standalone`, `start_url: /`). Its colours are the app's own
tokens: `--bg` is the `background_color` and `--accent` the `theme_color`. Three icons ship from
`public/` to the site root — 192 px and 512 px, plus a 512 px maskable variant whose mark stays
inside the platform safe zone. The service worker precache is unchanged; installing the app needs
no network beyond the initial load.
