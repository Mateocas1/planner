import { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { createTask, createWorkBlock, type Task, type WorkBlock } from "./model.ts";
import { auth, db } from "./client.ts";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  type User,
} from "firebase/auth";
import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import "./lab.css";

type StoredTask = Task & { completed: boolean };
type Item<T> = {
  value: T;
  pending: boolean;
  cached: boolean;
};

const id = () => crypto.randomUUID();

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [tasks, setTasks] = useState<Item<StoredTask>[]>([]);
  const [blocks, setBlocks] = useState<Item<WorkBlock>[]>([]);
  const [browserOnline, setBrowserOnline] = useState(navigator.onLine);
  const [error, setError] = useState("");
  const [email, setEmail] = useState("lab@example.invalid");
  const [password, setPassword] = useState("lab-password");
  const [title, setTitle] = useState("");
  const [start, setStart] = useState("2026-02-03T09:00:00-03:00");
  const [end, setEnd] = useState("2026-02-03T10:00:00-03:00");
  const [taskId, setTaskId] = useState("");
  const [editing, setEditing] = useState<StoredTask | null>(null);
  const [rename, setRename] = useState("");

  useEffect(() => onAuthStateChanged(auth, setUser), []);

  useEffect(() => {
    const reportOnline = () => setBrowserOnline(true);
    const reportOffline = () => setBrowserOnline(false);
    window.addEventListener("online", reportOnline);
    window.addEventListener("offline", reportOffline);
    return () => {
      window.removeEventListener("online", reportOnline);
      window.removeEventListener("offline", reportOffline);
    };
  }, []);

  useEffect(() => {
    setTasks([]);
    setBlocks([]);
    setEditing(null);
    setError("");
    if (!user) return;

    const stopTasks = onSnapshot(
      collection(db, `users/${user.uid}/tasks`),
      { includeMetadataChanges: true },
      snapshot => {
        setTasks(snapshot.docs.map(item => ({
          value: { id: item.id, ...item.data() } as StoredTask,
          pending: item.metadata.hasPendingWrites,
          cached: snapshot.metadata.fromCache,
        })));
      },
      caught => setError(caught.message),
    );
    const stopBlocks = onSnapshot(
      collection(db, `users/${user.uid}/blocks`),
      { includeMetadataChanges: true },
      snapshot => {
        setBlocks(snapshot.docs.map(item => ({
          value: { id: item.id, ...item.data() } as WorkBlock,
          pending: item.metadata.hasPendingWrites,
          cached: snapshot.metadata.fromCache,
        })));
      },
      caught => setError(caught.message),
    );
    return () => {
      stopTasks();
      stopBlocks();
    };
  }, [user]);

  const write = (work: Promise<unknown>) => {
    void work.catch(caught => {
      setError(caught instanceof Error ? caught.message : String(caught));
    });
  };

  const access = (create: boolean) => {
    if (!email.endsWith("@example.invalid")) {
      setError("Use a disposable @example.invalid lab email.");
      return;
    }
    setError("");
    write(create
      ? createUserWithEmailAndPassword(auth, email, password)
      : signInWithEmailAndPassword(auth, email, password));
  };

  const submitTask = (event: FormEvent) => {
    event.preventDefault();
    if (!user) return;
    try {
      const value = createTask(id(), title);
      setTitle("");
      write(setDoc(doc(db, `users/${user.uid}/tasks/${value.id}`), {
        ...value,
        completed: false,
      }));
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  const submitBlock = (event: FormEvent) => {
    event.preventDefault();
    if (!user) return;
    try {
      const value = createWorkBlock(id(), start, end, taskId || undefined);
      write(setDoc(doc(db, `users/${user.uid}/blocks/${value.id}`), value));
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  const saveRename = () => {
    if (!user || !editing) return;
    try {
      const value = createTask(editing.id, rename, editing.deadline);
      setEditing(null);
      write(updateDoc(doc(db, `users/${user.uid}/tasks/${value.id}`), {
        title: value.title,
      }));
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  const state = (item: Pick<Item<unknown>, "pending" | "cached">) => {
    if (item.pending) return "pending write";
    return item.cached ? "cached" : "server-confirmed";
  };

  return (
    <main>
      <h1>Planner lab</h1>
      <p className="warning">
        <strong>Synthetic local-only diagnostic.</strong>{" "}
        Use disposable emulator accounts; do not sign out or clear this origin
        until pending writes have synced.
      </p>

      <section aria-label="Workspace access">
        <h2>Workspace access</h2>
        <p>Create a fake account once, or sign in to its restored browser session.</p>
        <label>
          Email
          <input
            value={email}
            onChange={event => setEmail(event.target.value)}
            type="email"
          />
        </label>
        <label>
          Password
          <input
            value={password}
            onChange={event => setPassword(event.target.value)}
            type="password"
          />
        </label>
        <div>
          <button type="button" onClick={() => access(true)}>
            Create fake account
          </button>{" "}
          <button type="button" onClick={() => access(false)}>
            Sign in
          </button>
        </div>
      </section>

      <p className="status">
        {user ? `Signed in as ${user.email}.` : "Not signed in."}{" "}
        Browser reports {browserOnline ? "online" : "offline"}; snapshots,
        not this flag, indicate backend confirmation.
      </p>
      {error && <p className="error" role="alert">{error}</p>}

      {user && (
        <div className="workspace">
          <section>
            <h2>Tasks</h2>
            <form onSubmit={submitTask}>
              <label>
                Task title
                <input
                  value={title}
                  onChange={event => setTitle(event.target.value)}
                  required
                />
              </label>
              <button>Add task</button>
            </form>
            <ul>
              {tasks.map(({ value, ...metadata }) => (
                <li key={value.id}>
                  <strong>{value.title}</strong> — {value.completed ? "completed" : "open"}{" "}
                  ({state(metadata)}) {" "}
                  <button onClick={() => {
                    setEditing(value);
                    setRename(value.title);
                  }}>
                    Edit {value.title}
                  </button>{" "}
                  <button onClick={() => write(updateDoc(
                    doc(db, `users/${user.uid}/tasks/${value.id}`),
                    { completed: !value.completed },
                  ))}>
                    {value.completed ? "Uncomplete" : "Complete"} {value.title}
                  </button>
                </li>
              ))}
            </ul>
            {editing && (
              <div>
                <label>
                  Rename task
                  <input
                    value={rename}
                    onChange={event => setRename(event.target.value)}
                  />
                </label>
                <button onClick={saveRename}>Save rename</button>
              </div>
            )}
          </section>

          <section>
            <h2>Work blocks</h2>
            <form onSubmit={submitBlock}>
              <label>
                Start ISO timestamp with timezone
                <input
                  value={start}
                  onChange={event => setStart(event.target.value)}
                  required
                />
              </label>
              <label>
                End ISO timestamp with timezone
                <input
                  value={end}
                  onChange={event => setEnd(event.target.value)}
                  required
                />
              </label>
              <label>
                Optional task
                <select value={taskId} onChange={event => setTaskId(event.target.value)}>
                  <option value="">None</option>
                  {tasks.map(({ value }) => (
                    <option key={value.id} value={value.id}>{value.title}</option>
                  ))}
                </select>
              </label>
              <button>Add block</button>
            </form>
            <ul>
              {blocks.map(({ value, ...metadata }) => (
                <li key={value.id}>
                  {value.start} to {value.end}
                  {value.taskId && ` for task ${value.taskId}`} ({state(metadata)}) {" "}
                  <button onClick={() => write(deleteDoc(
                    doc(db, `users/${user.uid}/blocks/${value.id}`),
                  ))}>
                    Delete block
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
