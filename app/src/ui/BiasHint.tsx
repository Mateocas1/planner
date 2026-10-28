import { useMemo, useState } from "react";
import { ASSUMED_ESTIMATE_MINUTES, formatEstimate } from "../domain/model.ts";
import {
  MIN_ACTUAL_MINUTES,
  MIN_GLOBAL_SAMPLES,
  noBiasHint,
  suggestEstimate,
  type BiasSample,
} from "../planning/bias.ts";
import { t } from "../i18n/index.ts";
import { useKeyboardUp } from "./viewport.ts";
// The lesson's own paint ships beside it (AGENTS.md: co-located styles).
import "./BiasHint.css";

/**
 * The estimate lesson (F2b): what the planner has learned about how long tasks
 * like this one really take, offered as a sentence with one tap behind it.
 *
 * The whole point is that nothing happens silently. `planning/bias.ts` decides
 * whether there is evidence (three samples on a shared title token, or five
 * overall) and what the padded estimate would be; this component prints that
 * number in words and puts an accept button beside it. Until the button is
 * pressed the estimate field keeps exactly the number its owner typed, which is
 * what the radar, plan-my-day and the stored document all read.
 *
 * Two rules shape the surface:
 *
 * 1. The offer never chases its own answer. Accepting writes the suggested
 *    minutes into the estimate, and the rule is multiplicative -- accepting 45
 *    for a 30-minute task makes the next offer 70. So the hint remembers the
 *    number it wrote and stays quiet while the estimate still holds it; edit
 *    the estimate by hand and the lesson speaks again.
 * 2. Not knowing yet is said out loud, once: with too little history the line
 *    reads "Track a few tasks with the timer to learn your pace." instead of
 *    leaving the feature invisible. That copy is `bias.ts`'s own constant.
 *
 * No motion: this line changes while the user types a title, which is a
 * keyboard surface at typing cadence rather than an occasional transition
 * (DESIGN.md §4, and the roadmap's own "the hint appears inline (instant)").
 * The accept button carries the app's shared press feedback, nothing more.
 *
 * It also yields to the on-screen keyboard. The create sheet on a phone has no
 * vertical slack while the keyboard covers most of the screen -- its pinned
 * layout tests put the title, the deadline and the submit action in the visible
 * band -- so a line the sheet cannot afford would either be clipped or push the
 * title out of view. The lesson waits for the keyboard to close and comes back
 * with it; the focus timer that produces the history is a desktop surface, so
 * nothing is being hidden from the person who can act on it.
 */

/** A task as the learner reads it, plus the state that makes it a sample. */
export type TrackedTask = BiasSample & { completed?: boolean };

/**
 * The samples a surface may learn from: finished tasks, and only those. An
 * abandoned or still-running task is a plan in progress, not a measurement of
 * how long the work takes.
 */
export function completedSamples(tasks: readonly TrackedTask[]): BiasSample[] {
  return tasks
    .filter(task => task.completed === true)
    .map(task => ({ title: task.title, estimate: task.estimate, actualMinutes: task.actualMinutes }));
}

/** Samples the learner can actually read: an estimate and at least five tracked minutes. */
function usableSamples(samples: readonly BiasSample[]): number {
  return samples.filter(
    sample => sample.estimate !== undefined && (sample.actualMinutes ?? 0) >= MIN_ACTUAL_MINUTES,
  ).length;
}

export function BiasHint({
  samples,
  title,
  estimate,
  showEmptyHint = false,
  disabled = false,
  onAccept,
}: {
  /** Completed tasks, as `completedSamples` returns them. */
  samples: readonly BiasSample[];
  /** The title being estimated: its words are the learner's key. */
  title: string;
  /** The estimate currently in the field, which the offer pads. */
  estimate?: number;
  /** Print the "not enough history yet" line when nothing can be offered. */
  showEmptyHint?: boolean;
  disabled?: boolean;
  onAccept: (minutes: number) => void;
}) {
  const suggestion = useMemo(() => suggestEstimate(samples, { title, estimate }), [samples, title, estimate]);
  // The value the offer wrote, so it cannot keep climbing its own ladder.
  const [applied, setApplied] = useState<number | null>(null);
  const keyboardUp = useKeyboardUp();

  // No room while a keyboard covers the sheet (see the file header).
  if (keyboardUp) return null;

  if (suggestion !== null) {
    if (applied === estimate) return null;
    return (
      <div className="bias-hint">
        <p className="bias-hint-text">{suggestion.message}</p>
        <button
          type="button"
          className="button small bias-accept"
          disabled={disabled}
          onClick={() => {
            setApplied(suggestion.minutes);
            onAccept(suggestion.minutes);
          }}
        >
          {t("bias.use", { minutes: suggestion.minutes })}
        </button>
      </div>
    );
  }

  /* Nothing to offer and not enough history to offer anything: say how the
     lesson is learned. A neutral pace (enough samples, ratio near 1) stays
     quiet -- the estimate is already right. */
  if (!showEmptyHint || usableSamples(samples) >= MIN_GLOBAL_SAMPLES) return null;
  return <p className="sheet-note bias-hint-empty">{noBiasHint()}</p>;
}

/**
 * What a task really took, in the product's own words, next to what it was
 * planned as: "Estimated 30 min · took 45 min". A task with no estimate is
 * compared with the 60-minute assumption every planning surface uses, so the
 * sentence never pretends there was a plan there wasn't.
 *
 * An open task says what has been tracked *so far*: the timer's count is a
 * running total, and calling it "took" would be a lie until the task is done.
 */
export function ActualSummary({
  estimate,
  actualMinutes,
  completed,
}: {
  estimate?: number;
  actualMinutes?: number;
  completed: boolean;
}) {
  if (actualMinutes === undefined || actualMinutes < 1) return null;
  const planned = estimate === undefined
    ? t("plan.assumed", { estimate: formatEstimate(ASSUMED_ESTIMATE_MINUTES) })
    : t("bias.estimated", { estimate: formatEstimate(estimate) });
  const minutes = formatEstimate(actualMinutes);
  return <p className="actual-summary">{completed ? t("bias.tookDone", { planned, actual: minutes }) : t("bias.tookOpen", { planned, actual: minutes })}</p>;
}
