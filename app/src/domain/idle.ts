/**
 * Idle away accounting (task T9, spec S8.5) — the pure half of
 * `ui/useIdleAway.ts`, kept in a `.ts` module so the node test runner
 * (`--experimental-strip-types`) can load it without a DOM.
 *
 * While a focus session runs in the desktop shell, the app polls the Rust
 * `idle_seconds` command every ~30 s. When the OS reports no input for the
 * away threshold, an away span opens at "now − idle"; when input resumes the
 * span closes and the user is asked, once per session, whether those minutes
 * should be subtracted from the task's `actualMinutes`.
 *
 * Data safety is the whole point of this module:
 *
 * - Nothing here writes to Firestore. The subtraction is a *decision* the user
 *   confirms; the write happens through the same paths the focus timer uses
 *   (`addActualMinutes`, or the pending-subtraction adjustment inside
 *   `useFocusTimer.report`). Keep — or no answer at all — writes nothing.
 * - Spans are clipped to the session's focused time (never before the session
 *   started, never past the block's end or into an open pause), so away time
 *   can never exceed what the session will record.
 * - The confirmed subtraction is clamped a second time against the minutes the
 *   session actually recorded and the task's counter, so no counter can go
 *   negative.
 * - Every applied subtraction is recorded under a key derived from the session
 *   and its spans, persisted locally, and checked before any write: a double
 *   click, a re-render or a reconnect cannot apply it twice.
 */

import type { FocusSession } from "./focus.ts";

/** How often the desktop shell polls the OS idle time while a session runs. */
export const IDLE_POLL_MS = 30_000;

/** The away threshold the user chose for T9 (odd/tasks/desktop.md L14). */
export const DEFAULT_IDLE_THRESHOLD_MINUTES = 10;

/** The threshold setting's range, in whole minutes (spec: 5–60). */
export const MIN_IDLE_THRESHOLD_MINUTES = 5;
export const MAX_IDLE_THRESHOLD_MINUTES = 60;

const thresholdStorageKey = "planner-idle-threshold";
const pendingStorageKey = "planner-idle-pending";
const appliedStorageKey = "planner-idle-applied";

/** One stretch of user absence, already clipped to the session's focus. */
export type AwaySpan = { from: number; to: number };

/** A minimal Storage surface, so tests can pass a Map-backed fake. */
export type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/* ------------------------------------------------------------------ */
/* Threshold setting (desktop-only; persisted locally)                 */
/* ------------------------------------------------------------------ */

/**
 * Reads the configured away threshold, clamped into the 5–60 range. A missing,
 * stale or out-of-range value falls back to the default: the setting must
 * never disable detection by holding nonsense.
 */
export function readIdleThreshold(storage: KeyValueStorage | undefined): number {
  if (storage === undefined) return DEFAULT_IDLE_THRESHOLD_MINUTES;
  const raw = storage.getItem(thresholdStorageKey);
  const parsed = raw === null ? Number.NaN : Number(raw);
  if (!Number.isInteger(parsed)) return DEFAULT_IDLE_THRESHOLD_MINUTES;
  return Math.min(MAX_IDLE_THRESHOLD_MINUTES, Math.max(MIN_IDLE_THRESHOLD_MINUTES, parsed));
}

/** Persists the threshold. The caller clamps first (the sheet enforces the range). */
export function writeIdleThreshold(minutes: number, storage: KeyValueStorage): void {
  const clamped = Math.min(MAX_IDLE_THRESHOLD_MINUTES, Math.max(MIN_IDLE_THRESHOLD_MINUTES, Math.floor(minutes)));
  storage.setItem(thresholdStorageKey, String(clamped));
}

/* ------------------------------------------------------------------ */
/* Span detection and clipping                                         */
/* ------------------------------------------------------------------ */

/** The instant an away span began: the poll tick minus the OS-reported idle. */
export function awayStart(nowMs: number, idleSeconds: number): number {
  return nowMs - idleSeconds * 1000;
}

/** True when the OS idle time has reached the threshold: the user is away. */
export function isIdle(idleSeconds: number, thresholdMinutes: number): boolean {
  return idleSeconds * 1000 >= thresholdMinutes * 60_000;
}

/**
 * The last instant of a session that counts as focus: an open pause freezes
 * the clock (time after it is excluded from `focusedMs` by domain/focus.ts),
 * the block's end caps it, and it never runs before the session started. This
 * mirrors `focusClock` in domain/focus.ts. An open span is closed at
 * `pausedAt` when the pause begins (`idleFlow.closeAway`), so paused time is
 * never counted as away; this clip is the second line of defence.
 */
function focusEnd(session: FocusSession, nowMs: number): number {
  return Math.max(Math.min(session.pausedAt ?? nowMs, session.endAt), session.startedAt);
}

/**
 * Clips a raw away span into the session's focused time. Returns null when
 * nothing survives: the span fell entirely outside the session (before it
 * started, after its clock stopped) or lasted less than a whole millisecond
 * of focus.
 */
export function clipAwaySpan(span: AwaySpan, session: FocusSession, nowMs: number): AwaySpan | null {
  const from = Math.max(span.from, session.startedAt);
  const to = Math.min(span.to, focusEnd(session, nowMs));
  if (to <= from) return null;
  return { from, to };
}

/**
 * Whole away minutes across the session's spans, floored once on the sum so
 * two 9.5-minute absences read as 19, not 18. A total under a whole minute
 * stays silent — nothing worth a prompt.
 */
export function awayMinutesOf(spans: AwaySpan[]): number {
  const totalMs = spans.reduce((sum, span) => sum + Math.max(0, span.to - span.from), 0);
  return Math.floor(totalMs / 60_000);
}

/* ------------------------------------------------------------------ */
/* Clamping the confirmed subtraction                                  */
/* ------------------------------------------------------------------ */

/**
 * The largest subtraction that is safe to write.
 *
 * `recordedMinutes` is what the session already added to the task. While the
 * session still runs it is null: its minutes are not in the counter yet, the
 * away span was already clipped so it cannot exceed the session's focus, and
 * the stop write floors `tracked − away` at zero, so `taskActualMinutes` does
 * not apply. Once the session reported, `taskActualMinutes` (a required
 * snapshot of the counter the store holds, 0 for a task with none) bounds the
 * decrement so it can never drive the counter below zero even when the
 * session's own minutes would allow it. Everything floors to a whole minute
 * count of at least 0.
 */
export function clampSubtraction(
  awayMinutes: number,
  recordedMinutes: number | null,
  taskActualMinutes: number,
): number {
  let limit = awayMinutes;
  if (recordedMinutes !== null) limit = Math.min(limit, recordedMinutes, taskActualMinutes);
  return Math.max(0, Math.floor(limit));
}

/* ------------------------------------------------------------------ */
/* Keys                                                                */
/* ------------------------------------------------------------------ */

/** Stable identity of a focus session: the focused block plus the instant the
 * user pressed Focus (a session is re-startable on the same block, so the
 * block alone is not enough). */
export function sessionKeyOf(session: Pick<FocusSession, "blockId" | "startedAt">): string {
  return `${session.blockId}@${session.startedAt}`;
}

/** The idempotency key of one confirmed subtraction: the session plus its
 * exact spans, so the same away stretch can never be applied twice. */
export function appliedKeyOf(sessionKey: string, spans: AwaySpan[]): string {
  return `${sessionKey}|${spans.map(span => `${span.from}-${span.to}`).join(",")}`;
}

/* ------------------------------------------------------------------ */
/* Pending subtraction (confirmed while the session still runs)        */
/* ------------------------------------------------------------------ */

type PendingMap = Record<string, { minutes: number; at: number }>;

/** Entries older than this are stale: their session ended without reporting
 * (the app was closed mid-session), so they can never be consumed. */
const PENDING_TTL_MS = 48 * 60 * 60_000;

function readPending(storage: KeyValueStorage): PendingMap {
  const raw = storage.getItem(pendingStorageKey);
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as PendingMap;
  } catch {
    return {};
  }
}

/**
 * Records a confirmed subtraction for a session that has not reported yet;
 * `useFocusTimer.report` consumes it when the session stops and subtracts the
 * minutes from what that stop writes. Keyed by session; confirmations of one
 * session cover disjoint spans (a confirmed span leaves the books), so they
 * add up. Repeating the same confirmation is the applied ledger's job.
 */
export function savePendingSubtraction(sessionKey: string, minutes: number, storage: KeyValueStorage): void {
  const pending = readPending(storage);
  const kept: PendingMap = {};
  for (const [key, entry] of Object.entries(pending)) {
    if (Date.now() - entry.at < PENDING_TTL_MS) kept[key] = entry;
  }
  kept[sessionKey] = { minutes: (kept[sessionKey]?.minutes ?? 0) + minutes, at: Date.now() };
  storage.setItem(pendingStorageKey, JSON.stringify(kept));
}

/**
 * Reads and removes the pending subtraction for a session — the one-shot hand
 *off into the stop write. Consuming is what makes the adjustment happen at
 * most once: after this returns the minutes, the entry is gone.
 */
export function consumePendingSubtraction(sessionKey: string, storage: KeyValueStorage): number {
  const pending = readPending(storage);
  const entry = pending[sessionKey];
  if (entry === undefined) return 0;
  delete pending[sessionKey];
  storage.setItem(pendingStorageKey, JSON.stringify(pending));
  return Math.max(0, Math.floor(entry.minutes));
}

/* ------------------------------------------------------------------ */
/* Applied ledger (idempotency across re-renders and reconnects)       */
/* ------------------------------------------------------------------ */

/** How many applied keys the ledger keeps. Sessions are sequential and short;
 * the last 50 span many days and the ledger must never grow without bound. */
const APPLIED_LIMIT = 50;

function readApplied(storage: KeyValueStorage): string[] {
  const raw = storage.getItem(appliedStorageKey);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(entry => typeof entry === "string")) return [];
    return parsed as string[];
  } catch {
    return [];
  }
}

/** True when this exact subtraction (session + spans) was already applied. */
export function isApplied(key: string, storage: KeyValueStorage): boolean {
  return readApplied(storage).includes(key);
}

/** Records the subtraction as applied. The write itself is queued by the
 * Firestore SDK; the decision — once — is what the ledger pins. */
export function markApplied(key: string, storage: KeyValueStorage): void {
  const applied = readApplied(storage).filter(entry => entry !== key);
  applied.push(key);
  storage.setItem(appliedStorageKey, JSON.stringify(applied.slice(-APPLIED_LIMIT)));
}
