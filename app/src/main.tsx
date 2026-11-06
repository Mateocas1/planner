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
// press.css is imported last on purpose: it owns the one press language every
// pressable answers with, and its element-level rules must sit after the
// sheets whose class rules consume its tokens (app.css, glass.css).
import "./ui/press.css";
import { installCompositorHandoff } from "./ui/compositorHandoff.ts";
import { installLens } from "./ui/lens.ts";
import { installSheen } from "./ui/sheen.ts";
import { installUpdatePrompt } from "./pwa-update.ts";

/** True only inside the pill window (its initialization script, set by
 * `src-tauri/pill.rs`, marks the page before any app script runs). The pill
 * renders the floating timer alone — no Firestore, no shortcuts, no document
 * motion — so its dynamic import keeps those modules out of its chunk graph. */
const isPillWindow = (globalThis as { __PILL__?: boolean }).__PILL__ === true;

// FocusPill.css keys its transparent page on this mark.
if (isPillWindow) document.documentElement.dataset.window = "pill";

// WebKitGTK (the Linux shell marks the page, src-tauri/src/window.rs) drops a
// stale frame at the end of compositor animations; the guard must be in place
// before anything animates.
if ((globalThis as { __WEBKITGTK__?: boolean }).__WEBKITGTK__ === true) installCompositorHandoff();

// Document-level motion is installed once, outside React: a StrictMode remount
// must never stack a second pointer listener. The lens gate only sets an
// attribute on <html>; CSS decides whether the filter is used.
if (!isPillWindow) installSheen();
if (!isPillWindow) installLens();

// Registers the offline app-shell service worker only where the browser has one.
// `registerSW` is wired to `registerType: "prompt"` in vite.config.ts: a waiting
// worker is never activated on its own and the page is never force-reloaded,
// which would interrupt unsent writes held in the Firestore persistent local
// cache. `installUpdatePrompt` surfaces that waiting worker as a corner card
// whose Reload button is the only way a new build takes over (SB1).
const root = createRoot(document.getElementById("root")!);

const route = parseWindowRoute(window.location.search, window.location.hash);

if (isPillWindow) {
  void import("./ui/FocusPill.tsx").then(({ FocusPill }) => {
    root.render(
      <StrictMode>
        <FocusPill />
      </StrictMode>,
    );
  });
} else {
  installUpdatePrompt();

  // One bundle, two surfaces: the quick-add window loads the same index.html
  // with the `#quickadd` route flag (tauri.conf.json) and renders only the
  // natural-language quick add. Theme, brand tokens, lens and sheen are shared.
  root.render(
    <StrictMode>{route === "quickadd" ? <QuickAddWindow /> : <App />}</StrictMode>,
  );
}
