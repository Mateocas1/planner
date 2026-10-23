/**
 * The focus timer's state, pure and independent of React, storage and the DOM.
 *
 * A session is one block being focused on. It is a plain object, so it is
 * stored as it is (`localStorage`, per device) and every number in it is
 * recomputed from the stored instants: nothing counts ticks, so a throttled
 * timer, a sleeping laptop or a reload cannot drift the countdown.
 *
 * Two clocks run over the same session:
 *
 * - `remainingMs` counts down to the block's end, the target the user chose;
 * - `focusedMs` counts the time actually spent focusing, which is why a pause
 *   is frozen in both and excluded from the focused total afterwards.
 *
 * Both are clamped, so a system clock that steps backwards can never report
 * negative time or a countdown longer than the block.
 *
 * Timestamps are epoch milliseconds; the caller decides what "now" is.
 */

import { dateKey } from "./instant.ts";

/** One device's focus session, exactly as it is persisted. */
export type FocusSession = {
  blockId: string;
  taskId?: string;
  /** The focused block's end: the countdown target. */
  endAt: number;
  /** When the user pressed Focus. */
  startedAt: number;
  /** When the pause that is still open began; absent while running. */
  pausedAt?: number;
  /** Time spent paused by the pauses that already ended. */
  pausedMs: number;
};

/** What a session needs from a block to start. */
export type FocusSource = { blockId: string; taskId?: string; endAt: number };

export type FocusStatus = "running" | "paused" | "done";

/** What a stopped session reports to the counter (F2 records `actualMinutes`). */
export type FocusReport = { blockId: string; taskId?: string; focusedMs: number };

/** Starts focusing on a block; the countdown target is the block's own end. */
export function startFocus(source: FocusSource, now: number): FocusSession {
  if (!Number.isFinite(source.endAt)) throw new Error("a focus session needs the block's end");
  if (!Number.isFinite(now)) throw new Error("a focus session needs an instant");
  return {
    blockId: source.blockId,
    ...(source.taskId === undefined ? {} : { taskId: source.taskId }),
    endAt: source.endAt,
    startedAt: now,
    pausedMs: 0,
  };
}

/** Freezes the session. Pausing a paused session is a no-op, and a pause can
 * never start before the session did (a clock that stepped back). */
export function pauseFocus(session: FocusSession, now: number): FocusSession {
  if (session.pausedAt !== undefined) return session;
  return { ...session, pausedAt: Math.max(now, session.startedAt) };
}

/** Resumes a paused session, adding the pause to the excluded total. Resuming a
 * running session is a no-op. */
export function resumeFocus(session: FocusSession, now: number): FocusSession {
  if (session.pausedAt === undefined) return session;
  const { pausedAt, ...running } = session;
  return { ...running, pausedMs: session.pausedMs + Math.max(0, now - pausedAt) };
}

/** Ends the session and reports the focused time. Dropping the session is the
 * caller's job: this module never owns storage. */
export function stopFocus(session: FocusSession, now: number): FocusReport {
  return {
    blockId: session.blockId,
    ...(session.taskId === undefined ? {} : { taskId: session.taskId }),
    focusedMs: focusedMs(session, now),
  };
}

/** The instant the focused time is measured up to: the open pause while paused,
 * the block's end once it is over, and never before the session started. */
function focusClock(session: FocusSession, now: number): number {
  return Math.max(Math.min(session.pausedAt ?? now, session.endAt), session.startedAt);
}

/** Milliseconds of focus: elapsed time minus every pause, frozen at the block's
 * end, and never negative (a pause longer than the elapsed time is clamped). */
export function focusedMs(session: FocusSession, now: number): number {
  return Math.max(0, focusClock(session, now) - session.startedAt - session.pausedMs);
}

/** Milliseconds left until the block ends: frozen while paused, never negative
 * and never longer than the block itself (a clock that stepped back). */
export function remainingMs(session: FocusSession, now: number): number {
  const at = Math.min(Math.max(session.pausedAt ?? now, session.startedAt), session.endAt);
  return Math.max(0, session.endAt - at);
}

/** Running, paused, or over: the block's end wins over a stale pause. */
export function focusStatus(session: FocusSession, now: number): FocusStatus {
  if (remainingMs(session, now) === 0) return "done";
  return session.pausedAt === undefined ? "running" : "paused";
}

/**
 * The countdown as the widget writes it: hours and minutes while more than five
 * minutes are left ("1:30", "0:05"), then minutes and seconds for the last five
 * ("04:59", "00:09"). Both are fixed width, so the digits never reflow.
 */
export function formatRemaining(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const pad = (value: number) => String(value).padStart(2, "0");
  if (seconds >= 300) return `${Math.floor(seconds / 3600)}:${pad(Math.floor((seconds % 3600) / 60))}`;
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

/**
 * The storage key, shared by the sidebar hook (`useFocusTimer.ts`, including
 * the browser tests that assert a reload resumes) and the desktop pill window
 * (`ui/FocusPill.tsx`): both windows load the same origin, so one
 * `localStorage` entry is the single source of truth for the running session.
 */
export const focusStorageKey = "planner-focus";

/** The stored form. One key, one JSON object, read back by parseSession. */
export function serializeSession(session: FocusSession): string {
  return JSON.stringify(session);
}

/**
 * The profile-zone day (YYYY-MM-DD) a stopped session's tracked minutes are
 * attributed to (ronda 2 S3/L6): the day the session *started*, never the day
 * it stopped. A timer running 23:30 → 00:15 counts for the day the work
 * began, so one session never splits across two days and the write lands on
 * the same day key the hook passes to `addActualMinutes` — an attribution the
 * weekly review can sum back exactly.
 */
export function sessionDayKey(startedAtMs: number, timeZone: string): string {
  return dateKey(new Date(startedAtMs), timeZone);
}

function instant(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/**
 * Reads a stored session back, or null when it cannot be trusted.
 *
 * Everything is behind a guard: storage is user-writable, survives deploys and
 * can be written by an older build, so a malformed value must mean "no timer"
 * rather than a broken widget. A restore is deliberately tolerant of the past
 * (a session that ended yesterday restores as done) and strict about shape.
 */
export function parseSession(raw: string | null): FocusSession | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const stored = value as Record<string, unknown>;
  if (typeof stored.blockId !== "string" || stored.blockId === "") return null;
  if (!instant(stored.endAt) || !instant(stored.startedAt)) return null;
  if (!instant(stored.pausedMs) || stored.pausedMs < 0) return null;
  if (stored.pausedAt !== undefined && !instant(stored.pausedAt)) return null;
  if (stored.taskId !== undefined && typeof stored.taskId !== "string") return null;
  return {
    blockId: stored.blockId,
    ...(stored.taskId === undefined ? {} : { taskId: stored.taskId }),
    endAt: stored.endAt,
    startedAt: stored.startedAt,
    ...(stored.pausedAt === undefined ? {} : { pausedAt: stored.pausedAt }),
    pausedMs: stored.pausedMs,
  };
}
