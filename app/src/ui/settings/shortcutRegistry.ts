/**
 * The shortcut registry (Ronda 2, spec S2 — odd/tasks/ronda2.md).
 *
 * One pure module owning the three rebindable shortcuts -- the command
 * palette, the chat panel and the global quick-add -- and the rules a new
 * combination must satisfy before it may take one of their slots. The DOM and
 * the Tauri runtime stay out: everything here runs under the node test runner,
 * and the recorder and the live listeners are thin consumers of this file.
 *
 * Vocabulary: an accelerator is the string both localStorage and the Rust
 * global-shortcut side speak, modifiers first, key last, with the key named by
 * its DOM `code` ("ctrl+KeyK", "ctrl+alt+Space"). The DOM `code` is what a
 * keyboard layout can never change, which is why it travels instead of `key`.
 *
 * Storage decision (W1): palette and chat bindings persist in
 * **localStorage**, not the synced profile. A chord is a habit of the hands on
 * one machine's keyboard -- the same reason the away threshold and the
 * notification toggles already live per device -- and keeping it out of the
 * profile avoids a schema migration for a value another device cannot honor
 * (the chat panel is desktop-only, the palette's default fits every device).
 * Quick-add stays in Rust (`app_config_dir/quickadd.json`), where it already
 * lives.
 */

import { useSyncExternalStore } from "react";
import { isApplePlatform, modifierLabel } from "../shortcuts.ts";
import { desktopPlatform, type DesktopPlatform } from "../../desktop.ts";
import { en } from "../../i18n/en/index.ts";
import { t } from "../../i18n/index.ts";

/** The three shortcuts a person may rebind. Quick-add is desktop-only. */
export type RebindableShortcutId = "palette" | "chat" | "quickAdd";

/** Accelerator strings, DOM-code vocabulary, modifiers first. */
export type Accelerator = string;

export type RebindableShortcut = {
  id: RebindableShortcutId;
  /** The name the settings row, the palette conflict copy and the recorder
   * all share, so one wording cannot drift from another. */
  label: string;
  defaultAccelerator: Accelerator;
  desktopOnly: boolean;
};

export const rebindableShortcuts: readonly RebindableShortcut[] = [
  { id: "palette", get label() { return t("shortcuts.rebind.palette"); }, defaultAccelerator: "ctrl+KeyK", desktopOnly: false },
  { id: "chat", get label() { return t("shortcuts.rebind.chat"); }, defaultAccelerator: "ctrl+KeyJ", desktopOnly: false },
  { id: "quickAdd", get label() { return t("shortcuts.rebind.quickAdd"); }, defaultAccelerator: "ctrl+alt+Space", desktopOnly: true },
];

export function rebindableShortcut(id: RebindableShortcutId): RebindableShortcut {
  const found = rebindableShortcuts.find(shortcut => shortcut.id === id);
  if (found === undefined) throw new Error(`Unknown shortcut id: ${id}`);
  return found;
}

/* -------------------------------------------------------------------------
 * Parsing and formatting
 * ---------------------------------------------------------------------- */

/** The modifier tokens an accelerator may carry, in canonical order. */
const MODIFIERS = ["ctrl", "alt", "shift", "meta"] as const;

export type Combo = {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** The DOM `code` of the non-modifier key ("KeyK", "Space", "Comma"). */
  code: string;
};

/**
 * Parses an accelerator into its parts, or null when the string is not one.
 * Tolerates the case the Rust side prints (`Ctrl+Alt+Space`) but keeps the
 * canonical lowercase modifiers.
 */
export function parseAccelerator(text: string): Combo | null {
  const parts = text.trim().split("+").filter(part => part !== "");
  if (parts.length < 2) return null; // modifiers first, key last: at least two
  const combo: Combo = { ctrl: false, alt: false, shift: false, meta: false, code: "" };
  for (const [index, part] of parts.entries()) {
    const lower = part.toLowerCase();
    if (index < parts.length - 1) {
      if (!(MODIFIERS as readonly string[]).includes(lower) || combo[lower as keyof Omit<Combo, "code">]) return null;
      combo[lower as keyof Omit<Combo, "code">] = true;
    } else {
      if ((MODIFIERS as readonly string[]).includes(lower)) return null; // key must come last
      combo.code = part;
    }
  }
  return combo;
}

/** The accelerator string a combo serializes to. */
export function acceleratorOf(combo: Combo): Accelerator {
  const modifiers = [
    combo.ctrl ? "ctrl" : null,
    combo.alt ? "alt" : null,
    combo.shift ? "shift" : null,
    combo.meta ? "meta" : null,
  ].filter(part => part !== null);
  return `${modifiers.join("+")}+${combo.code}`;
}

/** The keycap labels a chip shows, in press order: modifiers, then the key. */
const KEY_LABELS: Record<string, string> = {
  Space: "Space",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
  Minus: "−",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Backslash: "\\",
  Enter: "Enter",
  Tab: "Tab",
  Delete: "Del",
  Insert: "Ins",
  Home: "Home",
  End: "End",
  PageUp: "PgUp",
  PageDown: "PgDn",
};

/** The meta key's keycap: "⌘" on Apple platforms, "Super" on Linux, "Win" elsewhere. */
function metaLabel(apple: boolean, platform: DesktopPlatform): string {
  if (apple) return "⌘";
  return platform === "linux" ? "Super" : "Win";
}

export function keycaps(
  accelerator: Accelerator,
  apple: boolean = isApplePlatform(),
  platform: DesktopPlatform = desktopPlatform(),
): string[] {
  const combo = parseAccelerator(accelerator);
  if (combo === null) return [];
  const caps: string[] = [];
  if (combo.ctrl) caps.push(modifierLabel(apple));
  if (combo.alt) caps.push("Alt");
  if (combo.shift) caps.push("Shift");
  if (combo.meta) caps.push(metaLabel(apple, platform));
  const code = combo.code;
  const named = KEY_LABELS[code];
  if (named !== undefined) caps.push(named);
  else {
    const letter = /^Key([A-Z])$/i.exec(code);
    const digit = /^Digit(\d)$/i.exec(code);
    const numpad = /^Numpad(\w+)$/i.exec(code);
    const arrow = /^Arrow(\w+)$/i.exec(code);
    const fn = /^F([1-9]|1[0-2])$/.exec(code);
    if (letter !== null) caps.push(letter[1]);
    else if (digit !== null) caps.push(digit[1]);
    else if (numpad !== null) caps.push(`Num${numpad[1]}`);
    else if (arrow !== null) caps.push(arrow[1]);
    else if (fn !== null) caps.push(fn[0]);
    else caps.push(code.charAt(0).toUpperCase() + code.slice(1));
  }
  return caps;
}

/** "Ctrl+Alt+Space" — the wording rows and messages share. */
export function acceleratorLabel(accelerator: Accelerator): string {
  return keycaps(accelerator).join("+");
}

/* -------------------------------------------------------------------------
 * Capturing: a live keydown becomes a candidate accelerator
 * ---------------------------------------------------------------------- */

/** The keys that are modifiers themselves: pressing one is not choosing a key. */
export const MODIFIER_CODES = new Set([
  "ControlLeft", "ControlRight", "AltLeft", "AltRight",
  "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight",
]);

/** The English wording, which the capture returns in English; other languages
 * read the same keys through `t()`. */
export const CAPTURE_MODIFIER_ERROR = en["shortcuts.capture.modifier"];
export const CAPTURE_KEY_ERROR = en["shortcuts.capture.key"];

/** The fields of a keydown the capture reads; a stub in tests, a real event in the browser. */
export type CaptureInput = { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean };

export type Capture =
  | { ok: true; accelerator: Accelerator }
  | { ok: false; error: string };

/**
 * One captured keydown becomes a candidate accelerator, or one calm refusal.
 * Escape and the lone modifiers never reach here (the recorder answers them
 * before asking), so the two refusals left are a key that cannot be part of a
 * chord and a press without Ctrl/Alt/Cmd -- Shift alone would swallow a
 * capital letter the user was typing.
 */
export function captureFromEvent(event: CaptureInput, platform: DesktopPlatform = desktopPlatform()): Capture {
  const modifierError = t(platform === "linux" ? "shortcuts.capture.modifier.linux" : "shortcuts.capture.modifier");
  if (event.code === "" || event.code === "Unidentified") return { ok: false, error: t("shortcuts.capture.key") };
  if (MODIFIER_CODES.has(event.code)) return { ok: false, error: modifierError };
  if (!event.ctrlKey && !event.altKey && !event.metaKey) return { ok: false, error: modifierError };
  return {
    ok: true,
    accelerator: acceleratorOf({
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      meta: event.metaKey,
      code: event.code,
    }),
  };
}

/* -------------------------------------------------------------------------
 * Conflicts: what a candidate may and may not take
 * ---------------------------------------------------------------------- */

export type Conflict =
  | { kind: "rebindable"; holder: RebindableShortcutId; message: string }
  | { kind: "fixed"; message: string }
  | { kind: "reserved"; message: string };

/**
 * The fixed in-app chords: combos with modifiers that belong to the shell and
 * are not rebindable. Today that is `Ctrl+,` for opening Settings; the
 * rebindable defaults (Ctrl+K, Ctrl+J) are checked as rebindable bindings, not
 * here, so rebinding the palette away frees Ctrl+K.
 *
 * The single-key shortcuts (j, k, x, ?, the g-sequences) can never collide:
 * a rebindable chord always carries Ctrl/Alt/Cmd, and a plain letter never
 * equals a chord. `shortcutHelp`'s entries stay the source of truth for the
 * read-only list in the UI; this table only holds what a chord could actually
 * shadow.
 */
export const fixedInAppShortcuts: readonly { accelerator: Accelerator; label: string }[] = [
  { accelerator: "ctrl+Comma", get label() { return t("shortcuts.fixed.settings"); } },
];

/**
 * The chords the browser and the operating system keep, matched on Ctrl-or-Cmd
 * (Windows' WebView2 and the browsers agree on most of them) plus the
 * desktop-only OS-reserved set: Win-key combos and system-level sequences.
 */
const RESERVED_CHORD_KEYS = new Set([
  "KeyW", // close tab / window
  "KeyT", // new tab
  "KeyN", // new window
  "KeyR", // reload (Ctrl+Shift+R hard reload included below)
  "KeyL", // focus address bar
  "KeyQ", // quit (macOS) / close window
]);

/** True when `left` and `right` describe the same chord, Ctrl and Cmd counting
 * as the same command modifier (a Mac user presses Cmd+K, the accelerator
 * says ctrl+KeyK). Shift and Alt must match exactly. */
export function sameCombo(left: Combo, right: Combo): boolean {
  const command = (candidate: Combo) => candidate.ctrl || candidate.meta;
  return command(left) === command(right) && left.alt === right.alt && left.shift === right.shift && left.code === right.code;
}

export function findConflict(
  accelerator: Accelerator,
  context: {
    /** The bindings currently held, by id, including defaults not yet overridden. */
    bindings: Readonly<Record<RebindableShortcutId, Accelerator>>;
    /** The shortcut being set, so a shortcut never conflicts with itself. */
    setting: RebindableShortcutId;
    /** Desktop builds keep more combinations for themselves. */
    desktop: boolean;
  },
): Conflict | null {
  const candidate = parseAccelerator(accelerator);
  if (candidate === null) return null;

  // Another rebindable shortcut holds this chord.
  for (const shortcut of rebindableShortcuts) {
    if (shortcut.id === context.setting) continue;
    if (shortcut.desktopOnly && !context.desktop) continue;
    const held = parseAccelerator(context.bindings[shortcut.id]);
    if (held !== null && sameCombo(candidate, held)) {
      return {
        kind: "rebindable",
        holder: shortcut.id,
        message: t("shortcuts.conflict.rebindable", { holder: shortcut.label }),
      };
    }
  }

  // A fixed in-app chord.
  for (const fixed of fixedInAppShortcuts) {
    const held = parseAccelerator(fixed.accelerator);
    if (held !== null && sameCombo(candidate, held)) {
      return { kind: "fixed", message: t("shortcuts.conflict.fixed", { keys: acceleratorLabel(fixed.accelerator), holder: fixed.label }) };
    }
  }

  // Reserved by the browser or the operating system.
  const chord = candidate.ctrl || candidate.meta;
  const plainKey = chord && !candidate.shift && RESERVED_CHORD_KEYS.has(candidate.code);
  const shiftedKey = chord && candidate.shift && RESERVED_CHORD_KEYS.has(candidate.code);
  if (plainKey || shiftedKey) {
    return { kind: "reserved", message: t("shortcuts.conflict.reserved", { keys: acceleratorLabel(accelerator) }) };
  }
  if (context.desktop) {
    // Win-key combos: the OS owns Meta everywhere on Windows.
    if (candidate.meta) {
      return { kind: "reserved", message: `${acceleratorLabel(accelerator)} is reserved by Windows.` };
    }
    // Ctrl+Alt+Delete is a secure attention sequence; Alt+F4 closes a window.
    const attention = candidate.ctrl && candidate.alt && /^Delete$/i.test(candidate.code);
    const closeWindow = candidate.alt && !candidate.ctrl && !candidate.shift && candidate.code === "F4";
    if (attention || closeWindow) {
      return { kind: "reserved", message: `${acceleratorLabel(accelerator)} is reserved by Windows.` };
    }
  }
  return null;
}

/* -------------------------------------------------------------------------
 * Storage: palette and chat in localStorage, quick-add in Rust
 * ---------------------------------------------------------------------- */

const STORAGE_KEY = "planner.shortcuts.bindings";
/** Fired (and heard cross-tab via `storage`) whenever a binding changes. */
const CHANGE_EVENT = "planner:shortcut-binding-changed";

type StoredBindings = { palette?: string; chat?: string };

function readStored(): StoredBindings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return {};
    const record = parsed as Record<string, unknown>;
    const out: StoredBindings = {};
    for (const id of ["palette", "chat"] as const) {
      const value = record[id];
      if (typeof value === "string" && parseAccelerator(value) !== null) out[id] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writeStored(next: StoredBindings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage denied: the binding then lives until the page closes */
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** The shortcut a live listener must honor right now, default included. */
export function getBinding(id: RebindableShortcutId): Accelerator {
  if (id === "quickAdd") return rebindableShortcut(id).defaultAccelerator; // truth lives in Rust
  const stored = readStored()[id];
  return stored ?? rebindableShortcut(id).defaultAccelerator;
}

/**
 * Persists a new binding, or clears one (null = default again). Returns the
 * conflict when the chord may not be taken; nothing is written then.
 */
export function setBinding(
  id: RebindableShortcutId,
  accelerator: Accelerator | null,
): Conflict | null {
  if (accelerator === null) {
    const next = readStored() as Record<string, string>;
    delete next[id];
    writeStored(next);
    return null;
  }
  const current = readStored();
  const bindings: Record<RebindableShortcutId, Accelerator> = {
    palette: current.palette ?? rebindableShortcut("palette").defaultAccelerator,
    chat: current.chat ?? rebindableShortcut("chat").defaultAccelerator,
    quickAdd: rebindableShortcut("quickAdd").defaultAccelerator,
  };
  const conflict = findConflict(accelerator, { bindings, setting: id, desktop: false });
  if (conflict !== null) return conflict;
  const next = { ...current } as Record<string, string | undefined>;
  if (accelerator === rebindableShortcut(id).defaultAccelerator) delete next[id];
  else next[id] = accelerator;
  writeStored(next as StoredBindings);
  return null;
}

/**
 * The hook the live listeners read: the panel's Ctrl+J handler, the palette's
 * Ctrl+K and the shell's Ctrl+, all call this, so a rebind takes effect the
 * moment it is saved, on every listening surface and tab.
 *
 * TODO(integrator, chat C-wiring): `ChatPanel.tsx` still hardcodes Ctrl+J —
 * swap its literal match for `useShortcutBinding("chat")` (or `getBinding`)
 * from this module; the handler's preventDefault and capture stay as they are.
 */
export function useShortcutBinding(id: RebindableShortcutId): Accelerator {
  return useSyncExternalStore(subscribeBindings, () => getBinding(id), () => getBinding(id));
}

function subscribeBindings(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  // Another tab rebinding the same shortcut arrives as a storage event.
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/* -------------------------------------------------------------------------
 * Matching: does this live keydown mean the shortcut?
 * ---------------------------------------------------------------------- */

/** The fields of a keydown a live listener reads. */
export type LiveEventInput = { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean };

/**
 * True when this keydown is the shortcut's chord. Ctrl and Cmd count as the
 * same command modifier (see `sameCombo`); every other modifier must match
 * exactly, so Ctrl+Shift+K is never the palette.
 */
export function matchesEvent(accelerator: Accelerator, event: LiveEventInput): boolean {
  const combo = parseAccelerator(accelerator);
  if (combo === null) return false;
  return sameCombo(combo, {
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
    code: event.code,
  });
}
