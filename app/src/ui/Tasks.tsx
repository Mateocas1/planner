import { useState, type FormEvent } from "react";
import type { TaskView } from "../data/store.ts";
import { addTask, deleteTask, renameTask, setTaskCompleted, setTaskDeadline } from "../data/tasks.ts";
import { TaskDetails } from "./TaskDetails.tsx";

/**
 * The Tasks surface. Rows are compact — completion checkbox, title, deadline —
 * and every mutating action lives in the details panel for the selected row.
 * Input is validated by the domain module (via the data helpers), so rejected
 * input never reaches Firestore; thrown errors are displayed. No offline
 * claim: writes go to Firestore and the store reflects what it reports.
 */
export function Tasks({ uid, tasks, loading }: { uid: string; tasks: TaskView[]; loading: boolean }) {
  const [title, setTitle] = useState("");
  const [deadline, setDeadline] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Rows whose completion the user just performed in this session: the wash
  // class is applied only to these, so it never plays on mount for rows that
  // were already completed. The class is removed on animationend.
  const [washIds, setWashIds] = useState<ReadonlySet<string>>(() => new Set<string>());

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  /** Completes or reopens a task; completing it queues the one-shot wash. */
  function completeTask(taskId: string, completed: boolean) {
    void run(async () => {
      await setTaskCompleted(uid, taskId, completed);
      setWashIds(previous => {
        const next = new Set(previous);
        if (completed) next.add(taskId);
        else next.delete(taskId);
        return next;
      });
    });
  }

  /** Retires the wash class once its animation has actually run. */
  const endTaskWash = (taskId: string, event: React.AnimationEvent) => {
    if (event.animationName !== "task-wash") return;
    setWashIds(previous => {
      if (!previous.has(taskId)) return previous;
      const next = new Set(previous);
      next.delete(taskId);
      return next;
    });
  };

  const onAdd = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await addTask(uid, title, deadline === "" ? undefined : deadline);
      setTitle("");
      setDeadline("");
    });
  };

  const selected = tasks.find(task => task.id === selectedId);
  const open = tasks.filter(task => !task.completed);
  const completed = tasks.filter(task => task.completed);

  const group = (label: string, items: TaskView[]) => (
    <section className="task-group">
      <h3>
        {label} ({items.length})
      </h3>
      <ul className="task-list">
        {items.map(task => (
          <li
            key={task.id}
            className={`task${task.completed ? " completed" : ""}${washIds.has(task.id) ? " task-wash" : ""}`}
            onAnimationEnd={event => endTaskWash(task.id, event)}
          >
            <input
              type="checkbox"
              className="task-check"
              checked={task.completed}
              disabled={busy}
              aria-label={`${task.completed ? "Reopen" : "Complete"}: ${task.title}`}
              onChange={() => completeTask(task.id, !task.completed)}
            />
            <button
              type="button"
              className="task-open"
              onClick={() => {
                setSelectedId(task.id);
                setError(null);
              }}
            >
              <span className="task-title">{task.title}</span>
            </button>
            {task.deadline && <span className="task-deadline">due {task.deadline}</span>}
          </li>
        ))}
      </ul>
    </section>
  );

  return (
    <section aria-labelledby="tasks-heading">
      <h2 id="tasks-heading">Tasks</h2>
      <form className="task-form" onSubmit={onAdd}>
        <label htmlFor="task-title">Task title</label>
        <input
          id="task-title"
          type="text"
          value={title}
          onChange={event => setTitle(event.target.value)}
        />
        <label htmlFor="task-deadline">Deadline</label>
        <input
          id="task-deadline"
          type="date"
          value={deadline}
          onChange={event => setDeadline(event.target.value)}
        />
        <button type="submit" disabled={busy}>
          Add task
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {!loading && tasks.length === 0 ? (
        <p role="status">No tasks yet. Add your first one above.</p>
      ) : (
        <>
          {open.length > 0 && group("Open", open)}
          {completed.length > 0 && group("Completed", completed)}
        </>
      )}
      {selected && (
        <TaskDetails
          key={selected.id}
          task={selected}
          busy={busy}
          onClose={() => setSelectedId(null)}
          onRename={next => {
            void run(async () => {
              await renameTask(uid, selected.id, next);
            });
          }}
          onDeadlineChange={next => {
            void run(async () => {
              await setTaskDeadline(uid, selected.id, selected.title, next === "" ? undefined : next);
            });
          }}
          onToggleCompleted={() => {
            completeTask(selected.id, !selected.completed);
          }}
          onDelete={() => {
            void run(() => deleteTask(uid, selected.id));
          }}
        />
      )}
    </section>
  );
}
