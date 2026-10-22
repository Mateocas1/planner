import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import type { User } from "firebase/auth";
import { signOutUser, useSession } from "./data/session.ts";
import { useProfileTimeZone } from "./data/profile.ts";
import { addSeries, type Frequency } from "./data/series.ts";
import { useStore } from "./data/store.ts";
import { addTask } from "./data/tasks.ts";
import { parseQuickAdd } from "./domain/quickAdd.ts";
import { MAX_ESTIMATE_MINUTES, MIN_ESTIMATE_MINUTES, estimateNote } from "./domain/model.ts";
import type { ShutdownState } from "./planning/shutdown.ts";
import { AuthForm } from "./ui/AuthForm.tsx";
import { BiasHint, completedSamples, type TrackedTask } from "./ui/BiasHint.tsx";
import { Calendar } from "./ui/Calendar.tsx";
import { CommandPalette } from "./ui/CommandPalette.tsx";
import { GcalImportSheet } from "./ui/GcalImport.tsx";
import { TaskDragProvider } from "./ui/drag.tsx";
import { Home } from "./ui/Home.tsx";
import { NowMode } from "./ui/NowMode.tsx";
import { ShutdownSheet } from "./ui/ShutdownSheet.tsx";
import { QuickAddChips } from "./ui/QuickAddChips.tsx";
import { CloseIcon, PersonIcon, PlusIcon, SearchIcon } from "./ui/icons.tsx";
import { dur, easeOut, phoneQuery, spring, useMediaQuery } from "./ui/motion.ts";
import { DaySettingsSheet } from "./ui/Settings.tsx";
import { Sheet } from "./ui/Sheet.tsx";
import { ShortcutHelp } from "./ui/ShortcutHelp.tsx";
import { Sidebar, ThemeSwitch, views } from "./ui/Sidebar.tsx";
import { DesktopShell } from "./ui/DesktopShell.tsx";
import { createShortcutRouter, dialogOpen, publishShortcut, rowHasFocus } from "./ui/shortcuts.ts";
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
      <DesktopShell />
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
  // restarts its countdown instead of stacking a second one. The id is returned
  // because the shutdown ritual withdraws its own offer when the server rejects
  // the close it announced, without touching an offer somebody else made.
  const [undo, setUndo] = useState<PendingUndo | null>(null);
  const undoCursor = useRef(0);
  const offerUndo = (item: UndoableDelete) => {
    const id = ++undoCursor.current;
    setUndo({ ...item, id });
    return id;
  };
  /* The ritual's undo runs from a toast that outlives the sheet, so what it
     checks must be the state the shell holds *then*: the store's deadlines and
     the profile's raw stamp, read through a getter at the moment Undo is
     pressed (F3c review item 4). */
  const liveShutdown = useRef<ShutdownState>({ tasks: [], lastShutdown: undefined });
  liveShutdown.current = {
    tasks: tasks.map(task => ({ id: task.id, deadline: task.deadline })),
    lastShutdown: profile.storedLastShutdown,
  };
  // Command palette: open/closed, and the task the palette asked the Tasks
  // surface to reveal. The request survives the view change that mounts it.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Now mode: the full-screen glance surface. It owns no data of its own -- it
  // reads the shell's blocks, tasks and timer -- so the shell only tracks
  // whether it is on screen.
  const [nowOpen, setNowOpen] = useState(false);
  // The shutdown ritual (F3c): the sheet that shows what the day left behind and
  // turns Today to Tomorrow. Opened from Home's banner (or the page turn) and
  // from the palette, which is why the origin of its entrance is recorded here.
  const [shutdownOpen, setShutdownOpen] = useState(false);
  const shutdownOrigin = useRef<HTMLElement | null>(null);
  const openShutdown = (origin: HTMLElement | null) => {
    shutdownOrigin.current = origin;
    setShutdownOpen(true);
  };
  // The Google Calendar import sheet: whether it is open, and the control that
  // opened it (its box is what the panel grows out of). The palette closes
  // before the sheet mounts, so that path has no origin and the panel pops.
  const [importOpen, setImportOpen] = useState(false);
  const importOrigin = useRef<HTMLElement | null>(null);
  const openImport = (origin: HTMLElement | null) => {
    importOrigin.current = origin;
    setImportOpen(true);
  };
  // Day settings (S1): the same panel from the sidebar's account row and from
  // the phone's account menu, so it grows out of whichever control was pressed.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsOrigin = useRef<HTMLElement | null>(null);
  const openSettings = (origin: HTMLElement | null) => {
    settingsOrigin.current = origin;
    setSettingsOpen(true);
  };
  // The keyboard's reference sheet (F6): `?` opens it, Esc closes it.
  const [helpOpen, setHelpOpen] = useState(false);
  // One router for the shell, so the pending `g` of a sequence survives a
  // re-render; the listener that feeds it is registered once below.
  const shortcuts = useRef(createShortcutRouter());
  // The controls a keyboard-created sheet grows out of. A pointer passes its own
  // event target; a key press has no box, so it borrows the control a pointer
  // would have pressed.
  const newTaskRef = useRef<HTMLButtonElement>(null);
  const newTaskFabRef = useRef<HTMLButtonElement>(null);
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

  /* The keyboard (F6): one more listener, and the only one that reads letters.
     ui/shortcuts.ts decides -- is this a field, a dialog, an IME, a browser
     chord, a sequence that has waited too long -- and this effect only performs
     the answer: navigation and the sheets the shell owns here, and the row
     actions published to the surface that owns the focused row. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const route = shortcuts.current.route(event, {
        dialogOpen: dialogOpen(),
        enabled: profile.shortcutsEnabled,
        rowFocused: rowHasFocus(),
        now: performance.now(),
      });
      if (route.kind !== "action") return;
      // An action was chosen: the arrow must not scroll the page, and Enter must
      // not also activate the focused row natively (the row is clicked once,
      // below).
      event.preventDefault();
      switch (route.action) {
        case "next":
        case "previous":
        case "complete":
        case "tomorrow":
        case "newBlock":
          // Only the mounted surface knows what its rows mean, which write to
          // make and which undo to offer, so it performs the action.
          publishShortcut(route.action);
          return;
        case "details": {
          const row = document.activeElement;
          if (row instanceof HTMLElement) row.click();
          return;
        }
        case "newTask":
          setCreating(keyboardOrigin(newTaskRef.current, newTaskFabRef.current));
          return;
        case "goToday":
          onNavigate("home");
          return;
        case "goTasks":
          onNavigate("tasks");
          return;
        case "goCalendar":
          onNavigate("calendar");
          return;
        case "now":
          setNowOpen(true);
          return;
        case "help":
          setHelpOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onNavigate, profile.shortcutsEnabled]);

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
          onImport={openImport}
          onOpenSettings={openSettings}
        />
      )}
      <div className="main">
        <header
          data-tauri-drag-region
          className={`topbar${scrolled ? " is-scrolled" : ""}${titleHidden ? " is-titled" : ""}`}
        >
          <span className="topbar-title" data-tauri-drag-region aria-hidden="true">{titles[view]}</span>
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
              <AccountMenu
                email={user.email ?? ""}
                pending={pending}
                onSignOut={signOut}
                onImport={openImport}
                onSettings={openSettings}
              />
            ) : (
              <button ref={newTaskRef} type="button" className="button button-accent" onClick={newTask}>
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
                  workWindow={profile.workWindow}
                  shutdownTime={profile.shutdownTime}
                  lastShutdown={profile.lastShutdown}
                  profileError={profile.error}
                  onOpenCalendar={() => onNavigate("calendar")}
                  onOpenNow={() => setNowOpen(true)}
                  onCloseDay={openShutdown}
                  onOfferUndo={offerUndo}
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
          <button ref={newTaskFabRef} type="button" className="fab glass glass-float glass-lens" aria-label="New task" onClick={newTask}>
            <PlusIcon />
          </button>
        </>
      )}
      {undo && (
        <UndoToast key={undo.id} item={undo} onDismiss={() => setUndo(null)} onError={setLateError} />
      )}
      <AnimatePresence>
        {creating && (
          <NewTaskSheet key="new-task" uid={user.uid} timeZone={zone} tasks={tasks} origin={creating} onClose={() => setCreating(null)} />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {settingsOpen && (
          <DaySettingsSheet
            key="day-settings"
            uid={user.uid}
            workWindow={profile.workWindow}
            shutdownTime={profile.shutdownTime}
            shortcutsEnabled={profile.shortcutsEnabled}
            origin={settingsOrigin.current}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {importOpen && (
          <GcalImportSheet
            key="gcal-import"
            uid={user.uid}
            blocks={blocks}
            tasks={tasks}
            timeZone={zone}
            origin={importOrigin.current}
            onClose={() => setImportOpen(false)}
            onOfferUndo={offerUndo}
          />
        )}
      </AnimatePresence>
      {paletteOpen && (
        <CommandPalette
          uid={user.uid}
          timeZone={zone}
          tasks={tasks}
          focus={focus}
          onClose={() => setPaletteOpen(false)}
          onNavigate={onNavigate}
          onImport={() => openImport(null)}
          onOpenNow={() => setNowOpen(true)}
          onCloseDay={() => openShutdown(null)}
          onOpenTask={taskId => {
            setPendingTask(taskId);
            onNavigate("tasks");
          }}
        />
      )}
      <AnimatePresence>
        {shutdownOpen && (
          <ShutdownSheet
            key="shutdown"
            uid={user.uid}
            tasks={tasks}
            blocks={blocks}
            timeZone={zone}
            workWindow={profile.workWindow}
            now={new Date()}
            storedShutdown={profile.storedLastShutdown}
            origin={shutdownOrigin.current}
            onClose={() => setShutdownOpen(false)}
            onOfferUndo={offerUndo}
            onWithdrawUndo={id => setUndo(current => (current?.id === id ? null : current))}
            onProblem={setLateError}
            getShutdownState={() => liveShutdown.current}
          />
        )}
      </AnimatePresence>
      {helpOpen && <ShortcutHelp onClose={() => setHelpOpen(false)} />}
      {nowOpen && (
        <NowMode
          uid={user.uid}
          blocks={blocks}
          tasks={tasks}
          timeZone={zone}
          focus={focus}
          onClose={() => setNowOpen(false)}
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
function AccountMenu({
  email,
  pending,
  onSignOut,
  onImport,
  onSettings,
}: {
  email: string;
  pending: number;
  onSignOut: () => void;
  onImport: (origin: HTMLElement) => void;
  onSettings: (origin: HTMLElement) => void;
}) {
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
            {/* And so does the import entry: the same footer action, one tap
                from the account the calendars belong to. */}
            <button
              type="button"
              className="link-button"
              onClick={event => {
                setOpen(false);
                onSettings(event.currentTarget);
              }}
            >
              Day settings
            </button>
            <button
              type="button"
              className="link-button"
              onClick={event => {
                setOpen(false);
                onImport(event.currentTarget);
              }}
            >
              Import from Google Calendar
            </button>
            <button type="button" className="button" onClick={onSignOut}>Sign out</button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** The New task sheet, reachable from every view. Enter in the title submits.
 * A repeating task needs a start date; the deadline is optional either way.
 *
 * The title line is read by the quick-add parser while it is typed. Recognized
 * parts become chips and fill the Deadline, Repeat and Start controls; a part
 * the model cannot hold (a time of day, an unsupported repeat) is not consumed,
 * so the created task keeps the user's words. The field itself is never
 * rewritten: the user's line stays as typed and the chips say what the sheet
 * made of it. Once a control is edited by hand that control stops following the
 * parse -- the user's choice outranks it, including an emptied field. */
function NewTaskSheet({
  uid,
  timeZone,
  tasks,
  origin,
  onClose,
}: {
  uid: string;
  timeZone: string;
  /** The stored tasks: the estimate lesson reads the completed ones (F2b). */
  tasks: readonly TrackedTask[];
  origin: HTMLElement;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  // null means "whatever the parse says"; a string (including "") is the user's
  // own value for that control and wins over every later keystroke.
  const [deadlineEdit, setDeadlineEdit] = useState<string | null>(null);
  const [repeatEdit, setRepeatEdit] = useState<Frequency | "off" | null>(null);
  const [startEdit, setStartEdit] = useState<string | null>(null);
  // The estimate is minutes or nothing: an empty field means "no estimate",
  // which planning reads as the 60-minute assumption (never as zero).
  const [estimateEdit, setEstimateEdit] = useState("");
  // Undone chips, by the exact text they matched: that text stays in the title
  // and is not consumed again, so one undo does not cancel every later parse.
  const [undone, setUndone] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The clock is read inside the parse, so every keystroke resolves "tomorrow"
  // against the planner's day at that moment: a sheet can stay open past
  // midnight, and the day is the profile zone's day (D3), never the browser's.
  const parsed = useMemo(
    () => parseQuickAdd(title, { now: new Date(), timeZone, ignore: undone }),
    [title, timeZone, undone],
  );
  const deadline = deadlineEdit ?? parsed.deadline ?? "";
  const repeat = repeatEdit ?? parsed.frequency ?? "off";
  const start = startEdit ?? parsed.anchorDate ?? "";
  const estimate = estimateEdit === "" ? undefined : Number(estimateEdit);
  // The lesson is only as good as its history: finished tasks with a recorded
  // pace. Recomputed when the store changes, never while the sheet sits still.
  const biasSamples = useMemo(() => completedSamples(tasks), [tasks]);
  // A chip that would no longer describe the control it stands for is dropped:
  // the text it matched stays consumed, because the user replaced the value.
  const chips = parsed.parts.filter(part =>
    part.kind === "date" ? deadline === parsed.deadline : repeat !== "off" && repeat === parsed.frequency,
  );

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await settle(
        repeat === "off"
          ? addTask(uid, parsed.title, deadline === "" ? undefined : deadline, estimate)
          : addSeries(uid, parsed.title, repeat, start, deadline === "" ? undefined : deadline, estimate),
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
        <QuickAddChips parts={chips} today={parsed.today} onUndo={part => setUndone(list => [...list, part.text])} />
        <div className="form-group">
          <div className="form-row">
            <label htmlFor="task-deadline">Deadline</label>
            <input
              id="task-deadline"
              className="form-control"
              type="date"
              value={deadline}
              onChange={event => setDeadlineEdit(event.target.value)}
            />
          </div>
          <div className="form-row stacked">
            <label htmlFor="task-estimate">Estimate</label>
            <input
              id="task-estimate"
              className="form-control"
              type="number"
              inputMode="numeric"
              min={MIN_ESTIMATE_MINUTES}
              max={MAX_ESTIMATE_MINUTES}
              step={5}
              placeholder="Minutes"
              value={estimateEdit}
              aria-describedby="task-estimate-note"
              onChange={event => setEstimateEdit(event.target.value)}
            />
            {/* An empty field is the assumption, stated rather than implied:
                the created task stores no estimate and planning uses 60 min. */}
            <p id="task-estimate-note" className="sheet-note estimate-note">
              {estimateNote(estimate)}
            </p>
            {/* What tasks like this one usually take, offered rather than
                applied: the field keeps the number its owner typed until the
                offer is tapped (F2b, roadmap §5 question 3). */}
            <BiasHint
              samples={biasSamples}
              title={parsed.title}
              estimate={estimate}
              showEmptyHint
              onAccept={minutes => setEstimateEdit(String(minutes))}
            />
          </div>
          <div className="form-row">
            <label htmlFor="task-repeat">Repeat</label>
            <select
              id="task-repeat"
              className="form-control"
              value={repeat}
              onChange={event => setRepeatEdit(event.target.value as Frequency | "off")}
            >
              <option value="off">Never</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
          {repeat !== "off" && (
            <div className="form-row">
              <label htmlFor="task-start">Start date</label>
              <input
                id="task-start"
                className="form-control"
                type="date"
                value={start}
                onChange={event => setStartEdit(event.target.value)}
              />
            </div>
          )}
        </div>
        {error && <p className="inline-error" role="alert">{error}</p>}
        <button type="submit" className="button-primary" disabled={busy}>Add task</button>
      </form>
    </Sheet>
  );
}

/** Where a keyboard-created sheet grows from: the control the caret is on if it
 * is on one, else the control a pointer would have pressed, else the page. */
function keyboardOrigin(...candidates: Array<HTMLElement | null>): HTMLElement {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) return active;
  for (const candidate of candidates) if (candidate !== null) return candidate;
  return document.body;
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
