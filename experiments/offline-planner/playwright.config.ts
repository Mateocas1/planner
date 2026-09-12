import { defineConfig } from "@playwright/test";

const required = {
  FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
  FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
  GCLOUD_PROJECT: "demo-calendar-offline",
};
for (const [name, value] of Object.entries(required)) {
  if (process.env[name] !== value) throw new Error(`test:browser requires ${name}=${value}`);
}

export default defineConfig({
  testDir: "./tests",
  testMatch: "browser.spec.ts",
  use: { baseURL: "http://127.0.0.1:4173" },
  webServer: {
    command: "npm run build && vite preview --host 127.0.0.1 --port 4173",
    port: 4173,
    reuseExistingServer: false,
  },
});
