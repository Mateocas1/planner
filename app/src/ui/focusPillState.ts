import {
  focusStatus,
  parseSession,
  remainingMs,
  type FocusSession,
  type FocusStatus,
} from "../domain/focus.ts";

/**
 * Pure state for the mini floating focus pill (task T8, spec S8.4).
 *
 * The pill is a second Tauri window loading the same bundle, so it shares the
 * main window's `localStorage` on the same origin: the entry
 * `domain/focus.ts` calls `focusStorageKey` is the single source of truth for
 * the running session, and every number here is recomputed from the stored
 * instants — the pill counts nothing of its own. These helpers are pure so the
 * visibility rule and the countdown math can be tested without a DOM.
 *
 * L15 (the pill "aparece sola… pero configurable… pueda esconderla") shapes
 * the visibility rule: it appears by itself while a focus session runs and the
 * main window is not the foreground window, it can be hidden per session with
 * its close button, and the Settings toggle turns it off entirely.
 */

/** The Settings toggle's key; absence means on (the L15 default). */
export const pillEnabledKey = "planner-pill-enabled";

/** Events between the two windows (see ui/FocusPillBridge.tsx). */
export const pillEvents = {
  /** Rust → pill: the main window gained or lost the foreground. */
  mainFocus: "pill://main-focus",
  /** main → pill: the session and its label changed. */
  state: "pill://state",
  /** pill → main: pause/resume the session the pill shares. */
  pause: "pill://pause",
  resume: "pill://resume",
  /** pill → main: "tell me the current session" (asked once, on load). */
  requestState: "pill://request-state",
} as const;

/** Everything the visibility rule weighs. */
export type PillInputs = {
  /** The Settings toggle ("Show floating timer", on by default). */
  enabled: boolean;
  /** The user pressed the pill's close button on this session. */
  hiddenByUser: boolean;
  /** The main window is the foreground window (focused, not hidden/minimized). */
  mainFocused: boolean;
  /** The session exactly as it is stored (or null when none). */
  session: FocusSession | null;
  /** The instant the status is evaluated at. */
  now: number;
};

/**
 * Whether the pill should be on screen right now: a live session (running or
 * paused — a pause is a glance at a frozen timer, not the end of one) while
 * the main window is elsewhere, the setting on, and the user has not hidden it
 * for this session. A done session is over, so it hides.
 */
export function pillVisibility(inputs: PillInputs): boolean {
  if (!inputs.enabled || inputs.hiddenByUser || inputs.mainFocused) return false;
  if (!inputs.session) return false;
  const status = focusStatus(inputs.session, inputs.now);
  return status === "running" || status === "paused";
}

/** What the pill renders, recomputed from the stored session. */
export type PillSnapshot = {
  session: FocusSession;
  status: FocusStatus;
  /** Milliseconds left until the block ends. */
  remaining: number;
};

/** Reads a stored session back into what the pill shows, or null when the
 * stored value cannot be trusted (`parseSession`'s own rule). */
export function pillSnapshot(raw: string | null, now: number): PillSnapshot | null {
  const session = parseSession(raw);
  if (!session) return null;
  return { session, status: focusStatus(session, now), remaining: remainingMs(session, now) };
}

/**
 * The countdown ring's fraction left: 1 at the start, 0 when the block ends.
 * Derived from `remainingMs` (so it freezes on a pause, exactly like the
 * digits) and clamped, so a clock that stepped back can never overshoot.
 */
export function pillProgress(session: FocusSession, now: number): number {
  const total = session.endAt - session.startedAt;
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, remainingMs(session, now) / total));
}

/** Reads the Settings toggle; anything unreadable still means on. */
export function readPillEnabled(storage: Pick<Storage, "getItem"> = window.localStorage): boolean {
  try {
    return storage.getItem(pillEnabledKey) !== "0";
  } catch {
    return true;
  }
}

/** Writes the Settings toggle. A blocked storage silently keeps the default. */
export function writePillEnabled(
  enabled: boolean,
  storage: Pick<Storage, "setItem"> = window.localStorage,
): void {
  try {
    storage.setItem(pillEnabledKey, enabled ? "1" : "0");
  } catch {
    /* storage can be blocked; the pill then follows the default until it is not */
  }
}
