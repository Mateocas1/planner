import type { View } from "../App.tsx";
import type { FocusStatus } from "../domain/focus.ts";
import { availableSettingsTabs, type SettingsTab } from "./settings/tabs.ts";
import { shortcutHelp, type ShortcutAction } from "./shortcuts.ts";
import type { ThemePreference } from "./theme.ts";

/**
 * The command palette's result model. The ranking rules live here, apart from
 * the dialog, so they can be tested without a DOM. The palette has two modes,
 * and the mode follows the query:
 *
 * - an empty query offers the destinations only, so Enter never creates a task
 *   the user did not ask for;
 * - a typed query always offers "create this title" first, which is what makes
 *   Enter the quick-add path, then the matching tasks by title, then any
 *   destination the query names, then the theme and action commands it names.
 *
 * Every row has a stable id: it is the option's DOM id and the value the
 * combobox points at with aria-activedescendant.
 */

/** One destination the palette can jump to. */
export type PaletteDestination = { id: View; label: string };

/** The subset of a task the palette needs to rank it. */
export type PaletteTask = { id: string; title: string };

/** A theme value the palette can set. It repaints; it navigates and creates
 * nothing, which is why it is not a destination. */
export type PaletteThemeCommand = { kind: "theme"; id: string; pref: ThemePreference; label: string };

/**
 * A one-shot command: it opens a surface of its own, or acts on the focused
 * task, instead of navigating or creating. It matches on `keywords` rather than
 * on its label, so typing "cal" still offers only the Calendar destination --
 * the label is a sentence, not a search key.
 *
 * `hint` is the key that performs the same action, read from the keyboard's
 * own table (shortcuts.ts). It is absent when the action has no key, and when
 * the profile has keyboard shortcuts switched off.
 */
export type PaletteActionCommand = {
  kind: "action";
  id: string;
  action: PaletteActionKind;
  label: string;
  keywords: string[];
  hint?: string;
};

/** Every action the palette can run. The two task actions act on the row the
 * palette was opened from; the others open a surface of their own. */
export type PaletteActionKind = "gcal-import" | "now-mode" | "close-day" | "complete-task" | "move-tomorrow";

/** The keyboard action each palette action performs, so its hint is the key
 * the router already answers with. */
const actionShortcut: Partial<Record<PaletteActionKind, ShortcutAction>> = {
  "complete-task": "complete",
  "move-tomorrow": "tomorrow",
  "now-mode": "now",
};

export type PaletteCommand =
  | { kind: "create"; id: "create"; title: string }
  | { kind: "navigate"; id: string; view: View; label: string }
  | { kind: "task"; id: string; taskId: string; label: string }
  | PaletteThemeCommand
  | PaletteActionCommand
  | PaletteSettingsCommand
  | PaletteFocusCommand;

/**
 * The focus timer as a palette command: it changes the timer and navigates
 * nowhere (value roadmap §3). `verb` is what the palette runs; `label` is what
 * the user reads and what the query matches.
 *
 * It is deliberately not the general `action` kind F6 adds later: this is one
 * concern's vocabulary, and widening the model is that unit's decision.
 */
export type PaletteFocusCommand = { kind: "focus"; id: string; verb: "start" | "pause" | "resume" | "stop"; label: string };

/**
 * Opens the Settings view on a tab (Ronda 2, S1): one generic command plus one
 * per tab, so "settings" finds the view and "shortcuts" finds its tab. The
 * per-tab list is the rail's own table, so Desktop and AI drop off on the web
 * with everything else that is hidden there.
 */
export type PaletteSettingsCommand = { kind: "settings"; id: string; tab?: SettingsTab; label: string; keywords: string[] };

export function settingsCommands(desktop: boolean): PaletteSettingsCommand[] {
  const tabs = availableSettingsTabs(desktop);
  return [
    { kind: "settings", id: "settings", label: "Settings", keywords: ["settings", "preferences", "options"] },
    ...tabs.map(tab => ({
      kind: "settings" as const,
      id: `settings-${tab.id}`,
      tab: tab.id,
      label: `Settings: ${tab.label}`,
      keywords: ["settings", tab.label.toLowerCase(), tab.id],
    })),
  ];
}

/** What the palette needs to know about the timer to offer the right rows. */
export type FocusCommandState = { canStart: boolean; status: FocusStatus | null };

/**
 * The focus rows that apply right now: a start command while a block can be
 * focused, exactly one of pause/resume, and stop while any session lives. An
 * empty list is the honest answer when nothing applies, so the palette never
 * offers a command that would do nothing.
 */
export function focusCommands({ canStart, status }: FocusCommandState): PaletteFocusCommand[] {
  if (status === null) {
    return canStart ? [{ kind: "focus", id: "focus-start", verb: "start", label: "Start focus on next block" }] : [];
  }
  const rows: PaletteFocusCommand[] = [];
  if (canStart) rows.push({ kind: "focus", id: "focus-start", verb: "start", label: "Start focus on next block" });
  if (status === "paused") rows.push({ kind: "focus", id: "focus-resume", verb: "resume", label: "Resume focus" });
  if (status === "running") rows.push({ kind: "focus", id: "focus-pause", verb: "pause", label: "Pause focus" });
  rows.push({ kind: "focus", id: "focus-stop", verb: "stop", label: "Stop focus" });
  return rows;
}

/**
 * The theme values as palette commands (value roadmap §4). They appear for a
 * typed query that names them, so an empty palette still offers only the places
 * to go.
 */
export const themeCommands: PaletteThemeCommand[] = [
  { kind: "theme", id: "theme-system", pref: "system", label: "Theme: System" },
  { kind: "theme", id: "theme-light", pref: "light", label: "Theme: Light" },
  { kind: "theme", id: "theme-dark", pref: "dark", label: "Theme: Dark" },
];

/**
 * The actions the palette can run: the Google Calendar import (value roadmap
 * §1), Now mode (distinctive roadmap F5) and the shutdown ritual (F3c). They
 * appear for a typed query that names them, like the theme commands, so an
 * empty palette still offers only the places to go.
 */
export const actionCommands: PaletteActionCommand[] = [
  {
    kind: "action",
    id: "action-gcal-import",
    action: "gcal-import",
    label: "Import from Google Calendar",
    keywords: ["import", "google"],
  },
  {
    kind: "action",
    id: "action-now-mode",
    action: "now-mode",
    label: "Open Now mode",
    keywords: ["now", "glance", "full screen"],
  },
  /* F3's second entry point (the banner is the first). It opens the ritual, it
     does not close the day: the roll is the sheet's commit, so the summary is
     on screen before anything is written. */
  {
    kind: "action",
    id: "action-close-day",
    action: "close-day",
    label: "Close the day",
    keywords: ["close", "shutdown", "day", "ritual"],
  },
];

/**
 * The task actions: they act on the focused row, so they are listed only while
 * a task row holds focus when the palette opens. Without one they would do
 * nothing, and the palette never offers a command that does nothing.
 */
export const taskActionCommands: PaletteActionCommand[] = [
  {
    kind: "action",
    id: "action-complete-task",
    action: "complete-task",
    label: "Complete task",
    keywords: ["complete", "check", "done", "finish"],
  },
  {
    kind: "action",
    id: "action-move-tomorrow",
    action: "move-tomorrow",
    label: "Move to tomorrow",
    keywords: ["tomorrow", "move", "defer", "postpone"],
  },
];

/** How many tasks a query may list, so a broad word cannot bury the rest. */
export const taskResultLimit = 6;

/** What the palette knows about the screen it opened over, beyond the query. */
export type PaletteContext = {
  /** The profile's keyboard shortcuts. Off leaves the key hints out. */
  shortcuts: boolean;
  /** A task row held focus when the palette opened, so the task actions apply. */
  focusedTask: boolean;
  /** The Settings commands this device offers (Desktop and AI drop on web).
   * Absent in contexts that never render them (tests, older callers). */
  settingsCommands?: PaletteSettingsCommand[];
};

const defaultPaletteContext: PaletteContext = {
  shortcuts: true,
  focusedTask: false,
  settingsCommands: [],
};

export function buildCommands(
  rawQuery: string,
  tasks: PaletteTask[],
  destinations: PaletteDestination[],
  focus: PaletteFocusCommand[] = [],
  context: PaletteContext = defaultPaletteContext,
): PaletteCommand[] {
  const query = rawQuery.trim();
  if (query === "") {
    return destinations.map(destination => navigateCommand(destination));
  }
  const needle = query.toLowerCase();
  const matchedTasks = tasks
    .filter(task => task.title.toLowerCase().includes(needle))
    .sort((left, right) => left.title.localeCompare(right.title))
    .slice(0, taskResultLimit)
    .map(task => ({ kind: "task" as const, id: `task-${task.id}`, taskId: task.id, label: task.title }));
  const matchedDestinations = destinations
    .filter(destination => destination.label.toLowerCase().includes(needle))
    .map(navigateCommand);
  const matchedThemes = themeCommands.filter(command => command.label.toLowerCase().includes(needle));
  const actions = context.focusedTask ? [...taskActionCommands, ...actionCommands] : actionCommands;
  const matchedActions = actions
    .filter(command => command.keywords.some(keyword => keyword.includes(needle)))
    .map(command => withHint(command, context.shortcuts));
  const matchedSettings = (context.settingsCommands ?? []).filter(command =>
    command.keywords.some(keyword => keyword.includes(needle)),
  );
  const matchedFocus = focus.filter(command => command.label.toLowerCase().includes(needle));
  return [
    { kind: "create", id: "create", title: query },
    ...matchedTasks,
    ...matchedDestinations,
    ...matchedThemes,
    ...matchedActions,
    ...matchedSettings,
    ...matchedFocus,
  ];
}

/**
 * The action with its key hint, when the shortcuts are on and the action has a
 * key. The hint is read from the help sheet's table, which lists every key the
 * router answers, so it cannot drift from what a press really does.
 */
function withHint(command: PaletteActionCommand, shortcuts: boolean): PaletteActionCommand {
  const shortcut = actionShortcut[command.action];
  if (!shortcuts || shortcut === undefined) return command;
  const hint = shortcutHelp.flatMap(group => group.entries).find(entry => entry.action === shortcut)?.keys[0];
  return hint === undefined ? command : { ...command, hint };
}

function navigateCommand(destination: PaletteDestination): PaletteCommand {
  return { kind: "navigate", id: `navigate-${destination.id}`, view: destination.id, label: destination.label };
}
