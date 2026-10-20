import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
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
import { TaskDragProvider } from "./ui/drag.tsx";
import { Home } from "./ui/Home.tsx";
import { CloseIcon, PersonIcon, PlusIcon, SearchIcon } from "./ui/icons.tsx";
import { dur, easeOut, phoneQuery, spring, useMediaQuery } from "./ui/motion.ts";
import { Sheet } from "./ui/Sheet.tsx";
import { Sidebar, ThemeSwitch, views } from "./ui/Sidebar.tsx";
import { SyncStatus } from "./ui/SyncStatus.tsx";
import { Tasks } from "./ui/Tasks.tsx";
import { dateKey } from "./ui/time.ts";
import { useFocusTimer } from "./ui/useFocusTimer.ts";
import { useKeyboardInset } from "./ui/viewport.ts";
import { UndoToast, type PendingUndo, type UndoableDelete } from "./ui/UndoToast.tsx";
import { UpdatePrompt } from "./ui/UpdatePrompt.tsx";
import { settle, writeErrorEvent } from "./ui/write.ts";

export type View = "home" | "tasks" | "calendar";

export default function App() {
  // The keyboard inset is published once for the whole app: the sign-in gate and
  // every sheet and the palette size themselves against the same variable.
  useKeyboardInset();
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
      {/* Announced outside the shell: an update is just as available on the
          sign-in screen as inside the app. */}
      <UpdatePrompt />
    </MotionConfig>
  );
}

const titles: Record<View, string> = { home: "Today", tasks: "Tasks", calendar: "Calendar" };

function Shell({ user, view, onNavigate }: { user: User; view: View; onNavigate: (view: View) => void }) {
  const { loading, tasks, blocks, series, completions, pendingWrites: pending } = useStore(user.uid);
  const profile = useProfileTimeZone(user.uid);
  const phone = useMediaQuery(phoneQuery);
  // One timer for the whole shell: the sidebar card shows it and the palette
  // commands change it. A phone has no focus surface yet, so it runs none.
  const focus = useFocusTimer({ blocks, tasks, timeZone: profile.timeZone, enabled: !phone });
  const [calendarDay, setCalendarDay] = useState<string | null>(null);
  const [creating, setCreating] = useState<HTMLElement | null>(null);
  const [lateError, setLateError] = useState<string | null>(null);
  // One undo offer at a time, keyed so a new delete replaces the old toast and
  // restarts its countdown instead of stacking a second one.
  const [undo, setUndo] = useState<PendingUndo | null>(null);
  const undoCursor = useRef(0);
  const offerUndo = (item: UndoableDelete) => setUndo({ ...item, id: ++undoCursor.current });
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
  const zone = profile.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = dateKey(new Date(), zone);
  const newTask = (event: React.MouseEvent<HTMLButtonElement>) => setCreating(event.currentTarget);

  return (
    <TaskDragProvider onNavigate={onNavigate}>
      <div className={`shell${phone ? " is-phone" : ""}`}>
      {!phone && (
        <Sidebar
          email={user.email ?? ""}
          uid={user.uid}
          view={view}
          openCount={openCount}
          pending={pending}
          tasks={tasks}
          blocks={blocks}
          timeZone={profile.timeZone}
          selectedDay={calendarDay}
          focus={focus}
          onNavigate={onNavigate}
          onPickDay={key => {
            setCalendarDay(key === today ? null : key);
            onNavigate("calendar");
          }}
          onOpenTask={taskId => {
            setPendingTask(taskId);
            onNavigate("tasks");
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
          {/* The page lands where it lands: opacity only, one 120 ms beat, and
              no exit at all. mode="wait" made every navigation pay the old
              view's departure first (280 ms in total, including the palette's
              Enter); now the new view mounts at once and is legible long before
              its fade ends. */}
          <AnimatePresence initial={false}>
            <motion.div
              key={view}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: dur.page, ease: easeOut }}
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
                  onDeleted={offerUndo}
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
                  onDeleted={offerUndo}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
      {phone && (
        <>
          <TabBar view={view} onNavigate={onNavigate} />
          <button type="button" className="fab glass glass-float glass-lens" aria-label="New task" onClick={newTask}>
            <PlusIcon />
          </button>
        </>
      )}
      {undo && (
        <UndoToast key={undo.id} item={undo} onDismiss={() => setUndo(null)} onError={setLateError} />
      )}
      <AnimatePresence>
        {creating && <NewTaskSheet key="new-task" uid={user.uid} origin={creating} onClose={() => setCreating(null)} />}
      </AnimatePresence>
      {paletteOpen && (
        <CommandPalette
          uid={user.uid}
          tasks={tasks}
          focus={focus}
          onClose={() => setPaletteOpen(false)}
          onNavigate={onNavigate}
          onOpenTask={taskId => {
            setPendingTask(taskId);
            onNavigate("tasks");
          }}
        />
      )}
      </div>
    </TaskDragProvider>
  );
}

/** The phone's floating tab bar. The selection pill slides between tabs on the
 * app's snappy spring -- the same tempo the desktop nav pill already uses. It
 * used to squash along the way (scaleX 1.18 / scaleY 0.9); two overshooting
 * springs on a 22 px glyph read as a wobble, so the pill now only travels. */
function TabBar({ view, onNavigate }: { view: View; onNavigate: (view: View) => void }) {
  return (
    <nav aria-label="Main" className="tabbar glass glass-float">
      {views.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          className="tab"
          aria-current={view === id ? "page" : undefined}
          {...(id === "calendar" ? { "data-drop-nav": "calendar" } : {})}
          data-sheen={view === id ? "" : undefined}
          onClick={() => onNavigate(id)}
        >
          {view === id && (
            <motion.span
              layoutId="tab-pill"
              className="tab-pill"
              aria-hidden="true"
              transition={spring.snappy}
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
            className="popover glass glass-thick"
            initial={{ opacity: 0, scale: 0.94 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.12 } }}
            transition={spring.snappy}
          >
            <p className="popover-email" title={email}>{email}</p>
            <SyncStatus pending={pending} />
            {/* No sidebar at this width, so the theme control lives here. */}
            <ThemeSwitch />
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
