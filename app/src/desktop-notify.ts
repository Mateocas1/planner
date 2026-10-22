import { bannerVisible } from "./ui/shutdownRitual.ts";

/**
 * Actionable native notifications' pure half (task T7, spec S8.3 + S3).
 *
 * Two reminders exist, and both reuse a rule the app already owns:
 *
 * - **Block start.** Two minutes before a work block starts, a Windows toast
 *   offers [Start focus] and [+5 min]. What to notify when, the dedupe and the
 *   snooze live here, so the Rust side only draws a toast and reports back
 *   which action the person pressed. Nothing is ever notified twice for the
 *   same block start: the dedupe key is the block id *and* its start instant,
 *   so moving a block re-arms its reminder while a redundant move does not.
 * - **Shutdown nudge.** The same trigger as Home's banner: `bannerVisible`
 *   (`ui/shutdownRitual.ts`), the app's own rule, not a new time. At most one
 *   nudge per profile-zone day.
 *
 * No Firebase, no React, no storage, no clock: the caller hands in the blocks
 * it currently knows about and `Date.now()`, and gets back data. The React glue
 * (`ui/useDesktopNotifications.ts`) reads and writes the per-device state this
 * module shapes, so unit tests pin every decision without a DOM.
 *
 * Two deliberate rules, from the T7 checklist:
 *
 * - A snoozed reminder fires even though the block may have started meanwhile
 *   ("+5 min re-notifies 5 min later" is tested against a block starting 3 min
 *   out, so the re-toast lands after the start). It never fires for a deleted
 *   or already *ended* block: there is nothing left to focus on.
 * - The first reminder is never sent late: a block that already started when
 *   the scheduler first sees it ("missed") stays silent.
 */

/** How long before a block's start its reminder fires. */
export const reminderLeadMs = 2 * 60_000;

/** How far [+5 min] pushes the reminder. Only the reminder moves, never the block. */
export const snoozeMs = 5 * 60_000;

/**
 * A block as the scheduler sees it: the store's shape, narrowed to the fields
 * the decision needs. `id` is the Firestore document id; `start`/`end` are ISO
 * instants, exactly as stored.
 */
/**
 * A block as the scheduler sees it: the store's shape, narrowed to the fields
 * the decision needs. `id` is the Firestore document id; `start`/`end` are ISO
 * instants, exactly as stored. `title`/`taskId` are display-only (the toast's
 * line of text); the decisions never read them.
 */
export type NotifyBlock = { id: string; start: string; end: string; title?: string; taskId?: string };

/** Per-device notification settings (desktop only, both on by default). */
export type NotifySettings = { blockReminders: boolean; shutdownNudge: boolean };

/** The settings a fresh device gets. */
export const defaultNotifySettings: NotifySettings = { blockReminders: true, shutdownNudge: true };

/**
 * Per-device reminder state, persisted in this device's `localStorage` (not the
 * profile): toasts belong to the machine that showed them.
 *
 * - `notified` holds the dedupe keys whose reminder already fired.
 * - `snoozed` maps a key to the instant its snoozed reminder fires.
 * - `shutdownDay` is the profile-zone day key the nudge last fired on.
 */
export type NotifyState = { notified: string[]; snoozed: Record<string, number>; shutdownDay?: string };

export function emptyNotifyState(): NotifyState {
  return { notified: [], snoozed: {} };
}

/** The dedupe key of one block start: the id *and* the instant (S8.3). */
export function reminderKey(block: Pick<NotifyBlock, "id" | "start">): string {
  return `${block.id}@${block.start}`;
}

/** Reads stored state, tolerating anything a hand edit or a schema bump left there. */
export function parseNotifyState(raw: string | null): NotifyState {
  if (raw === null) return emptyNotifyState();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return emptyNotifyState();
  }
  if (value === null || typeof value !== "object") return emptyNotifyState();
  const { notified, snoozed, shutdownDay } = value as Record<string, unknown>;
  const state = emptyNotifyState();
  if (Array.isArray(notified)) state.notified = notified.filter((key): key is string => typeof key === "string");
  if (snoozed !== null && typeof snoozed === "object" && !Array.isArray(snoozed)) {
    for (const [key, instant] of Object.entries(snoozed)) {
      if (typeof instant === "number" && Number.isFinite(instant)) state.snoozed[key] = instant;
    }
  }
  if (typeof shutdownDay === "string") state.shutdownDay = shutdownDay;
  return state;
}

export function serializeNotifyState(state: NotifyState): string {
  return JSON.stringify(state);
}

/** The per-device key the settings live under (React glue and the settings sheet share it). */
export const notifySettingsStorageKey = "planner-notify-settings";

/** Same tolerance for the settings payload. Missing toggles mean "on". */
export function parseNotifySettings(raw: string | null): NotifySettings {
  if (raw === null) return { ...defaultNotifySettings };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ...defaultNotifySettings };
  }
  if (value === null || typeof value !== "object") return { ...defaultNotifySettings };
  const { blockReminders, shutdownNudge } = value as Record<string, unknown>;
  return {
    blockReminders: typeof blockReminders === "boolean" ? blockReminders : true,
    shutdownNudge: typeof shutdownNudge === "boolean" ? shutdownNudge : true,
  };
}

/** Why a reminder fires: the block's first toast, or one the user asked for. */
export type DueReminder = { block: NotifyBlock; key: string; kind: "start" | "snoozed" };

/**
 * Every block reminder that should fire *now*.
 *
 * The first reminder is due from `start - 2 min` until the block starts; once
 * the block started, a reminder nobody saw is not sent late. A snoozed
 * reminder fires at its asked-for instant even past the start, but never for a
 * block that is gone or already over, and never twice.
 */
export function dueReminders(blocks: readonly NotifyBlock[], nowMs: number, state: NotifyState): DueReminder[] {
  const notified = new Set(state.notified);
  const due: DueReminder[] = [];
  for (const block of blocks) {
    const key = reminderKey(block);
    if (notified.has(key)) continue;
    const startMs = Date.parse(block.start);
    const endMs = Date.parse(block.end);
    const snoozedAt = state.snoozed[key];
    if (snoozedAt !== undefined) {
      if (snoozedAt <= nowMs && nowMs < endMs) due.push({ block, key, kind: "snoozed" });
      continue;
    }
    if (startMs - reminderLeadMs <= nowMs && nowMs < startMs) due.push({ block, key, kind: "start" });
  }
  return due;
}

/** Records that a reminder fired, so the same block start never toasts twice. */
export function applyNotified(state: NotifyState, key: string): NotifyState {
  const snoozed = { ...state.snoozed };
  delete snoozed[key];
  return { ...state, notified: [...state.notified, key], snoozed };
}

/** Records a [+5 min] press: the reminder moves, the block never does. */
export function applySnooze(state: NotifyState, key: string, nowMs: number): NotifyState {
  return { ...state, snoozed: { ...state.snoozed, [key]: nowMs + snoozeMs } };
}

/**
 * Drops history nobody needs: notified keys whose block start lies in the past,
 * and snoozes whose block was deleted (they must never fire again, and a key
 * that is gone from `blocks` cannot).
 */
export function pruneNotifyState(state: NotifyState, blocks: readonly NotifyBlock[], nowMs: number): NotifyState {
  const live = new Set(blocks.map(reminderKey));
  const notified = state.notified.filter(key => {
    const start = key.slice(key.indexOf("@") + 1);
    const instant = Date.parse(start);
    return !Number.isNaN(instant) && instant >= nowMs;
  });
  const snoozed: Record<string, number> = {};
  for (const [key, instant] of Object.entries(state.snoozed)) {
    if (live.has(key)) snoozed[key] = instant;
  }
  return { ...state, notified, snoozed };
}

/**
 * Whether the shutdown nudge is due: exactly when Home's banner would be
 * (`bannerVisible` is the app's one rule for "the day is open past its shut
 * down minute"), and this device has not nudged today yet.
 */
export function shutdownNudgeDue(input: {
  today: string;
  wallMinutes: number;
  shutdownTime: number;
  lastShutdown?: unknown;
  state: NotifyState;
}): boolean {
  if (!bannerVisible(input)) return false;
  return input.state.shutdownDay !== input.today;
}

/** Records that the nudge fired on `today`, so it stays at most once per day. */
export function applyShutdownNotified(state: NotifyState, today: string): NotifyState {
  return { ...state, shutdownDay: today };
}
