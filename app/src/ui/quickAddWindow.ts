/**
 * Pure helpers for the global quick-add window (task T5, spec S8.1) — the
 * decision logic of the surface, kept out of the JSX so the node test runner
 * can hold every rule without a DOM or a Tauri runtime:
 *
 * - `parseWindowRoute` — which surface this page load is. The quick-add window
 *   loads the same bundle as the main app; only a route flag in the URL
 *   (`#quickadd`, set in tauri.conf.json, or `?window=quickadd` for tests and
 *   manual navigation) tells the bundle to render the mini window instead of
 *   the shell.
 * - `formatShortcutLabel` — the wording the settings row shows.
 */

import { desktopPlatform, type DesktopPlatform } from "../desktop.ts";

export type WindowRoute = "main" | "quickadd";

/** "quickadd" when the page load carries the route flag, "main" otherwise. */
export function parseWindowRoute(search: string, hash: string): WindowRoute {
  if (hash.startsWith("#quickadd")) return "quickadd";
  const param = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("window");
  return param === "quickadd" ? "quickadd" : "main";
}

const MODIFIER_LABELS: Record<string, string> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  alt: "Alt",
  shift: "Shift",
};

const KEY_LABELS: Record<string, string> = { numpadadd: "Num+", numpadsubtract: "Num−", numpadmultiply: "Num*", numpaddivide: "Num/" };

/** "ctrl+alt+Space" → "Ctrl+Alt+Space"; "ctrl+KeyJ" → "Ctrl+J"; the meta key
 * reads "Super" on Linux and "Win" elsewhere. */
export function formatShortcutLabel(accelerator: string, platform: DesktopPlatform = desktopPlatform()): string {
  const meta = platform === "linux" ? "Super" : "Win";
  return accelerator
    .split("+")
    .map(part => {
      const lower = part.toLowerCase();
      if (lower === "meta" || lower === "super") return meta;
      const mod = MODIFIER_LABELS[lower];
      if (mod) return mod;
      const key = KEY_LABELS[lower];
      if (key) return key;
      const letter = /^Key([A-Z])$/i.exec(part);
      if (letter) return letter[1];
      const digit = /^Digit(\d)$/i.exec(part);
      if (digit) return digit[1];
      const numpad = /^Numpad(\w+)$/i.exec(part);
      if (numpad) return `Num${numpad[1]}`;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join("+");
}
