import type { Dictionary } from "../types.ts";
import { app } from "./app.ts";
import { auth } from "./auth.ts";
import { calendar } from "./calendar.ts";
import { chat } from "./chat.ts";
import { controls } from "./controls.ts";
import { forms } from "./forms.ts";
import { home } from "./home.ts";
import { palette } from "./palette.ts";
import { gcal } from "./gcal.ts";
import { rituals } from "./rituals.ts";
import { planning } from "./planning.ts";
import { settings } from "./settings.ts";
import { settingsTabs } from "./settingsTabs.ts";
import { shell } from "./shell.ts";
import { today } from "./today.ts";

/** A key missing here (or an extra one) is a type error: `Dictionary` mirrors `en`. */
export const es: Dictionary = {
  ...app,
  ...auth,
  ...calendar,
  ...chat,
  ...controls,
  ...forms,
  ...home,
  ...palette,
  ...gcal,
  ...rituals,
  ...planning,
  ...settings,
  ...settingsTabs,
  ...shell,
  ...today,
};
