import { app } from "./app.ts";
import { auth } from "./auth.ts";
import { calendar } from "./calendar.ts";
import { capture } from "./capture.ts";
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
import { tray } from "./tray.ts";

/** Every English message, composed from one file per area. */
export const en = {
  ...app,
  ...auth,
  ...calendar,
  ...capture,
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
  ...tray,
} as const;
