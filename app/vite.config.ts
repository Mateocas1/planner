import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // `prompt` leaves a newly installed service worker in the "waiting" state
      // until the app explicitly asks it to activate, so a new build never takes
      // control and reloads the page underneath the user. A forced reload would
      // discard unsent writes queued in the Firestore persistent local cache.
      // No `onNeedRefresh` callback is registered on purpose (see src/main.tsx):
      // an available update is simply not surfaced, and the tab keeps running
      // the version it loaded until the next full page load. That is deliberate
      // for this increment, not an oversight.
      registerType: "prompt",
      // The app registers the worker itself from src/main.tsx, guarded on
      // service-worker support, so the plugin must not inject a registration
      // script into index.html.
      injectRegister: false,
      // This unit ships an offline app shell only: no web app manifest and no
      // icons.
      manifest: false,
      workbox: {
        // The built app shell the offline page renders from: markup, scripts,
        // styles, and the self-hosted Geist font (woff2). Firestore data is not
        // precached; it comes from the persistent local cache.
        globPatterns: ["**/*.{html,js,css,woff2}"],
      },
    }),
  ],
});
