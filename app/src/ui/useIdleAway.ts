import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FocusReport, FocusSession, FocusStatus } from "../domain/focus.ts";
import {
  IDLE_POLL_MS,
  appliedKeyOf,
  awayMinutesOf,
  awayStart,
  clipAwaySpan,
  clampSubtraction,
  isApplied,
  isIdle,
  markApplied,
  readIdleThreshold,
  savePendingSubtraction,
  sessionKeyOf,
  type AwaySpan,
} from "../domain/idle.ts";
import { subtractActualMinutes } from "../data/tasks.ts";
import { isTauri } from "../desktop.ts";
import { trackedMinutes } from "./useFocusTimer.ts";

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

  // The current session's away spans, plus one still open (the user has been
  // idle past the threshold but has not come back yet).
  const spansRef = useRef<AwaySpan[]>([]);
  const openFromRef = useRef<number | null>(null);
  // The last session this hook saw, so the transition can close an open span.
  const lastSessionRef = useRef<FocusSession | null>(null);
  // The latest stopped report per block, so a prompt created when the session
  // already ended can still know what was recorded.
  const recordedRef = useRef<{ blockId: string; minutes: number } | null>(null);

  /** Closes the open span at `end`, clips it, and sums the session's spans
   * into (or updates) the one pending prompt. A total under a whole minute
   * stays silent. */
  const closeSpanAndPrompt = useCallback((ended: FocusSession, end: number) => {
    if (openFromRef.current !== null) {
      const clipped = clipAwaySpan({ from: openFromRef.current, to: end }, ended, end);
      openFromRef.current = null;
      if (clipped !== null) spansRef.current.push(clipped);
    }
    const minutes = awayMinutesOf(spansRef.current);
    if (minutes < 1) return;
    const recorded =
      recordedRef.current !== null && recordedRef.current.blockId === ended.blockId
        ? recordedRef.current.minutes
        : null;
    const sessionKey = sessionKeyOf(ended);
    setPrompt({
      key: appliedKeyOf(sessionKey, spansRef.current),
      sessionKey,
      blockId: ended.blockId,
      ...(ended.taskId === undefined ? {} : { taskId: ended.taskId }),
      minutes,
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
            if (openFromRef.current === null) openFromRef.current = awayStart(Date.now(), idleSeconds);
          } else if (openFromRef.current !== null) {
            closeSpanAndPrompt(session, Date.now());
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
    if (openFromRef.current !== null) closeSpanAndPrompt(previous, Math.min(Date.now(), previous.endAt));
    spansRef.current = [];
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

  /** Subtract, once. The clamp uses the counter snapshot the store holds; the
   * ledger pins the decision so a second click, a re-render or a reconnect
   * cannot repeat the write. */
  const confirm = useCallback(
    (taskActualMinutes: number | undefined) => {
      const current = promptRef.current;
      if (current === null) return;
      const subtractable = clampSubtraction(current.minutes, current.recorded, taskActualMinutes);
      setPrompt(null);
      if (subtractable < 1 || isApplied(current.key, window.localStorage)) return;
      markApplied(current.key, window.localStorage);
      if (current.recorded === null) {
        // The session has not reported: fold the subtraction into its stop
        // write (useFocusTimer consumes it exactly once).
        savePendingSubtraction(current.sessionKey, subtractable, window.localStorage);
        return;
      }
      if (uid === undefined || current.taskId === undefined) return; // nothing was ever written
      void subtractActualMinutes(uid, current.taskId, subtractable).catch((cause: unknown) => {
        onError?.(cause instanceof Error ? cause.message : "The subtraction could not be saved. Try again.");
      });
    },
    [uid, onError],
  );

  /** Keep: no write at all, and the session's spans are spent — they never
   * come back into a later prompt. */
  const keep = useCallback(() => {
    setPrompt(null);
    spansRef.current = [];
  }, []);

  return { prompt, onFocusStopped, confirm, keep };
}
