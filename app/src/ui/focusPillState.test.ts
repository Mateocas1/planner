import assert from "node:assert/strict";
import test from "node:test";
import { startFocus } from "../domain/focus.ts";
import { pauseFocus } from "../domain/focus.ts";
import {
  mainInForeground,
  pillEnabledKey,
  pillProgress,
  pillSnapshot,
  pillVisibility,
  readPillEnabled,
  writePillEnabled,
} from "./focusPillState.ts";

const NOW = 1_700_000_000_000;
const session = startFocus({ blockId: "b1", endAt: NOW + 20 * 60_000 }, NOW);

/** A Storage stub: the pill helpers must work without a real localStorage. */
function fakeStorage(values: Record<string, string> = {}): Storage {
  return {
    get length() {
      return Object.keys(values).length;
    },
    clear: () => {
      values = {};
    },
    getItem: (key: string) => values[key] ?? null,
    key: () => null,
    removeItem: (key: string) => {
      delete values[key];
    },
    setItem: (key: string, value: string) => {
      values[key] = value;
    },
  } as Storage;
}

function inputs(overrides: Partial<Parameters<typeof pillVisibility>[0]> = {}) {
  return {
    enabled: true,
    hiddenByUser: false,
    mainFocused: false,
    session,
    now: NOW + 60_000,
    ...overrides,
  };
}

test("the pill shows for a running session nobody is hiding", () => {
  assert.equal(pillVisibility(inputs()), true);
});

test("the pill shows while the session is paused", () => {
  assert.equal(pillVisibility(inputs({ session: { ...session, pausedAt: NOW + 30_000 } })), true);
});

test("the setting off means the pill never shows", () => {
  assert.equal(pillVisibility(inputs({ enabled: false })), false);
});

test("the pill hides while the main window is in the foreground", () => {
  assert.equal(pillVisibility(inputs({ mainFocused: true })), false);
});

test("the user's close keeps the pill hidden for the rest of the session", () => {
  assert.equal(pillVisibility(inputs({ hiddenByUser: true })), false);
});

test("the pill hides when there is no session or the session is done", () => {
  assert.equal(pillVisibility(inputs({ session: null })), false);
  assert.equal(pillVisibility(inputs({ now: session.endAt + 1 })), false);
});

test("pillSnapshot recomputes status and remaining from the stored instants", () => {
  const snap = pillSnapshot(JSON.stringify(session), NOW + 60_000);
  assert.equal(snap?.status, "running");
  assert.equal(snap?.remaining, 19 * 60_000);
  assert.equal(pillSnapshot("not json", NOW), null);
  assert.equal(pillSnapshot(null, NOW), null);
});

test("pillProgress is the remaining fraction of the block, clamped to 0..1", () => {
  assert.equal(pillProgress(session, NOW), 1);
  assert.equal(pillProgress(session, NOW + 5 * 60_000), 0.75);
  assert.equal(pillProgress(session, session.endAt + 60_000), 0);
});

test("the floating-timer setting defaults to on and round-trips", () => {
  const storage = fakeStorage();
  assert.equal(readPillEnabled(storage), true);
  writePillEnabled(false, storage);
  assert.equal(storage.getItem(pillEnabledKey), "0");
  assert.equal(readPillEnabled(storage), false);
  writePillEnabled(true, storage);
  assert.equal(readPillEnabled(storage), true);
});

test("a broken or blocked storage still reads as on", () => {
  const broken = {
    getItem: () => {
      throw new Error("blocked");
    },
  } as unknown as Storage;
  assert.equal(readPillEnabled(broken), true);
});

/** The full show rule as the pill page applies it: Rust's window facts
 * folded by `mainInForeground`, then weighed with the session and settings. */
function shows(
  main: { focused: boolean; visible: boolean; minimized: boolean },
  overrides: Partial<Parameters<typeof pillVisibility>[0]> = {},
) {
  return pillVisibility(inputs({ mainFocused: mainInForeground(main), ...overrides }));
}

const front = { focused: true, visible: true, minimized: false };

test("pill rule: hidden while the main window is focused", () => {
  assert.equal(shows(front), false);
});

test("pill rule: shows when the window is hidden to the tray, even if focus was never reported lost", () => {
  assert.equal(shows({ focused: true, visible: false, minimized: false }), true);
  assert.equal(shows({ focused: false, visible: false, minimized: false }), true);
});

test("pill rule: shows when the window is minimized", () => {
  assert.equal(shows({ focused: true, visible: true, minimized: true }), true);
});

test("pill rule: shows when another app has the focus", () => {
  assert.equal(shows({ focused: false, visible: true, minimized: false }), true);
});

test("pill rule: a paused session still shows, an ended one does not", () => {
  const away = { focused: false, visible: false, minimized: false };
  assert.equal(shows(away, { session: pauseFocus(session, NOW + 30_000) }), true);
  assert.equal(shows(away, { now: NOW + 21 * 60_000 }), false);
  assert.equal(shows(away, { session: null }), false);
});

test("pill rule: the user's close and the setting off win over any window state", () => {
  const away = { focused: false, visible: false, minimized: false };
  assert.equal(shows(away, { hiddenByUser: true }), false);
  assert.equal(shows(away, { enabled: false }), false);
});
