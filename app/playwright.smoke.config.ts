import { defineConfig } from "@playwright/test";

/**
 * The offline smoke suite: a single test that runs against the *deployed*
 * site in production, not the local emulators.
 *
 * It is deliberately separate from `playwright.config.ts`:
 *   - this config targets the real origin and starts no `webServer`, so it
 *     needs no emulator and no local preview server;
 *   - the local suite matches only `browser.spec.ts` and this one matches only
 *     `smoke.spec.ts`, so neither run can pick up the other's tests.
 *
 * Run it with `npm run test:smoke`.
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: ["smoke.spec.ts"],
  use: {
    baseURL: "https://cumbia-4ca6e.web.app",
    // The offline reload relies on the precache worker serving the app shell.
    serviceWorkers: "allow",
    navigationTimeout: 60_000,
  },
});
