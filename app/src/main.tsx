/// <reference types="vite-plugin-pwa/client" />
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { QuickAddWindow } from "./ui/QuickAddWindow.tsx";
import { parseWindowRoute } from "./ui/quickAddWindow.ts";
// brand.css is the scale itself (--brand-* / --ink-*); app.css maps every colour
// token onto a step of it, so the scale is loaded first.
import "./ui/brand.css";
import "./app.css";
// glass.css is imported after app.css on purpose: it owns the glass materials
// and tokens that app.css used to define.
import "./ui/glass.css";
import { installLens } from "./ui/lens.ts";
import { installSheen } from "./ui/sheen.ts";
import { installUpdatePrompt } from "./pwa-update.ts";

// Document-level motion is installed once, outside React: a StrictMode remount
// must never stack a second pointer listener. The lens gate only sets an
// attribute on <html>; CSS decides whether the filter is used.
installSheen();
installLens();

// Registers the offline app-shell service worker only where the browser has one.
// `registerSW` is wired to `registerType: "prompt"` in vite.config.ts: a waiting
// worker is never activated on its own and the page is never force-reloaded,
// which would interrupt unsent writes held in the Firestore persistent local
// cache. `installUpdatePrompt` surfaces that waiting worker as a corner card
// whose Reload button is the only way a new build takes over (SB1).
installUpdatePrompt();

// One bundle, two surfaces: the quick-add window loads the same index.html with
// the `#quickadd` route flag (tauri.conf.json) and renders only the
// natural-language quick add. Everything else — theme bootstrap, brand tokens,
// the lens and sheen attributes — is shared on purpose, so both windows read
// identical materials.
const route = parseWindowRoute(window.location.search, window.location.hash);

createRoot(document.getElementById("root")!).render(
  <StrictMode>{route === "quickadd" ? <QuickAddWindow /> : <App />}</StrictMode>,
);
