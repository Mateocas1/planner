import { useMemo, useState } from "react";
import { t } from "../../i18n/index.ts";
import { addBlocks, removeBlocks } from "../../data/blocks.ts";
import type { BlockView, TaskView } from "../../data/store.ts";
import { unplacedNotice, type PlanBlock, type PlanTask, type Unplaced } from "../../planning/place.ts";
import type { WorkWindow } from "../../planning/window.ts";
import { dayMs, keyToWallUtc, localValue, pad, toZonedInstant, wallDayKey } from "../time.ts";
import type { UndoableDelete } from "../UndoToast.tsx";
import { settle } from "../write.ts";
import { nextWeekDays, planWeek, type WeekPlacement } from "./planWeek.ts";
import { weekdayName } from "./weeklyFlow.ts";

/**
 * The Plan step (S3): pick next week's priorities, place their blocks on next
 * week's days. The placement arithmetic is `planWeek.ts`'s — one `planDay` per
 * day, priorities first — which is `planning/place.ts`'s own rule, so the
 * week's plan and the daily plan-my-day can never disagree about what "free"
 * means.
 *
 * Applying is one `writeBatch` (`data/blocks.ts` `addBlocks`), and the undo
 * offer names exactly the documents the batch created, as the daily plan does.
 * The step minimum is the spec's: priorities chosen, blocks on next week's
 * days — a full week editor is not built here.
 */
export function PlanStep({
  uid,
  tasks,
  blocks,
  timeZone,
  now,
  workWindow,
  weekMonday,
  onOfferUndo,
  onProblem,
}: {
  uid: string;
  tasks: readonly TaskView[];
  blocks: readonly BlockView[];
  timeZone: string;
  now: Date;
  workWindow: WorkWindow;
  /** The review's week Monday; the plan is written on the following week. */
  weekMonday: string;
  onOfferUndo: (item: UndoableDelete) => void;
  onProblem: (message: string) => void;
}) {
  const nextMonday = wallDayKey(keyToWallUtc(weekMonday) + 7 * dayMs);
  const days = nextWeekDays(nextMonday);
  // The candidates the picker offers: open, not shelved for someday.
  const open = useMemo(
    () => tasks.filter(task => !task.completed && !task.someday),
    [tasks],
  );
  // Priorities in the order they were picked; the array is the pick order.
  const [picked, setPicked] = useState<string[]>([]);
  const [plan, setPlan] = useState<{ placements: WeekPlacement[]; unplaced: Unplaced[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (taskId: string) => {
    setPicked(current => (current.includes(taskId) ? current.filter(id => id !== taskId) : [...current, taskId]));
    // A changed pick voids the preview: it was computed for the other list.
    setPlan(null);
  };

  function propose() {
    setError(null);
    const result = planWeek({
      days,
      now,
      timeZone,
      window: workWindow,
      tasks: tasks as readonly PlanTask[],
      blocks: blocks as readonly PlanBlock[],
      priorityIds: picked,
    });
    setPlan(result);
  }

  async function apply() {
    if (busy || plan === null || plan.placements.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const writes = plan.placements.map(placement => ({
        start: toZonedInstant(localValue(placement.day, placement.startMinutes), timeZone),
        end: toZonedInstant(localValue(placement.day, placement.endMinutes), timeZone),
        taskId: placement.taskId,
      }));
      const count = writes.length;
      const { ids, done } = addBlocks(uid, writes);
      await settle(done);
      onOfferUndo({
        message: t("weekly.plan.planned", { count }),
        restore: () => settle(removeBlocks(uid, ids)),
      });
      setPlan(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("weekly.plan.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="weekly-pane-body">
      <p className="weekly-lede">
        {picked.length === 0
          ? t("weekly.plan.pickPrompt")
          : t("weekly.plan.picked", { count: picked.length })}
      </p>
      {open.length === 0 ? (
        <p className="weekly-empty">{t("weekly.plan.noOpen")}</p>
      ) : (
        <ul className="weekly-pick">
          {open.map(task => (
            <li key={task.id}>
              <label className="weekly-pick-row">
                <input
                  type="checkbox"
                  className="check"
                  checked={picked.includes(task.id)}
                  onChange={() => toggle(task.id)}
                />
                <span className="weekly-pick-title" title={task.title}>{task.title}</span>
                {task.deadline !== undefined && (
                  <span className="weekly-pick-deadline">{dayLabel(task.deadline)}</span>
                )}
              </label>
            </li>
          ))}
        </ul>
      )}
      {plan === null ? (
        <div className="weekly-plan-actions">
          <button type="button" className="button" disabled={picked.length === 0} onClick={propose}>
            {t("weekly.plan.place")}
          </button>
        </div>
      ) : (
        <div className="weekly-plan-panel" role="group" aria-label={t("weekly.plan.proposed")}>
          {plan.placements.length > 0 && (
            <ul className="weekly-plan-list">
              {plan.placements.map((placement, index) => (
                <li key={`${placement.day}-${placement.startMinutes}`} className="weekly-plan-row" style={{ "--i": Math.min(index, 7) } as React.CSSProperties}>
                  <span className="weekly-plan-day">{dayLabel(placement.day)}</span>
                  <time className="weekly-plan-time">{range(placement.startMinutes, placement.endMinutes)}</time>
                  <b className="weekly-plan-title" title={placement.title}>{placement.title}</b>
                </li>
              ))}
            </ul>
          )}
          {plan.unplaced.length > 0 && <p className="weekly-plan-notice">{unplacedNotice(plan.unplaced)}</p>}
          {plan.placements.length > 0 ? (
            <div className="weekly-plan-actions">
              <button type="button" className="button-primary" disabled={busy} onClick={() => void apply()}>
                {t("weekly.plan.apply", { count: plan.placements.length })}
              </button>
              <button type="button" className="button" onClick={() => setPlan(null)}>
                {t("weekly.plan.cancel")}
              </button>
            </div>
          ) : (
            <p className="weekly-empty">{t("weekly.plan.full")}</p>
          )}
        </div>
      )}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </div>
  );
}

/** "Mon 12" — a day key as the week's own short label. */
function dayLabel(day: string): string {
  const stamp = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(stamp.getTime())) return day;
  return `${weekdayName(stamp.getUTCDay()).slice(0, 3)} ${stamp.getUTCDate()}`;
}

function range(startMinutes: number, endMinutes: number): string {
  const label = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  return `${label(startMinutes)}–${label(endMinutes)}`;
}
