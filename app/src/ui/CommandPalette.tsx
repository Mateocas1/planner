import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { View } from "../App.tsx";
import { addSeries } from "../data/series.ts";
import type { TaskView } from "../data/store.ts";
import { addTask } from "../data/tasks.ts";
import { parseQuickAdd, type QuickAdd } from "../domain/quickAdd.ts";
import { CalendarIcon, PlusIcon, CloseIcon, SearchIcon, TasksIcon } from "./icons.tsx";
import { buildCommands, type PaletteCommand, type PaletteDestination } from "./palette.ts";
import { quickAddPartLabel } from "./QuickAddChips.tsx";
import { ThemeIcon, views } from "./Sidebar.tsx";
import { setThemePreference } from "./theme.ts";
import { settle } from "./write.ts";
import "./CommandPalette.css";

/**
 * The destinations, in the sidebar's order and with the sidebar's own labels,
 * so a renamed view never leaves the palette behind.
 */
const destinations: PaletteDestination[] = views.map(({ id, label }) => ({ id, label: `Go to ${label}` }));

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
  onClose,
  onNavigate,
  onOpenTask,
  onImport,
}: {
  uid: string;
  /** The profile zone: the create row's date preview is a planner day. */
  timeZone: string;
  tasks: TaskView[];
  onClose: () => void;
  onNavigate: (view: View) => void;
  onOpenTask: (taskId: string) => void;
  /** Runs the "Import from Google Calendar" command (the sheet is the shell's). */
  onImport: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  // A destination or a task moves focus itself; only a plain close gives it back.
  const restoreFocus = useRef(true);
  const [query, setQuery] = useState("");
  // The selected row is an id, not an index: when the list changes under it and
  // the row is gone, the first row is selected again.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const commands = useMemo(() => buildCommands(query, tasks, destinations), [query, tasks]);
  // The same parser the New task sheet uses, so one line creates the same task
  // from either place. The clock is read per keystroke: "tomorrow" follows the
  // planner's day, and a panel left open past midnight must not keep yesterday's.
  const parsed = useMemo(() => parseQuickAdd(query, { now: new Date(), timeZone }), [query, timeZone]);
  const activeIndex = Math.max(0, commands.findIndex(command => command.id === activeId));
  const active = commands[activeIndex];

  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
      /* The sheet that opens takes the focus; handing it back to the trigger
         behind the dialog would fight the panel's own focus return. */
      restoreFocus.current = false;
      onImport();
      onClose();
      return;
    }
    void create();
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
      setError(cause instanceof Error ? cause.message : "Something went wrong. Try again.");
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
      <h2 id="palette-heading" className="sr-only">Command palette</h2>
      <div className="palette-field">
        <SearchIcon className="palette-icon" />
        <input
          ref={inputRef}
          className="palette-input"
          type="text"
          role="combobox"
          aria-label="Search tasks or run a command"
          aria-expanded="true"
          aria-haspopup="listbox"
          aria-controls="palette-list"
          aria-autocomplete="list"
          aria-activedescendant={active ? `palette-option-${active.id}` : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder="Search tasks or type a title…"
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
        <button type="button" className="icon-button" aria-label="Close palette" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      {error && <p className="palette-error" role="alert">{error}</p>}
      <ul ref={listRef} id="palette-list" className="palette-list" role="listbox" aria-label="Results">
        {commands.map((command, index) => (
          <li
            key={command.id}
            id={`palette-option-${command.id}`}
            role="option"
            aria-selected={index === activeIndex}
            className="palette-option"
            onClick={() => run(command)}
          >
            <span className="palette-option-icon" aria-hidden="true">{commandIcon(command)}</span>
            <span className="palette-option-label">{commandLabel(command, parsed)}</span>
          </li>
        ))}
      </ul>
      <p className="palette-hint" aria-hidden="true">↑↓ to move · ↵ to run · esc to close</p>
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
  return detail === "" ? `Create “${title}”` : `Create “${title}” — ${detail}`;
}

function commandIcon(command: PaletteCommand) {
  if (command.kind === "create") return <PlusIcon />;
  if (command.kind === "task") return <TasksIcon />;
  if (command.kind === "theme") return <ThemeIcon preference={command.pref} />;
  if (command.kind === "action") return <CalendarIcon />;
  const Icon = views.find(entry => entry.id === command.view)?.Icon ?? TasksIcon;
  return <Icon />;
}
