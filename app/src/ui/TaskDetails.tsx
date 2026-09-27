import { useEffect, useState } from "react";
import type { TaskView } from "../data/store.ts";

/**
 * The details panel for the selected task. Every mutating action lives here
 * and nowhere else. It closes through the explicit Close control and with
 * Escape. The deadline renders as a read-only date control: the data layer
 * exposes no deadline write yet, and a local write here would bypass the
 * domain validation every other write goes through.
 */
export function TaskDetails({
  task,
  busy,
  onClose,
  onRename,
  onToggleCompleted,
  onDelete,
}: {
  task: TaskView;
  busy: boolean;
  onClose: () => void;
  onRename: (title: string) => void;
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
      <input id="task-details-deadline" type="date" value={task.deadline ?? ""} readOnly />
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
