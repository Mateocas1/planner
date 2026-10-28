import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FocusReport, FocusSession, FocusStatus } from "../domain/focus.ts";
import {
  IDLE_POLL_MS,
  appliedKeyOf,
  awayMinutesOf,
  awayEnd,
  awayStart,
  isIdle,
  readIdleThreshold,
  sessionKeyOf,
} from "../domain/idle.ts";
import { closeAway, confirmAway, emptyBooks, keepAway, openAway, type AwayBooks } from "../domain/idleFlow.ts";
import { subtractActualMinutes } from "../data/tasks.ts";
import { useProfileTimeZone } from "../data/profile.ts";
import { isTauri } from "../desktop.ts";
import { subtractionDayKey } from "../domain/idle.ts";
import { trackedMinutes } from "./useFocusTimer.ts";
import { t } from "../i18n/index.ts";

/**
 * Idle detection while a focus session runs (task T9, spec S8.5) — the stateful
 * half of `domain/idle.ts`, desktop only (`isTauri`).
 *
 * While the timer's session is open and not paused, this hook polls the Rust
 * `idle_seconds` command every ~30 s. When the OS reports no input for the
 * configured threshold, an away span opens at "now − idle"; when input
 * resumes, the span closes, is clipped to the session's focused time, and the
 * accumulated spans become one non-blocking prompt per session:
 * "You were away 12 min — subtract them?" with [Subtract] [Keep].
 *
 * Data safety is the contract (the whole point of the feature):
 *
 * - Nothing is written unless the user presses Subtract. Keep — or never
 *   answering — writes nothing; the prompt simply stays (or is replaced by a
 *   newer one) until it is answered.
 * - Subtract while the session still runs records a *pending* subtraction that
 *   `useFocusTimer.report` folds into the session's own stop write: one write,
 *   not two. Subtract after the session reported goes through the same
 *   increment transform with a negative value (`subtractActualMinutes`).
 * - Every confirmed subtraction is clamped (`clampSubtraction`) so no counter
 *   can go negative, and recorded in a persisted applied ledger keyed by the
 *   session and its exact spans, so a double click, a re-render or a
 *   reconnect applies it exactly once.
 *
 * The probe failure mode is silence: a failed `idle_seconds` call skips that
 * tick and the next one tries again. Detection never disturbs the timer.
 */

/** What the prompt holds while the user decides. */
export type IdlePrompt = {
  /** The idempotency key of this exact confirmation (session + spans). */
  key: string;
  /** The session the away time belongs to. */
  sessionKey: string;
  /** The block the away time was spent on (to match a late report). */
  blockId: string;
  taskId?: string;
  /** Whole away minutes, unclamped — the number the sentence shows. */
  minutes: number;
  /**
   * The session's start, in epoch ms: the instant the subtraction's day key
   * comes from (ronda 2, review fix 2 — the same day the session's focus
   * credit landed, never the away span's own day and never "now" at write
   * time). A prompt without a usable start refuses the write (review fix 4).
   */
  startedAt: number;
  /**
   * What the session already recorded, when it has stopped: null while the
   * session is still open (its minutes will fold the subtraction in), 0 when
   * it reported nothing worth recording (below MIN_TRACKED_MINUTES or no
   * linked task — subtracting would then have nothing to subtract from).
   */
  recorded: number | null;
};

export function useIdleAway({
  uid,
  session,
  status,
  onError,
}: {
  uid: string | undefined;
  session: FocusSession | null;
  status: FocusStatus | null;
  /** Where a failed subtraction is reported (the shell's error line). */
  onError?: (message: string) => void;
}) {
  const [prompt, setPrompt] = useState<IdlePrompt | null>(null);
  const promptRef = useRef<IdlePrompt | null>(null);
  promptRef.current = prompt;

  // The profile zone decides which day an away span belongs to — the same
  // zone every other day key in the app is read in. The browser zone is the
  // fallback while the profile is still loading, like the focus timer's.
  const profile = useProfileTimeZone(uid ?? null);
  const zone = profile.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  // The current session's away spans, plus one still open (the user has been
  // idle past the threshold but has not come back yet).
  const booksRef = useRef<AwayBooks>(emptyBooks());
  // The last session this hook saw, so the transition can close an open span.
  const lastSessionRef = useRef<FocusSession | null>(null);
  // The latest stopped report per block, so a prompt created when the session
  // already ended can still know what was recorded.
  const recordedRef = useRef<{ blockId: string; minutes: number } | null>(null);

  /** Closes the open span at `end`, clips it, and sums the session's spans
   * into (or updates) the one pending prompt. A total under a whole minute
   * stays silent. */
  const closeSpanAndPrompt = useCallback((ended: FocusSession, end: number) => {
    booksRef.current = closeAway(booksRef.current, ended, end);
    const spans = booksRef.current.spans;
    const minutes = awayMinutesOf(spans);
    if (minutes < 1) return;
    const recorded =
      recordedRef.current !== null && recordedRef.current.blockId === ended.blockId
        ? recordedRef.current.minutes
        : null;
    const sessionKey = sessionKeyOf(ended);
    setPrompt({
      key: appliedKeyOf(sessionKey, spans),
      sessionKey,
      blockId: ended.blockId,
      ...(ended.taskId === undefined ? {} : { taskId: ended.taskId }),
      minutes,
      // The subtraction rides the session's start day (review fix 2), so the
      // prompt carries the start the credit used.
      startedAt: ended.startedAt,
      recorded,
    });
  }, []);

  /* The poller. It exists only while a desktop session is open and not paused:
     a paused session counts nothing (its clock is frozen, so a span would clip
     to nothing anyway, but there is no reason to burn a timer either). */
  useEffect(() => {
    if (!isTauri() || session === null || session.taskId === undefined || status === "paused") {
      return undefined;
    }
    let cancelled = false;
    const tick = () => {
      invoke<number>("idle_seconds")
        .then(idleSeconds => {
          if (cancelled) return;
          const threshold = readIdleThreshold(window.localStorage);
          if (isIdle(idleSeconds, threshold)) {
            // The span opens where the absence began, not where we noticed it.
            booksRef.current = openAway(booksRef.current, awayStart(Date.now(), idleSeconds));
          } else if (booksRef.current.openFrom !== null) {
            // The absence ended at the last input, not at this poll.
            closeSpanAndPrompt(session, awayEnd(Date.now(), idleSeconds));
          }
        })
        .catch(() => {
          /* The probe is unavailable (rare): skip this tick, try the next. */
        });
    };
    tick();
    const id = window.setInterval(tick, IDLE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [session, status, closeSpanAndPrompt]);

  /* Session transitions: when the session that owned an open span ends or is
     replaced, close the span against its focused clock (stopping the timer
     takes input, so the poller may not have seen the return yet), evaluate
     the prompt, and start the next session with empty books. */
  useEffect(() => {
    const previous = lastSessionRef.current;
    lastSessionRef.current = session;
    if (previous === null) return;
    if (session !== null && sessionKeyOf(session) === sessionKeyOf(previous)) return;
    if (booksRef.current.openFrom !== null) closeSpanAndPrompt(previous, Math.min(Date.now(), previous.endAt));
    booksRef.current = emptyBooks();
  }, [session, closeSpanAndPrompt]);

  /* A pause freezes the focus clock and stops the poller, so an absence still
     open at that instant ends there: paused time is never counted as away,
     however long the pause lasts. */
  useEffect(() => {
    if (session === null || session.pausedAt === undefined) return;
    if (booksRef.current.openFrom !== null) closeSpanAndPrompt(session, session.pausedAt);
  }, [session, closeSpanAndPrompt]);

  /** Where a stopped session's report lands: the prompt learns what the
   * session actually recorded, which is the ceiling of a late subtraction. */
  const onFocusStopped = useCallback((report: FocusReport) => {
    const tracked = trackedMinutes(report);
    const minutes = tracked === null ? 0 : tracked.minutes;
    recordedRef.current = { blockId: report.blockId, minutes };
    setPrompt(current =>
      current !== null && current.blockId === report.blockId && current.recorded === null
        ? { ...current, recorded: minutes }
        : current,
    );
  }, []);

  /** Subtract, once. The clamp uses the counter snapshot the store holds (0
   * for a task with none); the ledger pins the decision so a second click, a
   * re-render or a reconnect cannot repeat the write. The confirmed spans
   * leave the books, so a later stop cannot offer them again. */
  const confirm = useCallback(
    (taskActualMinutes: number) => {
      const current = promptRef.current;
      if (current === null) return;
      // The subtraction's day is the day the session STARTED (ronda 2, review
      // fix 2) — the same day its focus credit landed, so a cross-midnight
      // away span can never drive another day negative. A prompt without a
      // usable start refuses the write (review fix 4): nothing is written and
      // nothing is marked applied, so no epoch-0 day key can exist.
      const dayKey = subtractionDayKey(current.startedAt, zone);
      if (dayKey === undefined) return;
      setPrompt(null);
      booksRef.current = confirmAway(booksRef.current, current, taskActualMinutes, {
        storage: window.localStorage,
        write:
          uid === undefined
            ? undefined
            : (taskId, minutes) => {
                void subtractActualMinutes(uid, taskId, minutes, dayKey).catch(() => {
                  onError?.(t("idle.subtractFailed"));
                });
              },
      }).books;
    },
    [uid, zone, onError],
  );

  /** Keep: no write at all, and the session's spans are spent — they never
   * come back into a later prompt. */
  const keep = useCallback(() => {
    setPrompt(null);
    booksRef.current = keepAway(booksRef.current);
  }, []);

  return { prompt, onFocusStopped, confirm, keep };
}
