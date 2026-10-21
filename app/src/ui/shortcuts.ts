/**
 * The keyboard engine (distinctive roadmap F6, "Keyboard-first").
 *
 * One listener in the shell asks this module what a key press means; the shell
 * then performs the action or hands it to the mounted surface. Everything that
 * decides -- which key, when to stay out of the way, how long `g h` waits -- is
 * here, apart from React and apart from the DOM, so the rules are testable
 * without a browser and can be changed without touching a surface.
 *
 * The two questions that need the page (is a dialog up, is the caret on a row)
 * are answered by the readers at the bottom; the router only takes their
 * answers, which is why it never reads the DOM itself.
 *
 * Nothing here writes data. The row cursor is real focus, so the surface that
 * owns the focused row performs the action with its own write helper and its
 * own undo offer (`publishShortcut` below carries the request to it).
 */

import { instantForEdge } from "./grid.ts";
import { dateKey, dayMs, keyToWallUtc, wallDayKey, wallMinutes } from "./time.ts";

/**
 * How long the second key of a sequence waits. One second is long enough for a
 * deliberate press and short enough that a forgotten `g` never swallows the
 * next thing the user types.
 */
export const sequenceTimeoutMs = 1000;

/** Everything a key press can ask the app to do. */
export type ShortcutAction =
  | "next"
  | "previous"
  | "complete"
  | "tomorrow"
  | "details"
  | "newTask"
  | "newBlock"
  | "goToday"
  | "goTasks"
  | "goCalendar"
  | "now"
  | "help";

/**
 * Why a press was left alone. Each reason is a rule, so the unit tests can name
 * the rule they prove instead of asserting that "nothing happened".
 */
export type IgnoredReason =
  /** The caret is in a field (input, textarea, select, contenteditable). */
  | "editable"
  /** A sheet, the palette, Now mode or another dialog is up. */
  | "dialog"
  /** An input method is composing; its keystrokes belong to the IME. */
  | "composing"
  /** Ctrl, Meta or Alt is held: the browser and Cmd/Ctrl+K own those. */
  | "modifier"
  /** Day settings has keyboard shortcuts switched off. */
  | "disabled"
  /** Enter with no row-cursor control focused: native activation handles it. */
  | "noRow"
  /** Not a key this engine maps. */
  | "unmapped";

export type Route =
  | { kind: "action"; action: ShortcutAction }
  | { kind: "pending"; sequence: "g" }
  | { kind: "ignored"; reason: IgnoredReason };

/**
 * The event as the router reads it: the fields of a KeyboardEvent that matter,
 * with a target narrow enough to inspect without a DOM.
 */
export type KeyEventLike = {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  /** Whatever the press landed on: a real EventTarget in the browser, a stub in
   * a unit test. The router only asks whether it is a text field. */
  target?: unknown;
};

/** Whatever the press landed on, as far as "is this a text field" goes. */
export type KeyTarget = {
  tagName?: string;
  /** An `<input>`'s type, which decides whether it is a place to type. */
  type?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
} | null;

export type RouterContext = {
  /** A dialog, sheet or overlay owns the keyboard. */
  dialogOpen: boolean;
  /** Day settings → Keyboard shortcuts. Off blocks the single-key shortcuts. */
  enabled: boolean;
  /** The caret sits on a row-cursor control, so Enter has something to open. */
  rowFocused: boolean;
  /** A monotonic clock reading in milliseconds (performance.now()). */
  now: number;
};

/** The keys that mean something on their own, by lowercased key. */
const singleKeys: Record<string, ShortcutAction> = {
  j: "next",
  k: "previous",
  x: "complete",
  t: "tomorrow",
  c: "newTask",
  b: "newBlock",
  n: "now",
  "?": "help",
};

/** The second key of a `g` sequence. */
const sequences: Record<string, ShortcutAction> = {
  h: "goToday",
  t: "goTasks",
  c: "goCalendar",
};

const editingTags = new Set(["TEXTAREA", "SELECT"]);
const editingSelector = "input, textarea, select, [contenteditable]";

/**
 * The `<input>` types that are not a place to type a word: a check, a radio, a
 * button, a slider, a swatch, a file. Focused on one of those a letter is a
 * shortcut again -- there is nothing to type into, and taking the keys away
 * would strand the row cursor on a check (the Tasks row's own check is exactly
 * where a completion leaves focus).
 */
const quietInputTypes = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"]);

/**
 * True when a press is really typing: the target is an editable control, its
 * content is editable, or it sits inside one (a rich-text child). A button, a
 * row or the page itself is not typing.
 */
export function isTypingTarget(target: unknown): boolean {
  if (target === null || target === undefined || typeof target !== "object") return false;
  const candidate = target as { tagName?: unknown; type?: unknown; isContentEditable?: unknown; closest?: unknown };
  if (candidate.isContentEditable === true) return true;
  const tag = typeof candidate.tagName === "string" ? candidate.tagName.toUpperCase() : undefined;
  if (tag === "INPUT") {
    const type = typeof candidate.type === "string" ? candidate.type.toLowerCase() : "";
    return !quietInputTypes.has(type);
  }
  if (tag !== undefined && editingTags.has(tag)) return true;
  if (typeof candidate.closest !== "function") return false;
  // A rich-text child reports no tag of its own; the editable ancestor is what
  // makes the press typing rather than a shortcut.
  return (candidate.closest as (selector: string) => unknown)(editingSelector) !== null;
}

export type ShortcutRouter = {
  /** What this press means, given the page's state. */
  route: (event: KeyEventLike, context: RouterContext) => Route;
};

/**
 * One router per shell, so the pending `g` survives re-renders. It holds that
 * one piece of state and nothing else; every other answer comes from the
 * context the caller passes.
 */
export function createShortcutRouter(): ShortcutRouter {
  let pendingG: number | null = null;

  return {
    route(event, context) {
      /** Every path that ignores a press also spends a pending sequence: a
       * keystroke the engine refused is not the second half of `g t`. */
      const ignore = (reason: IgnoredReason): Route => {
        pendingG = null;
        return { kind: "ignored", reason };
      };

      const key = event.key;
      if (event.isComposing === true || key === "Process" || key === "Dead") return ignore("composing");
      if (isTypingTarget(event.target)) return ignore("editable");
      if (event.ctrlKey === true || event.metaKey === true || event.altKey === true) return ignore("modifier");
      // Shift+Arrow is a control's own gesture (the Calendar resizes the
      // focused block), so the engine never claims a shifted arrow.
      if (event.shiftKey === true && key.startsWith("Arrow")) return ignore("modifier");
      if (context.dialogOpen) return ignore("dialog");

      const lower = key.length === 1 ? key.toLowerCase() : key;

      // A sequence in flight is answered by this key, whatever else it means.
      const waited = pendingG === null ? null : context.now - pendingG;
      pendingG = null;
      if (waited !== null && waited <= sequenceTimeoutMs) {
        const sequence = sequences[lower];
        if (sequence !== undefined) return { kind: "action", action: sequence };
      }

      if (lower === "g") {
        pendingG = context.now;
        return { kind: "pending", sequence: "g" };
      }

      // Arrows are navigation, not a character-key shortcut: WCAG 2.1.4's
      // switch turns off the letters and punctuation below, never these.
      if (key === "ArrowDown") return { kind: "action", action: "next" };
      if (key === "ArrowUp") return { kind: "action", action: "previous" };

      // Enter activates the focused control natively. The engine only adds the
      // row-cursor case, where the row is not a form and nothing would happen.
      if (lower === "Enter") return context.rowFocused ? { kind: "action", action: "details" } : ignore("noRow");

      const action = singleKeys[lower];
      if (action === undefined) return ignore("unmapped");
      if (!context.enabled) return ignore("disabled");
      return { kind: "action", action };
    },
  };
}

/* -------------------------------------------------------------------------
 * The transport: what the shell hands to the surface that owns the rows.
 * ---------------------------------------------------------------------- */

/**
 * The actions a surface performs itself, because only it knows what its rows
 * mean and which undo offer they carry.
 */
export type SurfaceAction = "next" | "previous" | "complete" | "tomorrow" | "newBlock";

/** The window event the shell publishes a surface action on. */
export const shortcutEvent = "planner:shortcut";

export function publishShortcut(action: SurfaceAction): void {
  window.dispatchEvent(new CustomEvent<SurfaceAction>(shortcutEvent, { detail: action }));
}

export function subscribeShortcut(handler: (action: SurfaceAction) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<SurfaceAction>).detail);
  window.addEventListener(shortcutEvent, listener);
  return () => window.removeEventListener(shortcutEvent, listener);
}

/* -------------------------------------------------------------------------
 * The two questions only the page can answer.
 * ---------------------------------------------------------------------- */

/** The row cursor's marker: the control that takes focus for a row. */
export const rowCursorSelector = "[data-row-cursor]";

/**
 * True when something modal owns the screen: a sheet (including the details
 * panels and the creation sheets), the command palette, Now mode or the help
 * sheet. A dismissed panel stays mounted through its exit, so only an open
 * state counts.
 */
export function dialogOpen(root: ParentNode = document): boolean {
  return root.querySelector('.sheet[data-state="open"], dialog[open], [role="dialog"]') !== null;
}

/** True when the caret sits on a row-cursor control. */
export function rowHasFocus(root: Document = document): boolean {
  const active = root.activeElement;
  return active !== null && typeof (active as Element).closest === "function" && (active as Element).closest(rowCursorSelector) !== null;
}

/* -------------------------------------------------------------------------
 * The row cursor's tab stop, and the `t` action's calendar arithmetic.
 * ---------------------------------------------------------------------- */

/**
 * Which row carries the list's single tab stop. The cursor follows focus, so
 * every other row is taken out of the tab order; a cursor left on a row that a
 * completion moved out of the list falls back to the first row instead of
 * leaving the list unreachable.
 */
export function rovingTabIndex(activeId: string | null, id: string, order: readonly string[]): 0 | -1 {
  const stop = activeId !== null && order.includes(activeId) ? activeId : order[0];
  return id === stop ? 0 : -1;
}

/** The calendar day after a stored date key, on wall-clock days. */
export function tomorrowKey(key: string): string {
  return wallDayKey(keyToWallUtc(key) + dayMs);
}

/**
 * A block's stored instants one calendar day later, in the profile zone: the
 * same wall-clock hours on the next day. Day arithmetic runs on wall-UTC days
 * and the edges are rebuilt as zoned instants, so a DST change moves the block
 * by 23 or 25 hours rather than by 24 and never shifts its hour (criterion 7).
 */
export function blockTomorrow(block: { start: string; end: string }, timeZone: string): { start: string; end: string } {
  const start = new Date(block.start);
  const end = new Date(block.end);
  return {
    start: instantForEdge(tomorrowKey(dateKey(start, timeZone)), wallMinutes(start, timeZone), timeZone),
    end: instantForEdge(tomorrowKey(dateKey(end, timeZone)), wallMinutes(end, timeZone), timeZone),
  };
}

/* -------------------------------------------------------------------------
 * The help sheet's content: every action above, by group, in the order a
 * person learns them. ShortcutHelp.tsx only renders this.
 * ---------------------------------------------------------------------- */

export type ShortcutHelpEntry = {
  /** The keys as they are printed on a keyboard, one chip each. */
  keys: readonly string[];
  label: string;
  /** The action these keys route to; absent for a key the surfaces own. */
  action?: ShortcutAction;
};

export type ShortcutHelpGroup = { title: string; entries: readonly ShortcutHelpEntry[] };

export const shortcutHelp: readonly ShortcutHelpGroup[] = [
  {
    title: "Move",
    entries: [
      { keys: ["j", "↓"], label: "Next row", action: "next" },
      { keys: ["k", "↑"], label: "Previous row", action: "previous" },
    ],
  },
  {
    title: "Act on the focused row",
    entries: [
      { keys: ["Enter"], label: "Open details", action: "details" },
      { keys: ["x"], label: "Complete the task", action: "complete" },
      { keys: ["t"], label: "Move to the next day", action: "tomorrow" },
    ],
  },
  {
    title: "Create",
    entries: [
      { keys: ["c"], label: "New task", action: "newTask" },
      { keys: ["b"], label: "New block", action: "newBlock" },
    ],
  },
  {
    title: "Go",
    entries: [
      { keys: ["g", "h"], label: "Today", action: "goToday" },
      { keys: ["g", "t"], label: "Tasks", action: "goTasks" },
      { keys: ["g", "c"], label: "Calendar", action: "goCalendar" },
      { keys: ["n"], label: "Now mode", action: "now" },
    ],
  },
  {
    title: "Anywhere",
    entries: [
      { keys: ["⌘", "K"], label: "Command palette" },
      { keys: ["?"], label: "This sheet", action: "help" },
      { keys: ["Esc"], label: "Close what is open" },
    ],
  },
];
