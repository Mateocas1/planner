import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import type { User } from "firebase/auth";
import { signOutUser, useSession } from "./data/session.ts";
import { useProfileTimeZone } from "./data/profile.ts";
import { useLocale, useSyncedLanguage } from "./i18n/index.ts";
import { addSeries, type Frequency } from "./data/series.ts";
import { useStore } from "./data/store.ts";
import { addTask } from "./data/tasks.ts";
import { parseQuickAdd } from "./domain/quickAdd.ts";
import { useDeepLink } from "./desktop-deeplink.ts";
import { isTauri } from "./desktop.ts";
import { useDesktopNotifications } from "./ui/useDesktopNotifications.ts";
import { useDesktopTray } from "./desktop-tray.ts";
import { useSignInReveal } from "./desktop-autostart.ts";
import { MAX_ESTIMATE_MINUTES, MIN_ESTIMATE_MINUTES, estimateNote } from "./domain/model.ts";
import type { ShutdownState } from "./planning/shutdown.ts";
import { AuthForm } from "./ui/AuthForm.tsx";
import { BiasHint, completedSamples, type TrackedTask } from "./ui/BiasHint.tsx";
import { Calendar } from "./ui/Calendar.tsx";
import { ChatSurface } from "./chat/ChatSurface.tsx";
import { CommandPalette } from "./ui/CommandPalette.tsx";
import { GcalImportSheet } from "./ui/GcalImport.tsx";
import { TaskDragProvider } from "./ui/drag.tsx";
import { FocusPillBridge } from "./ui/FocusPillBridge.tsx";
import { Home } from "./ui/Home.tsx";
import { NowMode } from "./ui/NowMode.tsx";
import { ShutdownSheet } from "./ui/ShutdownSheet.tsx";
import { QuickAddChips } from "./ui/QuickAddChips.tsx";
import { CalendarIcon, CloseIcon, PersonIcon, PlusIcon, SearchIcon } from "./ui/icons.tsx";
import { dur, easeOut, phoneQuery, spring, useMediaQuery } from "./ui/motion.ts";
import { SettingsIcon } from "./ui/Settings.tsx";
import { SettingsView } from "./ui/settings/SettingsView.tsx";
import { resolveSettingsTab, type SettingsTab } from "./ui/settings/tabs.ts";
import { useWeeklyReview } from "./ui/weekly/useWeeklyReview.ts";
import { WeeklyReview } from "./ui/weekly/WeeklyReview.tsx";
import { matchesEvent, useShortcutBinding } from "./ui/settings/shortcutRegistry.ts";
import { dueMoment, snoozedUntil } from "./planning/weekly.ts";
import { skipWeeklyReview, snoozeWeeklyReview } from "./data/weeklyReview.ts";
import { useNow } from "./ui/motion.ts";
import { Select } from "./ui/Select.tsx";
import { Sheet } from "./ui/Sheet.tsx";
import { ShortcutHelp } from "./ui/ShortcutHelp.tsx";
import { Sidebar, ThemeSwitch, views } from "./ui/Sidebar.tsx";
import { DesktopShell } from "./ui/DesktopShell.tsx";
import { createShortcutRouter, dialogOpen, publishShortcut, rowHasFocus } from "./ui/shortcuts.ts";
import { SyncStatus } from "./ui/SyncStatus.tsx";
import { Tasks } from "./ui/Tasks.tsx";
import { dateKey } from "./ui/time.ts";
import { useFocusTimer } from "./ui/useFocusTimer.ts";
import { useIdleAway } from "./ui/useIdleAway.ts";
import { IdleToast } from "./ui/IdleToast.tsx";
import type { FocusReport } from "./domain/focus.ts";
import { useKeyboardInset } from "./ui/viewport.ts";
import { DateField } from "./ui/DateField.tsx";
import { dateFieldLabels } from "./ui/DateField.labels.ts";
import { UndoToast, type PendingUndo, type UndoableDelete } from "./ui/UndoToast.tsx";
import { UpdatePrompt } from "./ui/UpdatePrompt.tsx";
import { settle, writeErrorEvent } from "./ui/write.ts";

const repeatOptions = [
  { value: "off", label: "Never" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

export type View = "home" | "tasks" | "calendar" | "settings" | "weekly";

export default function App() {
  // The keyboard inset is published once for the whole app: the sign-in gate and
  // every sheet and the palette size themselves against the same variable.
  useKeyboardInset();
  // Re-renders the whole tree on a language switch: `t()` and the date
  // formatters read the current language, so a root subscription is enough.
  useLocale();
  const { loading, user } = useSession();
  const [view, setView] = useState<View>("home");
  // Settings (Ronda 2, S1) is a view in the shell; the tab it opens on lives
  // here — not in the shell — so `openSettings(tab?)` stays the single entry
  // point for the shell's doors (palette, `Ctrl+,`, account menus) AND for the
  // chat panel's no-key empty state (C3b), which mounts outside the shell.
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  // The view Settings was opened from is remembered for Back; Escape and every
  // sidebar nav item return the ordinary way.
  const previousView = useRef<View>("home");
  const viewRef = useRef<View>(view);
  viewRef.current = view;
  const openSettings = useCallback((tab?: SettingsTab) => {
    setSettingsTab(resolveSettingsTab(tab, isTauri()));
    if (viewRef.current !== "settings") previousView.current = viewRef.current;
    setView("settings");
  }, []);
  const closeSettings = useCallback(() => {
    setView(previousView.current === "settings" ? "home" : previousView.current);
  }, []);

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
        <Shell
          user={user}
          view={view}
          onNavigate={setView}
          settingsTab={settingsTab}
          onSettingsTab={setSettingsTab}
          openSettings={openSettings}
          closeSettings={closeSettings}
        />
      )}
      {/* Announced outside the shell: an update is just as available on the
          sign-in screen as inside the app. */}
      <UpdatePrompt />
      {/* The floating chat panel (desktop, signed-in; dev-mock with ?chatMock
          is account-free). Signed-out users never see it — not even on the
          sign-in screen (review #2). ChatSurface wires transport, planner
          context and memories (C3a); the key setup opens Settings' AI tab in
          W1. */}
      <ChatSurface
        signedIn={user !== null}
        uid={user?.uid ?? null}
        onSetupKey={() => openSettings("ai")}
      />
    </MotionConfig>
  );
}

const titles: Record<View, string> = { home: "Today", tasks: "Tasks", calendar: "Calendar", settings: "Settings", weekly: "Weekly review" };
function Shell({
  user,
  view,
  onNavigate,
  settingsTab,
  onSettingsTab,
  openSettings,
  closeSettings,
}: {
  user: User;
  view: View;
  onNavigate: (view: View) => void;
  /** Settings' tab state lives in App so the chat panel can deep-link (C3b). */
  settingsTab: SettingsTab;
  onSettingsTab: (tab: SettingsTab) => void;
  /** The single entry point: opens Settings on a tab (default General). */
  openSettings: (tab?: SettingsTab) => void;
  /** Returns to the view Settings was opened from. */
  closeSettings: () => void;
}) {
  // The shell's one clock tick (30 s): the weekly review's due moment and its
  // week identity are wall-clock answers, and an idle shell must still notice
  // Friday turning to Saturday.
  const shellNow = useNow();
  const { loading, tasks, blocks, series, holidays, completions, pendingWrites: pending } = useStore(user.uid);
  const profile = useProfileTimeZone(user.uid);
  useSyncedLanguage(profile.loading || profile.error !== null ? undefined : profile.language);
  const zone = profile.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  // A sign-in launch (T10) shows the window only when today's brief applies.
  useSignInReveal({ ready: !loading && !profile.loading, blocks, timeZone: profile.timeZone, workWindow: profile.workWindow });
  const phone = useMediaQuery(phoneQuery);
  // One timer for the whole shell: the sidebar card shows it and the palette
  // commands change it. A phone has no focus surface yet, so it runs none.
  // The idle-away hook (T9, desktop only) needs the timer's session and hands
  // back the stop report it must see, so the report travels through a ref: the
  // hook is created after the timer, and useFocusTimer keeps its onStop fresh
  // every render.
  const idleStopBridge = useRef<(report: FocusReport) => void>(() => {});
  const [lateError, setLateError] = useState<string | null>(null);
  const focus = useFocusTimer({
    blocks,
    tasks,
    timeZone: profile.timeZone,
    enabled: !phone,
    onStop: report => idleStopBridge.current(report),
  });
  const idle = useIdleAway({ uid: user.uid, session: focus.session, status: focus.status, onError: setLateError });
  idleStopBridge.current = idle.onFocusStopped;
  // The tray (T6) mirrors exactly this: the Up next pick, the live session and
  // the taskbar bar that goes with it, pushed to Rust whenever they change.
  useDesktopTray({ blocks, tasks, timeZone: profile.timeZone, session: focus.session });
  const [calendarDay, setCalendarDay] = useState<string | null>(null);
  const [creating, setCreating] = useState<HTMLElement | null>(null);
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
  // Settings (Ronda 2, S1) is a view in the shell, not a sheet; its tab state
  // and `openSettings(tab?)` live in App — see the comment there.
  // The weekly review (S3) is a view in the shell too. `via` remembers whether
  // it proposed itself (banner, toast, the shutdown chain) or was opened by
  // hand — that is what decides the steps the flow runs.
  const [weeklyVia, setWeeklyVia] = useState<"due" | "manual">("manual");
  const openWeeklyReview = useCallback(
    (via: "due" | "manual") => {
      setWeeklyVia(via);
      onNavigate("weekly");
    },
    [onNavigate],
  );
  // One subscription to the current week's review document; the banner, the
  // nudge pump and the flow all answer from it, so "what is due" is one fact.
  const weekly = useWeeklyReview(user.uid, zone, shellNow);
  const weeklyDue = profile.timeZone === null || !profile.weeklyReview.nudges
    ? null
    : dueMoment(shellNow, zone, profile.weeklyReview, weekly.state);
  // Actionable native notifications (T7, S8.3): block-start toasts with
  // [Start focus] / [+5 min] and the shutdown nudge. Desktop only, the web
  // build runs nothing. The actions reuse the shell's own doors: the timer's
  // one start, the calendar's day, the shutdown sheet the banner opens.
  useDesktopNotifications({
    blocks,
    tasks,
    timeZone: profile.timeZone,
    shutdownTime: profile.shutdownTime,
    lastShutdown: profile.lastShutdown,
    focus,
    onOpenBlock: date => {
      setCalendarDay(date);
      onNavigate("calendar");
    },
    onOpenShutdown: () => openShutdown(null),
    // The weekly review's nudge (S3): the same due moment the Home banner
    // reads, at most one toast per week and moment, and the shutdown chain
    // takes its place on a day the ritual already closed.
    weeklyNudge: {
      getDue: () => {
        if (profile.timeZone === null || !profile.weeklyReview.nudges) return null;
        const due = dueMoment(new Date(), zone, profile.weeklyReview, weekly.state);
        return due === null ? null : { week: due.week, day: due.moment.day, time: due.moment.time };
      },
      lastShutdown: profile.lastShutdown,
      onOpen: () => openWeeklyReview("due"),
      onLater: () => {
        void settle(snoozeWeeklyReview(user.uid, weekly.state.week, snoozedUntil(new Date()))).catch(() => undefined);
      },
      onSkip: () => {
        void settle(skipWeeklyReview(user.uid, weekly.state.week)).catch(() => undefined);
      },
    },
  });
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

  // The palette opens on its rebindable chord (default Ctrl+K), read live
  // from the shortcut registry so a rebind in Settings takes at once. Cmd and
  // Ctrl count as the same command modifier (the registry's rule).
  const paletteChord = useShortcutBinding("palette");
  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (!matchesEvent(paletteChord, event)) return;
      // The palette is open from anywhere, including inside a field.
      event.preventDefault();
      setPaletteOpen(true);
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [paletteChord]);

  // `Ctrl+,` opens Settings from anywhere. It is a fixed chord (the registry
  // keeps it out of the recorder), so a plain listener is all it needs.
  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (!matchesEvent("ctrl+Comma", event)) return;
      event.preventDefault();
      openSettings();
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [openSettings]);

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
        case "weekly":
          openWeeklyReview("manual");
          return;
        case "help":
          setHelpOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onNavigate, profile.shortcutsEnabled, openWeeklyReview]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [view]);

  // `calendar://` links (desktop shell): today is Home, a day opens the Calendar on it.
  useDeepLink({
    today: () => onNavigate("home"),
    day: key => {
      setCalendarDay(key === dateKey(new Date(), profile.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone) ? null : key);
      onNavigate("calendar");
    },
  });

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
  const today = dateKey(new Date(), zone);
  const newTask = (event: React.MouseEvent<HTMLButtonElement>) => setCreating(event.currentTarget);

  return (
    <TaskDragProvider onNavigate={onNavigate}>
      {/* The floating pill (desktop) mirrors this shell's one timer; a no-op
          off Tauri. It renders nothing here — it only carries the session
          across the window boundary. */}
      <FocusPillBridge focus={focus} />
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
          onOpenWeeklyReview={() => openWeeklyReview("manual")}
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
                onOpenSettings={() => openSettings()}
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
                  weeklyDue={weeklyDue}
                  onOpenCalendar={() => onNavigate("calendar")}
                  onOpenNow={() => setNowOpen(true)}
                  onCloseDay={openShutdown}
                  onOpenWeeklyReview={() => openWeeklyReview("due")}
                  onWeeklyLater={() => {
                    void settle(snoozeWeeklyReview(user.uid, weekly.state.week, snoozedUntil(new Date()))).catch(() => undefined);
                  }}
                  onWeeklySkip={() => {
                    void settle(skipWeeklyReview(user.uid, weekly.state.week)).catch(() => undefined);
                  }}
                  onOpenSettings={() => openSettings("rituals")}
                  onOfferUndo={offerUndo}
                  onNewTask={setCreating}
                />
              )}
              {view === "tasks" && (
                <Tasks
                  uid={user.uid}
                  loading={loading}
                  tasks={tasks}
                  blocks={blocks}
                  series={series}
                  completions={completions}
                  today={today}
                  onDeleted={offerUndo}
                  openTaskId={pendingTask}
                  onOpenTaskHandled={clearPendingTask}
                  onNewTask={setCreating}
                />
              )}
              {view === "calendar" && (
                <Calendar
                  uid={user.uid}
                  loading={loading}
                  blocks={blocks}
                  tasks={tasks}
                  holidays={holidays}
                  timeZone={profile.timeZone}
                  profileError={profile.error}
                  day={calendarDay}
                  onDayChange={setCalendarDay}
                  onDeleted={offerUndo}
                />
              )}
              {view === "settings" && (
                <SettingsView
                  uid={user.uid}
                  workWindow={profile.workWindow}
                  shutdownTime={profile.shutdownTime}
                  shortcutsEnabled={profile.shortcutsEnabled}
                  weeklyReview={profile.weeklyReview}
                  tab={settingsTab}
                  onTab={onSettingsTab}
                  onBack={closeSettings}
                />
              )}
              {view === "weekly" && (
                <WeeklyReview
                  uid={user.uid}
                  tasks={tasks}
                  blocks={blocks}
                  timeZone={zone}
                  now={shellNow}
                  workWindow={profile.workWindow}
                  settings={profile.weeklyReview}
                  via={weeklyVia}
                  onBack={() => onNavigate("home")}
                  onOfferUndo={offerUndo}
                  onProblem={setLateError}
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
      {idle.prompt !== null && (
        <IdleToast
          prompt={idle.prompt}
          onSubtract={() =>
            idle.confirm(tasks.find(task => task.id === idle.prompt?.taskId)?.actualMinutes ?? 0)
          }
          onKeep={idle.keep}
        />
      )}
      <AnimatePresence>
        {creating && (
          <NewTaskSheet key="new-task" uid={user.uid} timeZone={zone} tasks={tasks} origin={creating} onClose={() => setCreating(null)} />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {importOpen && (
          <GcalImportSheet
            key="gcal-import"
            uid={user.uid}
            blocks={blocks}
            tasks={tasks}
            holidays={holidays}
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
          onOpenWeeklyReview={() => openWeeklyReview("manual")}
          onOpenSettings={openSettings}
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
            weeklyOffer={weeklyDue !== null}
            origin={shutdownOrigin.current}
            onClose={() => setShutdownOpen(false)}
            onOpenWeeklyReview={() => {
              setShutdownOpen(false);
              openWeeklyReview("due");
            }}
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
  onOpenSettings,
}: {
  email: string;
  pending: number;
  onSignOut: () => void;
  onImport: (origin: HTMLElement) => void;
  onOpenSettings: () => void;
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
            {/* And so does the settings entry: the same footer action, one tap
                from the account whose preferences they are. */}
            <button
              type="button"
              className="button small"
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
            >
              <SettingsIcon />
              Settings
            </button>
            <button
              type="button"
              className="button small"
              onClick={event => {
                setOpen(false);
                onImport(event.currentTarget);
              }}
            >
              <CalendarIcon />
              Import from Google Calendar
            </button>
            <button type="button" className="button small" onClick={onSignOut}>Sign out</button>
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
            <DateField
              id="task-deadline"
              value={deadline}
              today={parsed.today}
              labels={dateFieldLabels}
              onChange={setDeadlineEdit}
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
            <Select
              id="task-repeat"
              label="Repeat"
              value={repeat}
              options={repeatOptions}
              onChange={value => setRepeatEdit(value as Frequency | "off")}
            />
          </div>
          {repeat !== "off" && (
            <div className="form-row">
              <label htmlFor="task-start">Start date</label>
              <DateField
                id="task-start"
                value={start}
                today={parsed.today}
                labels={dateFieldLabels}
                onChange={setStartEdit}
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
