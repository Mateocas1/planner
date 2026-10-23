/**
 * The Settings view's tab model (Ronda 2, S1): the rail's contents, their
 * labels and their availability, shared by the view, the palette commands and
 * the deep links (`openSettings("rituals")`), so one table decides what
 * exists and every entry point agrees.
 */

export type SettingsTab = "general" | "rituals" | "shortcuts" | "desktop" | "ai";

export type SettingsTabDef = {
  id: SettingsTab;
  label: string;
  /** A sentence under the tab's heading. */
  description: string;
  /** Desktop-only tabs are not rendered on the web at all — no disabled
   * teaser, per the design brief — and a deep link to one falls back to
   * General. */
  desktopOnly: boolean;
};

export const settingsTabs: readonly SettingsTabDef[] = [
  {
    id: "general",
    label: "General",
    description: "One working window for every day, in your planner's time zone.",
    desktopOnly: false,
  },
  {
    id: "rituals",
    label: "Rituals",
    description: "The daily shutdown and the weekly review.",
    desktopOnly: false,
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    description: "Rebind the chords you press most, and read the rest.",
    desktopOnly: false,
  },
  {
    id: "desktop",
    label: "Desktop",
    description: "How Planner behaves on this computer.",
    desktopOnly: true,
  },
  {
    id: "ai",
    label: "AI",
    description: "The assistant's setup.",
    desktopOnly: true,
  },
];

/** The tabs that exist on this device: Desktop and AI only inside the shell. */
export function availableSettingsTabs(desktop: boolean): SettingsTabDef[] {
  return settingsTabs.filter(tab => desktop || !tab.desktopOnly);
}

/**
 * The tab a request lands on: the requested one when it exists here, General
 * otherwise (a deep link to a hidden tab from a notification on the wrong
 * device is a navigation mistake, not an error).
 */
export function resolveSettingsTab(tab: SettingsTab | undefined, desktop: boolean): SettingsTab {
  if (tab === undefined) return "general";
  const def = settingsTabs.find(entry => entry.id === tab);
  return def === undefined || (def.desktopOnly && !desktop) ? "general" : tab;
}
