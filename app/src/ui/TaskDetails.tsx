import { useEffect, useRef, useState } from "react";
import { MAX_ESTIMATE_MINUTES, MIN_ESTIMATE_MINUTES, estimateNote } from "../domain/model.ts";
import type { SeriesView, TaskView } from "../data/store.ts";
import type { BiasSample } from "../planning/bias.ts";
import { ActualSummary, BiasHint } from "./BiasHint.tsx";
import { DateField } from "./DateField.tsx";
import { dateFieldLabels } from "./DateField.labels.ts";
import { formatDateKey } from "./format.ts";
import { CloseIcon } from "./icons.tsx";
import { Select } from "./Select.tsx";
import { Sheet } from "./Sheet.tsx";
import "./EstimateField.css";

/**
 * The estimate field both details sheets share (E1).
 *
 * It is the one control here that saves on commit instead of on every
 * keystroke: half-typed minute counts are valid-looking numbers ("4" on the
 * way to "45"), and writing each one would send an update per key and flash
 * the note through values nobody meant. Enter or blur commits, Escape restores
 * the stored value, and a value the domain rejects comes back as the parent's
 * error with the draft still in place. The note under the field says which
 * number planning will use: the stored estimate, or the 60-minute assumption
 * when the task has none.
 *
 * The note cross-fades when its text changes after the sheet has been read
 * once (150 ms, opacity plus a 2 px rise; reduced motion keeps the fade and
 * drops the rise). First paint is not animated: a sheet opening is not a value
 * change.
 */
function EstimateField({
  id,
  estimate,
  disabled,
  onChange,
}: {
  id: string;
  estimate?: number;
  disabled: boolean;
  onChange: (estimate: number | undefined) => void;
}) {
  const stored = estimate === undefined ? "" : String(estimate);
  const [draft, setDraft] = useState(stored);
  const note = estimateNote(estimate);
  // The note animates only once its text has actually changed under the user.
  const [animated, setAnimated] = useState(false);
  const seenNote = useRef(note);
  useEffect(() => {
    if (seenNote.current === note) return;
    seenNote.current = note;
    setAnimated(true);
  }, [note]);

  const commit = () => {
    if (draft === stored) return;
    // An emptied field is the assumption again: the document loses the field
    // rather than gaining a zero that planning would read as a real estimate.
    if (draft === "") {
      onChange(undefined);
      return;
    }
    onChange(Number(draft));
  };

  return (
    <div className="form-row stacked">
      <label htmlFor={id}>Estimate</label>
      <input
        id={id}
        className="form-control"
        type="number"
        inputMode="numeric"
        min={MIN_ESTIMATE_MINUTES}
        max={MAX_ESTIMATE_MINUTES}
        step={5}
        placeholder="Minutes"
        value={draft}
        disabled={disabled}
        aria-describedby={`${id}-note`}
        onChange={event => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={event => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape" && draft !== stored) {
            event.stopPropagation();
            setDraft(stored);
          }
        }}
      />
      <p key={note} id={`${id}-note`} className={`sheet-note estimate-note${animated ? " estimate-note-changed" : ""}`}>
        {note}
      </p>
    </div>
  );
}

/**
 * The details sheet for the selected task. Every mutating action on a task
 * lives here. It grows out of the row that opened it and closes through the
 * Close control, Escape, or a click on the scrim. The deadline control writes
 * through setTaskDeadline, so it carries the same domain validation as every
 * other write; errors are surfaced by the parent surface.
 *
 * An estimate is an optional field: the sheet shows the stored value when set,
 * or the 60-minute assumption text that planning falls back to when it is
 * absent. The field is keyed by the stored estimate, so a committed write
 * (which arrives back through the store) remounts it on the new value while a
 * rejected one leaves the user's draft in place.
 */
const frequencyOptions = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

export function TaskDetails({
  task,
  origin,
  shared = false,
  today,
  busy,
  biasSamples,
  onClose,
  onRename,
  onDeadlineChange,
  onToggleCompleted,
  onEstimateChange,
  onDelete,
}: {
  task: TaskView;
  origin: HTMLElement | null;
  /** Opened through the row-to-panel view transition (see morph.ts). */
  shared?: boolean;
  /** Today's key in the profile zone: the Deadline field's words and quick days. */
  today: string;
  busy: boolean;
  /**
   * Completed tasks the estimate learner may read (F2b). The sheet does not
   * fetch them: a surface that already holds the store passes them, and a
   * caller that does not gets only the tracked-minutes line. They are read
   * through `planning/bias.ts`, which decides alone whether there is enough
   * evidence for an offer.
   */
  biasSamples?: readonly BiasSample[];
  onClose: () => void;
  onRename: (title: string) => void;
  onDeadlineChange: (deadline: string) => void;
  onToggleCompleted: () => void;
  onEstimateChange: (estimate: number | undefined) => void;
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
      {/* What it really took, stated before the controls that can change the
          plan: the fact outranks the guess. */}
      <ActualSummary estimate={task.estimate} actualMinutes={task.actualMinutes} completed={task.completed} />
      <div className="form-group">
        <div className="form-row">
          <label htmlFor="task-details-deadline">Deadline</label>
          <DateField
            id="task-details-deadline"
            value={task.deadline ?? ""}
            today={today}
            labels={dateFieldLabels}
            onChange={onDeadlineChange}
          />
        </div>
        <EstimateField
          key={task.estimate ?? "none"}
          id="task-details-estimate"
          estimate={task.estimate}
          disabled={busy}
          onChange={onEstimateChange}
        />
        <BiasHint
          samples={biasSamples ?? []}
          title={task.title}
          estimate={task.estimate}
          disabled={busy}
          onAccept={onEstimateChange}
        />
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
  onEstimateChange,
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
  onEstimateChange: (estimate: number | undefined) => void;
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
          <Select
            id="series-details-frequency"
            label="Frequency"
            value={series.frequency}
            options={frequencyOptions}
            disabled={busy}
            onChange={value => onFrequencyChange(value as SeriesView["frequency"])}
          />
        </div>
        <div className="form-row">
          <label htmlFor="series-details-anchor">Anchor</label>
          <DateField
            id="series-details-anchor"
            value={series.anchorDate}
            today={today}
            labels={dateFieldLabels}
            disabled={busy}
            onChange={onAnchorChange}
          />
        </div>
        <EstimateField
          key={series.estimate ?? "none"}
          id="series-details-estimate"
          estimate={series.estimate}
          disabled={busy}
          onChange={onEstimateChange}
        />
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
