/// <reference types="vite-plugin-pwa/client" />
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App.tsx";
import "./app.css";
// glass.css is imported after app.css on purpose: it owns the glass materials
// and tokens that app.css used to define.
import "./ui/glass.css";
import { installSheen } from "./ui/sheen.ts";

// Document-level motion is installed once, outside React: a StrictMode remount
// must never stack a second pointer listener.
installSheen();

// Register the offline app-shell service worker only where the browser has one.
// `registerSW` is wired to `registerType: "prompt"` in vite.config.ts, and no
// update callback is passed here: a waiting worker is never activated and the
// page is never force-reloaded, which would interrupt unsent writes held in the
// Firestore persistent local cache. See the comment in vite.config.ts.
if ("serviceWorker" in navigator) {
  registerSW({ immediate: true });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
