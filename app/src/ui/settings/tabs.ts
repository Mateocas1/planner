/**
 * The Settings view's tab model: the rail's contents, their
 * labels and their availability, shared by the view, the palette commands and
 * the deep links (`openSettings("rituals")`), so one table decides what
 * exists and every entry point agrees.
 */

import { t } from "../../i18n/index.ts";

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
    get label() {
      return t("tabs.general.label");
    },
    get description() {
      return t("tabs.general.description");
    },
    desktopOnly: false,
  },
  {
    id: "rituals",
    get label() {
      return t("tabs.rituals.label");
    },
    get description() {
      return t("tabs.rituals.description");
    },
    desktopOnly: false,
  },
  {
    id: "shortcuts",
    get label() {
      return t("tabs.shortcuts.label");
    },
    get description() {
      return t("tabs.shortcuts.description");
    },
    desktopOnly: false,
  },
  {
    id: "desktop",
    get label() {
      return t("tabs.desktop.label");
    },
    get description() {
      return t("tabs.desktop.description");
    },
    desktopOnly: true,
  },
  {
    id: "ai",
    get label() {
      return t("tabs.ai.label");
    },
    get description() {
      return t("tabs.ai.description");
    },
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
