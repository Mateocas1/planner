import type { View } from "../App.tsx";
import type { FocusStatus } from "../domain/focus.ts";
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
 * A one-shot command: it opens a surface of its own instead of navigating or
 * creating. It matches on `keywords` rather than on its label, so typing "cal"
 * still offers only the Calendar destination -- the label is a sentence, not a
 * search key.
 */
export type PaletteActionCommand = {
  kind: "action";
  id: string;
  action: "gcal-import" | "now-mode" | "close-day";
  label: string;
  keywords: string[];
};

export type PaletteCommand =
  | { kind: "create"; id: "create"; title: string }
  | { kind: "navigate"; id: string; view: View; label: string }
  | { kind: "task"; id: string; taskId: string; label: string }
  | PaletteThemeCommand
  | PaletteActionCommand
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

/** How many tasks a query may list, so a broad word cannot bury the rest. */
export const taskResultLimit = 6;

export function buildCommands(
  rawQuery: string,
  tasks: PaletteTask[],
  destinations: PaletteDestination[],
  focus: PaletteFocusCommand[] = [],
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
  const matchedActions = actionCommands.filter(command => command.keywords.some(keyword => keyword.includes(needle)));
  const matchedFocus = focus.filter(command => command.label.toLowerCase().includes(needle));
  return [
    { kind: "create", id: "create", title: query },
    ...matchedTasks,
    ...matchedDestinations,
    ...matchedThemes,
    ...matchedActions,
    ...matchedFocus,
  ];
}

function navigateCommand(destination: PaletteDestination): PaletteCommand {
  return { kind: "navigate", id: `navigate-${destination.id}`, view: destination.id, label: destination.label };
}
