import { useState } from "react";
import type { SeriesView, TaskView } from "../data/store.ts";
import { formatDateKey } from "./format.ts";
import { CloseIcon } from "./icons.tsx";
import { Sheet } from "./Sheet.tsx";

/**
 * The details sheet for the selected task. Every mutating action on a task
 * lives here. It grows out of the row that opened it and closes through the
 * Close control, Escape, or a click on the scrim. The deadline control writes
 * through setTaskDeadline, so it carries the same domain validation as every
 * other write; errors are surfaced by the parent surface.
 */
export function TaskDetails({
  task,
  origin,
  shared = false,
  busy,
  onClose,
  onRename,
  onDeadlineChange,
  onToggleCompleted,
  onDelete,
}: {
  task: TaskView;
  origin: HTMLElement | null;
  /** Opened through the row-to-panel view transition (see morph.ts). */
  shared?: boolean;
  busy: boolean;
  onClose: () => void;
  onRename: (title: string) => void;
  onDeadlineChange: (deadline: string) => void;
  onToggleCompleted: () => void;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(task.title);

  /* The rename is inline: the title commits on Enter or blur and reverts on
     Escape. A pending edit swallows Escape so the sheet stays open to show the
     restored value; with nothing to cancel, Escape reaches the sheet and
     closes it. */
  const commitRename = () => {
    if (title === task.title) return;
    onRename(title);
  };

  return (
    <Sheet label="Task details" className="task-details" origin={origin} shared={shared} onClose={onClose}>
      <header className="sheet-head">
        <span className="sheet-kind">Task</span>
        <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <label className="sr-only" htmlFor="task-details-title">
        Rename task
      </label>
      <input
        id="task-details-title"
        className="sheet-title"
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
      <div className="form-group">
        <div className="form-row">
          <label htmlFor="task-details-deadline">Deadline</label>
          <input
            id="task-details-deadline"
            className="form-control"
            type="date"
            value={task.deadline ?? ""}
            onChange={event => onDeadlineChange(event.target.value)}
          />
        </div>
        <div className="form-row">
          <label htmlFor="task-details-completed">Completed</label>
          <input
            id="task-details-completed"
            type="checkbox"
            className="switch"
            role="switch"
            checked={task.completed}
            disabled={busy}
            onChange={onToggleCompleted}
          />
        </div>
      </div>
      <button type="button" className="button-danger" disabled={busy} onClick={onDelete}>
        Delete task
      </button>
    </Sheet>
  );
}

/** One upcoming occurrence of a series as the sheet shows it. */
export type SeriesOccurrenceView = { id: string; date: string; completed: boolean };

/**
 * The details sheet for the selected recurring series, the task sheet's peer.
 * Title, frequency and anchor are editable; each edit goes through the series
 * writers, so it carries the domain validation creation has. Occurrence
 * completion keeps per-occurrence semantics: each checkbox writes exactly that
 * occurrence's completion record, and a completed occurrence stays checked as
 * immutable history. Changing the schedule only changes future occurrences.
 */
export function SeriesDetails({
  series,
  origin,
  shared = false,
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
  origin: HTMLElement | null;
  /** Opened through the row-to-panel view transition (see morph.ts). */
  shared?: boolean;
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

  const commitRename = () => {
    if (title === series.title) return;
    onRename(title);
  };

  return (
    <Sheet label="Series details" className="task-details" origin={origin} shared={shared} onClose={onClose}>
      <header className="sheet-head">
        <span className="sheet-kind">Repeating task</span>
        <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <label className="sr-only" htmlFor="series-details-title">
        Rename series
      </label>
      <input
        id="series-details-title"
        className="sheet-title"
        type="text"
        value={title}
        autoFocus
        onChange={event => setTitle(event.target.value)}
        onBlur={commitRename}
        onKeyDown={event => {
          if (event.key === "Enter") {
            event.preventDefault();
            commitRename();
          } else if (event.key === "Escape" && title !== series.title) {
            event.stopPropagation();
            setTitle(series.title);
          }
        }}
      />
      <div className="form-group">
        <div className="form-row">
          <label htmlFor="series-details-frequency">Frequency</label>
          <select
            id="series-details-frequency"
            className="form-control"
            value={series.frequency}
            disabled={busy}
            onChange={event => onFrequencyChange(event.target.value as SeriesView["frequency"])}
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </div>
        <div className="form-row">
          <label htmlFor="series-details-anchor">Anchor</label>
          <input
            id="series-details-anchor"
            className="form-control"
            type="date"
            value={series.anchorDate}
            disabled={busy}
            onChange={event => onAnchorChange(event.target.value)}
          />
        </div>
      </div>
      {hasHistory && (
        <p className="sheet-note">Changing the schedule changes future occurrences. Completed occurrences stay as history.</p>
      )}
      <section className="sheet-section" aria-labelledby="series-occurrences-heading">
        <h4 id="series-occurrences-heading" className="sheet-section-title">Upcoming</h4>
        <ul className="form-group series-occurrences">
          {occurrences.map(occurrence => (
            <li key={occurrence.id} className={`form-row occurrence${occurrence.completed ? " done" : ""}`}>
              <input
                type="checkbox"
                className="check"
                checked={occurrence.completed}
                disabled={busy || occurrence.completed}
                aria-label={
                  occurrence.completed
                    ? `Completed: ${series.title} on ${occurrence.date}`
                    : `Complete: ${series.title} on ${occurrence.date}`
                }
                onChange={() => onCompleteOccurrence(occurrence.date)}
              />
              {/* the date reads human; the ISO key stays the record's identity */}
              <span className="occurrence-date">{formatDateKey(occurrence.date, today)}</span>
            </li>
          ))}
          {occurrences.length === 0 && <li className="form-row sheet-note">No upcoming occurrences in the current window.</li>}
        </ul>
      </section>
      <button type="button" className="button-danger" disabled={busy} onClick={onDelete}>
        Delete series
      </button>
    </Sheet>
  );
}
