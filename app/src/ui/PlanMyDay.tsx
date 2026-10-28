import { Fragment, useEffect, useRef, useState } from "react";
import { addBlocks, removeBlocks } from "../data/blocks.ts";
import type { BlockView, TaskView } from "../data/store.ts";
import { estimateNote } from "../domain/model.ts";
import { planDay, samePlan, unplacedNotice, type Plan, type PlanTask, type Unplaced } from "../planning/place.ts";
import { usePlannerWindow } from "./CapacityBar.tsx";
import { UndoToast, type PendingUndo, type UndoableDelete } from "./UndoToast.tsx";
import { t } from "../i18n/index.ts";
import { hasFreeTimeAhead } from "./shutdownRitual.ts";
import { dateKey, localValue, pad, toZonedInstant, wallMinutes } from "./time.ts";
import { settle } from "./write.ts";
import "./PlanMyDay.css";

/**
 * Plan my day (distinctive roadmap F4, UI half): one button that turns the day's
 * open tasks into a proposal, and one batch that applies it.
 *
 * The arithmetic is not here. `planning/place.ts` decides which task goes where
 * (deadline first, then the longer plan, the 60-minute assumption, the 45-minute
 * chunk floor, and nothing in the past); `planning/window.ts` supplies the free
 * time of the profile's one working window, so this button and the overcommit
 * radar (F1) can never disagree about what "free" means. This module only shows
 * the proposal, applies it, and offers the exact undo.
 *
 * Two surfaces, one component: the Unscheduled tray in the Calendar and the
 * Today brief render the same proposal with the same copy, so a person who
 * learns it in one place knows it in the other. `variant="brief"` adds the
 * heading and the sentence the brief needs; nothing else differs.
 *
 * Applying is one `writeBatch` (data/blocks.ts `addBlocks`), which is why the
 * undo can name exactly the documents the plan created: the batch hands back
 * their ids before the server answers, so the offer never waits for a network.
 * The toast is the shell's when the host offers one (the Calendar, which already
 * owns App's single undo offer); on the Today brief it is this component's own,
 * so the plan is undoable from wherever it was made.
 */
export function PlanMyDay({
  uid,
  tasks,
  blocks,
  timeZone,
  now,
  variant = "tray",
  onOfferUndo,
}: {
  uid: string;
  tasks: TaskView[];
  blocks: BlockView[];
  timeZone: string;
  now: Date;
  /** `tray` is the Calendar's Unscheduled panel; `brief` is Today's section. */
  variant?: "tray" | "brief";
  /** The shell's single undo offer, when the host has one (see UndoToast). */
  onOfferUndo?: (item: UndoableDelete) => void;
}) {
  const workWindow = usePlannerWindow(uid);
  const today = dateKey(now, timeZone);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<PendingUndo | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const applyRef = useRef<HTMLButtonElement>(null);
  const openCount = useRef(0);
  /* Set synchronously, so a second press that lands before the first render
     commits (`busy` is still false then) cannot write the same plan twice. */
  const applying = useRef(false);

  // The proposal takes focus as it appears, so the day is one Enter away and
  // Escape hands the trigger back without a detour through the tray.
  useEffect(() => {
    if (plan) applyRef.current?.focus();
  }, [plan]);

  const nowMs = now.getTime();
  const unscheduled = tasks.filter(task => !task.completed && !blocks.some(block => block.taskId === task.id && Date.parse(block.end) > nowMs));
  /* No free stretch left in the work window: the button would only answer
     "Nothing to plan", so it is disabled and says why (R5-18). */
  const todayIntervals = blocks
    .filter(block => dateKey(new Date(block.start), timeZone) === today)
    .map(block => {
      const startMinutes = wallMinutes(new Date(block.start), timeZone);
      const endMinutes = wallMinutes(new Date(block.end), timeZone);
      return { startMinutes, endMinutes: endMinutes <= startMinutes ? 1440 : endMinutes };
    });
  const noTimeLeft = !hasFreeTimeAhead(todayIntervals, workWindow, wallMinutes(now, timeZone));
  const lede =
    unscheduled.length === 0
      ? t("plan.allPlaced")
      : t("plan.lede", { count: unscheduled.length });

  function propose() {
    setError(null);
    const next = planDay({ day: today, now, timeZone, window: workWindow, tasks: tasks as PlanTask[], blocks });
    const empty = next.placements.length === 0 && next.unplaced.length === 0;
    setPlan(empty ? null : next);
    // A press that finds nothing to write says so instead of opening an empty
    // proposal: the second press of a day already planned is exactly that case.
    setMessage(next.placements.length === 0 ? t("plan.nothing") : null);
  }

  function close() {
    setPlan(null);
    trigger.current?.focus();
  }

  async function apply() {
    if (applying.current || !plan || plan.placements.length === 0) return;
    applying.current = true;
    setBusy(true);
    setError(null);
    try {
      // The shown plan was proposed a while ago: the day may have changed since
      // (a block added elsewhere, or the clock passed a quarter hour). Write only
      // what the current day still allows; otherwise show the fresh proposal.
      const fresh = planDay({ day: today, now, timeZone, window: workWindow, tasks: tasks as PlanTask[], blocks });
      if (!samePlan(fresh, plan)) {
        setPlan(fresh.placements.length === 0 && fresh.unplaced.length === 0 ? null : fresh);
        setMessage(fresh.placements.length === 0 ? t("plan.nothing") : t("plan.changed"));
        return;
      }
      const writes = plan.placements.map(placement => ({
        start: toZonedInstant(localValue(today, placement.startMinutes), timeZone),
        end: toZonedInstant(localValue(today, placement.endMinutes), timeZone),
        taskId: placement.taskId,
      }));
      const count = writes.length;
      const { ids, done } = addBlocks(uid, writes);
      const offer: UndoableDelete = {
        message: t("plan.planned", { count }),
        restore: () => settle(removeBlocks(uid, ids)),
      };
      await settle(done);
      openCount.current += 1;
      setPlan(null);
      setMessage(null);
      if (onOfferUndo) onOfferUndo(offer);
      else setUndo({ ...offer, id: openCount.current });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("plan.saveFailed"));
    } finally {
      applying.current = false;
      setBusy(false);
    }
  }

  const count = plan?.placements.length ?? 0;

  return (
    <section
      className={`plan${variant === "brief" ? " plan-card card" : ""}`}
      data-variant={variant}
      {...(variant === "brief" ? { "aria-labelledby": "plan-heading" } : {})}
    >
      {variant === "brief" ? (
        <div className="plan-head">
          <h3 id="plan-heading" className="section-title">{t("plan.title")}</h3>
          <p className="plan-lede">{lede}</p>
        </div>
      ) : null}
      <button
        ref={trigger}
        type="button"
        className="button plan-trigger"
        aria-expanded={plan !== null}
        aria-describedby={noTimeLeft && !plan ? "plan-no-time" : undefined}
        disabled={noTimeLeft && !plan}
        onClick={() => (plan ? close() : propose())}
      >
        {t("plan.title")}
      </button>
      {noTimeLeft && !plan && <p id="plan-no-time" className="plan-status">{t("today.plan.noFreeTime")}</p>}
      {plan && (
        <div
          className="plan-panel"
          role="group"
          aria-label={t("plan.proposed")}
          onKeyDown={event => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            close();
          }}
        >
          {count > 0 && (
            <ul className="plan-list">
              {plan.placements.map((placement, index) => (
                <li
                  key={`${placement.taskId}-${placement.startMinutes}`}
                  className="plan-row"
                  /* The stagger is the first six rows, 40 ms apart: the whole
                     entrance is over in 400 ms, and a longer day does not turn
                     into a queue of blocks arriving one by one. */
                  style={{ "--i": Math.min(index, 5) } as React.CSSProperties}
                >
                  <time className="plan-time">{rangeLabel(placement.startMinutes, placement.endMinutes)}</time>
                  <b className="plan-title">{placement.title}</b>
                  <span className="plan-est">{estimateNote(tasks.find(task => task.id === placement.taskId)?.estimate)}</span>
                </li>
              ))}
            </ul>
          )}
          {plan.unplaced.length > 0 && <UnplacedNotice unplaced={plan.unplaced} today={today} />}
          {count > 0 && (
            <div className="plan-actions">
              <button ref={applyRef} type="button" className="button-primary" disabled={busy} onClick={() => void apply()}>
                {t("plan.apply", { count })}
              </button>
              <button type="button" className="button" onClick={close}>
                {t("plan.cancel")}
              </button>
            </div>
          )}
        </div>
      )}
      {message && <p className="plan-status" role="status">{message}</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {undo && <UndoToast item={undo} onDismiss={() => setUndo(null)} onError={setError} />}
    </section>
  );
}

/** `08:00–09:30`: the wall-clock range the block will occupy, as the grid
 *  writes a range. */
function rangeLabel(startMinutes: number, endMinutes: number): string {
  const label = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  return `${label(startMinutes)}–${label(endMinutes)}`;
}

/**
 * The tray's leftovers, in `place.ts`'s own words: the sentence is
 * `unplacedNotice`'s, never a copy of it, and the names inside it are split out
 * only so the task due today can carry the red that says it will be late.
 *
 * The prefix and suffix are spliced off the sentence around the joined names,
 * so singular/plural, the day word and the closing question stay owned by the
 * module that also decides the order (due today first, undated last).
 */
function UnplacedNotice({ unplaced, today }: { unplaced: Unplaced[]; today: string }) {
  const sentence = unplacedNotice(unplaced);
  const names = unplaced.map(item => item.task.title).join(", ");
  const at = sentence.indexOf(names);
  if (at < 0) return <p className="plan-notice">{sentence}</p>;
  return (
    <p className="plan-notice">
      {sentence.slice(0, at)}
      {unplaced.map((item, index) => (
        <Fragment key={item.task.id}>
          {index === 0 ? null : ", "}
          <span className={dueToday(item.task, today) ? "is-overdue" : undefined}>{item.task.title}</span>
        </Fragment>
      ))}
      {sentence.slice(at + names.length)}
    </p>
  );
}

function dueToday(task: PlanTask, today: string): boolean {
  return task.deadline !== undefined && task.deadline <= today;
}
