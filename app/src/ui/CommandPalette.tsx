import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { flushSync } from "react-dom";
import { onSnapshot } from "firebase/firestore";
import type { View } from "../App.tsx";
import { t, useLocale } from "../i18n/index.ts";
import { isTauri } from "../desktop.ts";
import { parseShortcutsEnabled, profileDocument } from "../data/profile.ts";
import { addSeries } from "../data/series.ts";
import type { TaskView } from "../data/store.ts";
import { addTask } from "../data/tasks.ts";
import { parseQuickAdd, type QuickAdd } from "../domain/quickAdd.ts";
import { PlayIcon } from "./FocusWidget.tsx";
import { CalendarIcon, PlusIcon, CloseIcon, SearchIcon, TasksIcon } from "./icons.tsx";
import { useMediaQuery } from "./motion.ts";
import { buildCommands, focusCommands, settingsCommands, type PaletteCommand, type PaletteDestination } from "./palette.ts";
import { quickAddPartLabel } from "./QuickAddChips.tsx";
import { publishShortcut, type SurfaceAction } from "./shortcuts.ts";
import { SettingsIcon } from "./Settings.tsx";
import type { SettingsTab } from "./settings/tabs.ts";
import { ThemeIcon, views } from "./Sidebar.tsx";
import { setThemePreference } from "./theme.ts";
import type { FocusControls } from "./useFocusTimer.ts";
import { settle } from "./write.ts";
import "./CommandPalette.css";

/**
 * The destinations, in the sidebar's order and with the sidebar's own labels,
 * so a renamed view never leaves the palette behind.
 */
const destinations = (): PaletteDestination[] => views.map(({ id, label }) => ({ id, label: t("palette.goTo", { view: label }) }));

/** What a Tab may land on inside the dialog, in DOM order. */
const focusableSelector = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Command palette (Cmd/Ctrl+K). A keyboard surface opened hundreds of times a
 * day, so it gets the shortest entrance the app has and nothing more: it fades
 * in with a 2% scale over 150 ms (CommandPalette.css), the field takes focus in
 * the same effect that opens it, and no row animates while the user types. The
 * entrance is decoration, never a gate: a key typed on the opening frame is
 * accepted, and Escape closes it at once.
 *
 * It is a native modal <dialog>, so the browser owns the backdrop, the top
 * layer and the inert page; Tab wrapping is wired explicitly because a dialog
 * with a single field hands focus to the browser chrome on the way round.
 * Focus returns to whatever was focused before it opened. The field is a
 * combobox pointing at the listbox row the arrow keys selected.
 */
export function CommandPalette({
  uid,
  timeZone,
  tasks,
  focus,
  onClose,
  onNavigate,
  onOpenTask,
  onImport,
  onOpenNow,
  onCloseDay,
  onReplayDay,
  replayDay = false,
  onOpenWeeklyReview,
  onOpenSettings,
}: {
  uid: string;
  /** The profile zone: the create row's date preview is a planner day. */
  timeZone: string;
  tasks: TaskView[];
  /* The timer's live state: the palette offers the focus rows that apply and
     runs them itself, so a command never needs a second surface to work. */
  focus: FocusControls | null;
  onClose: () => void;
  onNavigate: (view: View) => void;
  onOpenTask: (taskId: string) => void;
  /** Runs the "Import from Google Calendar" command (the sheet is the shell's). */
  onImport: () => void;
  /** Runs the "Open Now mode" command (the overlay is the shell's). */
  onOpenNow: () => void;
  /** Runs the "Close the day" command (the ritual is the shell's, F3c). */
  onCloseDay: () => void;
  /** Runs the "Replay the day" command (the stage lives in the shutdown sheet). */
  onReplayDay?: () => void;
  /** Today has a replay to show and the setting allows it: only then is the command offered. */
  replayDay?: boolean;
  /** Runs the "Weekly review" command (the flow is the shell's, S3). */
  onOpenWeeklyReview: () => void;
  /** Opens the Settings view, optionally on a tab (Ronda 2, S1). */
  onOpenSettings: (tab?: SettingsTab) => void;
}) {
  const locale = useLocale();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  // A destination or a task moves focus itself; only a plain close gives it back.
  const restoreFocus = useRef(true);
  // The keyboard setting is read here rather than passed in: the palette is
  // open over one profile document, and the shell's App.tsx is not its owner.
  const [shortcutsOn, setShortcutsOn] = useState(false);
  const desktop = isTauri();
  // Whether a task row held focus when the palette opened: the task actions act
  // on that row, so they are offered only then.
  const [taskFocused, setTaskFocused] = useState(false);
  const touch = useMediaQuery("(pointer: coarse)") || navigator.maxTouchPoints > 0;
  const [query, setQuery] = useState("");
  // The selected row is an id, not an index: when the list changes under it and
  // the row is gone, the first row is selected again.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Touch-only devices get no key hints: there is no keyboard to press them on.
  const hints = shortcutsOn && !touch;
  const commands = useMemo(
    () =>
      buildCommands(
        query,
        tasks,
        destinations(),
        focusCommands({ canStart: focus?.canStart ?? false, status: focus?.status ?? null }),
        { shortcuts: hints, focusedTask: taskFocused, settingsCommands: settingsCommands(desktop), replayDay },
      ),
    [query, tasks, focus?.canStart, focus?.status, hints, taskFocused, desktop, locale, replayDay],
  );
  // The same parser the New task sheet uses, so one line creates the same task
  // from either place. The clock is read per keystroke: "tomorrow" follows the
  // planner's day, and a panel left open past midnight must not keep yesterday's.
  const parsed = useMemo(() => parseQuickAdd(query, { now: new Date(), timeZone }), [query, timeZone]);
  const activeIndex = Math.max(0, commands.findIndex(command => command.id === activeId));
  const active = commands[activeIndex];

  useEffect(() => {
    return onSnapshot(
      profileDocument(uid),
      snapshot => setShortcutsOn(parseShortcutsEnabled(snapshot.data())),
      () => setShortcutsOn(false),
    );
  }, [uid]);

  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTaskFocused(previousFocus.current?.closest("[data-task-id]") != null);
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    inputRef.current?.focus();
    return () => {
      if (!restoreFocus.current) return;
      const target = previousFocus.current;
      if (target?.isConnected) target.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  function run(command: PaletteCommand) {
    if (busy) return;
    if (command.kind === "navigate") {
      onNavigate(command.view);
      onClose();
      return;
    }
    if (command.kind === "task") {
      restoreFocus.current = false;
      onOpenTask(command.taskId);
      onClose();
      return;
    }
    if (command.kind === "theme") {
      /* a repaint, not a navigation: the palette closes and the page stays */
      setThemePreference(command.pref);
      onClose();
      return;
    }
    if (command.kind === "action") {
      if (command.action === "complete-task") {
        runOnRow("complete");
        return;
      }
      if (command.action === "move-tomorrow") {
        runOnRow("tomorrow");
        return;
      }
      /* The sheet or overlay that opens takes the focus; handing it back to the
         trigger behind the dialog would fight the panel's own focus return. */
      restoreFocus.current = false;
      if (command.action === "now-mode") onOpenNow();
      else if (command.action === "close-day") onCloseDay();
      else if (command.action === "replay-day") onReplayDay?.();
      else if (command.action === "weekly-review") onOpenWeeklyReview();
      else onImport();
      onClose();
      return;
    }
    if (command.kind === "settings") {
      onOpenSettings(command.tab);
      onClose();
      return;
    }
    if (command.kind === "focus") {
      /* The timer changes where it lives (the sidebar card); the palette's own
         job is done, so it closes like every other command surface. */
      if (command.verb === "start") focus?.startNext();
      else if (command.verb === "pause") focus?.pause();
      else if (command.verb === "resume") focus?.resume();
      else focus?.stop();
      onClose();
      return;
    }
    void create();
  }

  /**
   * Runs a task action on the row the palette was opened from. The page under
   * a modal dialog is inert, so the dialog closes first: flushSync commits the
   * unmount now, which lifts the inert state. Focus then goes back to the row,
   * and only then is the action published, because the surface reads the
   * focused row when it handles the event. The unmount must not move focus a
   * second time, so the restore is switched off here.
   */
  function runOnRow(action: SurfaceAction) {
    const row = previousFocus.current;
    restoreFocus.current = false;
    flushSync(() => onClose());
    if (row?.isConnected) row.focus({ preventScroll: true });
    publishShortcut(action);
  }

  /**
   * Creates what the line asked for: a task with its deadline, or a series when
   * a repeat was recognized. A line that is nothing but a date leaves no title,
   * and the domain says so -- the palette shows that message like any other.
   */
  async function create() {
    setBusy(true);
    setError(null);
    try {
      await settle(
        parsed.frequency === undefined
          ? addTask(uid, parsed.title, parsed.deadline)
          : addSeries(uid, parsed.title, parsed.frequency, parsed.anchorDate ?? parsed.today, parsed.deadline),
      );
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("palette.error"));
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      // Escape belongs to the palette while it is open: a details sheet behind
      // it must not close as well.
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = (activeIndex + step + commands.length) % commands.length;
      setActiveId(commands[next].id);
      return;
    }
    if (event.key === "Tab") {
      // A native dialog keeps Tab inside, but a lone field sends focus to the
      // browser chrome on the way round. Wiring the wrap here keeps it in.
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? []);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const current = document.activeElement;
      if (event.shiftKey && (current === first || !focusable.includes(current as HTMLElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (active) run(active);
    }
  }

  const onBackdropClick = (event: ReactMouseEvent<HTMLDialogElement>) => {
    if (event.target === dialogRef.current) onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className="palette glass glass-thick"
      role="dialog"
      aria-modal="true"
      aria-labelledby="palette-heading"
      onCancel={event => {
        // the open state is React's, so the native close is intercepted
        event.preventDefault();
        onClose();
      }}
      onClick={onBackdropClick}
      onKeyDown={onKeyDown}
    >
      <h2 id="palette-heading" className="sr-only">{t("palette.heading")}</h2>
      <div className="palette-field">
        <SearchIcon className="palette-icon" />
        <input
          ref={inputRef}
          className="palette-input"
          type="text"
          role="combobox"
          aria-label={t("palette.inputLabel")}
          aria-expanded="true"
          aria-haspopup="listbox"
          aria-controls="palette-list"
          aria-autocomplete="list"
          aria-activedescendant={active ? `palette-option-${active.id}` : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={t("palette.placeholder")}
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
        <button type="button" className="icon-button" aria-label={t("palette.close")} onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      {error && <p className="palette-error" role="alert">{error}</p>}
      <ul ref={listRef} id="palette-list" className="palette-list" role="listbox" aria-label={t("palette.results")}>
        {commands.map((command, index) => (
          <li
            key={command.id}
            id={`palette-option-${command.id}`}
            role="option"
            aria-selected={index === activeIndex}
            aria-keyshortcuts={commandHint(command)}
            className="palette-option"
            onClick={() => run(command)}
          >
            <span className="palette-option-icon" aria-hidden="true">{commandIcon(command)}</span>
            <span className="palette-option-label">{commandLabel(command, parsed)}</span>
            {commandHint(command) !== undefined && <kbd className="palette-option-key">{commandHint(command)}</kbd>}
          </li>
        ))}
      </ul>
      <p className="palette-hint" aria-hidden="true">{t("palette.hint")}</p>
    </dialog>
  );
}

/**
 * A row's label. The create row names the title the parser kept and previews
 * every part it recognized, so Enter never creates something other than what the
 * row says; when the line is nothing but a date the raw text stands in for the
 * (empty) title the domain will reject.
 */
function commandLabel(command: PaletteCommand, parsed: QuickAdd): string {
  if (command.kind !== "create") return command.label;
  const title = parsed.title === "" ? command.title : parsed.title;
  const detail = parsed.parts.map(part => quickAddPartLabel(part, parsed.today)).join(" · ");
  return detail === "" ? t("palette.create", { title }) : t("palette.createDetail", { title, detail });
}

/** The key that performs a row's action, when the row shows one. */
function commandHint(command: PaletteCommand): string | undefined {
  return command.kind === "action" ? command.hint : undefined;
}

function commandIcon(command: PaletteCommand) {
  if (command.kind === "create") return <PlusIcon />;
  if (command.kind === "task") return <TasksIcon />;
  if (command.kind === "theme") return <ThemeIcon preference={command.pref} />;
  if (command.kind === "action") {
    if (command.action === "now-mode") return <PlayIcon />;
    return command.action === "complete-task" ? <TasksIcon /> : <CalendarIcon />;
  }
  if (command.kind === "focus") return <PlayIcon />;
  if (command.kind === "settings") return <SettingsIcon />;
  const Icon = views.find(entry => entry.id === command.view)?.Icon ?? TasksIcon;
  return <Icon />;
}
