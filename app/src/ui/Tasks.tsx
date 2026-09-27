import { useState, type FormEvent } from "react";
import type { TaskView } from "../data/store.ts";
import { addTask, deleteTask, renameTask, setTaskCompleted } from "../data/tasks.ts";

/**
 * The Tasks surface. Input is validated by the domain module (via the data
 * helpers), so rejected input never reaches Firestore; thrown errors are
 * displayed. No offline claim: writes go to Firestore and the store reflects
 * what it reports.
 */
export function Tasks({ uid, tasks, loading }: { uid: string; tasks: TaskView[]; loading: boolean }) {
  const [title, setTitle] = useState("");
  const [deadline, setDeadline] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rename, setRename] = useState("");

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

  const onAdd = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await addTask(uid, title, deadline === "" ? undefined : deadline);
      setTitle("");
      setDeadline("");
    });
  };

  const onSaveRename = () => {
    if (editingId === null) return;
    void run(async () => {
      await renameTask(uid, editingId, rename);
      setEditingId(null);
      setRename("");
    });
  };

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
        <ul className="task-list">
          {tasks.map(task => (
            <li key={task.id} className={task.completed ? "task completed" : "task"}>
              <span className="task-title">{task.title}</span>
              {task.deadline && <span className="task-deadline">due {task.deadline}</span>}
              <span className="task-actions">
                <button type="button" disabled={busy} onClick={() => void run(() => setTaskCompleted(uid, task.id, !task.completed))}>
                  {task.completed ? `Uncomplete ${task.title}` : `Complete ${task.title}`}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setEditingId(task.id);
                    setRename(task.title);
                    setError(null);
                  }}
                >
                  Rename {task.title}
                </button>
                <button type="button" disabled={busy} onClick={() => void run(() => deleteTask(uid, task.id))}>
                  Delete {task.title}
                </button>
              </span>
              {editingId === task.id && (
                <span className="rename-form">
                  <label htmlFor={`rename-${task.id}`}>Rename task</label>
                  <input
                    id={`rename-${task.id}`}
                    type="text"
                    value={rename}
                    onChange={event => setRename(event.target.value)}
                  />
                  <button type="button" disabled={busy} onClick={onSaveRename}>
                    Save rename
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
