import { useEffect, useState } from "react";
import type { BlockView, TaskView } from "../../data/store.ts";
import { deleteTask, restoreTask, setTaskDeadline } from "../../data/tasks.ts";
import { setTaskSomeday } from "../../data/weeklyReview.ts";
import { cleanupCandidates, type CleanupAction } from "../../planning/weekly.ts";
import { cleanupActionLabels, cleanupReasonLabel } from "./weeklyFlow.ts";
import { dateKey } from "../time.ts";
import type { UndoableDelete } from "../UndoToast.tsx";
import { settle } from "../write.ts";

/**
 * The Clean-up step (S3): every stale task the week left behind, with the
 * three decisions it can take — keep it this week, put it on the someday
 * shelf, or delete it (through the shell's own undo toast).
 *
 * The candidates are `planning/weekly.ts`'s (W2a): overdue, or scheduled this
 * week and still open. "Postponed ≥ 2×" is not derivable from the stored
 * model, so the two real reasons stand in; the module documents that. Every
 * action writes at once and the row leaves the list — the step is a triage,
 * not a queue to revisit.
 */
export function CleanupStep({
  uid,
  tasks,
  blocks,
  timeZone,
  now,
  weekSunday,
  onOfferUndo,
  onProblem,
  onUndecided,
}: {
  uid: string;
  tasks: readonly TaskView[];
  blocks: readonly BlockView[];
  timeZone: string;
  now: Date;
  /** The last day of the review's week: where "This week" moves a deadline. */
  weekSunday: string;
  /** The shell's single undo offer, so a delete is undoable from anywhere. */
  onOfferUndo: (item: UndoableDelete) => void;
  /** Where a failed write goes once this view is gone. */
  onProblem: (message: string) => void;
  /** How many candidates still wait for a decision; the flow reads it to
   *  decide whether Next finishes the step. */
  onUndecided: (count: number) => void;
}) {
  const today = dateKey(now, timeZone);
  const candidates = cleanupCandidates({ tasks, blocks, today, timeZone });
  // Tasks already decided in this visit: they leave the list at once.
  const [acted, setActed] = useState<Set<string>>(new Set());
  const live = candidates.filter(candidate => !acted.has(candidate.task.id));
  useEffect(() => {
    onUndecided(live.length);
  }, [live.length, onUndecided]);

  const run = (action: CleanupAction, taskId: string) => {
    const candidate = candidates.find(entry => entry.task.id === taskId);
    if (candidate === undefined) return;
    const task = candidate.task;
    setActed(current => new Set(current).add(taskId));
    if (action === "this-week") {
      void settle(setTaskDeadline(uid, taskId, task.title, weekSunday)).catch(onProblem);
      return;
    }
    if (action === "someday") {
      void settle(setTaskSomeday(uid, taskId, true)).catch(onProblem);
      return;
    }
    // Delete offers the exact undo the row was deleted with, like Tasks and
    // Home do — the whole task travels with the offer.
    const deleted = tasks.find(entry => entry.id === taskId);
    void settle(deleteTask(uid, taskId))
      .then(() => {
        if (deleted !== undefined) {
          onOfferUndo({ message: "Task deleted", restore: () => settle(restoreTask(uid, deleted)) });
        }
      })
      .catch(onProblem);
  };

  return (
    <div className="weekly-pane-body">
      {live.length === 0 ? (
        <p className="weekly-empty" role="status">
          {candidates.length === 0 ? "Nothing to clean up — nothing is overdue or left on the calendar." : "All caught up."}
        </p>
      ) : (
        <ul className="weekly-cleanup">
          {live.map(candidate => (
            <li key={candidate.task.id} className="weekly-cleanup-row">
              <div className="weekly-cleanup-text">
                <span className="weekly-cleanup-title" title={candidate.task.title}>{candidate.task.title}</span>
                <span className="weekly-cleanup-why">
                  {candidate.reasons.map(reason => cleanupReasonLabel(reason, today)).join(" · ")}
                </span>
              </div>
              <div className="weekly-cleanup-actions" role="group" aria-label={`Decide: ${candidate.task.title}`}>
                {candidate.actions.map(action => (
                  <button
                    key={action}
                    type="button"
                    className={`button small${action === "delete" ? " is-danger" : ""}`}
                    onClick={() => run(action, candidate.task.id)}
                  >
                    {cleanupActionLabels[action]}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
