import type { Dictionary } from "../types.ts";
import { auth } from "./auth.ts";
import { calendar } from "./calendar.ts";
import { chat } from "./chat.ts";
import { controls } from "./controls.ts";
import { forms } from "./forms.ts";
import { palette } from "./palette.ts";
import { settings } from "./settings.ts";
import { settingsTabs } from "./settingsTabs.ts";
import { shell } from "./shell.ts";
import { today } from "./today.ts";

/** A key missing here (or an extra one) is a type error: `Dictionary` mirrors `en`. */
export const es: Dictionary = {
  ...auth,
  ...calendar,
  ...chat,
  ...controls,
  ...forms,
  ...palette,
  ...settings,
  ...settingsTabs,
  ...shell,
  ...today,
};
