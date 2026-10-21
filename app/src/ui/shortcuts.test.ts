import assert from "node:assert/strict";
import test from "node:test";
import {
  blockTomorrow,
  createShortcutRouter,
  isTypingTarget,
  rovingTabIndex,
  sequenceTimeoutMs,
  shortcutHelp,
  tomorrowKey,
  type KeyTarget,
  type RouterContext,
  type ShortcutAction,
} from "./shortcuts.ts";

/**
 * The keyboard engine (distinctive roadmap F6, "Keyboard-first").
 *
 * Everything a key press decides lives here, apart from the DOM and apart from
 * React: which keys mean which action, when a press must be left alone (a field,
 * a dialog, an IME, a browser modifier), and how long the second key of `g h`
 * waits. The components only carry real focus and perform the action, so the
 * rules can be moved without a browser.
 *
 * No clock, no timers: the caller passes the moment it read, and the router
 * compares it with the moment it remembered.
 */

const idle: RouterContext = { dialogOpen: false, enabled: true, rowFocused: false, now: 0 };

type Extra = { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean; isComposing?: boolean; target?: KeyTarget };

/** One press, with the context defaults of a quiet page. */
function press(router: ReturnType<typeof createShortcutRouter>, key: string, context: Partial<RouterContext> = {}, extra: Extra = {}) {
  return router.route({ key, ...extra }, { ...idle, ...context });
}

function actionOf(router: ReturnType<typeof createShortcutRouter>, key: string, context: Partial<RouterContext> = {}) {
  const route = press(router, key, context);
  assert.equal(route.kind, "action", `${key} should route to an action`);
  return route.kind === "action" ? route.action : null;
}

test("j and k walk the row cursor, and the arrows do the same", () => {
  const router = createShortcutRouter();
  assert.equal(actionOf(router, "j"), "next");
  assert.equal(actionOf(router, "k"), "previous");
  assert.equal(actionOf(router, "ArrowDown"), "next");
  assert.equal(actionOf(router, "ArrowUp"), "previous");
  // Caps lock is not a different key
  assert.equal(actionOf(router, "J"), "next");
});

test("the single-key actions are the ones the help promises", () => {
  const router = createShortcutRouter();
  assert.equal(actionOf(router, "x"), "complete");
  assert.equal(actionOf(router, "t"), "tomorrow");
  assert.equal(actionOf(router, "c"), "newTask");
  assert.equal(actionOf(router, "b"), "newBlock");
  assert.equal(actionOf(router, "n"), "now");
  assert.equal(actionOf(router, "?"), "help");
});

test("Enter opens the focused row and does nothing when no row has focus", () => {
  const router = createShortcutRouter();
  assert.equal(actionOf(router, "Enter", { rowFocused: true }), "details");
  // A focused button activates itself natively; the engine only adds the row
  // cursor case, so Enter on anything else stays the browser's.
  assert.deepEqual(press(router, "Enter"), { kind: "ignored", reason: "noRow" });
});

test("a sequence fires inside the window and not after it", () => {
  const router = createShortcutRouter();
  assert.deepEqual(press(router, "g", { now: 0 }), { kind: "pending", sequence: "g" });
  assert.equal(actionOf(router, "t", { now: sequenceTimeoutMs }), "goTasks");

  const late = createShortcutRouter();
  press(late, "g", { now: 0 });
  // 1 ms past the window the `g` is forgotten, so `t` is only itself
  assert.equal(actionOf(late, "t", { now: sequenceTimeoutMs + 1 }), "tomorrow");
});

test("every sequence destination is reachable", () => {
  const cases: Array<[string, ShortcutAction]> = [
    ["h", "goToday"],
    ["t", "goTasks"],
    ["c", "goCalendar"],
  ];
  for (const [key, action] of cases) {
    const router = createShortcutRouter();
    press(router, "g", { now: 100 });
    assert.equal(actionOf(router, key, { now: 200 }), action);
  }
});

test("a key that is not a destination ends the sequence and keeps its own meaning", () => {
  const router = createShortcutRouter();
  press(router, "g", { now: 0 });
  assert.equal(actionOf(router, "j", { now: 10 }), "next");
  // the pending `g` is spent: the next `h` is not a destination any more
  assert.equal(press(router, "h", { now: 20 }).kind, "ignored");
});

test("a second g restarts the window instead of counting as a destination", () => {
  const router = createShortcutRouter();
  press(router, "g", { now: 0 });
  assert.deepEqual(press(router, "g", { now: 900 }), { kind: "pending", sequence: "g" });
  assert.equal(actionOf(router, "c", { now: 1_800 }), "goCalendar");
});

test("typing is never a shortcut", () => {
  const router = createShortcutRouter();
  for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
    assert.deepEqual(press(router, "x", {}, { target: { tagName } }), { kind: "ignored", reason: "editable" });
  }
  assert.deepEqual(press(router, "x", {}, { target: { tagName: "DIV", isContentEditable: true } }), {
    kind: "ignored",
    reason: "editable",
  });
  // anything the browser reports as inside a field, even a rich-text child
  const insideField: KeyTarget = { tagName: "SPAN", closest: (selector: string) => (selector.includes("input") ? { tagName: "INPUT" } : null) };
  assert.equal(isTypingTarget(insideField), true);
  assert.deepEqual(press(router, "j", {}, { target: insideField }), { kind: "ignored", reason: "editable" });
  // a plain button is not a field, and neither is a check: a letter typed on a
  // checkbox is a shortcut, not text nobody can enter there
  assert.equal(isTypingTarget({ tagName: "BUTTON" }), false);
  assert.equal(isTypingTarget({ tagName: "INPUT", type: "checkbox" }), false);
  assert.equal(press(router, "x", {}, { target: { tagName: "INPUT", type: "checkbox" } }).kind, "action");
  // ...while a text input, a date field and a slider's sibling number field are
  assert.equal(isTypingTarget({ tagName: "INPUT", type: "date" }), true);
  assert.equal(isTypingTarget({ tagName: "INPUT", type: "number" }), true);
});

test("an open dialog owns the keyboard", () => {
  const router = createShortcutRouter();
  assert.deepEqual(press(router, "j", { dialogOpen: true }), { kind: "ignored", reason: "dialog" });
  press(router, "g", { now: 0 });
  assert.deepEqual(press(router, "t", { dialogOpen: true, now: 10 }), { kind: "ignored", reason: "dialog" });
  // the interrupted sequence does not survive the dialog
  assert.equal(press(router, "h", { now: 20 }).kind, "ignored");
});

test("an IME composing a word is not a shortcut", () => {
  const router = createShortcutRouter();
  assert.deepEqual(press(router, "x", {}, { isComposing: true }), { kind: "ignored", reason: "composing" });
  assert.deepEqual(press(router, "Process"), { kind: "ignored", reason: "composing" });
  assert.deepEqual(press(router, "Dead"), { kind: "ignored", reason: "composing" });
});

test("Ctrl, Meta and Alt belong to the browser and to the palette", () => {
  const router = createShortcutRouter();
  for (const extra of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
    assert.deepEqual(press(router, "x", {}, extra), { kind: "ignored", reason: "modifier" });
  }
  // Cmd/Ctrl+K stays the palette's: the engine never claims it
  assert.equal(press(router, "k", {}, { metaKey: true }).kind, "ignored");
  // Shift+Arrow resizes the focused block, so the engine leaves it alone
  assert.deepEqual(press(router, "ArrowDown", {}, { shiftKey: true }), { kind: "ignored", reason: "modifier" });
});

test("with the switch off only the single-key shortcuts stop", () => {
  const router = createShortcutRouter();
  const off = { enabled: false };
  for (const key of ["j", "k", "x", "t", "c", "b", "n", "?"]) {
    assert.deepEqual(press(router, key, off), { kind: "ignored", reason: "disabled" }, `${key} must be off`);
  }
  // Navigation keys and the two-key sequences were never single-character
  // shortcuts: they keep working so the switch stays a switch, not a cliff.
  assert.equal(actionOf(router, "ArrowDown", off), "next");
  press(router, "g", { now: 0, enabled: false });
  assert.equal(actionOf(router, "h", { now: 10, enabled: false }), "goToday");
});

test("the help sheet lists every action the engine can produce", () => {
  const covered = new Set(shortcutHelp.flatMap(group => group.entries.map(entry => entry.action)));
  const all: ShortcutAction[] = [
    "next",
    "previous",
    "complete",
    "tomorrow",
    "details",
    "newTask",
    "newBlock",
    "goToday",
    "goTasks",
    "goCalendar",
    "now",
    "help",
  ];
  for (const action of all) assert.equal(covered.has(action), true, `the help is missing ${action}`);
  // Every group has a title and no entry is empty.
  for (const group of shortcutHelp) {
    assert.ok(group.title.length > 0);
    for (const entry of group.entries) {
      assert.ok(entry.keys.length > 0, `${entry.action} has no key`);
      assert.ok(entry.label.length > 0, `${entry.action} has no label`);
    }
  }
});

test("roving tabindex keeps exactly one tab stop, even when the row left", () => {
  const order = ["a", "b", "c"];
  assert.equal(rovingTabIndex(null, "a", order), 0);
  assert.equal(rovingTabIndex(null, "b", order), -1);
  assert.equal(rovingTabIndex("b", "b", order), 0);
  assert.equal(rovingTabIndex("b", "a", order), -1);
  // the cursor was on a row that a completion just moved out of the list
  assert.equal(rovingTabIndex("gone", "a", order), 0);
  assert.equal(rovingTabIndex("gone", "b", order), -1);
  assert.equal(rovingTabIndex(null, "a", []), -1);
});

test("a deadline moves one calendar day, never earlier", () => {
  assert.equal(tomorrowKey("2026-03-29"), "2026-03-30");
  assert.equal(tomorrowKey("2026-12-31"), "2027-01-01");
  assert.equal(tomorrowKey("2028-02-28"), "2028-02-29");
});

test("t on a block keeps its hour on the next day, across a DST change", () => {
  // Madrid springs forward on 2026-03-29: 24 hours after 09:00 on the 28th is
  // 10:00 on the 29th, so a block that kept its hour is the only right answer.
  const spring = { start: "2026-03-28T09:00:00+01:00", end: "2026-03-28T10:00:00+01:00" };
  assert.deepEqual(blockTomorrow(spring, "Europe/Madrid"), {
    start: "2026-03-29T09:00:00+02:00",
    end: "2026-03-29T10:00:00+02:00",
  });
  // And it falls back on 2026-10-25, where 24 hours would land at 08:00.
  const autumn = { start: "2026-10-24T09:00:00+02:00", end: "2026-10-24T10:00:00+02:00" };
  assert.deepEqual(blockTomorrow(autumn, "Europe/Madrid"), {
    start: "2026-10-25T09:00:00+01:00",
    end: "2026-10-25T10:00:00+01:00",
  });
});

test("a block that ends at midnight ends at the next midnight", () => {
  const block = { start: "2026-05-04T23:00:00+02:00", end: "2026-05-05T00:00:00+02:00" };
  assert.deepEqual(blockTomorrow(block, "Europe/Madrid"), {
    start: "2026-05-05T23:00:00+02:00",
    end: "2026-05-06T00:00:00+02:00",
  });
});
