/**
 * The tray line, desktop only (T6, S8.2): one hook that mirrors what the app
 * already knows -- the Up next pick and the focus session -- into Rust, which
 * owns the tray menu, the tooltip and the taskbar progress.
 *
 * Three rules shape this module:
 *
 * 1. **No second opinion about the data.** The block selection is
 *    `domain/upNext.ts` (the same pair the sidebar card and Now mode show) and
 *    the timer maths is `domain/focus.ts`; this file only words them and times
 *    the transfer. Nothing here re-derives what another surface already owns.
 * 2. **The tray keeps its own clock.** A hidden window throttles (or stops) the
 *    page's timers, so the countdown in the payload is computed from
 *    `Date.now()` on every evaluation instead of reading React's last tick.
 *    The interval therefore keeps reporting while the window sits in the tray.
 * 3. **The bridge is rate limited, not chatty.** `trayPushDecision` decides
 *    whether a push goes now, goes after the remaining gap, or not at all:
 *    at most one push per `TRAY_PUSH_MIN_GAP_MS` (so the taskbar progress
 *    never updates faster than ~10 s) and at least one push per
 *    `TRAY_HEARTBEAT_MS` while a focus session runs.
 *
 * A plain browser never talks to Rust: every entry point is behind `isTauri`.
 */
import { useEffect, useRef } from "react";
import type { BlockView, TaskView } from "./data/store.ts";
import { isTauri } from "./desktop.ts";
import { focusStatus, focusedMs, remainingMs, type FocusSession } from "./domain/focus.ts";
import { currentAndNext } from "./domain/upNext.ts";
import { timeLabel } from "./ui/time.ts";

/** What the tray shows before anybody signed in (also Rust's starting label). */
export const SIGNED_OUT_UP_NEXT = "Sign in to see Up next";

/** The tray's line for a day with nothing left in it. */
export const NOTHING_UP_NEXT = "Up next: Nothing else today";

/** Never more than one push per 10 s: the taskbar progress update cap (S8.2). */
export const TRAY_PUSH_MIN_GAP_MS = 10_000;

/** While focus runs, a payload identical to the last one is still resent. */
export const TRAY_HEARTBEAT_MS = 60_000;

/** How often the payload is recomputed (the decision decides what is sent). */
export const TRAY_EVALUATE_MS = 5_000;

/** The taskbar bar while a session runs (`normal`) or is held (`paused`). */
export type TrayProgress = { status: "normal" | "paused"; fraction: number } | null;

/** Exactly what Rust receives: menu labels, tooltip and the taskbar state. */
export type TrayPayload = {
  /** The whole disabled menu line, e.g. `Up next: Deep work · 14:00`. */
  upNext: string;
  /** The focus line, or null while no session runs (the row is dropped). */
  focus: string | null;
  progress: TrayProgress;
};

/** What the shell knows and the tray mirrors; null while signed out. */
export type TrayData = {
  blocks: BlockView[];
  tasks: TaskView[];
  timeZone: string | null;
  session: FocusSession | null;
};

/** "Up next: Deep work · 14:00", "Up next: Nothing else today". The running
 * block wins the line (it is what the sidebar card shows first); its time is
 * the start, the same wall-clock the rows use. */
export function upNextLabel(blocks: BlockView[], tasks: TaskView[], timeZone: string, nowMs: number): string {
  const { current, next } = currentAndNext(blocks, nowMs, timeZone);
  const block = current ?? next;
  if (block === undefined) return NOTHING_UP_NEXT;
  const title = tasks.find(task => task.id === block.taskId)?.title ?? "Work block";
  return `Up next: ${title} · ${timeLabel(new Date(block.start), timeZone)}`;
}

/** "Focus: 18 min left". Whole minutes, rounding up so the last minute is
 * never shown as zero; the caller drops the line when the session is over. */
export function focusLine(remaining: number): string {
  const minutes = Math.max(1, Math.ceil(remaining / 60_000));
  return `Focus: ${minutes} min left`;
}

/** Elapsed fraction of the session's planned span, 0..1. Paused time is
 * already excluded by `focusedMs`, so pausing freezes the number in place. */
export function focusFraction(session: FocusSession, nowMs: number): number {
  const total = session.endAt - session.startedAt - session.pausedMs;
  if (total <= 0) return 1;
  return Math.min(1, Math.max(0, focusedMs(session, nowMs) / total));
}

/** When the payload should reach Rust. Pushes are rate limited to
 * `TRAY_PUSH_MIN_GAP_MS`; a running session is also resent every
 * `TRAY_HEARTBEAT_MS` even when nothing in the payload changed. */
export type TrayPushDecision = { push: true } | { push: false; retryInMs: number | null };

export function trayPushDecision(
  sent: TrayPayload | null,
  next: TrayPayload,
  nowMs: number,
  lastPushAt: number | null,
): TrayPushDecision {
  if (sent === null || lastPushAt === null) return { push: true };
  const gap = nowMs - lastPushAt;
  const changed = JSON.stringify(sent) !== JSON.stringify(next);
  const running = next.progress?.status === "normal";
  const heartbeat = running && gap >= TRAY_HEARTBEAT_MS;
  if (!changed && !heartbeat) return { push: false, retryInMs: null };
  if (gap >= TRAY_PUSH_MIN_GAP_MS) return { push: true };
  return { push: false, retryInMs: TRAY_PUSH_MIN_GAP_MS - gap };
}

/** The payload for a signed-in shell, computed at `nowMs` (rule 2 above). */
export function liveTrayPayload(data: TrayData, nowMs: number): TrayPayload {
  const zone = data.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const status = data.session === null ? null : focusStatus(data.session, nowMs);
  const session = data.session;
  if (session === null || status === null || status === "done") {
    return { upNext: upNextLabel(data.blocks, data.tasks, zone, nowMs), focus: null, progress: null };
  }
  return {
    upNext: upNextLabel(data.blocks, data.tasks, zone, nowMs),
    focus: focusLine(remainingMs(session, nowMs)),
    progress: { status: status === "paused" ? "paused" : "normal", fraction: focusFraction(session, nowMs) },
  };
}

/** The payload for a signed-out app: no focus, no progress, one instruction. */
export function signedOutTrayPayload(): TrayPayload {
  return { upNext: SIGNED_OUT_UP_NEXT, focus: null, progress: null };
}

/**
 * Pushes `{ upNext, focus, progress }` to Rust whenever the tray would say
 * something different. `data === null` means signed out; leaving the signed-in
 * shell (a sign-out) replaces the last live line with the signed-out one.
 */
export function useDesktopTray(data: TrayData | null): void {
  const latest = useRef(data);
  latest.current = data;
  const sentRef = useRef<{ payload: TrayPayload; at: number } | null>(null);
  const retryRef = useRef<number | undefined>(undefined);
  const signOutRef = useRef<number | undefined>(undefined);
  const evaluateRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!isTauri()) return undefined;
    // A StrictMode remount must not inherit a pending sign-out push: this run
    // is the live one again.
    window.clearTimeout(signOutRef.current);

    const push = (payload: TrayPayload, now: number) => {
      sentRef.current = { payload, at: now };
      void import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke("tray_sync", { payload }))
        .catch(cause => console.error("could not sync the tray", cause));
    };

    const evaluate = () => {
      window.clearTimeout(retryRef.current);
      const now = Date.now();
      const payload = latest.current === null ? signedOutTrayPayload() : liveTrayPayload(latest.current, now);
      const sent = sentRef.current;
      const decision = trayPushDecision(sent?.payload ?? null, payload, now, sent?.at ?? null);
      if (decision.push) push(payload, now);
      else if (decision.retryInMs !== null) retryRef.current = window.setTimeout(evaluate, decision.retryInMs);
    };
    evaluateRef.current = evaluate;

    const interval = window.setInterval(evaluate, TRAY_EVALUATE_MS);
    evaluate();
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(retryRef.current);
      evaluateRef.current = () => undefined;
      if (latest.current === null) return;
      // The shell is leaving (a sign-out): the live line must not outlive it.
      // Deferred so a StrictMode remount cancels it before it fires.
      signOutRef.current = window.setTimeout(() => push(signedOutTrayPayload(), Date.now()), 300);
    };
  }, []);

  // Sign-in, new blocks or a started session: refresh now, do not wait a tick.
  useEffect(() => {
    evaluateRef.current();
  }, [data]);
}
