import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import type { User } from "firebase/auth";
import { signOutUser, useSession } from "./data/session.ts";
import { useProfileTimeZone } from "./data/profile.ts";
import { addSeries, type Frequency } from "./data/series.ts";
import { useStore } from "./data/store.ts";
import { addTask } from "./data/tasks.ts";
import { AuthForm } from "./ui/AuthForm.tsx";
import { Calendar } from "./ui/Calendar.tsx";
import { CommandPalette } from "./ui/CommandPalette.tsx";
import { Home } from "./ui/Home.tsx";
import { CloseIcon, PersonIcon, PlusIcon, SearchIcon } from "./ui/icons.tsx";
import { easeOut, phoneQuery, spring, useMediaQuery } from "./ui/motion.ts";
import { Sheet } from "./ui/Sheet.tsx";
import { Sidebar, SyncStatus, views } from "./ui/Sidebar.tsx";
import { Tasks } from "./ui/Tasks.tsx";
import { dateKey } from "./ui/time.ts";
import { settle, writeErrorEvent } from "./ui/write.ts";

export type View = "home" | "tasks" | "calendar";

export default function App() {
  const { loading, user } = useSession();
  const [view, setView] = useState<View>("home");

  return (
    <MotionConfig reducedMotion="user">
      {loading ? (
        <main className="gate" role="status">
          <p>Checking your session…</p>
        </main>
      ) : !user ? (
        <AuthForm />
      ) : (
        <Shell user={user} view={view} onNavigate={setView} />
      )}
    </MotionConfig>
  );
}

const titles: Record<View, string> = { home: "Today", tasks: "Tasks", calendar: "Calendar" };

function Shell({ user, view, onNavigate }: { user: User; view: View; onNavigate: (view: View) => void }) {
  const { loading, tasks, blocks, series, completions } = useStore(user.uid);
  const profile = useProfileTimeZone(user.uid);
  const phone = useMediaQuery(phoneQuery);
  const [calendarDay, setCalendarDay] = useState<string | null>(null);
  const [creating, setCreating] = useState<HTMLElement | null>(null);
  const [lateError, setLateError] = useState<string | null>(null);
  // Command palette: open/closed, and the task the palette asked the Tasks
  // surface to reveal. The request survives the view change that mounts it.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [pendingTask, setPendingTask] = useState<string | null>(null);
  const clearPendingTask = useCallback(() => setPendingTask(null), []);
  const scrolled = useScrolled();
  const titleHidden = useTitleScrolledAway(view);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "k") return;
      // Cmd/Ctrl+K is the palette's from anywhere, including inside a field.
      event.preventDefault();
      setPaletteOpen(true);
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, []);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [view]);

  useEffect(() => {
    const onError = (event: Event) => setLateError((event as CustomEvent<string>).detail);
    window.addEventListener(writeErrorEvent, onError);
    return () => window.removeEventListener(writeErrorEvent, onError);
  }, []);

  const signOut = () => {
    onNavigate("home");
    void signOutUser();
  };
  const openCount = tasks.filter(task => !task.completed).length;
  const pending = tasks.filter(task => task.pending).length + blocks.filter(block => block.pending).length;
  const zone = profile.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = dateKey(new Date(), zone);
  const newTask = (event: React.MouseEvent<HTMLButtonElement>) => setCreating(event.currentTarget);

  return (
    <div className={`shell${phone ? " is-phone" : ""}`}>
      {!phone && (
        <Sidebar
          email={user.email ?? ""}
          view={view}
          openCount={openCount}
          pending={pending}
          blocks={blocks}
          timeZone={profile.timeZone}
          selectedDay={calendarDay}
          onNavigate={onNavigate}
          onPickDay={key => {
            setCalendarDay(key === today ? null : key);
            onNavigate("calendar");
          }}
          onSignOut={signOut}
        />
      )}
      <div className="main">
        <header className={`topbar${scrolled ? " is-scrolled" : ""}${titleHidden ? " is-titled" : ""}`}>
          <span className="topbar-title" aria-hidden="true">{titles[view]}</span>
          <div className="topbar-actions">
            <button
              type="button"
              className="icon-button large"
              aria-label="Command palette"
              aria-keyshortcuts="Control+K Meta+K"
              onClick={() => setPaletteOpen(true)}
            >
              <SearchIcon />
            </button>
            {phone ? (
              <AccountMenu email={user.email ?? ""} pending={pending} onSignOut={signOut} />
            ) : (
              <button type="button" className="button button-accent" onClick={newTask}>
                <PlusIcon />New task
              </button>
            )}
          </div>
        </header>
        {lateError && (
          <div className="toast" role="alert">
            <span>{lateError}</span>
            <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setLateError(null)}><CloseIcon /></button>
          </div>
        )}
        <main className="content">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={view}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.08 } }}
              transition={{ duration: 0.2, ease: easeOut }}
            >
              {view === "home" && (
                <Home
                  uid={user.uid}
                  loading={loading}
                  tasks={tasks}
                  blocks={blocks}
                  series={series}
                  completions={completions}
                  timeZone={profile.timeZone}
                  profileError={profile.error}
                  onOpenCalendar={() => onNavigate("calendar")}
                />
              )}
              {view === "tasks" && (
                <Tasks
                  uid={user.uid}
                  loading={loading}
                  tasks={tasks}
                  series={series}
                  completions={completions}
                  today={today}
                  openTaskId={pendingTask}
                  onOpenTaskHandled={clearPendingTask}
                />
              )}
              {view === "calendar" && (
                <Calendar
                  uid={user.uid}
                  loading={loading}
                  blocks={blocks}
                  tasks={tasks}
                  timeZone={profile.timeZone}
                  profileError={profile.error}
                  day={calendarDay}
                  onDayChange={setCalendarDay}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
      {phone && (
        <>
          <TabBar view={view} onNavigate={onNavigate} />
          <button type="button" className="fab glass glass-control" aria-label="New task" onClick={newTask}>
            <PlusIcon />
          </button>
        </>
      )}
      <AnimatePresence>
        {creating && <NewTaskSheet key="new-task" uid={user.uid} origin={creating} onClose={() => setCreating(null)} />}
      </AnimatePresence>
      {paletteOpen && (
        <CommandPalette
          uid={user.uid}
          tasks={tasks}
          onClose={() => setPaletteOpen(false)}
          onNavigate={onNavigate}
          onOpenTask={taskId => {
            setPendingTask(taskId);
            onNavigate("tasks");
          }}
        />
      )}
    </div>
  );
}

/** The phone's floating tab bar. The selection pill slides between tabs and
 * stretches along the way, like a droplet, then settles. */
function TabBar({ view, onNavigate }: { view: View; onNavigate: (view: View) => void }) {
  return (
    <nav aria-label="Main" className="tabbar glass glass-control">
      {views.map(({ id, label, Icon }) => (
        <button key={id} type="button" className="tab" aria-current={view === id ? "page" : undefined} onClick={() => onNavigate(id)}>
          {view === id && (
            <motion.span
              layoutId="tab-pill"
              className="tab-pill"
              aria-hidden="true"
              transition={spring.smooth}
              animate={{ scaleX: [1.18, 1], scaleY: [0.9, 1] }}
            />
          )}
          <Icon className="tab-icon" />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

/** On a phone the account lives behind a button in the top bar. The identity
 * line stays in the accessibility tree so the signed-in state is announced. */
function AccountMenu({ email, pending, onSignOut }: { email: string; pending: number; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="account-menu">
      <button type="button" className="icon-button large" aria-expanded={open} aria-label="Account" onClick={() => setOpen(value => !value)}>
        <PersonIcon />
        <span className="sr-only">Signed in as {email}</span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="popover glass glass-sheet"
            initial={{ opacity: 0, scale: 0.94, filter: "blur(4px)" }}
            animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.12 } }}
            transition={spring.snappy}
          >
            <p className="popover-email">{email}</p>
            <SyncStatus pending={pending} />
            <button type="button" className="button" onClick={onSignOut}>Sign out</button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** The New task sheet, reachable from every view. Enter in the title submits.
 * A repeating task needs a start date; the deadline is optional either way. */
function NewTaskSheet({ uid, origin, onClose }: { uid: string; origin: HTMLElement; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [deadline, setDeadline] = useState("");
  const [repeat, setRepeat] = useState<Frequency | "off">("off");
  const [start, setStart] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await settle(
        repeat === "off"
          ? addTask(uid, title, deadline === "" ? undefined : deadline)
          : addSeries(uid, title, repeat, start, deadline === "" ? undefined : deadline),
      );
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet label="New task" className="new-task-sheet" origin={origin} onClose={onClose}>
      <form className="sheet-form" onSubmit={event => void onSubmit(event)}>
        <header className="sheet-head">
          <span className="sheet-kind">New task</span>
          <button type="button" className="icon-button" aria-label="Cancel" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <label className="sr-only" htmlFor="task-title">Task title</label>
        <input
          id="task-title"
          className="sheet-title"
          type="text"
          placeholder="What needs doing?"
          autoFocus
          autoComplete="off"
          value={title}
          onChange={event => setTitle(event.target.value)}
        />
        <div className="form-group">
          <div className="form-row">
            <label htmlFor="task-deadline">Deadline</label>
            <input id="task-deadline" className="form-control" type="date" value={deadline} onChange={event => setDeadline(event.target.value)} />
          </div>
          <div className="form-row">
            <label htmlFor="task-repeat">Repeat</label>
            <select id="task-repeat" className="form-control" value={repeat} onChange={event => setRepeat(event.target.value as Frequency | "off")}>
              <option value="off">Never</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
          {repeat !== "off" && (
            <div className="form-row">
              <label htmlFor="task-start">Start date</label>
              <input id="task-start" className="form-control" type="date" value={start} onChange={event => setStart(event.target.value)} />
            </div>
          )}
        </div>
        {error && <p className="inline-error" role="alert">{error}</p>}
        <button type="submit" className="button-primary" disabled={busy}>Add task</button>
      </form>
    </Sheet>
  );
}

/** True once the page has scrolled, so the top bar turns to glass only when
 * content is actually underneath it. */
function useScrolled(): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return scrolled;
}

/** True once the view's large title has scrolled under the top bar, which
 * then shows the title inline. Read from layout on scroll, so a re-rendered
 * title element never leaves a stale observer behind. */
function useTitleScrolledAway(view: View): boolean {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const update = () => {
      const title = document.querySelector(".content .large-title");
      setHidden(title ? title.getBoundingClientRect().bottom < 56 : false);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, [view]);
  return hidden;
}
