import { defineConfig } from "@playwright/test";

const required = {
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9199",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8187",
  GCLOUD_PROJECT: "demo-calendar-app",
};
for (const [name, value] of Object.entries(required)) {
  if (process.env[name] !== value) throw new Error(`test:browser requires ${name}=${value}`);
}

export default defineConfig({
  testDir: "./tests",
  // The suite runs on a 6 GB host that other agents share, and every worker is a
  // whole Chromium with a glass/blur-heavy page. At Playwright's default (half the
  // logical CPUs, 6 here) the renderers plus the emulator JVM exhaust RAM: measured
  // 71 MB free, load 65, sign-ups taking 2 s and a view mount missing a 5 s budget.
  // Three workers fit the box, which is what keeps the timeouts below honest.
  workers: 3,
  // A view mount is a JS round trip through React and Firestore, not a local
  // assertion, so it gets more than Playwright's 5 s default. It is a budget, not a
  // tolerance: the assertion is unchanged and still fails when the app is wrong.
  expect: { timeout: 10_000 },
  // `browser.spec.ts` holds the end-to-end flows; feature specs (sync-status,
  // undo, manip, travel, palette, glass) are named after their feature. The
  // deployed-site smoke suite has its own config, so it is the only file
  // excluded here.
  testMatch: ["*.spec.ts"],
  testIgnore: ["smoke.spec.ts"],
  use: {
    baseURL: "http://127.0.0.1:4174",
    // C1: the rendered date string depends on the locale, so pin it. The
    // browser tests assert that literal; an unpinned locale would flake.
    locale: "en-US",
  },
  webServer: {
    command: "npm run build && vite preview --host 127.0.0.1 --port 4174",
    port: 4174,
    reuseExistingServer: false,
  },
});
