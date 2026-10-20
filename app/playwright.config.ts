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
  // `browser.spec.ts` holds the end-to-end flows; feature specs (sync-status,
  // undo, manip, travel) are named after their feature. The deployed-site smoke
  // suite has its own config, so it is the only file excluded here.
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
