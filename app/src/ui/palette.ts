import type { View } from "../App.tsx";
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
 *   destination the query names.
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

export type PaletteCommand =
  | { kind: "create"; id: "create"; title: string }
  | { kind: "navigate"; id: string; view: View; label: string }
  | { kind: "task"; id: string; taskId: string; label: string }
  | PaletteThemeCommand;

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

/** How many tasks a query may list, so a broad word cannot bury the rest. */
export const taskResultLimit = 6;

export function buildCommands(
  rawQuery: string,
  tasks: PaletteTask[],
  destinations: PaletteDestination[],
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
  return [{ kind: "create", id: "create", title: query }, ...matchedTasks, ...matchedDestinations, ...matchedThemes];
}

function navigateCommand(destination: PaletteDestination): PaletteCommand {
  return { kind: "navigate", id: `navigate-${destination.id}`, view: destination.id, label: destination.label };
}
