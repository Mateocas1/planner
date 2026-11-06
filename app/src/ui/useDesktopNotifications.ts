import { useEffect, useRef } from "react";
import { isTauri } from "../desktop.ts";
import {
  applyNotified,
  applyShutdownNotified,
  applySnooze,
  applyWeeklyNotified,
  dueReminders,
  notifySettingsStorageKey,
  parseNotifySettings,
  parseNotifyState,
  pruneNotifyState,
  reminderKey,
  serializeNotifyState,
  shutdownNudgeDue,
  weeklyNudgeDue,
  type NotifyBlock,
  type NotifyState,
  type WeeklyNudgeMoment,
} from "../desktop-notify.ts";
import { t } from "../i18n/index.ts";
import { dateKey, wallMinutes } from "./time.ts";
import type { FocusControls } from "./useFocusTimer.ts";
import type { BlockView, TaskView } from "../data/store.ts";

/**
 * Actionable native notifications' React half (task T7, spec S8.3 + S3).
 *
 * Every decision belongs to `desktop-notify.ts`; this hook is only the pump:
 * on a fixed tick it asks the pure half what is due, draws the toasts through
 * the Rust command (`notify_show`) and acts on what the person pressed, which
 * Rust reports back as `notify-action` events. All state is per-device
 * `localStorage` (toasts belong to the machine that showed them), so a plain
 * browser runs nothing: `isTauri` gates the whole hook, the web build keeps
 * its silence.
 *
 * The two actions reuse the surfaces that already own them, never a fork:
 * [Start focus] calls the shell's one `focus.start` (a session on the same
 * block is left alone), [Close the day] opens the shutdown sheet the banner
 * opens, and a toast's body lands the main window on the block's day in the
 * calendar.
 */

/** How often the scheduler looks at the clock. Toast timing stays inside ±15 s. */
const tickMs = 15_000;

const stateStorageKey = "planner-notify-state";

function readState(): NotifyState {
  try {
    return parseNotifyState(window.localStorage.getItem(stateStorageKey));
  } catch {
    return parseNotifyState(null);
  }
}

function writeState(state: NotifyState): void {
  try {
    window.localStorage.setItem(stateStorageKey, serializeNotifyState(state));
  } catch {
    /* see desktop-notify: the state then lives only until the page closes */
  }
}

function readSettings() {
  try {
    return parseNotifySettings(window.localStorage.getItem(notifySettingsStorageKey));
  } catch {
    return parseNotifySettings(null);
  }
}

/** What one toast activation carries; only these shapes are ever acted on. */
export type NotifyAction =
  | { kind: "blockFocus"; key: string; blockId: string }
  | { kind: "blockOpen"; key: string; blockId: string; date: string }
  | { kind: "blockSnooze"; key: string }
  | { kind: "shutdownOpen" }
  | { kind: "weeklyReview"; key: string; action: "start" | "later" | "skip" };

function parseNotifyAction(payload: unknown): NotifyAction | null {
  if (payload === null || typeof payload !== "object") return null;
  const { kind, key, blockId, date, action } = payload as Record<string, unknown>;
  if (kind === "shutdownOpen") return { kind };
  if (kind === "weeklyReview") {
    if (typeof key !== "string") return null;
    if (action === "start" || action === "later" || action === "skip") return { kind, key, action };
    return null;
  }
  if (typeof key !== "string") return null;
  switch (kind) {
    case "blockFocus":
      return typeof blockId === "string" ? { kind, key, blockId } : null;
    case "blockOpen":
      return typeof blockId === "string" && typeof date === "string" ? { kind, key, blockId, date } : null;
    case "blockSnooze":
      return { kind, key };
    case "shutdownOpen":
      return { kind };
    default:
      return null;
  }
}

/** The day key of a block's start in the profile zone, or null without a zone. */
function blockDay(block: NotifyBlock, timeZone: string): string | null {
  const instant = new Date(block.start);
  return Number.isNaN(instant.getTime()) ? null : dateKey(instant, timeZone);
}

export function useDesktopNotifications({
  blocks,
  tasks,
  timeZone,
  shutdownTime,
  lastShutdown,
  focus,
  onOpenBlock,
  onOpenShutdown,
  weeklyNudge,
}: {
  blocks: BlockView[];
  tasks: TaskView[];
  timeZone: string | null;
  /** Minutes after midnight in the profile zone: when the day shuts down (F3). */
  shutdownTime: number;
  /** The profile zone's day the ritual was last closed, if it was (F3c). */
  lastShutdown?: string;
  focus: FocusControls;
  /** Where a toast's body lands the window: the block's day, on the calendar. */
  onOpenBlock: (date: string) => void;
  /** Opens the shutdown ritual, the banner's own door. */
  onOpenShutdown: () => void;
  /** The weekly review's nudge (S3), already gated on the profile's nudges
   *  switch: the pump asks `getDue()` at every tick, draws at most one toast
   *  per week and moment, and never on a day the shutdown ritual closed.
   *  Absent on callers that do not carry the weekly review. */
  weeklyNudge?: {
    getDue: () => WeeklyNudgeMoment | null;
    lastShutdown?: unknown;
    onOpen: () => void;
    onLater: () => void;
    onSkip: () => void;
  };
}): void {
  // The tick reads these through refs, so a stale closure never toasts for a
  // block that was moved or deleted a beat ago.
  const latest = useRef({ blocks, tasks, timeZone, shutdownTime, lastShutdown, focus, onOpenBlock, onOpenShutdown, weeklyNudge });
  latest.current = { blocks, tasks, timeZone, shutdownTime, lastShutdown, focus, onOpenBlock, onOpenShutdown, weeklyNudge };

  useEffect(() => {
    if (!isTauri()) return undefined;

    const blockTitle = (block: { title?: string; taskId?: string }): string => {
      const { tasks: currentTasks } = latest.current;
      return block.title ?? currentTasks.find(task => task.id === block.taskId)?.title ?? t("tray.workBlock");
    };

    const showToast = (request: Record<string, unknown>): void => {
      void import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke("notify_show", { request }))
        .catch(() => undefined);
    };

    const tick = (): void => {
      const { blocks: currentBlocks, timeZone: zone, shutdownTime: shut, lastShutdown: closed } = latest.current;
      const now = Date.now();
      const settings = readSettings();
      let state = readState();
      let changed = false;

      if (settings.blockReminders) {
        const due = dueReminders(currentBlocks, now, state);
        for (const reminder of due) {
          state = applyNotified(state, reminder.key);
          changed = true;
          const date = zone && blockDay(reminder.block, zone);
          showToast({
            kind: "block",
            key: reminder.key,
            blockId: reminder.block.id,
            ...(date === null ? {} : { date }),
            title: blockTitle(reminder.block),
            ...(reminder.kind === "snoozed" ? { snoozed: true } : {}),
          });
        }
        const pruned = pruneNotifyState(state, currentBlocks, now);
        if (serializeNotifyState(pruned) !== serializeNotifyState(state)) {
          state = pruned;
          changed = true;
        }
      }

      if (settings.shutdownNudge && zone !== null) {
        const today = dateKey(new Date(now), zone);
        if (shutdownNudgeDue({ today, wallMinutes: wallMinutes(new Date(now), zone), shutdownTime: shut, lastShutdown: closed, state })) {
          state = applyShutdownNotified(state, today);
          changed = true;
          showToast({ kind: "shutdown" });
        }
      }

      // The weekly review's toast (S3), outside the shutdown toggle's gate:
      // the profile's nudges switch (through `getDue`) is its own off button.
      const weekly = latest.current.weeklyNudge;
      if (weekly !== undefined && zone !== null) {
        const today = dateKey(new Date(now), zone);
        const key = weeklyNudgeDue({ due: weekly.getDue(), today, lastShutdown: weekly.lastShutdown, state });
        if (key !== null) {
          state = applyWeeklyNotified(state, key);
          changed = true;
          showToast({ kind: "weeklyReview", key });
        }
      }

      if (changed) writeState(state);
    };

    const interval = window.setInterval(tick, tickMs);
    tick();

    let live = true;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const off = await listen<unknown>("notify-action", event => {
        const action = parseNotifyAction(event.payload);
        if (action === null || !live) return;
        const { blocks: currentBlocks, focus: currentFocus, onOpenBlock: openBlock, onOpenShutdown: openShutdown, weeklyNudge: weekly } = latest.current;
        switch (action.kind) {
          case "blockFocus": {
            if (currentFocus.session?.blockId === action.blockId) return;
            const block = currentBlocks.find(entry => entry.id === action.blockId);
            if (block) currentFocus.start({ blockId: block.id, ...(block.taskId === undefined ? {} : { taskId: block.taskId }), endAt: Date.parse(block.end) });
            return;
          }
          case "blockSnooze":
            writeState(applySnooze(readState(), action.key, Date.now()));
            return;
          case "blockOpen":
            openBlock(action.date);
            return;
          case "shutdownOpen":
            openShutdown();
            return;
          case "weeklyReview": {
            if (weekly === undefined) return;
            if (action.action === "start") weekly.onOpen();
            else if (action.action === "later") weekly.onLater();
            else weekly.onSkip();
            return;
          }
        }
      });
      if (!live) {
        off();
        return;
      }
      unlisten = off;
    })().catch(() => undefined);

    return () => {
      live = false;
      window.clearInterval(interval);
      unlisten?.();
    };
  }, []);
}
