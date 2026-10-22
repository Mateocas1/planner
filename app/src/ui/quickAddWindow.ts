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
 * - `shortcutFromEvent` — a captured keydown becomes the accelerator string
 *   the Rust side parses (global-hotkey's `HotKey` format, case-insensitive,
 *   modifiers first, key last) or one calm refusal: a bare key would swallow
 *   that key system-wide, a lone modifier is not a shortcut, and Escape must
 *   stay the window's close key.
 * - `formatShortcutLabel` — the wording the settings row shows.
 */

export type WindowRoute = "main" | "quickadd";

/** "quickadd" when the page load carries the route flag, "main" otherwise. */
export function parseWindowRoute(search: string, hash: string): WindowRoute {
  if (hash.startsWith("#quickadd")) return "quickadd";
  const param = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("window");
  return param === "quickadd" ? "quickadd" : "main";
}

/** The keys that are modifiers themselves: pressing one is not choosing a key. */
const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
  "MetaLeft",
  "MetaRight",
]);

/** One sentence for every refused capture: what was missing, no blame. */
export const SHORTCUT_CAPTURE_ERROR =
  "Include a modifier key (Ctrl, Alt, Shift or the Windows key) plus a regular key.";

const CAPTURE_KEY_ERROR = "That key cannot be part of the shortcut. Use a letter, number or symbol key.";

export type ShortcutCaptureInput = {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
};

export type ShortcutCapture =
  | { ok: true; accelerator: string }
  | { ok: false; error: string };

/**
 * Turns a captured keydown into the accelerator string the Rust side
 * registers, or refuses it. The key travels as the DOM `code` ("KeyA",
 * "Space", "Digit1"), which is exactly the vocabulary global-hotkey's parser
 * accepts, so a keyboard layout can never change what got registered.
 */
export function shortcutFromEvent(event: ShortcutCaptureInput): ShortcutCapture {
  if (event.code === "Unidentified") return { ok: false, error: CAPTURE_KEY_ERROR };
  if (event.code === "Escape") return { ok: false, error: CAPTURE_KEY_ERROR };
  if (MODIFIER_CODES.has(event.code)) return { ok: false, error: SHORTCUT_CAPTURE_ERROR };
  if (!event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
    return { ok: false, error: SHORTCUT_CAPTURE_ERROR };
  }
  const modifiers = [
    event.ctrlKey ? "ctrl" : null,
    event.altKey ? "alt" : null,
    event.shiftKey ? "shift" : null,
    event.metaKey ? "meta" : null,
  ].filter(part => part !== null);
  return { ok: true, accelerator: `${modifiers.join("+")}+${event.code}` };
}

const MODIFIER_LABELS: Record<string, string> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  meta: "Win",
  super: "Win",
};

const KEY_LABELS: Record<string, string> = { numpadadd: "Num+", numpadsubtract: "Num−", numpadmultiply: "Num*", numpaddivide: "Num/" };

/** "ctrl+alt+Space" → "Ctrl+Alt+Space"; "ctrl+KeyJ" → "Ctrl+J". */
export function formatShortcutLabel(accelerator: string): string {
  return accelerator
    .split("+")
    .map(part => {
      const mod = MODIFIER_LABELS[part.toLowerCase()];
      if (mod) return mod;
      const key = KEY_LABELS[part.toLowerCase()];
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
