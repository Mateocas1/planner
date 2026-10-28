import { auth } from "./auth.ts";
import { calendar } from "./calendar.ts";
import { chat } from "./chat.ts";
import { controls } from "./controls.ts";
import { forms } from "./forms.ts";
import { palette } from "./palette.ts";
import { gcal } from "./gcal.ts";
import { settings } from "./settings.ts";
import { shell } from "./shell.ts";
import { today } from "./today.ts";

/** Every English message, composed from one file per area. */
export const en = {
  ...auth,
  ...calendar,
  ...chat,
  ...controls,
  ...forms,
  ...palette,
  ...gcal,
  ...settings,
  ...shell,
  ...today,
} as const;
