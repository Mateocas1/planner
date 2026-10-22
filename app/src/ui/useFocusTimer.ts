import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../data/session.ts";
import type { BlockView, TaskView } from "../data/store.ts";
import { addActualMinutes } from "../data/tasks.ts";
import {
  focusStatus,
  focusedMs,
  formatRemaining,
  parseSession,
  pauseFocus,
  remainingMs,
  resumeFocus,
  serializeSession,
  startFocus,
  stopFocus,
  type FocusReport,
  type FocusSession,
  type FocusStatus,
} from "../domain/focus.ts";
import { dateKey } from "./time.ts";
import { consumePendingSubtraction, sessionKeyOf } from "../domain/idle.ts";
import { minutesToRecord } from "../domain/idleFlow.ts";

/**
 * The focus timer, as React state: one session for the document, kept per
 * device in `localStorage["planner-focus"]` (the sidebar widget's storage rule,
 * value roadmap §3) so a reload resumes the countdown instead of losing it.
 *
 * Three rules shape this hook:
 *
 * 1. Timestamps are the truth. A single interval re-reads `Date.now()` once a
 *    second while the session runs and the tab is visible, and every number is
 *    recomputed from the stored instants (domain/focus.ts). Nothing counts
 *    ticks, so a throttled or suspended tab cannot drift the countdown.
 * 2. The interval exists only while it is needed: running, visible and enabled.
 *    Paused, done, or no session means no timer at all.
 * 3. Time is only *reported* on a stop, never written here -- except for the
 *    one number F2b owns: a stopped session that was spent on a task adds its
 *    whole minutes to that task's `actualMinutes` counter. The write is a
 *    Firestore increment (offline-safe, no read) and it happens beside the
 *    report rather than inside it, so the hook's own state never depends on a
 *    network round trip and a failed counter never breaks the timer.
 *
 * 4. Idle away (T9, desktop only): a subtraction the user confirmed while the
 *    session was still running is folded into this same write rather than sent
 *    as a second one -- domain/idle.ts holds the pending decision, consumed
 *    here exactly once, so the session's minutes land adjusted. The away span
 *    was already clipped to the session's focused time before the user
 *    confirmed, so the result can never go below zero.
 *
 * One session at a time: starting another replaces it with stop semantics, so a
 * replaced session is reported exactly like a stopped one.
 */

/** The storage key, shared with the browser tests that assert a reload resumes. */
export const focusStorageKey = "planner-focus";

/**
 * The shortest session worth recording, in whole minutes.
 *
 * Anything below this is a glance at the timer, not work: counting it would
 * teach the bias learner (planning/bias.ts, same threshold) that every task
 * takes four minutes. Whole completed minutes are recorded, so a 20:41 session
 * adds 20 -- a stopwatch counts what finished, never a rounded-up guess.
 */
export const MIN_TRACKED_MINUTES = 5;

/**
 * What one stopped session adds to the task it was spent on. Returns null when
 * the session contributes nothing: no linked task (a bare work block has
 * nothing to accumulate on) or less than MIN_TRACKED_MINUTES of focus.
 */
export function trackedMinutes(report: FocusReport): { taskId: string; minutes: number } | null {
  const minutes = Math.floor(report.focusedMs / 60_000);
  if (report.taskId === undefined || minutes < MIN_TRACKED_MINUTES) return null;
  return { taskId: report.taskId, minutes };
}

/** What the hook needs from a block to start focusing on it. */
export type FocusCandidate = { blockId: string; taskId?: string; endAt: number };

/** The timer's whole surface, passed to the sidebar widget and the palette. */
export type FocusControls = {
  session: FocusSession | null;
  status: FocusStatus | null;
  /** Countdown to the block's end, in ms. */
  remaining: number;
  /** Time actually focused, pauses excluded, in ms. */
  focused: number;
  /** The focused block's task title, or the product's name for a bare block. */
  label: string;
  /** False when there is no block to focus on, or the running one is that block. */
  canStart: boolean;
  start: (candidate: FocusCandidate) => void;
  startNext: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
};

/** The product's own word for a block with no task (`Calendar.tsx` says the same). */
export const unlinkedBlockTitle = "Work block";

function readStored(): FocusSession | null {
  try {
    return parseSession(window.localStorage.getItem(focusStorageKey));
  } catch {
    /* storage can be blocked (private mode, a denied policy): no restore */
    return null;
  }
}

function store(session: FocusSession | null): void {
  try {
    if (session === null) window.localStorage.removeItem(focusStorageKey);
    else window.localStorage.setItem(focusStorageKey, serializeSession(session));
  } catch {
    /* see readStored: the session then lives only until the page closes */
  }
}

/**
 * The block "start focus on next block" means: the one running now, else the
 * next one still to start today, in the profile timezone -- exactly the first
 * row Up next offers. Running is an instant, so a block that began before
 * midnight still counts; only "next" is a question about today.
 */
function focusCandidate(blocks: BlockView[], nowMs: number, timeZone: string): FocusCandidate | undefined {
  const today = dateKey(new Date(nowMs), timeZone);
  const sorted = [...blocks].sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
  const block =
    sorted.find(entry => Date.parse(entry.start) <= nowMs && nowMs < Date.parse(entry.end)) ??
    sorted.find(entry => Date.parse(entry.start) > nowMs && dateKey(new Date(entry.start), timeZone) === today);
  if (!block) return undefined;
  return { blockId: block.id, ...(block.taskId === undefined ? {} : { taskId: block.taskId }), endAt: Date.parse(block.end) };
}

export function useFocusTimer({
  blocks,
  tasks,
  timeZone,
  enabled = true,
  onStop,
}: {
  blocks: BlockView[];
  tasks: TaskView[];
  timeZone: string | null;
  /** Focus is a desktop surface today (the sidebar); a phone runs no timer. */
  enabled?: boolean;
  /** Where a finished session goes. F2 records `actualMinutes` here. */
  onStop?: (report: FocusReport) => void;
}): FocusControls {
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { user } = useSession();
  const uid = user?.uid;
  const [session, setSession] = useState<FocusSession | null>(() => (enabled ? readStored() : null));
  const [now, setNow] = useState(() => Date.now());
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");

  // The report is the caller's to change; a stale closure would drop it.
  const onStopRef = useRef(onStop);
  useEffect(() => {
    onStopRef.current = onStop;
  }, [onStop]);

  const report = useCallback((ended: FocusSession, stamp: number) => {
    const stopped = stopFocus(ended, stamp);
    onStopRef.current?.(stopped);
    const tracked = trackedMinutes(stopped);
    if (tracked === null || uid === undefined) return;
    // A subtraction confirmed while this session was still running folds into
    // this write instead of becoming a second one (T9 S8.5). Consuming removes
    // the pending entry, so the adjustment happens exactly once; the away span
    // was clipped to the session's focused time before the user confirmed, so
    // the result can never go below zero.
    const away = consumePendingSubtraction(sessionKeyOf(ended), window.localStorage);
    const minutes = minutesToRecord(tracked.minutes, away);
    if (minutes === 0) return;
    // The counter is a side effect of the session, never a gate on it: the
    // timer has already stopped and cleared itself by the time this lands, so
    // an unreachable server leaves the session recorded rather than repeated.
    void addActualMinutes(uid, tracked.taskId, minutes).catch(cause => {
      console.error("could not record actual minutes", cause);
    });
  }, [uid]);

  useEffect(() => {
    const onVisibility = () => {
      const next = document.visibilityState !== "hidden";
      setVisible(next);
      /* Coming back re-reads the clock at once, so a block that ended while the
         tab was hidden shows its done state without waiting for a tick. */
      if (next) setNow(Date.now());
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const status = enabled && session ? focusStatus(session, now) : null;

  useEffect(() => {
    if (status !== "running" || !visible) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [status, visible]);

  const candidate = useMemo(() => focusCandidate(blocks, now, zone), [blocks, now, zone]);

  const start = useCallback(
    (next: FocusCandidate) => {
      const stamp = Date.now();
      if (session) report(session, stamp);
      const started = startFocus(next, stamp);
      setSession(started);
      store(started);
      setNow(stamp);
    },
    [report, session],
  );

  const startNext = useCallback(() => {
    if (candidate) start(candidate);
  }, [candidate, start]);

  const pause = useCallback(() => {
    if (!session) return;
    const stamp = Date.now();
    const next = pauseFocus(session, stamp);
    setSession(next);
    store(next);
    setNow(stamp);
  }, [session]);

  const resume = useCallback(() => {
    if (!session) return;
    const stamp = Date.now();
    const next = resumeFocus(session, stamp);
    setSession(next);
    store(next);
    setNow(stamp);
  }, [session]);

  const stop = useCallback(() => {
    if (!session) return;
    const stamp = Date.now();
    report(session, stamp);
    setSession(null);
    store(null);
    setNow(stamp);
  }, [report, session]);

  const label = session ? tasks.find(task => task.id === session.taskId)?.title ?? unlinkedBlockTitle : "";
  const remaining = session ? remainingMs(session, now) : 0;

  /* The tab title carries the countdown while the timer is live and gives the
     page its own title back on a pause-free stop or on unmount. */
  const prefixed = enabled && session !== null && (status === "running" || status === "paused");
  const titleBase = useRef<string | null>(null);
  useEffect(() => {
    if (prefixed) {
      if (titleBase.current === null) titleBase.current = document.title;
      document.title = `${formatRemaining(remaining)} · ${label}`;
      return;
    }
    if (titleBase.current !== null) {
      document.title = titleBase.current;
      titleBase.current = null;
    }
  }, [prefixed, remaining, label]);
  useEffect(
    () => () => {
      if (titleBase.current !== null) document.title = titleBase.current;
    },
    [],
  );

  return {
    session: enabled ? session : null,
    status,
    remaining,
    focused: session ? focusedMs(session, now) : 0,
    label,
    canStart: enabled && candidate !== undefined && candidate.blockId !== session?.blockId,
    start,
    startNext,
    pause,
    resume,
    stop,
  };
}
