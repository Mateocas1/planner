import { useSyncExternalStore } from "react";

/**
 * Theme preference — System (the default), Light or Dark — persisted per device
 * in `localStorage["planner-theme"]` (value roadmap §4).
 *
 * Three rules shape this module:
 *
 * 1. The resolved scheme is always an attribute: `<html data-theme="light" |
 *    "dark">`. The CSS sheets switch on that attribute alone, so a dark token
 *    block exists once instead of twice (once for the media query, once for the
 *    choice). System is not a CSS state; it is resolved here.
 * 2. The first paint belongs to the inline script in `index.html`. It reads the
 *    key, resolves System through `matchMedia` and sets the attribute before any
 *    bundle runs. This module picks the same state up and keeps it live; it must
 *    never resolve a different first value, or the page would flash on load.
 * 3. Storage is per device on purpose. A Firestore profile value cannot be read
 *    before the first paint (it is async and may be offline), and a laptop in
 *    dark next to a phone on System is a normal wish. Cross-device sync would be
 *    a second step, not part of the first frame.
 */

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

/** The storage key the inline script in `index.html` also reads. */
export const themeStorageKey = "planner-theme";

const darkQuery = "(prefers-color-scheme: dark)";

/**
 * The page colour each scheme publishes to the browser chrome (the address bar,
 * the OS task switcher). Both are brand steps: ink-200 is `--bg` in light, ink-975
 * is `--bg` in dark. The inline script carries the same two values.
 */
const themeColors: Record<ResolvedTheme, string> = { light: "#EEF1F8", dark: "#0B0E15" };

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

/** The scheme the browser is painting for a preference. Pure, so it is testable
 * without a DOM: System follows the OS, an explicit choice ignores it. */
export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

export function readThemePreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const stored = window.localStorage.getItem(themeStorageKey);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    /* storage can be blocked (private mode, a denied policy): the session still
       switches, it just forgets */
    return "system";
  }
}

/* ---------- the store ----------
   One preference for the whole document, read by the sidebar switch, the phone's
   account menu and the palette command, and written by all three. The listeners
   below keep `data-theme` and the `theme-color` meta in step with it. */

let preference: ThemePreference | null = null;
const listeners = new Set<() => void>();

function currentPreference(): ThemePreference {
  if (preference === null) preference = readThemePreference();
  return preference;
}

function publish(): void {
  for (const listener of listeners) listener();
}

/**
 * Paints a preference: the attribute CSS reads, and the browser-chrome colour.
 * A switch that actually changes the scheme gets one frame with transitions
 * suppressed (app.css) — a theme change is not a motion opportunity, and without
 * it every paper control would ease through the old colours.
 */
export function applyTheme(value: ThemePreference): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const resolved = resolveTheme(value, window.matchMedia(darkQuery).matches);
  if (root.dataset.theme !== resolved) {
    root.dataset.themeSwitching = "";
    window.setTimeout(() => {
      delete root.dataset.themeSwitching;
    }, 0);
  }
  root.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", themeColors[resolved]);
}

/** Sets the preference for this device and paints it. */
export function setThemePreference(value: ThemePreference): void {
  preference = value;
  try {
    window.localStorage.setItem(themeStorageKey, value);
  } catch {
    /* see readThemePreference: in-memory only */
  }
  applyTheme(value);
  publish();
}

/* Runtime listeners are installed once, when this module is evaluated, so a
   System preference follows the OS from the first frame the bundle runs — not
   from a React effect that mounts later. */

if (typeof window !== "undefined") {
  /* the inline script already painted this value; re-applying it is a no-op */
  applyTheme(currentPreference());
  window.matchMedia(darkQuery).addEventListener("change", () => {
    if (currentPreference() === "system") applyTheme("system");
  });
  window.addEventListener("storage", event => {
    if (event.key !== themeStorageKey) return;
    preference = isThemePreference(event.newValue) ? event.newValue : "system";
    applyTheme(preference);
    publish();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The preference, shared by every control in the document. */
export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, currentPreference, () => "system");
}
