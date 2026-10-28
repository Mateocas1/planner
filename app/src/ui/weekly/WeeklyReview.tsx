import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { t } from "../../i18n/index.ts";
import type { BlockView, TaskView } from "../../data/store.ts";
import type { WorkWindow } from "../../planning/window.ts";
import {
  clearWeeklyReviewSnooze,
  markWeeklyStepDone,
  saveWeeklyReviewNote as saveNote,
} from "../../data/weeklyReview.ts";
import {
  dueMoment,
  MAX_NOTE_CHARS,
  type DueMoment,
  type WeeklyReviewSettings,
  type WeeklyReviewStep,
} from "../../planning/weekly.ts";
import { ChevronLeft } from "../icons.tsx";
import { dur, easeOut, spring } from "../motion.ts";
import type { UndoableDelete } from "../UndoToast.tsx";
import { settle } from "../write.ts";
import { useWeeklyReview } from "./useWeeklyReview.ts";
import { stepsToShow, stepLabel, stepLede, weekNumberLabel, weekRangeLabel } from "./weeklyFlow.ts";
import { ReviewStep } from "./ReviewStep.tsx";
import { CleanupStep } from "./CleanupStep.tsx";
import { PlanStep } from "./PlanStep.tsx";
import { ReflectStep } from "./ReflectStep.tsx";
import "./WeeklyReview.css";

/**
 * The weekly review flow (S3, ronda 2 W2b): Review → Clean up → Plan →
 * Reflect, one step at a time, inside the shell like Settings — a view of its
 * own, never a stacked modal.
 *
 * What this visit runs is the moment's steps: when the review proposes itself
 * (banner, toast, the shutdown chain) only the due moment's steps — plus the
 * earlier moments' unfinished ones, which `dueMoment` already carries — are
 * offered; opened by hand, all four are. Each step is marked done in the week
 * document the moment its Next is pressed, so leaving mid-flow keeps exactly
 * the progress that was really made, on this device or any other.
 *
 * Motion (AGENTS.md): the pane cross-fades like the Settings tabs — 160 ms
 * opacity plus a 4 px rise, the old pane unmounting at once — and the step
 * pill travels the rail on the shell's snappy spring. Reduced motion drops
 * the travel via MotionConfig.
 */
export function WeeklyReview({
  uid,
  tasks,
  blocks,
  timeZone,
  now,
  workWindow,
  settings,
  via,
  onBack,
  onOfferUndo,
  onProblem,
}: {
  uid: string;
  tasks: readonly TaskView[];
  blocks: readonly BlockView[];
  timeZone: string;
  now: Date;
  workWindow: WorkWindow;
  settings: WeeklyReviewSettings;
  /** "due" when the review proposed itself; "manual" from the palette, the
   *  sidebar or the shortcut — which also clears a standing snooze. */
  via: "due" | "manual";
  onBack: () => void;
  onOfferUndo: (item: UndoableDelete) => void;
  onProblem: (message: string) => void;
}) {
  const { week, state, loading } = useWeeklyReview(uid, timeZone, now);
  const due: DueMoment | null = useMemo(
    () => dueMoment(now, timeZone, settings, state),
    [now, timeZone, settings, state],
  );
  const steps = stepsToShow(via === "due" ? due : null);
  const done = new Set(state.stepsDone);

  const [index, setIndex] = useState(0);
  // The flow starts on the first step that is not done yet, but only once the
  // week document has actually arrived: marks that land a beat later must not
  // drag the user back a step mid-visit.
  const positioned = useRef(false);
  const firstOpen = Math.max(
    0,
    steps.findIndex(entry => !done.has(entry)),
  );
  useEffect(() => {
    if (positioned.current || loading) return;
    positioned.current = true;
    setIndex(firstOpen);
  }, [loading, firstOpen]);

  // A manual opening clears the nudge's snooze: the person came on their own.
  const cleared = useRef(false);
  useEffect(() => {
    if (via !== "manual" || cleared.current || state.snoozedUntil === undefined) return;
    cleared.current = true;
    void settle(clearWeeklyReviewSnooze(uid, week.week)).catch(onProblem);
  }, [via, state.snoozedUntil, uid, week.week, onProblem]);

  // The keyboard's reference sheet is not shown here; Escape returns, like
  // Settings' Escape.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  const step = steps[Math.min(index, steps.length - 1)];
  const last = index === steps.length - 1;

  // Clean up is finished only when every candidate has a decision; the
  // step reports its open rows here while it is on screen.
  const [cleanupUndecided, setCleanupUndecided] = useState(0);

  /**
   * Moves on, and marks the step finished when the user completes it. Next
   * over undecided clean-up rows still moves on, but the step stays open:
   * it is not marked done, so the due visit offers it again.
   */
  function advance() {
    const finished = step !== "cleanup" || cleanupUndecided === 0;
    if (finished) void settle(markWeeklyStepDone(uid, week.week, step)).catch(onProblem);
    if (last) {
      onBack();
      return;
    }
    setIndex(current => Math.min(current + 1, steps.length - 1));
  }

  // The reflection note's draft lives here, so the step's Next saves it: the
  // text is the step's outcome, and Next is how the step is finished.
  const [noteDraft, setNoteDraft] = useState("");
  const saveDraft = () => {
    const text = noteDraft.trim();
    if (text === "" || text.length > MAX_NOTE_CHARS) return;
    void settle(saveNote(uid, week.week, text)).catch(onProblem);
  };

  return (
    <section aria-label={t("weekly.flow.label")} className="weekly">
      <div className="weekly-head page-head">
        <button type="button" className="weekly-back" onClick={onBack}>
          <ChevronLeft className="weekly-back-icon" />
          {t("shell.back")}
        </button>
        <header className="weekly-title">
          <h2 className="large-title">{t("shell.title.weekly")}</h2>
          <p className="subtitle">
            {weekNumberLabel(week.week)} · {weekRangeLabel(week.monday, week.sunday)} · {t("weekly.flow.stepOf", { step: index + 1, total: steps.length })}
          </p>
        </header>
      </div>

      <ol className="weekly-rail" aria-label={t("weekly.flow.rail")}>
        {steps.map((entry, entryIndex) => (
          <li key={entry}>
            <button
              type="button"
              className="weekly-rail-item"
              aria-current={entryIndex === index ? "step" : undefined}
              onClick={() => setIndex(entryIndex)}
            >
              {entryIndex === index && (
                <motion.span layoutId="weekly-pill" className="weekly-pill" transition={spring.snappy} aria-hidden="true" />
              )}
              <span className={`weekly-step-mark${done.has(entry) ? " is-done" : ""}`} aria-hidden="true">
                {done.has(entry) ? "✓" : entryIndex + 1}
              </span>
              <span>{stepLabel(entry)}</span>
            </button>
          </li>
        ))}
      </ol>

      {loading ? (
        <p className="weekly-empty" role="status">{t("weekly.flow.loading")}</p>
      ) : (
        <>
          <motion.div
            key={step}
            className="weekly-pane"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: dur.enter, ease: easeOut }}
          >
            <div className="weekly-pane-lede">
              <h3>{stepLabel(step)}</h3>
              <p>{stepLede(step)}</p>
            </div>
            {step === "review" && <ReviewStep tasks={tasks} blocks={blocks} timeZone={timeZone} now={now} />}
            {step === "cleanup" && (
              <CleanupStep
                uid={uid}
                tasks={tasks}
                blocks={blocks}
                timeZone={timeZone}
                now={now}
                weekSunday={week.sunday}
                onOfferUndo={onOfferUndo}
                onProblem={onProblem}
                onUndecided={setCleanupUndecided}
              />
            )}
            {step === "plan" && (
              <PlanStep
                uid={uid}
                tasks={tasks}
                blocks={blocks}
                timeZone={timeZone}
                now={now}
                workWindow={workWindow}
                weekMonday={week.monday}
                onOfferUndo={onOfferUndo}
                onProblem={onProblem}
              />
            )}
            {step === "reflect" && <ReflectStep value={noteDraft} onChange={setNoteDraft} />}
          </motion.div>

          <div className="weekly-actions">
            <button
              type="button"
              className="weekly-quiet"
              disabled={index === 0}
              onClick={() => setIndex(current => Math.max(current - 1, 0))}
            >
              {t("weekly.flow.back")}
            </button>
            <button
              type="button"
              className="button button-accent weekly-next"
              onClick={() => {
                if (step === "reflect") saveDraft();
                advance();
              }}
            >
              {last ? t("weekly.flow.finish") : t("weekly.flow.next")}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** The steps this visit runs, as the header's own words. Kept for the tests
 *  and the banner's summary; the flow's rail shows the same steps. */
function stepListLabel(steps: readonly WeeklyReviewStep[]): string {
  return steps.map(stepLabel).join(" · ");
}
