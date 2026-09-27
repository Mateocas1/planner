import { useEffect, useState } from "react";
import type { SeriesView, TaskView } from "../data/store.ts";

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

  return (
    <aside className="task-details" aria-label="Task details">
      <header className="task-details-head">
        <h3>Task details</h3>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>
      <label htmlFor="task-details-title">Rename task</label>
      <input
        id="task-details-title"
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
      <label htmlFor="task-details-deadline">Deadline</label>
      <input
        id="task-details-deadline"
        type="date"
        value={task.deadline ?? ""}
        onChange={event => onDeadlineChange(event.target.value)}
      />
      <label className="task-details-completed">
        <input type="checkbox" checked={task.completed} disabled={busy} onChange={onToggleCompleted} />
        Completed
      </label>
      <button type="button" className="task-details-delete" disabled={busy} onClick={onDelete}>
        Delete task
      </button>
    </aside>
  );
}

/** One upcoming occurrence of a series as the panel shows it. */
export type SeriesOccurrenceView = { id: string; date: string; completed: boolean };

/**
 * The details panel for the selected recurring series. It reuses the task
 * panel's shell (class and behaviour: right-anchored wide, overlay narrow,
 * Close and Escape). Occurrence completion keeps the list's per-occurrence
 * semantics: each checkbox writes exactly that occurrence's completion
 * record; a completed occurrence is immutable history, so it stays checked.
 * The data layer has no writer for a series' title, frequency or anchor, so
 * those are shown read-only.
 */
export function SeriesDetails({
  series,
  occurrences,
  busy,
  onClose,
  onCompleteOccurrence,
  onDelete,
}: {
  series: SeriesView;
  occurrences: SeriesOccurrenceView[];
  busy: boolean;
  onClose: () => void;
  onCompleteOccurrence: (date: string) => void;
  onDelete: () => void;
}) {
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
      <p className="series-details-title">{series.title}</p>
      <dl className="series-details-meta">
        <div>
          <dt>Frequency</dt>
          <dd className="series-details-frequency">{series.frequency}</dd>
        </div>
        <div>
          <dt>Anchor</dt>
          <dd className="series-details-anchor">{series.anchorDate}</dd>
        </div>
      </dl>
      <h4>Upcoming occurrences</h4>
      <ul className="series-occurrences">
        {occurrences.map(occurrence => (
          <li key={occurrence.id}>
            <input
              type="checkbox"
              checked={occurrence.completed}
              disabled={busy || occurrence.completed}
              aria-label={
                occurrence.completed
                  ? `Completed: ${series.title} on ${occurrence.date}`
                  : `Complete: ${series.title} on ${occurrence.date}`
              }
              onChange={() => onCompleteOccurrence(occurrence.date)}
            />
            <span>{occurrence.date}</span>
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
