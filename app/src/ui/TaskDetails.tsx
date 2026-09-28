import { useEffect, useState } from "react";
import type { SeriesView, TaskView } from "../data/store.ts";
import { formatDateKey } from "./format.ts";

/**
 * The details panel for the selected task. Every mutating action lives here
 * and nowhere else. It closes through the explicit Close control and with
 * Escape. The deadline control writes through the data layer's
 * setTaskDeadline, so the write goes through the same domain validation as
 * every other write; errors are surfaced by the parent surface.
 */
export function TaskDetails({
  task,
  busy,
  onClose,
  onRename,
  onDeadlineChange,
  onToggleCompleted,
  onDelete,
}: {
  task: TaskView;
  busy: boolean;
  onClose: () => void;
  onRename: (title: string) => void;
  onDeadlineChange: (deadline: string) => void;
  onToggleCompleted: () => void;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(task.title);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  /* The rename is inline: the title commits on Enter or blur and reverts on
     Escape. A pending edit swallows Escape so the panel stays open to show the
     restored value; with nothing to cancel, Escape falls through to the
     document handler above and still closes the panel. */
  const commitRename = () => {
    if (title === task.title) return;
    onRename(title);
  };

  return (
    <aside className="task-details" aria-label="Task details">
      <header className="task-details-head">
        <h3>Task details</h3>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>
      {/* D1: the rename control is the panel's title and edits in place. The
          label stays attached to the input (visually hidden, still in the
          accessibility tree) so the tests keep addressing it by name. */}
      <div className="task-details-title-row">
        <label className="sr-only" htmlFor="task-details-title">
          Rename task
        </label>
        <input
          id="task-details-title"
          className="task-details-title"
          type="text"
          value={title}
          autoFocus
          onChange={event => setTitle(event.target.value)}
          onBlur={commitRename}
          onKeyDown={event => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitRename();
            } else if (event.key === "Escape" && title !== task.title) {
              event.stopPropagation();
              setTitle(task.title);
            }
          }}
        />
      </div>
      {/* D2: deadline and completion share one metadata row beneath the
          title, so the panel reads as a record; both labels stay attached. */}
      <section className="task-details-section">
        <h4>Details</h4>
        <div className="task-details-meta">
          <div className="task-details-meta-item">
            <label htmlFor="task-details-deadline">Deadline</label>
            <input
              id="task-details-deadline"
              type="date"
              value={task.deadline ?? ""}
              onChange={event => onDeadlineChange(event.target.value)}
            />
          </div>
          <label className="task-details-completed">
            <input
              type="checkbox"
              className="task-check"
              checked={task.completed}
              disabled={busy}
              onChange={onToggleCompleted}
            />
            Completed
          </label>
        </div>
      </section>
      {/* D3: the destructive action is its own labelled section behind a
          hairline rule, so the panel has section rhythm instead of one flat
          stack. */}
      <section className="task-details-section task-details-danger">
        <h4>Delete</h4>
        <button type="button" className="task-details-delete" disabled={busy} onClick={onDelete}>
          Delete task
        </button>
      </section>
    </aside>
  );
}

/** One upcoming occurrence of a series as the panel shows it. */
export type SeriesOccurrenceView = { id: string; date: string; completed: boolean };

/**
 * The details panel for the selected recurring series. It reuses the task
 * panel's shell (class and behaviour: right-anchored wide, overlay narrow,
 * Close and Escape). Its title, frequency and anchor are editable; each edit
 * goes through the data layer's series writers, so the write carries the same
 * domain validation as creation and errors are surfaced by the parent surface.
 * Occurrence completion keeps the list's per-occurrence semantics: each
 * checkbox writes exactly that occurrence's completion record; a completed
 * occurrence is immutable history, so it stays checked. Changing the schedule
 * only changes future occurrences; recorded completions are never touched, and
 * the panel says so once the series has history.
 */
export function SeriesDetails({
  series,
  occurrences,
  today,
  busy,
  hasHistory,
  onClose,
  onRename,
  onFrequencyChange,
  onAnchorChange,
  onCompleteOccurrence,
  onDelete,
}: {
  series: SeriesView;
  occurrences: SeriesOccurrenceView[];
  today: string;
  busy: boolean;
  hasHistory: boolean;
  onClose: () => void;
  onRename: (title: string) => void;
  onFrequencyChange: (frequency: SeriesView["frequency"]) => void;
  onAnchorChange: (anchorDate: string) => void;
  onCompleteOccurrence: (date: string) => void;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(series.title);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside className="task-details" aria-label="Series details">
      <header className="task-details-head">
        <h3>Series details</h3>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>
      <label htmlFor="series-details-title">Rename series</label>
      <input
        id="series-details-title"
        type="text"
        value={title}
        autoFocus
        onChange={event => setTitle(event.target.value)}
        onKeyDown={event => {
          if (event.key === "Enter") onRename(title);
        }}
      />
      <button type="button" disabled={busy} onClick={() => onRename(title)}>
        Save rename
      </button>
      <label htmlFor="series-details-frequency">Frequency</label>
      <select
        id="series-details-frequency"
        className="series-details-frequency"
        value={series.frequency}
        disabled={busy}
        onChange={event => onFrequencyChange(event.target.value as SeriesView["frequency"])}
      >
        <option value="daily">Daily</option>
        <option value="weekly">Weekly</option>
        <option value="monthly">Monthly</option>
      </select>
      <label htmlFor="series-details-anchor">Anchor</label>
      <input
        id="series-details-anchor"
        className="series-details-anchor"
        type="date"
        value={series.anchorDate}
        disabled={busy}
        onChange={event => onAnchorChange(event.target.value)}
      />
      {hasHistory && (
        <p className="series-details-history-note">
          Changing the schedule changes future occurrences. Completed occurrences stay as history.
        </p>
      )}
      <h4>Upcoming occurrences</h4>
      <ul className="series-occurrences">
        {occurrences.map(occurrence => (
          <li key={occurrence.id}>
            <input
              type="checkbox"
              className="task-check"
              checked={occurrence.completed}
              disabled={busy || occurrence.completed}
              aria-label={
                occurrence.completed
                  ? `Completed: ${series.title} on ${occurrence.date}`
                  : `Complete: ${series.title} on ${occurrence.date}`
              }
              onChange={() => onCompleteOccurrence(occurrence.date)}
            />
            {/* C1: the occurrence date is displayed human; the ISO key stays
                the record's identity for the checkbox label and the write */}
            <span>{formatDateKey(occurrence.date, today)}</span>
          </li>
        ))}
        {occurrences.length === 0 && <li>No upcoming occurrences in the current window.</li>}
      </ul>
      <button type="button" className="task-details-delete" disabled={busy} onClick={onDelete}>
        Delete series
      </button>
    </aside>
  );
}
